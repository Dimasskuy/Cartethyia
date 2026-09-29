/// <reference types="bun-types" />
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { USAGE_PERIODS } from "../src/console/observability/usage-periods";

const projectRoot = resolve(import.meta.dir, "..");
const outPath = resolve(projectRoot, "dashboard/src/data/generated/usage-periods.json");
const next = `${JSON.stringify([...USAGE_PERIODS], null, 2)}\n`;

try {
  const current = await readFile(outPath, "utf8");
  if (current === next) {
    process.exit(0);
  }
} catch {
  // missing or unreadable — write below
}

await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, next);
