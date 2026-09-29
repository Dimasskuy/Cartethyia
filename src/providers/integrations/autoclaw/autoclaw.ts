import { GatewayError } from "../../../transport/gateway-error";
import type { CanonicalEvent, CanonicalRequest } from "../../../transport/canonical-model";
import type {
  ProviderAdapter,
  ProviderDispatchContext,
  ProviderDispatchTarget,
  ModelDefinition,
} from "../../provider-registry";
import { defineModel } from "../../model-definition";
import { providerBaseUrl } from "../../provider-metadata";
import { OpenAICompatibleAdapter, withBearerAuthentication } from "../../compatible-adapter";
import {
  AUTOCLAW_CHAT_COMPLETIONS_PATH,
  buildAutoClawChatHeaders,
  fetchAutoClawUserApi,
} from "./autoclaw-shared";

export const AUTOCLAW_PROVIDER_ID = "autoclaw" as const;
export const AUTOCLAW_ENDPOINT_PATHS = { chat: AUTOCLAW_CHAT_COMPLETIONS_PATH } as const;
const SANDBOX_LIST_PATH = "/agentdr/v2/assistant/sandbox/list";

/** Model IDs advertised by the current CN AutoClaw bridge. */
export const AUTOCLAW_MODELS: readonly ModelDefinition[] = [
  defineModel({ id: "openclaw", wireFamily: "chat", endpoint: AUTOCLAW_CHAT_COMPLETIONS_PATH }),
  defineModel({ id: "openclaw/default", wireFamily: "chat", endpoint: AUTOCLAW_CHAT_COMPLETIONS_PATH }),
  defineModel({ id: "glm-5.3-flash", wireFamily: "chat", endpoint: AUTOCLAW_CHAT_COMPLETIONS_PATH }),
  defineModel({ id: "glm-5.2", wireFamily: "chat", endpoint: AUTOCLAW_CHAT_COMPLETIONS_PATH }),
  defineModel({ id: "zai_auto", wireFamily: "chat", endpoint: AUTOCLAW_CHAT_COMPLETIONS_PATH }),
  defineModel({ id: "zai_auto-fast", wireFamily: "chat", endpoint: AUTOCLAW_CHAT_COMPLETIONS_PATH }),
  defineModel({ id: "zai_glm-5.3-flash", wireFamily: "chat", endpoint: AUTOCLAW_CHAT_COMPLETIONS_PATH }),
  defineModel({ id: "zaicoding_glm-5.3", wireFamily: "chat", endpoint: AUTOCLAW_CHAT_COMPLETIONS_PATH }),
  defineModel({ id: "tdpsk_deepseek-v4-flash-202605", wireFamily: "chat", endpoint: AUTOCLAW_CHAT_COMPLETIONS_PATH }),
  defineModel({ id: "tdpsk_deepseek-v4-pro-202606", wireFamily: "chat", endpoint: AUTOCLAW_CHAT_COMPLETIONS_PATH }),
];

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function accessToken(context: ProviderDispatchContext): string {
  const secret = context.credential.secret;
  const token = secret ? new TextDecoder().decode(secret).trim() : "";
  if (!token) throw new GatewayError("authentication_failed", 401, "AutoClaw access token is missing");
  if (context.credential.auth_state?.["region"] !== "cn") {
    throw new GatewayError("authentication_failed", 401, "AutoClaw account is not configured for the CN region");
  }
  return token;
}

function sandboxEndpoint(value: unknown): { readonly endpoint: URL; readonly sandboxId: string } {
  const root = asRecord(value);
  const topData = root?.["data"];
  const data = asRecord(topData);
  const sandboxes = Array.isArray(value)
    ? value
    : Array.isArray(topData)
      ? topData
      : data?.["sandbox_list"] ?? root?.["sandbox_list"];
  const sandbox = Array.isArray(sandboxes)
    ? sandboxes
        .map(asRecord)
        .filter((item): item is Record<string, unknown> => item !== null)
        .find((item) => {
          const expiresAt = item["end_timestamp"];
          return typeof expiresAt !== "number" || expiresAt === 0 || expiresAt > Date.now();
        })
    : null;
  const id = sandbox?.["sandbox_id"];
  const rawEndpoint = sandbox?.["sandbox_endpoint"];
  if (typeof id !== "string" || !id.trim() || typeof rawEndpoint !== "string" || !rawEndpoint.trim()) {
    throw new GatewayError("transport_unavailable", 502, "AutoClaw has no usable CN sandbox");
  }
  let endpoint: URL;
  try {
    endpoint = new URL(rawEndpoint.trim());
  } catch {
    throw new GatewayError("transport_unavailable", 502, "AutoClaw returned an invalid CN sandbox endpoint");
  }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.hash) {
    throw new GatewayError("transport_unavailable", 502, "AutoClaw returned an unsafe CN sandbox endpoint");
  }
  const marker = endpoint.pathname.indexOf("/autoclaw-cloud");
  endpoint.pathname = marker >= 0
    ? endpoint.pathname.slice(0, marker + "/autoclaw-cloud".length)
    : `${endpoint.pathname.replace(/\/+$/, "")}/autoclaw-cloud`;
  endpoint.search = "";
  endpoint.hash = "";
  endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, "")}/proxy/${encodeURIComponent(id.trim())}`;
  return { endpoint, sandboxId: id.trim() };
}


interface RelayMessage {
  readonly sessionKey: string;
  readonly message: string;
  readonly thinking?: string;
}

function relayRequestBody(request: CanonicalRequest): RelayMessage {
  const lastUser = [...request.messages].reverse().find((message) => message.role === "user");
  if (!lastUser) throw new GatewayError("invalid_request", 400, "AutoClaw relay requires a user message");
  const text = typeof lastUser.content === "string"
    ? lastUser.content
    : lastUser.content.map((part) => part.kind === "text" ? part.text : "").filter(Boolean).join("\n");
  if (!text.trim()) throw new GatewayError("invalid_request", 400, "AutoClaw relay requires a user text message");
  const thinking = request.reasoning?.effort;
  return {
    sessionKey: request.session_id?.trim() || "main",
    message: text,
    ...(thinking ? { thinking } : {}),
  };
}

function relayHeaders(token: string, modelId: string): Record<string, string> {
  return {
    accept: "application/json, text/plain, */*",
    "content-type": "application/json",
    authorization: token.toLowerCase().startsWith("bearer ") ? token : `Bearer ${token}`,
    "x-openclaw-model": modelId,
  };
}

async function* relayEvents(
  context: ProviderDispatchContext,
  request: CanonicalRequest,
  candidate: ProviderDispatchTarget,
): AsyncIterable<CanonicalEvent> {
  const token = accessToken(context);
  const websocket = context.outbound_websocket;
  const fetcher = context.outbound_fetch;
  if (!websocket || !fetcher) {
    throw new GatewayError("transport_unavailable", 503, "AutoClaw relay requires validated HTTP and WebSocket networking");
  }
  const { endpoint, sandboxId } = sandboxEndpoint(await fetchAutoClawUserApi(SANDBOX_LIST_PATH, token, {
    signal: context.abort_signal,
    fetcher,
  }));
  const access = token.toLowerCase().startsWith("bearer ") ? token.slice(7).trim() : token;
  const bareEndpoint = new URL(endpoint.toString());
  bareEndpoint.pathname = bareEndpoint.pathname.replace(/\/proxy\/[^/]+$/, "");
  const deviceUrl = new URL(bareEndpoint.toString());
  deviceUrl.protocol = "wss:";
  deviceUrl.pathname = `${bareEndpoint.pathname.replace(/\/+$/, "")}/v1/client/ws`;
  deviceUrl.searchParams.set("device_id", sandboxId);
  deviceUrl.searchParams.set("access_token", access);
  const device = await websocket(deviceUrl, { "user-agent": "AutoClaw/1.18.5" }, context.abort_signal);
  let eventsResponse: Response | undefined;
  try {
    device.send(JSON.stringify({
      type: "auth.inject",
      token: access,
      ...(typeof context.credential.auth_state?.["userId"] === "string" ? { userId: context.credential.auth_state["userId"] } : {}),
      ...(typeof context.credential.auth_state?.["userName"] === "string" ? { userName: context.credential.auth_state["userName"] } : {}),
      clientMetadata: { client_type: "web" },
    }));
    const deadline = Date.now() + 25_000;
    let authenticated = false;
    while (!authenticated && Date.now() < deadline) {
      const raw = await device.receive(context.abort_signal);
      let decoded: unknown;
      try {
        decoded = JSON.parse(raw);
      } catch {
        continue;
      }
      const frame = asRecord(decoded);
      if (frame?.["type"] === "auth.inject.ok") authenticated = true;
      else if (frame?.["type"] === "auth.inject.error") {
        throw new GatewayError("authentication_failed", 401, "AutoClaw sandbox rejected authentication");
      }
    }
    if (!authenticated) throw new GatewayError("authentication_failed", 401, "AutoClaw sandbox authentication timed out");

    const proxyBase = new URL(endpoint.toString());
    const fetcher = context.outbound_fetch;
    const authorization = access.toLowerCase().startsWith("bearer ") ? access : `Bearer ${access}`;
    eventsResponse = await fetcher(new URL(`${proxyBase.pathname.replace(/\/+$/, "")}/api/events`, proxyBase), {
      headers: { accept: "text/event-stream", authorization },
      signal: context.abort_signal,
    });
    if (!eventsResponse.ok || !eventsResponse.body) {
      throw new GatewayError("transport_unavailable", 502, `AutoClaw relay events returned HTTP ${eventsResponse.status}`);
    }
    const requestBody = relayRequestBody(request);
    const sendResponse = await fetcher(new URL(`${proxyBase.pathname.replace(/\/+$/, "")}/api/electron/agent/send`, proxyBase), {
      method: "POST",
      headers: relayHeaders(token, candidate.model_id),
      body: JSON.stringify({ args: [{ ...requestBody, model: "openclaw" }] }),
      signal: context.abort_signal,
    });
    if (!sendResponse.ok) throw new GatewayError("transport_unavailable", 502, `AutoClaw relay send returned HTTP ${sendResponse.status}`);
    const sendRoot = asRecord(await sendResponse.json());
    const sendData = asRecord(sendRoot?.["data"]);
    if (sendRoot?.["ok"] === false || (sendRoot?.["code"] !== undefined && sendRoot["code"] !== 0)) {
      throw new GatewayError("transport_unavailable", 502, "AutoClaw relay rejected the send request");
    }
    const runValue = sendData?.["runId"] ?? sendData?.["run_id"] ?? sendRoot?.["data"];
    const runId = typeof runValue === "string" ? runValue : "";
    const responseId = `chatcmpl-${crypto.randomUUID()}`;
    let sequence = 0;
    let lastText = "";
    let terminal = false;
    const reader = eventsResponse.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const nextSequence = (): number => ++sequence;
    try {
      while (!terminal) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const frameText = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const dataLine = frameText.split(/\r?\n/).find((line) => line.startsWith("data:"));
          if (dataLine) {
            let decoded: unknown;
            try {
              decoded = JSON.parse(dataLine.slice(5).trim());
            } catch {
              decoded = undefined;
            }
            const envelope = asRecord(decoded);
            const payload = asRecord(envelope?.["payload"]);
            if (payload && !terminal) {
              const frameRunId = payload["runId"] ?? payload["run_id"];
              const frameSession = payload["sessionKey"] ?? payload["to"];
              const sameRun = runId.length > 0 && frameRunId === runId;
              const sameSession = frameSession === requestBody.sessionKey || frameSession === `agent:main:${requestBody.sessionKey}`;
              if (sameRun || (!runId && sameSession)) {
                const kind = payload["type"];
                if (kind === "text") {
                  const snapshot = payload["delta"] ?? payload["text"];
                  if (typeof snapshot === "string" && snapshot.length > 0) {
                    const delta = snapshot.startsWith(lastText) ? snapshot.slice(lastText.length) : snapshot;
                    lastText = snapshot;
                    if (delta) yield {
                      type: "content_delta",
                      sequence_number: nextSequence(),
                      content: { kind: "text", text: delta },
                      response_id: responseId,
                    };
                  }
                } else if (kind === "thinking") {
                  const thinking = payload["text"] ?? payload["delta"];
                  if (typeof thinking === "string" && thinking.length > 0) yield {
                    type: "content_delta",
                    sequence_number: nextSequence(),
                    content: { kind: "reasoning", payload: null, summary: thinking },
                    response_id: responseId,
                  };
                } else if (kind === "tool_call" || kind === "tool_use") {
                  const name = payload["name"] ?? payload["tool"];
                  if (typeof name === "string" && name.length > 0) {
                    const id = payload["id"];
                    const input = payload["input"] ?? payload["arguments"];
                    yield {
                      type: "tool_call_delta",
                      sequence_number: nextSequence(),
                      call_id: typeof id === "string" ? id : `${name}-${sequence}`,
                      name,
                      arguments_delta: input === undefined ? "{}" : JSON.stringify(input),
                      response_id: responseId,
                    };
                  }
                } else if (kind === "done") {
                  yield {
                    type: "terminal",
                    sequence_number: nextSequence(),
                    state: "complete",
                    stop_reason: "stop",
                    response_id: responseId,
                  };
                  terminal = true;
                } else if (kind === "error") {
                  yield {
                    type: "error",
                    sequence_number: nextSequence(),
                    category: "upstream_error",
                    message: "AutoClaw relay generation failed",
                    response_id: responseId,
                  };
                  yield {
                    type: "terminal",
                    sequence_number: nextSequence(),
                    state: "failed",
                    response_id: responseId,
                  };
                  terminal = true;
                }
              }
            }
          }
          boundary = buffer.indexOf("\n\n");
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    if (!terminal) yield {
      type: "terminal",
      sequence_number: nextSequence(),
      state: "complete",
      stop_reason: "stop",
      response_id: responseId,
    };
  } finally {
    await eventsResponse?.body?.cancel().catch(() => undefined);
    device.close();
  }
}

class AutoClawAdapter implements ProviderAdapter {
  readonly provider_id = AUTOCLAW_PROVIDER_ID;
  readonly #chat: OpenAICompatibleAdapter;

  constructor(fetchImpl?: typeof fetch) {
    this.#chat = new OpenAICompatibleAdapter(withBearerAuthentication({
      provider_id: AUTOCLAW_PROVIDER_ID,
      base_url: providerBaseUrl(AUTOCLAW_PROVIDER_ID),
      endpoint_paths_by_wire_family: AUTOCLAW_ENDPOINT_PATHS,
      credential_forwarding: "never",
      buildExtraHeaders: (context, _request, candidate) =>
        buildAutoClawChatHeaders(accessToken(context), candidate?.model_id ?? ""),
      ...(fetchImpl === undefined ? {} : { fetchImpl }),
    }));
  }

  async *dispatch(
    request: CanonicalRequest,
    candidate: ProviderDispatchTarget,
    context: ProviderDispatchContext,
  ): AsyncIterable<CanonicalEvent> {
    let emitted = false;
    try {
      for await (const event of this.#chat.dispatch(request, candidate, context)) {
        emitted = true;
        yield event;
      }
      return;
    } catch (error) {
      const canUseSandboxFallback =
        error instanceof GatewayError &&
        (error.code === "upstream_not_found" || error.status === 406 || error.status === 501 || error.status >= 500);
      if (emitted || !canUseSandboxFallback || context.abort_signal.aborted) {
        throw error;
      }
    }
    if (!context.outbound_websocket || !context.outbound_fetch) {
      throw new GatewayError("transport_unavailable", 503, "AutoClaw relay egress is unavailable");
    }
    if (request.tools && request.tools.length > 0) {
      throw new GatewayError(
        "capability_unsupported",
        400,
        "AutoClaw relay fallback cannot preserve caller tool declarations",
      );
    }
    yield* relayEvents(context, request, candidate);
  }
}

/** Creates an AutoClaw adapter with direct Chat Completions and validated CN relay fallback. */
export function createAutoClawAdapter(fetchImpl?: typeof fetch): ProviderAdapter {
  return new AutoClawAdapter(fetchImpl);
}
