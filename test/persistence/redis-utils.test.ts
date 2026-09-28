import { afterEach, describe, expect, test } from "bun:test";
import {
  closeRedis,
  getRedis,
  getRedisOrUndefined,
  redisEvalNumber,
  setRedisForTesting,
} from "../../src/persistence/redis";

const REDIS_CONNECTION_KEYS = [
  "REDIS_URL",
  "REDIS_PUBLIC_URL",
  "REDISHOST",
  "REDISPORT",
  "REDISUSER",
  "REDISPASSWORD",
] as const;

afterEach(() => {
  globalThis.__cartethyiaRedis = undefined;
  for (const key of REDIS_CONNECTION_KEYS) delete process.env[key];
});

describe("requireRedisUrl (via getRedis)", () => {
  test("throws when no connection source is configured", () => {
    // The repo .env sets REDIS_URL for the operator; the unit boundary is
    // "no source configured", so clear every source instead of assuming the
    // ambient environment is bare.
    const saved = REDIS_CONNECTION_KEYS.map((key) => [key, process.env[key]] as const);
    for (const key of REDIS_CONNECTION_KEYS) delete process.env[key];
    try {
      expect(() => getRedis()).toThrow("No Redis connection string is configured");
      expect(getRedisOrUndefined()).toBeUndefined();
    } finally {
      for (const [key, value] of saved) {
        if (value !== undefined) process.env[key] = value;
      }
    }
  });

  test("throws on a malformed REDIS_URL", () => {
    process.env.REDIS_URL = "not-a-url";
    expect(() => getRedis()).toThrow("REDIS_URL is not a valid URL");
  });

  test("rejects a scheme that is not Redis", () => {
    process.env.REDIS_URL = "http://localhost:6379";
    expect(() => getRedis()).toThrow("REDIS_URL must use the redis: or rediss: scheme");
  });

  test("accepts a default-port REDIS_URL and still rejects a missing host", () => {
    process.env.REDIS_URL = "redis://localhost";
    expect(() => getRedis()).not.toThrow();
    closeRedis();
    process.env.REDIS_URL = "redis:///0";
    expect(() => getRedis()).toThrow("must include an explicit host");
    delete process.env.REDIS_URL;
  });

  test("falls through to the discrete variables when REDIS_URL is empty", async () => {
    // An empty value is what a `${{ Service.VAR }}` reference to a misspelled
    // service name produces; it must not be treated as a configured URL.
    process.env.REDIS_URL = "";
    process.env.REDISHOST = "127.0.0.1";
    process.env.REDISPORT = "6399";
    const client = getRedis();
    try {
      expect(client.options.host).toBe("127.0.0.1");
      expect(client.options.port).toBe(6399);
    } finally {
      globalThis.__cartethyiaRedis = undefined;
      await client.disconnect();
    }
  });

  test("keeps a password-only credential in the userinfo position", async () => {
    process.env.REDIS_URL = "";
    process.env.REDISHOST = "127.0.0.1";
    process.env.REDISPORT = "6399";
    process.env.REDISPASSWORD = "p@ss:word/1";
    const client = getRedis();
    try {
      expect(client.options.password).toBe("p@ss:word/1");
    } finally {
      globalThis.__cartethyiaRedis = undefined;
      await client.disconnect();
    }
  });
});

describe("closeRedis", () => {
  test("no-ops with no shared connection", async () => {
    await closeRedis();
  });

  test("quits and clears the shared client", async () => {
    let quitCalls = 0;
    const fake = { quit: async () => { quitCalls += 1; }, disconnect: () => {} };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setRedisForTesting(fake as any);
    await closeRedis();
    expect(quitCalls).toBe(1);
    expect(globalThis.__cartethyiaRedis).toBeUndefined();
  });

  test("falls back to disconnect when quit times out", async () => {
    let disconnectCalls = 0;
    const fake = {
      quit: async () => {
        await Bun.sleep(500);
      },
      disconnect: () => { disconnectCalls += 1; },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setRedisForTesting(fake as any);
    await closeRedis({ quitTimeoutMs: 10 });
    expect(disconnectCalls).toBe(1);
  });
});

describe("redisEvalNumber", () => {
  test("returns a finite numeric result", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fake = { eval: async () => 7 } as any;
    expect(await redisEvalNumber(fake, "script", 1, "k")).toBe(7);
  });

  test("coerces numeric strings", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fake = { eval: async () => "42" } as any;
    expect(await redisEvalNumber(fake, "script", 1, "k")).toBe(42);
  });

  test("throws on NaN or garbled results", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nan = { eval: async () => "garbage" } as any;
    await expect(redisEvalNumber(nan, "script", 1, "k")).rejects.toThrow("non-finite");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const undef = { eval: async () => undefined } as any;
    await expect(redisEvalNumber(undef, "script", 1, "k")).rejects.toThrow("non-finite");
  });
});
