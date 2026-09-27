import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractPayloadFileReference,
  isPayloadFileReference,
  prunePayloadFrames,
  readPayloadFrame,
  writePayloadFrame,
} from "../../src/observability/payload-store";
import {
  reportCaptureFailure,
  resetCaptureFailureReportForTests,
} from "../../src/transport/dispatch/attempt-finalize";
import { getConsoleLogSnapshot, resetConsoleLogsForTests } from "../../src/observability/log-ring";

const originalDirectory = process.env.CARTETHYIA_TELEMETRY_PAYLOAD_DIR;
let directory: string | undefined;

afterEach(async () => {
  if (originalDirectory === undefined) delete process.env.CARTETHYIA_TELEMETRY_PAYLOAD_DIR;
  else process.env.CARTETHYIA_TELEMETRY_PAYLOAD_DIR = originalDirectory;
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe(".jsonb telemetry payload storage", () => {
  test("writes and reads a framed payload without PostgreSQL body storage", async () => {
    directory = await mkdtemp(join(tmpdir(), "cartethyia-payload-") );
    process.env.CARTETHYIA_TELEMETRY_PAYLOAD_DIR = directory;
    const expiresAt = new Date(Date.now() + 60_000);
    const reference = await writePayloadFrame({ request: "hello" }, expiresAt);

    expect(isPayloadFileReference(reference)).toBe(true);
    await expect(readPayloadFrame(reference)).resolves.toEqual({ request: "hello" });
  });

  test("unwraps the wrapped row shape the writer stores", async () => {
    directory = await mkdtemp(join(tmpdir(), "cartethyia-payload-") );
    process.env.CARTETHYIA_TELEMETRY_PAYLOAD_DIR = directory;
    const reference = await writePayloadFrame({ request: "hello" }, new Date(Date.now() + 60_000));

    // `TelemetryPayloadCapture.capture` wraps the reference as
    // `{ _payload_ref: ... }`; a failed unwrap leaks that raw JSON to the
    // drawer instead of the captured body.
    expect(extractPayloadFileReference({ _payload_ref: reference })).toEqual(reference);
    expect(extractPayloadFileReference(reference)).toEqual(reference);
    expect(extractPayloadFileReference({ request: "hello" })).toBeUndefined();
  });

  test("prunes expired framed payload files", async () => {
    directory = await mkdtemp(join(tmpdir(), "cartethyia-payload-") );
    process.env.CARTETHYIA_TELEMETRY_PAYLOAD_DIR = directory;
    await writePayloadFrame({ request: "expired" }, new Date(Date.now() - 1_000));

    await expect(prunePayloadFrames(new Date())).resolves.toBe(1);
  });
});

describe("payload capture failure is reported, not swallowed", () => {
  test("a write failure surfaces a warning naming the directory and the fix", async () => {
    // Regression: capture used to swallow every error, so an operator with the
    // switch visibly On saw no bodies and no reason. The usual cause is a
    // bind-mounted data directory owned by root while the container runs
    // unprivileged, so the message must name the directory and the remedy.
    resetCaptureFailureReportForTests();
    resetConsoleLogsForTests();
    directory = await mkdtemp(join(tmpdir(), "cartethyia-payload-"));
    // A path whose parent is a *file* cannot be created, so the write fails
    // for real rather than by mocking the store.
    const blockingFile = join(directory, "not-a-directory");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(blockingFile, "x", "utf8");
    const missingDirectory = join(blockingFile, "nested");
    process.env.CARTETHYIA_TELEMETRY_PAYLOAD_DIR = missingDirectory;

    const failure = await writePayloadFrame({ request: "hello" }, new Date()).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    // The failure must be reported through the console ring the operator sees.
    reportCaptureFailure(failure);
    const warning = getConsoleLogSnapshot().find((line) =>
      line.msg.includes("payload capture is enabled"),
    );
    expect(warning).toBeDefined();
    expect(warning?.msg).toContain(missingDirectory);
  });

  test("reports once per process so a broken directory cannot flood the log", () => {
    resetCaptureFailureReportForTests();
    resetConsoleLogsForTests();
    reportCaptureFailure(new Error("EACCES"));
    reportCaptureFailure(new Error("EACCES"));
    reportCaptureFailure(new Error("EACCES"));
    const matches = getConsoleLogSnapshot().filter((line) =>
      line.msg.includes("payload capture is enabled"),
    );
    expect(matches).toHaveLength(1);
  });
});
