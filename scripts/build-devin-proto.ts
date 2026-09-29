/**
 * Regen Devin protobuf output from the oh-my-pi protos.
 *
 * The .proto files are NOT vendored here — source of truth is the oh-my-pi
 * checkout pinned below. This script generates into
 * `src/providers/integrations/devin/generated/` (never hand-edit that output).
 *
 * Usage: bun run scripts/build-devin-proto.ts
 * Requires: `buf` on PATH (`go install github.com/bufbuild/buf/cmd/buf@latest`)
 *           and the oh-my-pi checkout at OH_MY_PI_DIR (default: ../Public/oh-my-pi).
 *
 * To update protos: bump OH_MY_PI_PIN to the new upstream commit, verify the
 * checkout matches, then run this script and commit the regenerated output.
 */

import { $ } from "bun";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

// Upstream commit the protos were last generated from. Bump deliberately.
const OH_MY_PI_PIN = "da58b16f424273605795435a6753778f422baff3";

const repoRoot = import.meta.dir.endsWith("/scripts")
  ? resolve(import.meta.dir, "..")
  : process.cwd();
const ohMyPiDir = process.env.OH_MY_PI_DIR ?? resolve(repoRoot, "..", "Public", "oh-my-pi");
const protoRoot = resolve(
  ohMyPiDir,
  "packages/ai/src/providers/devin/proto",
);
const outDir = resolve(
  repoRoot,
  "src/providers/integrations/devin/generated",
);

if (!existsSync(protoRoot)) {
  throw new Error(`oh-my-pi proto root not found: ${protoRoot} (set OH_MY_PI_DIR)`);
}

// Fail closed: the checkout must match the pin, so a dirty/drifted upstream
// can never silently change the generated wire code.
const actualPin = (await $`git -C ${ohMyPiDir} rev-parse HEAD`.text()).trim();
if (actualPin !== OH_MY_PI_PIN) {
  throw new Error(
    `oh-my-pi checkout is ${actualPin}, expected pin ${OH_MY_PI_PIN}. ` +
      `Checkout the pinned commit or bump OH_MY_PI_PIN deliberately.`,
  );
}

const tmpGen = mkdtempSync(resolve(tmpdir(), "devin-proto-"));
// protoc-gen-es ships in node_modules/.bin via @bufbuild/protobuf — local,
// pinned, no network. buf resolves bare plugin names through PATH.
const esPlugin = resolve(repoRoot, "node_modules", ".bin", "protoc-gen-es");
if (!existsSync(esPlugin) && !existsSync(`${esPlugin}.exe`)) {
  throw new Error(`protoc-gen-es not found at ${esPlugin} (run bun install first)`);
}
const pathWithPlugin = `${resolve(repoRoot, "node_modules", ".bin")}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`;
const bufGenYaml = `${tmpGen}/buf.gen.yaml`;
await Bun.write(
  bufGenYaml,
  `version: v1
plugins:
  - name: es
    out: ${tmpGen}/out
    opt: target=ts,import_extension=.js
`,
);

// buf generates the full transitive closure (api_server pulls cortex,
// language_server, index, ... via imports) — that is expected, not bloat:
// protoc-gen-es emits per-file and every file in the closure may carry a
// message the chat/tools/image/quota path references.
//
// `--path` filters which ROOTS are generated, but every file they import is
// still emitted as a dependency. So no --path flags: generate the whole
// module and keep all of it. Trimming the file list breaks TS imports.
await $`buf generate --template ${bufGenYaml}`.cwd(protoRoot).env({ ...process.env, PATH: pathWithPlugin });
rmSync(outDir, { recursive: true, force: true });
cpSync(resolve(tmpGen, "out"), outDir, { recursive: true });
rmSync(tmpGen, { recursive: true, force: true });

console.log(`regenerated devin protobuf output into ${outDir} from oh-my-pi@${OH_MY_PI_PIN}`);
