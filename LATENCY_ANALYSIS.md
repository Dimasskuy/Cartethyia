# Analisis Latency dan Performa Router AI (Cartethyia) pada Deployment Koyeb

Dokumen ini berisi hasil analisis mendalam mengenai masalah respons lambat (latency) pada web aplikasi router AI (Cartethyia) saat dijalankan melalui base URL (di-host di Koyeb) dan diakses oleh client seperti OpenCode dan Pi agent, khususnya ketika menggunakan provider custom dan fitur model combo.

---

## 1. Prioritas Utama Penyebab Latency

Berikut adalah urutan kemungkinan penyebab utama kelambatan respons, diurutkan dari yang **paling mungkin (dampak terbesar)** hingga yang **paling kecil kemungkinannya**, beserta alasan singkatnya:

1. **Perilaku Custom Provider Upstream & Cold Start (Prioritas 1 - Paling Ringkas & Sering)**
   - *Alasan*: Custom provider (terutama self-hosted, serverless LLM, vLLM/Ollama di balik Cloudflare Tunnel/Ngrok, atau custom proxy) sering mengalami cold start, antrean internal (queue), atau buffering SSE di level framework upstream (misal FastAPI/Uvicorn yang tidak mengaktifkan response streaming).
2. **First Chunk Priming & Behavior Combo Routing (Prioritas 2)**
   - *Alasan*: Router Cartethyia menunggu event pertama (`iterator.next()`) dari upstream *sebelum* mengirimkan HTTP response headers 200 ke client. Jika kandidat pertama dalam Combo (seperti `cascade` strategy) mengalami *hang* atau respon lambat, client akan mengalami jeda TTFB (Time-To-First-Byte) yang lama.
3. **Buffering pada Ingress Proxy / Reverse Proxy (Koyeb Envoy Edge Proxy) (Prioritas 3)**
   - *Alasan*: Koyeb menggunakan Envoy sebagai edge proxy. Jika header HTTP seperti `x-accel-buffering: no` atau `cache-control: no-transform` tidak dipatuhi secara penuh oleh proxy perantara atau client, Envoy/Cloudflare akan menahan token-token SSE hingga buffer penuh baru dikirim sekaligus ke client.
4. **HTTP Connection Pooling, Keep-Alive, dan Handshake Overhead (Prioritas 4)**
   - *Alasan*: Tanpa HTTP Keep-Alive connection pool yang persistent antar-request ke custom provider, setiap request router harus melakukan handshake TCP + TLS 1.3 baru. Ini menambah RTT (Round Trip Time) sebesar 100ms–300ms per request.
5. **Network Hop & Latency Wilayah (Geographic / DNS) (Prioritas 5)**
   - *Alasan*: Lokasi data center Koyeb (misalnya Washington D.C. `iad` atau Frankfurt `fra`) yang jauh dari lokasi custom provider atau client (misalnya provider di lokal/Asia) menambah RTT jaringan pada setiap SSE chunk.
6. **Overhead Middleware, Token Saver (RTK Compression), dan Logging Telemetri (Prioritas 6 - Dampak Terkecil)**
   - *Alasan*: Pemrosesan prompt pada Token Saver (seperti RTK compression) untuk konteks besar (misalnya 30k+ token dari OpenCode) memakan CPU cycles sebelum request dikirim ke upstream.

---

## 2. Identifikasi Penyebab Latency Secara Detail

### A. Perilaku Provider Custom Upstream
- **Cold Start & Unbuffered SSE**: Banyak custom provider tidak melakukan *flush* immediate pada header SSE (`text/event-stream`). Framework Python (seperti Flask/FastAPI tanpa `StreamingResponse`) sering menahan output generator sampai buffer penuh.
- **Queueing & Rate Limit Internal**: Jika custom provider menangani request secara sekuensial (concurrency limit = 1), request berikutnya dari OpenCode/Pi agent harus mengantre di upstream.

### B. Handling Request/Response di Router (Streaming & Combo Routing)
- **Priming Event Pertama (`src/transport/dispatch/proxy-request.ts`)**:
  ```typescript
  // Router memanggil first chunk sebelum mengembalikan Response HTTP 200
  state.upstreamDispatchStartedAtMs = Date.now();
  first = await iterator.next();
  ```
  Tujuan fungsi ini adalah untuk memastikan upstream tidak error sebelum mengirim status HTTP 200. Namun efek sampingnya: jika provider lambat memberikan token pertama (misal model reasoning/thinking seperti DeepSeek R1/o1), client melihat status `Pending/Waiting TTFB` yang sangat lama.
- **Combo Strategy Overhead (`cascade` / `fallback`)**:
  Ketika model combo memilih kandidat provider custom yang lambat, strategi `cascade` akan menunggu hingga timeout kandidat pertama habis sebelum mencoba kandidat berikutnya.

### C. Buffering pada Layer Network Koyeb & Ingress
- Koyeb menjalankan Envoy Edge Proxy. Jika response streaming dari Cartethyia tidak menyertakan instruksi penonaktifan buffer yang tepat, Envoy dapat mem-buffer SSE chunk.
- Kompresi Gzip/Brotli pada perantara dapat menahan chunk kecil SSE sampai payload berukuran ~4KB terkumpul.

### D. Konfigurasi Timeout & Connection Pooling
- Jika `undici` / Bun `fetch` membuat koneksi HTTP/1.1 baru untuk setiap dispatch request tanpa memelihara HTTP Keep-Alive pool ke endpoint custom provider, TLS handshake overhead terjadi berulang kali.

---

## 3. Metode Diagnosis Latency

Untuk menentukan secara pasti apakah bottleneck terletak di Router Cartethyia atau di Upstream Custom Provider, lakukan langkah-langkah diagnosis berikut:

### Langkah 1: Ukur Metrics Telemetri Router (TTFB vs Execution Time)
Gunakan console dashboard Cartethyia pada menu **Usage / Log** atau periksa data telemetri DB.
Bandingkan dua angka utama:
1. `ttfb_ms` (Time To First Byte): Waktu dari request masuk ke router hingga token pertama dikirim ke client.
2. `duration_ms`: Total waktu penyelesaian stream.

> **Analisis**:
> - Jika `ttfb_ms` tinggi (misal > 3000ms), bottleneck ada pada **penyiapan koneksi/cold start upstream** atau **first event priming**.
> - Jika `ttfb_ms` kecil (< 500ms) tetapi total waktu streaming lambat, bottleneck ada pada **throughput streaming/buffering proxy**.

### Langkah 2: Bandingkan Request Langsung vs Melalui Router (cURL Benchmark)
Jalankan perintah `curl` dengan flag `-w` untuk mengukur waktu spesifik:

```bash
# 1. Test Langsung ke Custom Provider Upstream
curl -iv -X POST "https://custom-provider.example.com/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_KEY" \
  -d '{"model":"custom-model","messages":[{"role":"user","content":"hi"}],"stream":true}' \
  -w "\n\nTTFB: %{time_starttransfer}s | Total: %{time_total}s\n"

# 2. Test Melalui Router Cartethyia di Koyeb
curl -iv -X POST "https://your-app.koyeb.app/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_CARTETHYIA_KEY" \
  -d '{"model":"your-combo-or-custom-model","messages":[{"role":"user","content":"hi"}],"stream":true}' \
  -w "\n\nTTFB: %{time_starttransfer}s | Total: %{time_total}s\n"
```

### Langkah 3: Periksa Framing SSE Chunks Real-time
Gunakan `curl -N` (no buffer) untuk melihat apakah token keluar secara bertahap satu per satu atau sekaligus banyak (chunking issue):
```bash
curl -N -X POST "https://your-app.koyeb.app/v1/chat/completions" \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"combo-model","messages":[{"role":"user","content":"Count 1 to 20 slowly"}],"stream":true}'
```

---

## 4. Rekomendasi Perbaikan & Solusi

### Solusi 1: Pastikan Header Anti-Buffering untuk Koyeb/Envoy
Tambahkan header pelindung SSE agar Koyeb/Envoy Edge Proxy tidak menahan stream:

```typescript
// Di src/transport/dispatch/proxy-request.ts
return new Response(stream, {
  headers: {
    "content-type": "text/event-stream; charset=utf-8",
    "connection": "keep-alive",
    "cache-control": "no-cache, no-transform",
    "x-accel-buffering": "no",
    "x-content-type-options": "nosniff",
  },
});
```

### Solusi 2: Optimasi HTTP Client & Connection Pooling (Keep-Alive)
Gunakan `undici` Agent dengan HTTP Keep-Alive yang dioptimalkan untuk custom provider pada `src/protocol/transport/openai.ts`:

```typescript
import { Agent, fetch as undiciFetch } from "undici";

// Inisialisasi HTTP Keep-Alive Agent terpusat
const globalDispatcher = new Agent({
  keepAliveTimeout: 60_000, // Simpan koneksi idle selama 60s
  keepAliveMaxTimeout: 600_000,
  connections: 100, // Connection pool size
});

export async function postUpstreamJson(...) {
  // Gunakan dispatcher dengan Keep-Alive
  const res = await outboundFetch(fetchUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: lifecycle.signal,
    dispatcher: globalDispatcher,
  } as RequestInit);
  ...
}
```

### Solusi 3: Penyesuaian Timeout & Failover pada Model Combo
Jika menggunakan strategi Combo `cascade`, percepat timeout kandidat pertama agar router segera pindah jika provider custom lambat/stuck.
Atur variabel lingkungan di `.env` Koyeb:

```env
# Timeout untuk token pertama (default 200s, kurangi jika ingin fast failover)
CARTETHYIA_STREAM_FIRST_CHUNK_TIMEOUT_MS=15000

# Timeout jika stream berhenti di tengah jalan
CARTETHYIA_STREAM_STALL_TIMEOUT_MS=60000

# Upstream HTTP request deadline
CARTETHYIA_UPSTREAM_TIMEOUT_MS=30000
```

### Solusi 4: Perbaikan pada Custom Provider Upstream (Jika Self-Hosted)
Jika custom provider menggunakan Python / FastAPI, pastikan generator mengalirkan buffer secara langsung (`yield`) dan menggunakan `ujson` / `orjson`:

```python
# Contoh perbaikan pada Custom Provider (FastAPI)
from fastapi import FastAPI
from fastapi.responses import StreamingResponse
import asyncio

app = FastAPI()

async def event_generator():
    for token in ["Hello", " world", "!"]:
        yield f"data: {{\"choices\":[{{\"delta\":{{\"content\":\"{token}\"}}}}]}}\n\n"
        await asyncio.sleep(0.05)

@app.post("/v1/chat/completions")
async def chat_completions():
    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive"
        }
    )
