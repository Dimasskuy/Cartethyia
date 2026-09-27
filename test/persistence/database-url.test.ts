import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { requireDatabaseUrl } from "../../src/persistence/postgres";

/**
 * `requireDatabaseUrl` reads the process environment, so every case here sets
 * and restores the keys it touches. An emptied variable is not the same as an
 * absent one: a `${{ Service.VAR }}` reference to a misspelled service name
 * resolves to `""`, and that is the failure this resolution order exists for.
 */
const KEYS = [
  "DATABASE_URL",
  "DATABASE_PRIVATE_URL",
  "DATABASE_PUBLIC_URL",
  "PGHOST",
  "PGPORT",
  "PGUSER",
  "PGPASSWORD",
  "PGDATABASE",
] as const;

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const key of KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("requireDatabaseUrl source resolution", () => {
  test("prefers DATABASE_URL over every alternative", () => {
    process.env.DATABASE_URL = "postgres://u:p@primary:5432/db";
    process.env.DATABASE_PRIVATE_URL = "postgres://u:p@private:5432/db";
    process.env.DATABASE_PUBLIC_URL = "postgres://u:p@public:5432/db";
    process.env.PGHOST = "libpq";
    process.env.PGPORT = "5432";
    expect(requireDatabaseUrl()).toBe("postgres://u:p@primary:5432/db");
  });

  test("falls through an empty DATABASE_URL to the next published name", () => {
    // An unresolved platform reference yields "" rather than throwing, so the
    // empty case has to be treated as absent or the boot fails on a value the
    // operator cannot see in the variable list.
    process.env.DATABASE_URL = "";
    process.env.DATABASE_PRIVATE_URL = "postgres://u:p@private:5432/db";
    expect(requireDatabaseUrl()).toBe("postgres://u:p@private:5432/db");

    process.env.DATABASE_PRIVATE_URL = "   ";
    process.env.DATABASE_PUBLIC_URL = "postgres://u:p@public:5432/db";
    expect(requireDatabaseUrl()).toBe("postgres://u:p@public:5432/db");
  });

  test("assembles a URL from the libpq variables when no URL is published", () => {
    process.env.PGHOST = "postgres.railway.internal";
    process.env.PGPORT = "5432";
    process.env.PGUSER = "postgres";
    process.env.PGPASSWORD = "s3cret";
    process.env.PGDATABASE = "railway";
    expect(requireDatabaseUrl()).toBe("postgres://postgres:s3cret@postgres.railway.internal:5432/railway");
  });

  test("percent-encodes libpq credentials so a password cannot reshape the URL", () => {
    process.env.PGHOST = "db.internal";
    process.env.PGPORT = "5432";
    process.env.PGUSER = "user@tenant";
    // A literal `@` or `/` here would move the authority boundary and silently
    // point the pool at a different host.
    process.env.PGPASSWORD = "p@ss/w:rd";
    process.env.PGDATABASE = "app db";
    expect(requireDatabaseUrl()).toBe(
      "postgres://user%40tenant:p%40ss%2Fw%3Ard@db.internal:5432/app%20db",
    );
  });

  test("allows a passwordless role and an omitted database", () => {
    process.env.PGHOST = "db.internal";
    process.env.PGPORT = "5432";
    process.env.PGUSER = "postgres";
    expect(requireDatabaseUrl()).toBe("postgres://postgres@db.internal:5432");

    process.env.PGPASSWORD = "";
    expect(requireDatabaseUrl()).toBe("postgres://postgres@db.internal:5432");
  });

  test("brackets an IPv6 libpq host so it is not read as host:port", () => {
    process.env.PGHOST = "fd12:3456:789a::1";
    process.env.PGPORT = "5432";
    process.env.PGUSER = "postgres";
    expect(requireDatabaseUrl()).toBe("postgres://postgres@[fd12:3456:789a::1]:5432");
  });

  test("requires the libpq set to be complete before assembling anything", () => {
    process.env.PGHOST = "db.internal";
    expect(() => requireDatabaseUrl()).toThrow(/No Postgres connection string is configured/);

    process.env.PGPORT = "5432";
    expect(requireDatabaseUrl()).toBe("postgres://db.internal:5432");
  });

  test("names the sources an operator can set when nothing is configured", () => {
    let message = "";
    try {
      requireDatabaseUrl();
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("DATABASE_URL");
    expect(message).toContain("PGHOST");
    expect(message).toContain("PGPASSWORD");
    // The misdiagnosis this message exists to prevent.
    expect(message).toContain("resolves to an empty string");
  });

  test("still rejects a malformed or incomplete URL and names the source it came from", () => {
    process.env.DATABASE_URL = "not-a-url";
    expect(() => requireDatabaseUrl()).toThrow(/DATABASE_URL is not a valid URL/);

    process.env.DATABASE_URL = "postgres://user:pass@host-without-port/db";
    expect(() => requireDatabaseUrl()).toThrow(/DATABASE_URL must include explicit host and port/);

    delete process.env.DATABASE_URL;
    process.env.PGHOST = "db.internal";
    process.env.PGPORT = "5432";
    process.env.PGDATABASE = "app";
    // The assembled source is reported, not always "DATABASE_URL".
    process.env.DATABASE_PUBLIC_URL = "postgres://user:pass@no-port/db";
    expect(() => requireDatabaseUrl()).toThrow(/DATABASE_PUBLIC_URL must include explicit host and port/);
  });
});
