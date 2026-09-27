import { describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ApiKeyResponse, SharedKeyActivityDetail } from "../../src/data/contracts";

const activity: SharedKeyActivityDetail = {
  models: [
    {
      providerId: "openai",
      modelId: "gpt-5",
      retainedRequests: 8,
      retainedErrors: 1,
      retainedTokens: 270,
      todayRequests: 4,
      todayErrors: 0,
      todayTokens: 125,
    },
  ],
  requests: [
    {
      requestId: "event-1",
      startedAt: "2026-09-25T12:30:00.000Z",
      providerId: "openai",
      modelId: "gpt-5",
      status: "success",
      httpStatus: 200,
      clientIp: "203.0.113.*",
      inputTokens: 10,
      outputTokens: 15,
      totalTokens: 25,
    },
  ],
};

/** Records the key ids the recipients query was enabled for, per render. */
const sharedKeysCalls: Array<string | null> = [];

mock.module("../../src/hooks/api-keys", () => ({
  useShareApiKey: () => ({ isPending: false, mutate: () => undefined }),
  useRegenerateApiKey: () => ({ isPending: false, mutate: () => undefined }),
  useShareLink: () => ({ data: null, isPending: false, isError: false }),
  useRevokeSharedKey: () => ({ isPending: false, mutate: () => undefined }),
  useSharedKeys: (keyId: string | null) => {
    sharedKeysCalls.push(keyId);
    return { data: [], isPending: keyId !== null, isError: false, refetch: () => undefined };
  },
  useSharedKeyActivity: () => ({ data: activity, isPending: false, isError: false }),
}));

const { ChildDetail, ShareManagementContent } = await import(
  "../../src/components/ShareManagementDialog"
);

function renderNode(node: ReturnType<typeof createElement>): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(createElement(QueryClientProvider, { client: queryClient }, node));
}

function render(): string {
  return renderNode(createElement(ChildDetail, { parentId: "parent-id", childId: "child-id" }));
}

function key(overrides: Partial<ApiKeyResponse>): ApiKeyResponse {
  return {
    id: "key-1",
    label: "my key",
    keyMode: "personal",
    scopes: [],
    createdAt: "2026-01-02T00:00:00.000Z",
    tokensConsumed: 12_345,
    ...overrides,
  } as ApiKeyResponse;
}

describe("share management dialog", () => {
  test("expanded recipient exposes token usage without credential material", () => {
    const markup = render();
    expect(markup).toContain("Top models");
    expect(markup).toContain("gpt-5");
    expect(markup).toContain("Recent requests");
    // Token totals only: the detail deliberately drops the per-event client IP
    // and error fields the owner does not act on.
    expect(markup).toContain("25");
    expect(markup).not.toContain("203.0.113.*");
    expect(markup).not.toContain("child-id");
  });

  test("a personal key shows its own usage and never queries recipients", () => {
    sharedKeysCalls.length = 0;
    const markup = renderNode(
      createElement(ShareManagementContent, { parent: key({}) }),
    );
    // `/shared-keys` is a share-template route that 404s for a personal key, so
    // the query must be disabled rather than surfacing an error over the modal.
    expect(sharedKeysCalls).toEqual([null]);
    expect(markup).toContain("Usage");
    expect(markup).not.toContain("Recipients");
    expect(markup).toContain("Create link");
    // Lifetime tokens are real data for a personal key, not a placeholder.
    expect(markup).toContain("12.35K");
  });

  test("a share template lists recipients and its own link", () => {
    sharedKeysCalls.length = 0;
    const markup = renderNode(
      createElement(ShareManagementContent, {
        parent: key({ id: "template-1", keyMode: "share", label: "share template" }),
      }),
    );
    expect(sharedKeysCalls).toEqual(["template-1"]);
    expect(markup).toContain("Recipients");
    expect(markup).not.toContain("Usage");
    expect(markup).toContain("Create link");
  });
});
