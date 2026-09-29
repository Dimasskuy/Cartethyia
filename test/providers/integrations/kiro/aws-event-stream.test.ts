/**
 * AWS EventStream framing coverage.
 *
 * The decoder is the boundary between an untrusted binary stream and JSON an
 * adapter will stream to a client, so the tests pin the properties that make
 * that safe: a message is only accepted when both CRCs match, a partial message
 * is buffered rather than rejected, and a corrupt message stops the stream
 * instead of yielding plausible garbage.
 */
import { describe, expect, test } from "bun:test";
import {
  EVENTSTREAM_MAX_HEADERS_BYTES,
  EVENTSTREAM_MAX_MESSAGE_BYTES,
  crc32,
  decodeEventStreamMessages,
} from "../../../../src/providers/integrations/kiro/aws-event-stream";

/** Encodes one header value as an EventStream string header. */
function stringHeader(name: string, value: string): Buffer {
  const nameBytes = Buffer.from(name, "utf8");
  const valueBytes = Buffer.from(value, "utf8");
  const head = Buffer.alloc(1 + nameBytes.length + 1 + 2);
  head.writeUInt8(nameBytes.length, 0);
  nameBytes.copy(head, 1);
  head.writeUInt8(7, 1 + nameBytes.length);
  head.writeUInt16BE(valueBytes.length, 2 + nameBytes.length);
  return Buffer.concat([head, valueBytes]);
}

/** Encodes one whole EventStream message with correct CRCs. */
function encodeMessage(headers: Record<string, string>, payload: string | null): Buffer {
  const headerBytes = Buffer.concat(
    Object.entries(headers).map(([name, value]) => stringHeader(name, value)),
  );
  const payloadBytes = payload === null ? Buffer.alloc(0) : Buffer.from(payload, "utf8");
  const totalLength = 12 + headerBytes.length + payloadBytes.length + 4;
  const prelude = Buffer.alloc(12);
  prelude.writeUInt32BE(totalLength, 0);
  prelude.writeUInt32BE(headerBytes.length, 4);
  prelude.writeUInt32BE(crc32(prelude.subarray(0, 8)), 8);
  const body = Buffer.concat([prelude, headerBytes, payloadBytes]);
  const trailer = Buffer.alloc(4);
  trailer.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([body, trailer]);
}

describe("decodeEventStreamMessages", () => {
  test("decodes a complete message with its headers and payload", () => {
    const frame = encodeMessage(
      { ":message-type": "event", ":event-type": "assistantResponseEvent" },
      JSON.stringify({ content: "hello" }),
    );
    const result = decodeEventStreamMessages(frame);
    expect(result.failure).toBeUndefined();
    expect(result.consumed).toBe(frame.length);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.headers[":event-type"]).toBe("assistantResponseEvent");
    expect(result.messages[0]?.payload).toBe('{"content":"hello"}');
  });

  test("decodes several messages from one read and reports bytes consumed", () => {
    const first = encodeMessage({ ":event-type": "codeEvent" }, '{"content":"a"}');
    const second = encodeMessage({ ":event-type": "messageStopEvent" }, '{"stopReason":"end_turn"}');
    const result = decodeEventStreamMessages(Buffer.concat([first, second]));
    expect(result.failure).toBeUndefined();
    expect(result.messages).toHaveLength(2);
    expect(result.consumed).toBe(first.length + second.length);
  });

  test("buffers a partial trailing message instead of failing", () => {
    const frame = encodeMessage({ ":event-type": "codeEvent" }, '{"content":"a"}');
    const result = decodeEventStreamMessages(frame.subarray(0, frame.length - 3));
    expect(result.failure).toBeUndefined();
    expect(result.messages).toHaveLength(0);
    expect(result.consumed).toBe(0);
  });

  test("decodes the messages that arrived whole before a partial one", () => {
    const first = encodeMessage({ ":event-type": "codeEvent" }, '{"content":"a"}');
    const second = encodeMessage({ ":event-type": "codeEvent" }, '{"content":"b"}');
    const joined = Buffer.concat([first, second]);
    const result = decodeEventStreamMessages(joined.subarray(0, joined.length - 2));
    expect(result.messages).toHaveLength(1);
    expect(result.consumed).toBe(first.length);
  });

  test("rejects a message whose payload CRC does not match", () => {
    const frame = encodeMessage({ ":event-type": "codeEvent" }, '{"content":"a"}');
    // Flip a payload byte without recomputing the trailing CRC.
    const corrupted = Buffer.from(frame);
    corrupted[corrupted.length - 6] = corrupted[corrupted.length - 6]! ^ 0xff;
    const result = decodeEventStreamMessages(corrupted);
    expect(result.messages).toHaveLength(0);
    expect(result.failure?.reason).toBe("message_crc_mismatch");
  });

  test("rejects a message whose prelude CRC does not match", () => {
    const frame = encodeMessage({ ":event-type": "codeEvent" }, '{"content":"a"}');
    const corrupted = Buffer.from(frame);
    corrupted.writeUInt32BE(frame.readUInt32BE(8) ^ 0xffff, 8);
    const result = decodeEventStreamMessages(corrupted);
    expect(result.failure?.reason).toBe("prelude_crc_mismatch");
  });

  test("rejects a header block that does not fit in its declared message", () => {
    const frame = encodeMessage({ ":event-type": "codeEvent" }, '{"content":"a"}');
    const corrupted = Buffer.from(frame);
    corrupted.writeUInt32BE(frame.readUInt32BE(0) - 4, 4);
    const result = decodeEventStreamMessages(corrupted);
    expect(result.failure?.reason).toBe("malformed_headers");
  });

  test("rejects a message that declares more bytes than the cap allows", () => {
    const frame = encodeMessage({ ":event-type": "codeEvent" }, '{"content":"a"}');
    const corrupted = Buffer.from(frame);
    corrupted.writeUInt32BE(EVENTSTREAM_MAX_MESSAGE_BYTES + 1, 0);
    const result = decodeEventStreamMessages(corrupted);
    expect(result.failure?.reason).toBe("oversize_message");
  });

  test("rejects a header block larger than the cap", () => {
    const frame = encodeMessage({ ":event-type": "codeEvent" }, '{"content":"a"}');
    const corrupted = Buffer.from(frame);
    corrupted.writeUInt32BE(EVENTSTREAM_MAX_HEADERS_BYTES + 1, 4);
    const result = decodeEventStreamMessages(corrupted);
    expect(result.failure?.reason).toBe("oversize_headers");
  });

  test("reports a null payload for a message that carries none", () => {
    const frame = encodeMessage({ ":message-type": "event", ":event-type": "messageStopEvent" }, null);
    const result = decodeEventStreamMessages(frame);
    expect(result.messages[0]?.payload).toBeNull();
  });

  test("crc32 matches the known IEEE check value", () => {
    // The canonical CRC32 of "123456789" is 0xcbf43926.
    expect(crc32(Buffer.from("123456789", "utf8"))).toBe(0xcbf43926);
  });
});
