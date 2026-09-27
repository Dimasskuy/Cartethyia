import { describe, expect, test } from "bun:test";
import { ChatAdapter } from "../../src/transport/surface/chat/adapter";
import { ResponsesAdapter } from "../../src/transport/surface/responses/adapter";
import { MessagesAdapter } from "../../src/transport/surface/messages/adapter";
import { canonicalToClaudeMessagesPayload } from "../../src/protocol/request/messages";
import { buildGeminiPayload } from "../../src/protocol/request/gemini";
import type { CanonicalRequest } from "../../src/transport/canonical-model";

/**
 * The multimodal path an Antigravity-format client takes through this gateway.
 *
 * Such a client (an IDE or a router in front of one) speaks OpenAI Chat
 * Completions to us and its images arrive as `image_url` data URIs, because the
 * upstream format carries bytes as `inlineData` and there is no URL to point
 * at. We then select a Gemini-backed provider, whose wire needs `inlineData`
 * back. So the whole path is: data URI in → canonical image → `inlineData` out.
 *
 * Nothing pinned this end to end before, and a break anywhere in it is silent:
 * the image degrades to text and the model answers as if no attachment was
 * sent. `[image]` in a transcript is this failure, not a formatting quirk.
 */

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PDF_BASE64 = "JVBERi0xLjQK";

function chatImageMessage(dataUri: string): CanonicalRequest {
  return new ChatAdapter().parse({
    model: "gemini-3-flash",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "what is in this image?" },
          { type: "image_url", image_url: { url: dataUri } },
        ],
      },
    ],
  });
}

function geminiParts(request: CanonicalRequest): Record<string, unknown>[] {
  const payload = buildGeminiPayload(request);
  const contents = payload["contents"] as Array<{ parts: Record<string, unknown>[] }>;
  return contents.flatMap((entry) => entry.parts);
}

function inlineParts(request: CanonicalRequest): Record<string, unknown>[] {
  return geminiParts(request).filter((part) => "inlineData" in part);
}

function fileParts(request: CanonicalRequest): Record<string, unknown>[] {
  return geminiParts(request).filter((part) => "fileData" in part);
}

function userMessage(content: readonly Record<string, unknown>[]): {
  model: string;
  max_tokens: number;
  messages: Array<{ role: string; content: readonly Record<string, unknown>[] }>;
} {
  return { model: "gemini-3-flash", max_tokens: 1024, messages: [{ role: "user", content }] };
}

describe("chat data URI image reaches a Gemini wire as inlineData", () => {
  test("an image/png data URI survives the round trip byte-for-byte", () => {
    const dataUri = `data:image/png;base64,${PNG_BASE64}`;
    const parts = inlineParts(chatImageMessage(dataUri));
    expect(parts).toHaveLength(1);
    expect(parts[0]).toEqual({
      inlineData: { mimeType: "image/png", data: PNG_BASE64 },
    });
  });

  test("the media type is preserved rather than forced to image/png", () => {
    // A JPEG sent as image/png is a wire lie: the upstream may decode-fail or
    // silently mis-handle it. The caller's own media type must survive.
    for (const mimeType of ["image/jpeg", "image/webp", "image/gif"]) {
      const parts = inlineParts(
        chatImageMessage(`data:${mimeType};base64,${PNG_BASE64}`),
      );
      expect(parts[0]?.["inlineData"]).toEqual({ mimeType, data: PNG_BASE64 });
    }
  });

  test("a non-image media type in an image_url keeps its declared type", () => {
    // The upstream format maps any inline bytes to an image block, so a client
    // can send a media type we would not have guessed. Forwarding what it
    // declared is what lets the provider accept or reject it on its own terms
    // instead of us relabelling the payload.
    const parts = inlineParts(chatImageMessage(`data:application/pdf;base64,${PNG_BASE64}`));
    expect(parts[0]?.["inlineData"]).toEqual({
      mimeType: "application/pdf",
      data: PNG_BASE64,
    });
  });

  test("the base64 payload is not truncated or re-encoded", () => {
    // A large body is the case a naive parser mangles. Round-tripping it
    // exactly is the whole contract.
    const large = Buffer.alloc(512 * 1024, 7).toString("base64");
    const parts = inlineParts(chatImageMessage(`data:image/png;base64,${large}`));
    expect((parts[0]?.["inlineData"] as { data: string }).data).toBe(large);
  });

  test("a remote image URL is sent as fileData, not inlineData", () => {
    // A URL carries no bytes, so it must not be inlined as empty data.
    const request = chatImageMessage("https://example.test/cat.png");
    expect(inlineParts(request)).toHaveLength(0);
    const fileData = fileParts(request);
    expect(fileData).toHaveLength(1);
    expect(fileData[0]?.["fileData"]).toEqual({ fileUri: "https://example.test/cat.png" });
  });

  test("a remote image URL is not given a fabricated media type", () => {
    // `FileData.mimeType` is optional in the Gemini schema, and the origin
    // declared none. A hardcoded `image/png` would tell the upstream that a
    // JPEG is a PNG — a wire lie it cannot detect and may act on.
    const [part] = fileParts(chatImageMessage("https://example.test/cat.png"));
    expect(part?.["fileData"]).not.toHaveProperty("mimeType");
  });

  test("a string image_url is read the same as the nested object form", () => {
    // Chat Completions allows `image_url` to be either `{url}` or a bare
    // string, and a client that sends the string form must not lose its image.
    const request = new ChatAdapter().parse({
      model: "gemini-3-flash",
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: `data:image/png;base64,${PNG_BASE64}` },
          ],
        },
      ],
    });
    expect(inlineParts(request)[0]?.["inlineData"]).toEqual({
      mimeType: "image/png",
      data: PNG_BASE64,
    });
  });
});

describe("the Responses surface reaches the same Gemini inlineData", () => {
  test("an input_image data URI becomes inlineData", () => {
    const request = new ResponsesAdapter().parse({
      model: "gemini-3-flash",
      input: [
        {
          role: "user",
          content: [{ type: "input_image", image_url: `data:image/png;base64,${PNG_BASE64}` }],
        },
      ],
    });
    expect(inlineParts(request)[0]?.["inlineData"]).toEqual({
      mimeType: "image/png",
      data: PNG_BASE64,
    });
  });

  test("an input_image object form becomes inlineData", () => {
    const request = new ResponsesAdapter().parse({
      model: "gemini-3-flash",
      input: [
        {
          role: "user",
          content: [
            { type: "input_image", image_url: { url: `data:image/png;base64,${PNG_BASE64}` } },
          ],
        },
      ],
    });
    expect(inlineParts(request)[0]?.["inlineData"]).toEqual({
      mimeType: "image/png",
      data: PNG_BASE64,
    });
  });

  test("a remote input_image URL becomes fileData", () => {
    const request = new ResponsesAdapter().parse({
      model: "gemini-3-flash",
      input: [
        {
          role: "user",
          content: [{ type: "input_image", image_url: "https://example.test/cat.png" }],
        },
      ],
    });
    expect(inlineParts(request)).toHaveLength(0);
    expect(fileParts(request)[0]?.["fileData"]).toEqual({
      fileUri: "https://example.test/cat.png",
    });
  });
});

describe("the Messages surface reaches the same Gemini inlineData", () => {
  test("an Anthropic base64 image block becomes inlineData with its media type", () => {
    // The same attachment expressed the Anthropic way. Both surfaces are
    // plausible for an IDE, and both must land on the same Gemini bytes.
    const request = new MessagesAdapter().parse(
      userMessage([
        { type: "text", text: "what is in this image?" },
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: PNG_BASE64 } },
      ]),
    );
    const parts = inlineParts(request);
    expect(parts).toHaveLength(1);
    expect(parts[0]?.["inlineData"]).toEqual({
      mimeType: "image/jpeg",
      data: PNG_BASE64,
    });
  });

  test("an Anthropic data-URL image keeps its bytes", () => {
    // Anthropic has no data-URL source field, and a `url` source carrying a
    // data: URI is not a URL — the bytes are right there. Both an origin
    // vocabulary carrying a data URI and a native Anthropic `url` source must
    // end up as the same inline bytes rather than as a data URI handed to the
    // upstream in a file-uri field.
    const request = new MessagesAdapter().parse(
      userMessage([
        { type: "image", source: { type: "url", url: `data:image/png;base64,${PNG_BASE64}` } },
      ]),
    );
    const parts = inlineParts(request);
    expect(parts).toHaveLength(1);
    expect(parts[0]?.["inlineData"]).toEqual({ mimeType: "image/png", data: PNG_BASE64 });
  });

  test("an Anthropic url image source stays a reference", () => {
    const request = new MessagesAdapter().parse(
      userMessage([{ type: "image", source: { type: "url", url: "https://example.test/cat.png" } }]),
    );
    expect(inlineParts(request)).toHaveLength(0);
    expect(fileParts(request)[0]?.["fileData"]).toEqual({
      fileUri: "https://example.test/cat.png",
    });
  });

  test("a data URI in a `url` source is split for a Claude upstream too", () => {
    // The same split must hold on the Claude wire, which has no data-URL
    // source either: leaving `type: "url"` with a data URI in it asks the
    // upstream to fetch bytes it already has.
    const request = new MessagesAdapter().parse(
      userMessage([
        { type: "image", source: { type: "url", url: `data:image/png;base64,${PNG_BASE64}` } },
      ]),
    );
    const payload = canonicalToClaudeMessagesPayload(request);
    const content = (payload["messages"] as Array<{ content: Array<Record<string, unknown>> }>)[0]
      ?.content;
    expect(content?.[0]?.["source"]).toEqual({
      type: "base64",
      media_type: "image/png",
      data: PNG_BASE64,
    });
  });
});

describe("non-image attachments survive the Gemini encoder", () => {
  // The capability layer grants `document` to every codec-backed route, so a
  // document that reaches this encoder is one the router already promised to
  // carry. Dropping it here loses the attachment with no error at all.
  test("a Chat data-URI document becomes inlineData with its declared type", () => {
    const request = new ChatAdapter().parse({
      model: "gemini-3-flash",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "file",
              file: {
                filename: "report.pdf",
                file_data: `data:application/pdf;base64,${PDF_BASE64}`,
              },
            },
          ],
        },
      ],
    });
    expect(inlineParts(request)[0]?.["inlineData"]).toEqual({
      mimeType: "application/pdf",
      data: PDF_BASE64,
    });
  });

  test("a Chat document URL becomes fileData", () => {
    const request = new ChatAdapter().parse({
      model: "gemini-3-flash",
      messages: [
        {
          role: "user",
          content: [
            { type: "file", file: { filename: "report.pdf", file_url: "https://example.test/r.pdf" } },
          ],
        },
      ],
    });
    expect(fileParts(request)[0]?.["fileData"]).toEqual({
      fileUri: "https://example.test/r.pdf",
    });
  });

  test("an Anthropic base64 document becomes inlineData", () => {
    const request = new MessagesAdapter().parse(
      userMessage([
        {
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: PDF_BASE64 },
        },
      ]),
    );
    expect(inlineParts(request)[0]?.["inlineData"]).toEqual({
      mimeType: "application/pdf",
      data: PDF_BASE64,
    });
  });

  test("an Anthropic text document becomes a plain text part", () => {
    // A `text` document source is prose, and Gemini has no document wrapper
    // for prose. It must not be dropped, and must not be sent as base64.
    const request = new MessagesAdapter().parse(
      userMessage([
        { type: "document", source: { type: "text", media_type: "text/plain", data: "hello" } },
      ]),
    );
    expect(geminiParts(request)[0]).toEqual({ text: "hello" });
  });

  test("an Anthropic document URL becomes fileData", () => {
    const request = new MessagesAdapter().parse(
      userMessage([{ type: "document", source: { type: "url", url: "https://example.test/r.pdf" } }]),
    );
    expect(inlineParts(request)).toHaveLength(0);
    expect(fileParts(request)[0]?.["fileData"]).toEqual({
      fileUri: "https://example.test/r.pdf",
    });
  });

  test("a data URI in a document `url` source is split, not sent as a URI", () => {
    // The same trap as the image case, and one an explicit `url` arm would
    // reintroduce: `source_type: "url"` does not mean the value is fetchable.
    const request = new MessagesAdapter().parse(
      userMessage([
        {
          type: "document",
          source: { type: "url", url: `data:application/pdf;base64,${PDF_BASE64}` },
        },
      ]),
    );
    expect(fileParts(request)).toHaveLength(0);
    expect(inlineParts(request)[0]?.["inlineData"]).toEqual({
      mimeType: "application/pdf",
      data: PDF_BASE64,
    });
  });

  test("a non-http document URL stays a reference instead of being inlined", () => {
    // A declared `url` source is authoritative about the transport. Falling
    // through to the inline arm would put a URI string where base64 bytes
    // belong, which the upstream cannot decode.
    const request = new MessagesAdapter().parse(
      userMessage([
        { type: "document", source: { type: "url", url: "gs://bucket/report.pdf" } },
      ]),
    );
    expect(inlineParts(request)).toHaveLength(0);
    expect(fileParts(request)[0]?.["fileData"]).toEqual({
      fileUri: "gs://bucket/report.pdf",
    });
  });

  test("a Files API document id is named rather than sent as a fake file URI", () => {
    // Same reasoning as the image case: the id belongs to the originating
    // provider's store and is not fetchable by this upstream.
    const request = new ResponsesAdapter().parse({
      model: "gemini-3-flash",
      input: [
        {
          role: "user",
          content: [{ type: "input_file", filename: "r.pdf", file_id: "file-77" }],
        },
      ],
    });
    expect(fileParts(request)).toHaveLength(0);
    expect(geminiParts(request)[0]).toEqual({ text: "[file: file-77]" });
  });

  test("Chat audio becomes inlineData under its own media type", () => {
    const request = new ChatAdapter().parse({
      model: "gemini-3-flash",
      messages: [
        {
          role: "user",
          content: [{ type: "input_audio", input_audio: { data: "QUJD", format: "wav" } }],
        },
      ],
    });
    expect(inlineParts(request)[0]?.["inlineData"]).toEqual({
      mimeType: "audio/wav",
      data: "QUJD",
    });
  });
});

describe("an unencodable attachment degrades visibly", () => {
  // The failure this whole file exists to prevent is a *silent* loss: the
  // request succeeds and the model answers as if nothing was attached. So the
  // last resort must still be visible in the transcript, and must never be an
  // undefined block type the provider rejects — that would take the caller's
  // text down with the attachment.
  test("an image with no resolvable source names itself instead of vanishing", () => {
    const request = new ChatAdapter().parse({
      model: "gemini-3-flash",
      messages: [
        { role: "user", content: [{ type: "image_url", image_url: {} }] },
      ],
    });
    const parts = geminiParts(request);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toEqual({ text: "[image: unsupported source]" });
  });

  test("a Files API image id is named rather than sent as a fake file URI", () => {
    // The id was minted by the *originating* provider's store. It is not a
    // Gemini file URI, so forwarding it as `fileData.fileUri` would ask this
    // upstream to fetch a file it has never heard of.
    const request = new ChatAdapter().parse({
      model: "gemini-3-flash",
      messages: [
        { role: "user", content: [{ type: "image_url", image_url: { file_id: "file-9" } }] },
      ],
    });
    expect(fileParts(request)).toHaveLength(0);
    expect(geminiParts(request)[0]).toEqual({ text: "[image: file-9]" });
  });
});
