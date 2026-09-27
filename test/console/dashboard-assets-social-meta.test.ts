import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { createStaticHandler } from "../../src/console/dashboard-assets";
import { join } from "path";
import { mkdir, writeFile, rm } from "fs/promises";

// Mirrors the sentinel-delimited block the Vite build emits in the shared index
// document: the landing card sits between the markers, and the server swaps it
// for the share card when serving a `/share/*` route. Crawlers do not run the
// client bundle, so the swap has to happen server-side.
const INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta name="description" content="Landing description." />
    <link rel="icon" type="image/webp" href="/favicon.webp" />
    <!-- cartethyia:social-meta:start -->
    <meta property="og:title" content="Cartethyia — One Stop OpenAI &amp; Anthropic Proxy Router" />
    <meta property="og:image" content="/og_image.webp" />
    <meta name="twitter:image" content="/og_image.webp" />
    <!-- cartethyia:social-meta:end -->
    <title>Cartethyia</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>`;

describe("Shared index social meta", () => {
  let testDir: string;
  let handler: ReturnType<typeof createStaticHandler>;

  beforeAll(async () => {
    testDir = "/tmp/console-social-meta-" + Date.now();
    await mkdir(testDir, { recursive: true });
    await writeFile(join(testDir, "index.html"), INDEX_HTML);
    handler = createStaticHandler({ buildDir: testDir });
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  const bodyOf = async (path: string): Promise<string> => {
    const result = await handler(path);
    expect(result.status).toBe(200);
    return new TextDecoder().decode(result.body);
  };

  it("serves the Bansos card on a public share enrollment route", async () => {
    const html = await bodyOf(`/share/${"a".repeat(43)}`);
    expect(html).toContain('property="og:image" content="/og_bansos.webp"');
    expect(html).toContain('name="twitter:image" content="/og_bansos.webp"');
    expect(html).toContain('property="og:title" content="Cartethyia — Bansos Token"');
    expect(html).toContain('property="og:image:width" content="1760"');
    expect(html).toContain('property="og:image:height" content="576"');
    expect(html).toContain("<title>Cartethyia — Bansos Token</title>");
    expect(html).toContain('name="description" content="Come and save your tokens');
    // The landing card must not leak through on the share route.
    expect(html).not.toContain("/og_image.webp");
  });

  it("keeps the landing card on the public root", async () => {
    const html = await bodyOf("/");
    expect(html).toContain('property="og:image" content="/og_image.webp"');
    expect(html).not.toContain("/og_bansos.webp");
    expect(html).toContain("<title>Cartethyia</title>");
  });

  it("keeps the landing card on console routes", async () => {
    const html = await bodyOf("/console/dashboard");
    expect(html).toContain('property="og:image" content="/og_image.webp"');
    expect(html).not.toContain("/og_bansos.webp");
  });

  it("does not require the sentinel block to be present", async () => {
    await writeFile(join(testDir, "index.html"), "<html><head><title>Bare</title></head></html>");
    const html = await bodyOf(`/share/${"a".repeat(43)}`);
    expect(html).toContain("<title>Cartethyia — Bansos Token</title>");
    await writeFile(join(testDir, "index.html"), INDEX_HTML);
  });
});
