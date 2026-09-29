import { createHash, randomUUID } from "node:crypto";

/** CN API origin used by the current server-side AutoClaw channel. */
export const AUTOCLAW_CN_BASE_URL = "https://autoglm-acceleration-api.zhipuai.cn";
/** OpenAI-compatible endpoint exposed by AutoClaw's proxy. */
export const AUTOCLAW_CHAT_COMPLETIONS_PATH = "/autoclaw-proxy/proxy/autoclaw/v1/chat/completions";
/** AutoClaw desktop client version used by the currently observed chat contract. */
export const AUTOCLAW_CLIENT_VERSION = "1.18.5";

export const AUTOCLAW_APP_ID = "100003";
const AUTOCLAW_APP_SIGNING_KEY = "38d2391985e2369a5fb8227d8e6cd5e5";
const AUTOCLAW_USER_API_VERSION = "1.12.1";
const USER_API_TIMEOUT_MS = 15_000;

/** HTTP fetch seam used by the provider's auth and quota requests. */
export type AutoClawFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

/** Options for one signed AutoClaw UserAPI request. */
export interface AutoClawUserApiOptions {
  readonly method?: "GET" | "POST";
  readonly body?: Readonly<Record<string, unknown>>;
  readonly signal?: AbortSignal;
  readonly fetcher?: AutoClawFetch;
}

function bearerToken(token: string): string {
  const normalized = token.trim();
  if (normalized.length === 0) throw new Error("AutoClaw access token is required");
  return normalized.toLowerCase().startsWith("bearer ") ? normalized : `Bearer ${normalized}`;
}

function userApiSignature(timestamp: string): string {
  return createHash("md5")
    .update(`${AUTOCLAW_APP_ID}&${timestamp}&${AUTOCLAW_APP_SIGNING_KEY}`)
    .digest("hex");
}

/** Builds the signed web-client headers used by AutoClaw's UserAPI endpoints. */
export function buildAutoClawUserApiHeaders(accessToken: string): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  return {
    accept: "application/json",
    "content-type": "application/json",
    "x-version": AUTOCLAW_USER_API_VERSION,
    "x-tm": "web",
    "x-product": "autoclaw",
    "x-client-type": "web",
    "x-channel": "official",
    "x-auth-appid": AUTOCLAW_APP_ID,
    "x-auth-timestamp": timestamp,
    "x-auth-sign": userApiSignature(timestamp),
    "x-trace-id": randomUUID(),
    "x-lang": "en",
    authorization: bearerToken(accessToken),
  };
}

/** Builds the desktop-client headers required by the chat-completions route. */
export function buildAutoClawChatHeaders(
  accessToken: string,
  modelId: string,
): Record<string, string> {
  const token = bearerToken(accessToken);
  return {
    accept: "application/json, text/plain, */*",
    authorization: token,
    "x-authorization": token,
    "x-request-model": modelId,
    "x-tm": "mac",
    "x-version": AUTOCLAW_CLIENT_VERSION,
    "x-product": "autoclaw",
    "x-channel": "official",
    "x-lang": "zh-CN",
    "x-client-type": "pc",
    "x-trace-id": randomUUID(),
    x_trace_id: "autoclaw-cartethyia",
    "user-agent": `AutoClaw/${AUTOCLAW_CLIENT_VERSION}`,
  };
}

/** Sends one signed UserAPI request and returns its validated business payload. */
export async function fetchAutoClawUserApi(
  path: string,
  accessToken: string,
  options: AutoClawUserApiOptions = {},
): Promise<unknown> {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new Error("AutoClaw UserAPI path must be origin-relative");
  }
  const url = new URL(path, AUTOCLAW_CN_BASE_URL);
  if (url.origin !== AUTOCLAW_CN_BASE_URL) {
    throw new Error("AutoClaw UserAPI path escaped the configured origin");
  }
  const signal = options.signal === undefined
    ? AbortSignal.timeout(USER_API_TIMEOUT_MS)
    : AbortSignal.any([options.signal, AbortSignal.timeout(USER_API_TIMEOUT_MS)]);
  const response = await (options.fetcher ?? globalThis.fetch)(url, {
    method: options.method ?? "GET",
    headers: buildAutoClawUserApiHeaders(accessToken),
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    signal,
  });
  const raw = await response.text();
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new Error(`AutoClaw UserAPI returned a non-JSON response (HTTP ${response.status})`);
  }
  const envelope = objectRecord(decoded);
  if (!response.ok) {
    throw new Error(`AutoClaw UserAPI returned HTTP ${response.status}`);
  }
  if (envelope === null) {
    throw new Error("AutoClaw UserAPI returned an invalid response envelope");
  }
  const code = typeof envelope["code"] === "number" ? envelope["code"] : Number(envelope["code"]);
  if (code !== 0) {
    if (code === 410000) throw new Error("invalid_token");
    throw new Error(`AutoClaw UserAPI rejected the request (code ${Number.isFinite(code) ? code : "unknown"})`);
  }
  if (!Object.hasOwn(envelope, "data")) {
    throw new Error("AutoClaw UserAPI response is missing data");
  }
  return envelope["data"];
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
