# Cartethyia Agent Contract

Operating contract for coding agents. Read once per task.

Goal of every rule: **leave the repo in a state the next reader can trust.** Rules are defaults, not ceremonies. When a rule and the goal visibly conflict, follow the goal and say so in your report.

Companions: `README.md` + `.env.example` (product/config), `ARCHITECTURE.md` (repo map), `CONTRIBUTING.md` (human workflow), one layer doc per top-level `src/` folder named for the layer (`src/transport/TRANSPORT.md`).

Skill: `.skills/cartethyia-engineering` is the single dev/debugging skill. Load the reference matching your task before subsystem work; the guard reference holds the repo-wide invariants.

## How to work

**Start fast.** Goal in one sentence, acceptance criteria, hard constraints. Read target + callers + tests + nearest layer doc — or search immediately if the target is unknown. One tool action before more prose. One-file/obvious edit: read, edit, smallest useful check, no plan. Typo fix needs no written goal; routing change does.

**Use everything available.** Codegraph first: `codegraph_explore` answers most how/where/who-calls questions in one call (verbatim source + call paths, including dynamic-dispatch hops grep misses). `Read` for a known range, `Grep` for a known literal. Load the matching skill reference before subsystem work. Delegate wide independent searches to a subagent; keep a single known file local. Any MCP tool that helps — use it.

**Spend context deliberately.** Land and verify one piece before the next. Quote lines/symbols/diffs — never paste source you already read. Low/normal reasoning for straightforward edits; high for ambiguous architecture, security, data safety, hard debugging — but take the first tool action as soon as the target is known.

**Act every turn.** A turn counts only when it reads, searches, edits, runs a command/test/probe, fetches authoritative docs, asks one necessary question, or reports a concrete blocker with evidence. Never spend consecutive turns restating plans. Two failed approaches → inspect and change approach. Three no-progress actions → report the exact blocker.

**Avoid the known loops:** re-instrumenting the same path (change *what* you observe: raw vs parsed, request vs response); restart loops without confirming the process picked up the change; broad harnesses when one targeted probe answers; tests written before the cause is known; reporting a plan or hypothesis as progress.

**Research:** local source first — never web-search what the repo answers. For external/time-sensitive facts: primary sources only, fetch and read the actual page before deciding (snippets are not evidence), verify locally, cite when the decision depends on it. Unfetchable → second source or mark unverified.

**Execution loop:** goal + constraints → read target/callers/tests/layer doc → one evidence-backed decision → edit the canonical implementation → migrate callers, remove old paths → run the real targeted check → fix root cause on failure → update docs/config → broader gates per impact → audit acceptance criteria, report evidence.

**Layer docs are mandatory reading, not optional context.** Each top-level `src/` folder has one doc named for the layer (`src/transport/TRANSPORT.md`) covering its whole subtree. Read the owning layer doc before editing anything in that subtree, and update it in the same change when your edit makes any claim in it wrong. A change that contradicts its layer doc without updating it is incomplete — same as a change without tests. Large docs (500+ lines) are read section-first: `Grep` the `##` headers, then `Read` only the matching range. Never skip the doc because it is long.

## What counts as done

- Acceptance criteria met; affected callers migrated; obsolete aliases/shims/dead code removed.
- Changed behavior exercised at its real boundary (not typecheck alone); required gates actually executed.
- Active docs/config match the source; failures, skips, blockers, unverified areas reported honestly.
- Report what you did and what proves it: commands run + output, files read + what they establish, what is unverified/skipped/blocked + why. "Tests pass" means you ran them this turn.

## Implementation rules

**Fix the cause, never the symptom.** No error suppression, single-input special-casing, loosened validation, swallowed exceptions, pinned fixtures, path-specific fallbacks, or "while here" extras the task doesn't need. A workaround is fine only as a named temporary boundary with a removal condition. Deliberate degradation paths and operator-configured fallbacks are legitimate design — name them as such in a comment + layer doc.

**Clean cutover, no aliases.** Add/rename/move/replace: find every caller → change the canonical definition → migrate all callers → delete the obsolete symbol → search the old name again (only intentional history remains) → run affected tests + typecheck. Never alias, forward, or shim to keep old imports compiling. History (`CHANGELOG`, old docs) mentioning the old name is not a caller.

**Real fix, throwaway tests.** Temp tests/scripts must exercise the real affected path and prove the real fix — never mock away the defect, hardcode success, disable validation/security, or remain as production behavior. Bug fix: reproduce → read implementation + callers → fix root cause → rerun same reproduction → keep a regression test where infrastructure exists → remove throwaways. A passing temp script proves only the path it ran.

**Prove deadness before deleting.** A symbol isn't dead because grep finds only its declaration. Rule out interface dispatch, callback/hook fields, re-exports, dynamic imports, test doubles, own-file use, dashboard/doc copies. For guards/probes, ask what the other arm does. Easiest proof: delete → typecheck + affected suites → read failures. Wrong removal → restore with a comment saying why it stays. Applies to symbols reachable from your change — not a licence to audit unrelated code.

**Shared contracts: check the blast radius.** Before changing a shared mapping/flag/envelope/registry entry, find everything that branches on it — a value change flips every decision made from it (retry, cooldown, rotation, security). State the answer before editing.

**Facts from source.** Numbers/mappings/counts in comments, docs, or reports come from reading the source — prefer a throwaway script that extracts them. Measure hot paths/pools/caches before recommending changes; report contradictions, don't soften them. New regression tests should be break-tested (break fix → fails on intended assertion → restore → passes). Wrong claim → correct it in place with a `> **Correction.**` note.

## Boundaries

- `src/` production backend; backend tests in `test/` (cross-cutting: `test/contracts`, `integration`, `architecture`, `frontend`, `helpers`; a script's own test co-locates as `scripts/<name>.test.ts`). `dashboard/src/` production browser code, tests mirror under `dashboard/test/`. Browser code never imports Elysia, DB drivers, filesystem, secrets, or Node-only deps.
- `scripts/` flat, `ops-*` / `build-*` / `ci-*` prefixes. No `index.ts` barrels — concrete modules, role filenames (`contracts.ts`, `routes.ts`, `store.ts`, `service.ts`, `errors.ts`). Keep parsing, encoding, adapters, errors separated. Committed protobuf is build input — typecheck/build must not need Buf, network, or codegen.
- TypeScript: backend strict + exact optional props + unchecked-index + isolated modules + verbatim syntax + unused checks; dashboard the same minus `exactOptionalPropertyTypes`/`verbatimModuleSyntax`. `import type` for types. No `any`, suppressions, needless assertions, or weakened settings without a documented reason. Exported APIs explicitly typed. Comments explain policy/security/protocol/tradeoffs, not the next line. Never name an external reference project in code, test names, docs, or commits — state the behavior and why it must hold.
- Untrusted at every boundary: network responses, env vars, DB rows, request bodies, user values. Security fails closed. Preserve intentional upstream wire bytes. One source of truth for provider metadata, persisted contracts, env names, dashboard mirrors.
- Never: destructive git commands (`reset --hard`, `checkout --`, `clean`); commit/push/deploy/touch prod/delete user data unasked; hand-edit generated output (change source/generator + run the command); leave stubs/TODOs/debug logging/placeholders; expose credentials/tokens/keys/payloads in output; touch unrelated working-tree changes. DB/prod ops: verify the environment first; transaction/backup/dry-run/reversible migration where practical.
- Docs are part of the change: `README.md` product usage; `.env.example` every literal `process.env.*` read (drift test derives from `CONFIG_SPEC` — a new knob is one `CONFIG_SPEC` row + one `.env.example` line); `ARCHITECTURE.md` the map; one layer doc per `src/` folder (no shared basenames; subfolders fold into the parent; only root/`dashboard/`/`migrations/` keep `README.md`; read section-first via `##` headers when 500+ lines — see "Layer docs" above); `CONTRIBUTING.md` human workflow. Env is for deployment settings — cache bounds and safety margins are constants beside the code. No volatile counts/line numbers/versions/hashes/secrets in docs. Code-vs-docs conflict → inspect the code, fix stale docs in the same change unless the code is the defect. Update docs your change made wrong; don't rewrite untouched layer docs; never paste implementation detail here — it belongs in the layer doc.
- Tests assert observable behavior (results, boundaries, errors, transitions, security invariants, persistence contracts, explicit layout contracts) — never implementation details, source text, or "does not throw". Never delete a valid test to go green; removed behavior → remove only redundant coverage, preserve the contract.
- Gates: narrowest useful check first, then expand by impact — `bun run typecheck`, `bun run test:fast` (unit/architecture/contracts; skips `test/integration/**` and `**/*.integration.test.ts`), `bun run test`, `bun run check:coverage`; dashboard/contract changes add `dashboard:typecheck`, `dashboard:test`, `test:contracts`. Root `dashboard:*` runs `generate:usage-periods` once; dashboard scripts do not re-codegen. Focused: `scripts/ops-run-tests.ts <dir>`. DB-gated skips reported separately from failures, never as green. UI changes: real browser surface, or state explicitly that it was unavailable.
