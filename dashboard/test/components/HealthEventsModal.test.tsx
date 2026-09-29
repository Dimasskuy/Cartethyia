import { describe, expect, mock, test } from "bun:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const healthEvents = [
  {
    id: "rate-event",
    accountId: "account-id",
    fromStatus: "active",
    toStatus: "cooldown",
    modelId: "deepseek/deepseek-v4-flash",
    errorCategory: "rate_limit_transient",
    reason: "Provider rate limit: requests per minute exceeded",
    createdAt: "2026-09-29T12:00:00.000Z",
  },
];
mock.module("../../src/components/ui/dialog", () => ({
  Dialog: ({ title, width, children }: { title: string; width?: number; children: ReactNode }) =>
    createElement("section", { "data-title": title, "data-width": width, style: { "--dialog-width": `${width ?? 520}px` } }, children),
}));

mock.module("../../src/hooks/providers", () => ({
  useAccountHealthEvents: () => ({ data: healthEvents, isPending: false, isError: false, refetch: () => undefined }),
  useRecoverAccount: () => ({ isPending: false, mutate: () => undefined }),
}));

const { HealthEventsModal } = await import("../../src/components/HealthEventsModal");

describe("HealthEventsModal", () => {
  test("shows the affected model in its own audit row instead of an ambiguous cooling summary", () => {
    const markup = renderToStaticMarkup(
      createElement(HealthEventsModal, {
        summary: {
          providerId: "deepseek",
          accountId: "account-id",
          title: "account label",
          status: "active",
          errorCategory: "rate_limit_transient",
          errorMessage: "Provider rate limit: requests per minute exceeded",
          emptyMessage: "No events",
        },
        onClose: () => undefined,
      }),
    );

    expect(markup).toContain("Timestamp");
    expect(markup).toContain("From → To");
    expect(markup).toContain("Model");
    expect(markup).toContain("deepseek/deepseek-v4-flash");
    expect(markup).toContain("rate_limit_transient");
    expect(markup).not.toContain("models cooling");
    expect(markup).toContain("--dialog-width");
    expect(markup).toContain("max-height:min(55dvh, 480px)");
    expect(markup).toContain("overflow:auto");
  });
});
