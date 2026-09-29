import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "../..");
const INTEGRATIONS = join(REPO_ROOT, "src/providers/integrations");

/**
 * Every hand-written module under `integrations/`, skipped for the committed
 * protobuf output (build input, not source).
 */
function listIntegrationFiles(): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(INTEGRATIONS, { withFileTypes: true })) {
    const path = join(INTEGRATIONS, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "generated") continue;
      for (const nested of readdirSync(path, { withFileTypes: true })) {
        if (nested.name === "generated") continue;
        const nestedPath = join(path, nested.name);
        if (nested.isDirectory()) {
          for (const deep of readdirSync(nestedPath)) {
            if (deep.endsWith(".ts")) files.push(join(nestedPath, deep));
          }
        } else if (nested.name.endsWith(".ts")) {
          files.push(nestedPath);
        }
      }
    } else if (entry.name.endsWith(".ts")) {
      files.push(path);
    }
  }
  return files;
}

/** `export const <name>` / `export function <name>` declarations in one file. */
function exportedNames(file: string): string[] {
  const source = readFileSync(file, "utf8");
  return [
    ...source.matchAll(/^export (?:const|function|async function|class)\s+(\w+)/gm),
  ].map((match) => match[1] ?? "");
}

const integrationFiles = listIntegrationFiles();
const oauthFiles = integrationFiles.filter((file) => basename(file).endsWith("-oauth.ts"));
const quotaFiles = integrationFiles.filter((file) => basename(file).endsWith("-quota.ts"));

describe("provider integration naming contract", () => {
  test("every OAuth module exports one `<id>OAuthClient` instance", () => {
    // The registry resolves clients by export name through `oauthCapability`,
    // so a name that does not end in `OAuthClient` is only discoverable at
    // runtime dispatch. A module may also export its class (`GrokOAuthClient`),
    // but the instance the registry imports is the lowerCamelCase one.
    // `codebuddy-oauth.ts` exports two on purpose: `cb` and `cbcn` are two
    // registered providers sharing one module.
    for (const file of oauthFiles) {
      const relative = file.slice(REPO_ROOT.length).replace(/\\/g, "/").replace(/^\//, "");
      const names = exportedNames(file);
      const instances = names.filter((name) => /^[a-z]\w*OAuthClient$/.test(name));
      expect({ file: relative, count: instances.length > 0 }).toEqual({
        file: relative,
        count: true,
      });
    }
  });

  test("every quota module exports a `fetch<Provider>Quota` collector", () => {
    // A variant family (CodeBuddy ships INTL + CN) legitimately exports more
    // than one; what must hold is that at least one collector exists and every
    // one is named `fetch…Quota`.
    for (const file of quotaFiles) {
      const relative = file.slice(REPO_ROOT.length).replace(/\\/g, "/").replace(/^\//, "");
      const collectors = exportedNames(file).filter((name) => /^fetch\w+Quota$/.test(name));
      expect({ file: relative, count: collectors.length > 0 }).toEqual({
        file: relative,
        count: true,
      });
    }
  });

  test("no adapter module hides behind a generic basename", () => {
    // `spec.ts` / `catalog.ts` / `index.ts` make a provider's adapter module
    // unfindable by provider id, which is the whole point of the layout.
    const generic = ["spec.ts", "catalog.ts", "index.ts", "adapter.ts"];
    const offenders = listIntegrationFiles()
      .filter((file) => generic.includes(basename(file)))
      .map((file) => file.slice(REPO_ROOT.length).replace(/\\/g, "/").replace(/^\//, ""));
    expect(offenders).toEqual([]);
  });

  test("no two integration modules share a basename", () => {
    // A duplicated basename makes a stack trace and a grep hit ambiguous:
    // `claude.ts` resolving to two different providers is only discoverable by
    // reading the full path. Family directories (`buddy/` holds `cb`, `cbcn`,
    // `workbuddy`; `xiaomi-mimo/` holds four ids) are legitimate, so the rule
    // is uniqueness, not "directory name equals provider id".
    const seen = new Map<string, string[]>();
    for (const file of integrationFiles) {
      const name = basename(file);
      const relative = file.slice(REPO_ROOT.length).replace(/\\/g, "/").replace(/^\//, "");
      seen.set(name, [...(seen.get(name) ?? []), relative]);
    }
    const collisions = [...seen.entries()]
      .filter(([, paths]) => paths.length > 1)
      .map(([name, paths]) => ({ name, paths }));
    expect(collisions).toEqual([]);
  });

  test("shared helpers are named `-shared`, never duplicated per provider", () => {
    // A helper shared by sibling providers (`buddy-*-shared.ts`) carries the
    // `-shared` suffix so it reads as pure, provider-identity-free support code.
    const shared = listIntegrationFiles()
      .map((file) => basename(file))
      .filter((name) => /(^|-)shared\.ts$/.test(name));
    for (const name of shared) {
      expect(name.endsWith("-shared.ts")).toBe(true);
    }
  });
});
