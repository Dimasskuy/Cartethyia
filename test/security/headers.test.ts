import { describe, expect, test } from "bun:test";
import {
  API_CONTENT_SECURITY_POLICY,
  BADGE_IMAGE_ORIGIN,
  X_FRAME_OPTIONS,
  dashboardContentSecurityPolicy,
  inlineScriptBodies,
  inlineScriptHash,
} from "../../src/security/outbound-headers";

describe("security header policy", () => {
  test("API CSP denies every resource class and blocks framing", () => {
    expect(API_CONTENT_SECURITY_POLICY).toContain("default-src 'none'");
    expect(API_CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'");
    expect(API_CONTENT_SECURITY_POLICY).toContain("object-src 'none'");
    expect(X_FRAME_OPTIONS).toBe("DENY");
  });

  test("inlineScriptHash is a stable base64 sha256 source expression", () => {
    const hash = inlineScriptHash("console.log(1)");
    expect(hash).toMatch(/^'sha256-[A-Za-z0-9+/=]+'$/);
    expect(inlineScriptHash("console.log(1)")).toBe(hash);
    expect(inlineScriptHash("console.log(2)")).not.toBe(hash);
  });

  test("inlineScriptBodies extracts only scripts without a src attribute", () => {
    const html = [
      `<script src="/app.js"></script>`,
      `<script>theme()</script>`,
      `<script type="module" src="/main.js"></script>`,
      `<script>\n  boot()\n</script>`,
      `<script>   </script>`,
    ].join("");
    expect(inlineScriptBodies(html)).toEqual(["theme()", "\n  boot()\n"]);
  });

  test("dashboard CSP allows only hashed inline scripts", () => {
    const csp = dashboardContentSecurityPolicy("<script>boot()</script>");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain(inlineScriptHash("boot()"));
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("https://fonts.googleapis.com");
    expect(csp).toContain("https://fonts.gstatic.com");
  });

  /**
   * The landing and share pages render the repository's star/fork counts from
   * the badge host, so `img-src` must name it. Widening images must not widen
   * the classes that could execute or exfiltrate: scripts stay same-origin plus
   * hashes, and `connect-src` stays `'self'`.
   */
  test("dashboard CSP admits the badge image host without widening scripts or connections", () => {
    const csp = dashboardContentSecurityPolicy("<script>boot()</script>");
    expect(csp).toContain(`img-src 'self' data: blob: ${BADGE_IMAGE_ORIGIN}`);
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("script-src 'self' ");
    expect(csp).not.toContain("connect-src 'self' https:");
    expect(csp).not.toContain(`script-src 'self' ${BADGE_IMAGE_ORIGIN}`);
  });

  /**
   * The dashboard copies the badge origin rather than importing it (browser code
   * cannot reach a module that reads `node:crypto`), so this is the join that
   * keeps the CSP and the badge URL from drifting apart.
   */
  test("the dashboard badge origin matches the origin the CSP permits", () => {
    const csp = dashboardContentSecurityPolicy("");
    const imgSrc = csp.split("; ").find((directive) => directive.startsWith("img-src "));
    expect(imgSrc).toBeDefined();
    expect(imgSrc).toContain(BADGE_IMAGE_ORIGIN);
  });

  test("dashboard CSP omits hashes when no inline script exists", () => {
    const csp = dashboardContentSecurityPolicy("<html><body></body></html>");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("'sha256-");
  });
});
