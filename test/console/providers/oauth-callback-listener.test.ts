import { describe, expect, test } from "bun:test";
import {
  OAuthCallbackListener,
  loopbackCallbackEndpoint,
} from "../../../src/console/providers/oauth/callback-listener";

/**
 * Every browser OAuth client here advertises a *loopback* redirect URI —
 * `localhost:1455` for Codex, `127.0.0.1:54549` for OpenRouter — which names the
 * machine the operator's browser is on. Advertising that URI without binding the
 * port left the browser on a dead page and stranded the code in the address bar,
 * which is why every browser login needed the redirect pasted back by hand.
 *
 * These tests exercise the listener that closes that gap. They drive it through
 * an injected `serve` rather than a real socket: the point is that the port is
 * claimed on register, answers the redirect, and is released afterwards, none of
 * which needs a live port to observe.
 */

interface Bind {
  readonly hostname: string;
  readonly port: number;
  readonly fetch: (request: Request) => Response | Promise<Response>;
}

/** A fake `Bun.serve` that records binds and can deliver a request to them. */
function fakeServe(): {
  binds: Bind[];
  serve: (options: Bind) => { port: number; stop: () => void };
  stopped: number[];
  deliver: (port: number, url: string) => Promise<Response>;
} {
  const binds: Bind[] = [];
  const stopped: number[] = [];
  return {
    binds,
    stopped,
    serve: (options) => {
      binds.push(options);
      return { port: options.port, stop: () => stopped.push(options.port) };
    },
    deliver: async (port, url) => {
      const bind = binds.find((candidate) => candidate.port === port);
      if (bind === undefined) throw new Error(`no listener on port ${port}`);
      return await bind.fetch(new Request(url));
    },
  };
}

function listenerWith(
  complete: (providerId: string, code: string, state: string) => Promise<{ ok: boolean; message: string }>,
) {
  const server = fakeServe();
  const listener = new OAuthCallbackListener({
    completer: { complete },
    serve: server.serve,
    ttlMs: 60_000,
  });
  return { listener, ...server };
}

const LOOPBACK = "http://127.0.0.1:54549/callback";

describe("loopbackCallbackEndpoint", () => {
  test("resolves the port and path a loopback HTTP redirect names", () => {
    expect(loopbackCallbackEndpoint(LOOPBACK)).toEqual({ port: 54549, path: "/callback" });
    expect(loopbackCallbackEndpoint("http://localhost:1455/auth/callback")).toEqual({
      port: 1455,
      path: "/auth/callback",
    });
    expect(loopbackCallbackEndpoint("http://[::1]:8080/cb")).toEqual({ port: 8080, path: "/cb" });
  });

  test("declines redirects this process cannot serve", () => {
    // A custom scheme is handed to the installed app by the OS, and a remote
    // host is delivered over the network; binding either is impossible, so the
    // caller keeps the manual path.
    expect(loopbackCallbackEndpoint("zcode://zai-auth/callback")).toBeUndefined();
    expect(loopbackCallbackEndpoint("https://example.com/callback")).toBeUndefined();
    expect(loopbackCallbackEndpoint("not a url")).toBeUndefined();
  });
});

describe("OAuthCallbackListener", () => {
  test("binds the advertised loopback port so the redirect delivers itself", async () => {
    const { listener, binds, deliver } = listenerWith(async () => ({ ok: true, message: "done" }));
    expect(listener.register(LOOPBACK, "openrouter", "state-1")).toBe(true);

    const ports = binds.map((bind) => bind.port);
    expect(ports).toContain(54549);
    // Both loopback families, so whichever one the browser resolves is served.
    expect(binds.map((bind) => bind.hostname)).toEqual(["127.0.0.1", "::1"]);

    const response = await deliver(54549, `${LOOPBACK}?code=abc&state=state-1`);
    expect(await response.text()).toContain("completed");
  });

  test("completes the flow with the code and state the redirect carried", async () => {
    const seen: { providerId: string; code: string; state: string }[] = [];
    const { listener, deliver } = listenerWith(async (providerId, code, state) => {
      seen.push({ providerId, code, state });
      return { ok: true, message: "done" };
    });
    listener.register(LOOPBACK, "openrouter", "state-1");
    await deliver(54549, `${LOOPBACK}?code=the-code&state=state-1`);
    expect(seen).toEqual([{ providerId: "openrouter", code: "the-code", state: "state-1" }]);
  });

  test("a second delivery of the same state cannot spend the code twice", async () => {
    let calls = 0;
    const { listener, deliver } = listenerWith(async () => {
      calls += 1;
      return { ok: true, message: "done" };
    });
    listener.register(LOOPBACK, "openrouter", "state-1");
    await deliver(54549, `${LOOPBACK}?code=abc&state=state-1`);
    const replay = await deliver(54549, `${LOOPBACK}?code=abc&state=state-1`);
    expect(calls).toBe(1);
    expect(replay.status).toBe(400);
  });

  test("an unknown state is refused rather than completed", async () => {
    const { listener, deliver } = listenerWith(async () => ({ ok: true, message: "done" }));
    listener.register(LOOPBACK, "openrouter", "state-1");
    const response = await deliver(54549, `${LOOPBACK}?code=abc&state=forged`);
    expect(response.status).toBe(400);
  });

  test("a state-less redirect is matched to the one flow waiting on that port", async () => {
    // OpenRouter does not echo `state` at all. Only this listener's port got the
    // redirect, and one browser login per port is in flight, so the waiting flow
    // is the one it belongs to.
    const seen: string[] = [];
    const { listener, deliver } = listenerWith(async (providerId) => {
      seen.push(providerId);
      return { ok: true, message: "done" };
    });
    listener.register(LOOPBACK, "openrouter", "state-1");
    const response = await deliver(54549, `${LOOPBACK}?code=abc`);
    expect(await response.text()).toContain("completed");
    expect(seen).toEqual(["openrouter"]);
  });

  test("releases the port once the flow settles, so it is not held open", async () => {
    const { listener, deliver, stopped } = listenerWith(async () => ({ ok: true, message: "done" }));
    listener.register(LOOPBACK, "openrouter", "state-1");
    expect(stopped).toEqual([]);
    await deliver(54549, `${LOOPBACK}?code=abc&state=state-1`);
    expect(stopped).toEqual([54549, 54549]);
  });

  test("a port shared by two flows stays bound until the last one settles", async () => {
    const { listener, deliver, stopped } = listenerWith(async () => ({ ok: true, message: "done" }));
    listener.register(LOOPBACK, "openrouter", "state-1");
    listener.register(LOOPBACK, "openrouter", "state-2");
    await deliver(54549, `${LOOPBACK}?code=a&state=state-1`);
    expect(stopped).toEqual([]);
    await deliver(54549, `${LOOPBACK}?code=b&state=state-2`);
    expect(stopped).toEqual([54549, 54549]);
  });

  test("a failing completion is reported in the browser, not swallowed", async () => {
    const { listener, deliver } = listenerWith(async () => ({
      ok: false,
      message: "token exchange failed",
    }));
    listener.register(LOOPBACK, "openrouter", "state-1");
    const response = await deliver(54549, `${LOOPBACK}?code=abc&state=state-1`);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("token exchange failed");
  });

  test("a provider denial is surfaced and does not complete the flow", async () => {
    let calls = 0;
    const { listener, deliver } = listenerWith(async () => {
      calls += 1;
      return { ok: true, message: "done" };
    });
    listener.register(LOOPBACK, "openrouter", "state-1");
    const response = await deliver(54549, `${LOOPBACK}?error=access_denied&state=state-1`);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("access_denied");
    expect(calls).toBe(0);
  });

  test("declines to register a redirect it cannot serve, without binding", () => {
    const { listener, binds } = listenerWith(async () => ({ ok: true, message: "done" }));
    expect(listener.register("zcode://zai-auth/callback", "zcode", "state-1")).toBe(false);
    expect(listener.register("https://example.com/callback", "devin", "state-1")).toBe(false);
    expect(binds).toEqual([]);
  });

  test("an unbindable port fails the login instead of advertising a dead address", () => {
    const listener = new OAuthCallbackListener({
      completer: { complete: async () => ({ ok: true, message: "done" }) },
      serve: () => {
        throw new Error("EADDRINUSE");
      },
    });
    expect(() => listener.register(LOOPBACK, "openrouter", "state-1")).toThrow(/port 54549 is in use/);
  });

  test("stop() releases every bound port", () => {
    const { listener, stopped } = listenerWith(async () => ({ ok: true, message: "done" }));
    listener.register(LOOPBACK, "openrouter", "state-1");
    listener.stop();
    expect(stopped).toEqual([54549, 54549]);
  });
});
