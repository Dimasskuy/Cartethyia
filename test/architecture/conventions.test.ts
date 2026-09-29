import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { listSourceFiles, toRepoRelative as toRepoRelativePath } from "../helpers/source-tree";

const REPO_ROOT = join(import.meta.dir, "../..");
const SRC_ROOT = join(REPO_ROOT, "src");
const DASHBOARD_SRC = join(REPO_ROOT, "dashboard", "src");
const BACKEND_SRC = join(REPO_ROOT, "src");
const INTEGRATIONS = join(REPO_ROOT, "src/providers/integrations");

const sourceFiles = listSourceFiles(SRC_ROOT);

// ── dashboard browser boundary (from dashboard-boundary.test.ts) ─────────────

const NODE_ONLY = /from\s+"(node:[a-z/_-]+|elysia|drizzle-orm|postgres|ioredis|bun:sqlite)"/;

function walk(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(path));
    else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
      files.push(path);
    }
  }
  return files;
}

function resolveSpecifier(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), spec);
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ]) {
    try {
      readFileSync(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

function isTypeOnly(clause: string): boolean {
  if (/^\s*type\s/.test(clause)) return true;
  const braces = clause.match(/\{([\s\S]*)\}/);
  if (!braces) return false;
  const outsideBraces = clause.replace(/\{[\s\S]*\}/, "").replace(/[\s,]/g, "");
  if (outsideBraces.length > 0) return false;
  const named = braces[1]!
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return named.length > 0 && named.every((name) => name.startsWith("type "));
}

function valueSpecifiers(file: string): string[] {
  const body = readFileSync(file, "utf8");
  const specs: string[] = [];
  const statement = /(?:^|\n)\s*(?:import|export)\s+([\s\S]*?)from\s+"([^"]+)"|(?:^|\n)\s*import\s+"([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = statement.exec(body)) !== null) {
    const clause = match[1];
    const spec = match[2] ?? match[3]!;
    if (clause !== undefined && isTypeOnly(clause)) continue;
    specs.push(spec);
  }
  return specs;
}

function offendingChain(entry: string): string[] | null {
  const seen = new Set<string>();
  const visit = (file: string, chain: string[]): string[] | null => {
    if (seen.has(file)) return null;
    seen.add(file);
    let body: string;
    try {
      body = readFileSync(file, "utf8");
    } catch {
      return null;
    }
    const here = [...chain, file];
    if (NODE_ONLY.test(body)) return here;
    for (const spec of valueSpecifiers(file)) {
      const next = resolveSpecifier(file, spec);
      if (next === null || !next.startsWith(BACKEND_SRC)) continue;
      const found = visit(next, here);
      if (found !== null) return found;
    }
    return null;
  };
  return visit(entry, []);
}

describe("dashboard browser boundary", () => {
  test("no dashboard module pulls a Node-only backend module into the bundle", () => {
    const offenders: string[] = [];
    for (const file of walk(DASHBOARD_SRC)) {
      const chain = offendingChain(file);
      if (chain === null) continue;
      const rendered = chain.map((step) => relative(REPO_ROOT, step).replaceAll("\\", "/"));
      offenders.push(`${rendered.join("\n    -> ")}`);
    }
    expect(offenders).toEqual([]);
  });

  test("the check detects a Node-only backend module behind a value re-export", () => {
    const entry = join(BACKEND_SRC, "protocol", "primitives.ts");
    const chain = offendingChain(entry);
    if (chain === null) throw new Error("walker did not resolve the known node:crypto chain");
    expect(chain.at(-1)).toBe(join(BACKEND_SRC, "security", "outbound-headers.ts"));
  });
});

// ── protocol layer (from protocol-naming.test.ts) ────────────────────────────

const REMOVED_LOCATIONS = [
  "src/providers/protocol",
  "src/providers/openai/protocol",
  "src/providers/claude/protocol",
  "src/providers/codex/protocol",
];

const STALE_IMPORT_FRAGMENTS = [
  "providers/protocol/chat",
  "providers/protocol/responses",
  "openai/protocol",
  "claude/protocol/",
  "codex/protocol/",
  "antigravity/protocol/",
];

describe("protocol layer contract", () => {
  test("old protocol locations no longer exist", () => {
    for (const location of REMOVED_LOCATIONS) {
      expect(existsSync(join(REPO_ROOT, location))).toBe(false);
    }
  });

  test("canonical protocol layer directories exist", () => {
    for (const location of [
      "src/protocol",
      "src/protocol/request",
      "src/protocol/response",
      "src/protocol/transport",
    ]) {
      expect(existsSync(join(REPO_ROOT, location))).toBe(true);
    }
  });

  test("no source file imports a removed protocol path", () => {
    const violations: string[] = [];
    for (const file of listSourceFiles(join(REPO_ROOT, "src"))) {
      const source = readFileSync(file, "utf8");
      for (const fragment of STALE_IMPORT_FRAGMENTS) {
        if (source.includes(fragment)) {
          violations.push(`${file.replace(REPO_ROOT, "")}: ${fragment}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

// ── provider integration naming (from provider-naming.test.ts) ───────────────

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

function exportedNames(file: string): string[] {
  const source = readFileSync(file, "utf8");
  return [...source.matchAll(/^export (?:const|function|async function|class)\s+(\w+)/gm)].map(
    (match) => match[1] ?? "",
  );
}

const integrationFiles = listIntegrationFiles();
const oauthFiles = integrationFiles.filter((file) => basename(file).endsWith("-oauth.ts"));
const quotaFiles = integrationFiles.filter((file) => basename(file).endsWith("-quota.ts"));

describe("provider integration naming contract", () => {
  test("every OAuth module exports one `<id>OAuthClient` instance", () => {
    for (const file of oauthFiles) {
      const relativePath = file.slice(REPO_ROOT.length).replace(/\\/g, "/").replace(/^\//, "");
      const names = exportedNames(file);
      const instances = names.filter((name) => /^[a-z]\w*OAuthClient$/.test(name));
      expect({ file: relativePath, count: instances.length > 0 }).toEqual({
        file: relativePath,
        count: true,
      });
    }
  });

  test("every quota module exports a `fetch<Provider>Quota` collector", () => {
    for (const file of quotaFiles) {
      const relativePath = file.slice(REPO_ROOT.length).replace(/\\/g, "/").replace(/^\//, "");
      const collectors = exportedNames(file).filter((name) => /^fetch\w+Quota$/.test(name));
      expect({ file: relativePath, count: collectors.length > 0 }).toEqual({
        file: relativePath,
        count: true,
      });
    }
  });

  test("no adapter module hides behind a generic basename", () => {
    const generic = ["spec.ts", "catalog.ts", "index.ts", "adapter.ts"];
    const offenders = listIntegrationFiles()
      .filter((file) => generic.includes(basename(file)))
      .map((file) => file.slice(REPO_ROOT.length).replace(/\\/g, "/").replace(/^\//, ""));
    expect(offenders).toEqual([]);
  });

  test("no two integration modules share a basename", () => {
    const seen = new Map<string, string[]>();
    for (const file of integrationFiles) {
      const name = basename(file);
      const relativePath = file.slice(REPO_ROOT.length).replace(/\\/g, "/").replace(/^\//, "");
      seen.set(name, [...(seen.get(name) ?? []), relativePath]);
    }
    const collisions = [...seen.entries()]
      .filter(([, paths]) => paths.length > 1)
      .map(([name, paths]) => ({ name, paths }));
    expect(collisions).toEqual([]);
  });

  test("shared helpers are named `-shared`, never duplicated per provider", () => {
    const shared = listIntegrationFiles()
      .map((file) => basename(file))
      .filter((name) => /(^|-)shared\.ts$/.test(name));
    for (const name of shared) {
      expect(name.endsWith("-shared.ts")).toBe(true);
    }
  });
});

// ── token saver (from token-saver.test.ts) ───────────────────────────────────

function listAllSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listAllSourceFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function toRepoRelative(path: string): string {
  return path.slice(REPO_ROOT.length).replace(/\\/g, "/").replace(/^\//, "");
}

describe("token saver architecture contract", () => {
  test("does not reintroduce tokenSaver settings into src", () => {
    const offenders = listAllSourceFiles(SRC_ROOT).flatMap((path) => {
      const lines = readFileSync(path, "utf8").split("\n");
      return lines.flatMap((line, index) =>
        /\btokenSaver[A-Za-z0-9_]*/.test(line)
          ? [`${toRepoRelative(path)}:${index + 1}: ${line.trim()}`]
          : [],
      );
    });
    expect(offenders).toEqual([]);
  });
});

// ── transport naming (from transport-naming.test.ts) ─────────────────────────

describe("transport naming contract", () => {
  test("no duplicate pipeline.ts basenames", () => {
    const pipelines = sourceFiles.filter((f) => basename(f) === "pipeline.ts");
    expect(pipelines.map((path) => toRepoRelativePath(REPO_ROOT, path))).toEqual([
      "src/transport/middleware/pipeline.ts",
    ]);
  });

  test("no dispatch- prefixed modules at the transport root", () => {
    const root = join(SRC_ROOT, "transport");
    const offenders = readdirSync(root)
      .filter((name) => name.startsWith("dispatch-") && name.endsWith(".ts"))
      .map((name) => `src/transport/${name}`);
    expect(offenders).toEqual([]);
  });

  test("no sse- prefixed source filenames", () => {
    const offenders = sourceFiles
      .filter((f) => basename(f).startsWith("sse-"))
      .map((path) => toRepoRelativePath(REPO_ROOT, path));
    expect(offenders).toEqual([]);
  });

  test("no encoder/decoder source filenames", () => {
    const offenders = sourceFiles
      .filter((f) => /(encoder|decoder)\.ts$/.test(basename(f)))
      .map((path) => toRepoRelativePath(REPO_ROOT, path));
    expect(offenders).toEqual([]);
  });

  test("no surface-base module remains", () => {
    const offenders = sourceFiles
      .filter((f) => basename(f) === "surface-base.ts")
      .map((path) => toRepoRelativePath(REPO_ROOT, path));
    expect(offenders).toEqual([]);
  });
});
