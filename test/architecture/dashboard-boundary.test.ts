import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const REPO_ROOT = join(import.meta.dir, "../..");
const DASHBOARD_SRC = join(REPO_ROOT, "dashboard", "src");
const BACKEND_SRC = join(REPO_ROOT, "src");

/**
 * Modules a browser bundle cannot carry: Node-only runtimes, the server
 * framework, and database drivers. `dashboard/README.md` states the rule —
 * "Never import backend modules, Elysia, `node:*` APIs, database clients,
 * provider adapters, secrets, or server-only crypto into `dashboard/src`" — and
 * Vite enforces it only with a warning, which is easy to miss in a build log.
 *
 * That is how `USAGE_DIMENSIONS` reached the browser: the dashboard mirror
 * re-exported the tuple from `console/observability/contracts`, which imports
 * Elysia and reaches `node:crypto` through `console/shared/errors` →
 * `protocol/primitives` → `security/outbound-headers`. Vite externalized the
 * builtin and carried a slice of the backend graph for one string list. The
 * tuple now lives in a pure module, and this test is what keeps the next value
 * re-export from repeating it.
 */
const NODE_ONLY = /from\s+"(node:[a-z/_-]+|elysia|drizzle-orm|postgres|ioredis|bun:sqlite)"/;

/** Every `.ts`/`.tsx` file under `directory`, recursively. */
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

/** Resolve a relative specifier to a file on disk, trying the usual extensions. */
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

/**
 * True when a binding clause carries no runtime value, so the bundler erases it.
 *
 * `import type { A }` and `import { type A, type B }` are erased; `import A from`
 * and `import { type A, B }` are not. Getting this wrong in the permissive
 * direction reports a pure facade as impure, which is how a first pass at this
 * check produced a false positive on `discovery-types.ts` — it imports
 * `quota-contracts` with `import type`, and `quota-contracts` does import
 * `node:crypto`.
 */
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

/** Specifiers this file imports or re-exports at runtime, including side effects. */
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

/** The import chain from a dashboard file to the first Node-only backend module. */
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
      // Only backend modules are judged; dashboard-internal hops are roots
      // themselves, so following them here would report the same chain twice.
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
    // Guards the walker itself: `protocol/primitives` imports
    // `security/outbound-headers`, which imports `node:crypto`. If the graph
    // walk silently stops resolving, the assertion above passes for the wrong
    // reason — this pins that the traversal still follows a value import into a
    // Node-only module and names where it landed.
    const entry = join(BACKEND_SRC, "protocol", "primitives.ts");
    const chain = offendingChain(entry);
    if (chain === null) throw new Error("walker did not resolve the known node:crypto chain");
    expect(chain.at(-1)).toBe(join(BACKEND_SRC, "security", "outbound-headers.ts"));
  });
});
