/// <reference types="bun-types" />
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { USAGE_PERIODS } from "../src/console/observability/usage-periods";

const projectRoot = resolve(import.meta.dir, "..");
const outPath = resolve(projectRoot, "dashboard/src/data/generated/usage-periods.json");

await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, `${JSON.stringify([...USAGE_PERIODS], null, 2)}\n`);
