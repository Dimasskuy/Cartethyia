import { describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ShareEnrollmentData, ShareHandoffData, ShareLinkData } from "../../../src/lib/hooks/share-data";

(globalThis as { window?: unknown }).window = {
  location: { pathname: "/share/public-token", origin: "https://gateway.example" },
  localStorage: { getItem: () => null, setItem: () => undefined },
};

interface ShareState { data: ShareLinkData | null; error: string | null; loading: boolean }
let shareState: ShareState = { data: null, error: null, loading: true };
mock.module("../../../src/lib/hooks/share-data", () => ({ useShareData: (): ShareState => shareState }));
// Load after mock.module so the page captures the mocked data hook.
const { SharePage, tokenFromPathname } = await import("../../../src/apps/share/page");
function render(): string { return renderToStaticMarkup(createElement(SharePage)); }

const data: ShareEnrollmentData = {
  kind: "enroll",
  name: "Team Access", keyPrefix: "ctk", canIssue: true, alreadyIssued: false,
  dailyLimit: 50_000, monthlyLimit: null, oneTimeLimit: null, requestsPerMinute: 20, maxConcurrentRequests: 3,
  modelAllowlist: ["gpt-5"], modelDenylist: null, modelPrefix: "gpt-", notes: { title: null, subtitle: "Shared access", body: "Use responsibly" },
  expiresAt: null,
};

const handoff: ShareHandoffData = {
  kind: "handoff",
  name: "Personal key", keyPrefix: "rk_", key: "rk_handed_over_secret",
  dailyLimit: null, monthlyLimit: null, oneTimeLimit: null, requestsPerMinute: null, maxConcurrentRequests: null,
  modelAllowlist: ["gpt-5"], modelDenylist: null, modelPrefix: null, notes: { title: null, subtitle: null, body: null },
  expiresAt: null,
};

describe("public share enrollment page", () => {
  test("shows a loading state while enrollment policy is fetched", () => {
    shareState = { data: null, error: null, loading: true };
    const markup = render();
    expect(markup).toContain("Loading enrollment policy…");
    expect(markup).not.toContain("Generate API Key");
  });

  test("offers the public endpoint and key generation action", () => {
    shareState = { data, error: null, loading: false };
    const markup = render();
    // The recipient is told to call the origin they reached this page by.
    expect(markup).toContain("https://gateway.example/v1");
    expect(markup).toContain("Base URL");
    expect(markup).toContain("Generate API Key");
  });

  test("shows the repository link beside Home, and drops the policy and prefix panels", () => {
    shareState = { data, error: null, loading: false };
    const markup = render();
    const github = markup.indexOf("Cartethyia on GitHub");
    const home = markup.indexOf("share-home-link");
    expect(github).toBeGreaterThan(-1);
    expect(home).toBeGreaterThan(-1);
    // The badge sits in the topbar actions, immediately before the Home link.
    expect(github).toBeLessThan(home);
    expect(markup).toContain("https://img.shields.io/github/stars/risunCode/Cartethyia");
    // The enrollment terms panel and the key prefix pill are gone.
    expect(markup).not.toContain("Your enrollment terms");
    expect(markup).not.toContain("Requests / minute");
    expect(markup).not.toContain("Prefix ctk");
    // "Ready to enroll" is the ordinary state and is not announced.
    expect(markup).not.toContain("Ready to enroll");
  });

  test("shows policy and explicit child-key generation without disclosing any credential", () => {
    shareState = { data, error: null, loading: false };
    const markup = render();
    expect(markup).toContain("Team Access");
    expect(markup).toContain("Generate API Key");
    expect(markup).toContain("Allowed models");
    expect(markup).toContain("gpt-5");
    expect(markup).toContain("Required model prefix: gpt-");
    // The trust copy was removed; the credential-hiding guarantee it described
    // still holds, so assert the secret never renders rather than the sentence.
    expect(markup).not.toContain("parentSecret");
    expect(markup).not.toContain("sk-parent-raw");
    expect(markup).not.toContain("telemetry");
  });

  test("announces an already-claimed enrollment", () => {
    shareState = { data: { ...data, canIssue: false, alreadyIssued: true }, error: null, loading: false };
    const markup = render();
    expect(markup).toContain("An active key has already been issued from this IP.");
    expect(markup).toContain("Already enrolled");
    expect(markup).not.toContain("Generate API Key");
  });

  test("reveals the key a handoff link carries, with no issuance action", () => {
    shareState = { data: handoff, error: null, loading: false };
    const markup = render();
    // A personal key's link exists to reveal that key, so the page shows it
    // rather than offering to mint one.
    expect(markup).toContain("rk_handed_over_secret");
    expect(markup).toContain("SHARED ACCESS / KEY");
    expect(markup).not.toContain("Generate API Key");
    expect(markup).not.toContain("An active key has already been issued from this IP.");
    expect(markup).toContain("https://gateway.example/v1");
  });

  test("says a handoff link cannot reveal a key when its ciphertext is gone", () => {
    shareState = { data: { ...handoff, key: null }, error: null, loading: false };
    const markup = render();
    expect(markup).toContain("This link can no longer reveal its key.");
    expect(markup).not.toContain("Generate API Key");
  });

  test("shows a useful unavailable state", () => {
    shareState = { data: null, error: "This enrollment link has expired.", loading: false };
    expect(render()).toContain("This enrollment link has expired.");
  });

  test("extracts the enrollment token from the pathname", () => {
    expect(tokenFromPathname("/share/public-token/")).toBe("public-token");
    expect(tokenFromPathname("/share/public-token")).toBe("public-token");
  });
});
