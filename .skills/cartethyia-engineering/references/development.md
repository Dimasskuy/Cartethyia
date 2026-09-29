
# Develop

Every repo modification. Jump to your section; all share one Verify block at the end.

## When to use

| Symptom | Section |
|---|---|
| New to the repo / where is the authority? | 0 Orientation |
| Changing behavior and unsure how to test it | 0.1 Goal-first testing |
| Add or extend a bundled provider | 1 Add provider |
| Provider stamps a CLI/client version in headers | 2 Version resolver |
| New Postgres column or routing setting | 3 Schema change |
| New field on the Console Log line | 4 Console-log field |
| Ready to commit / gates and constraints | 5 Change gate |
| Delete a whole feature cluster | 6 Feature removal |
| Delete files / measure a tree / check path readers | 7 Safe removal |
| Refactor left re-exports or type aliases | 8 Compat shims |
| Same logic in several places | 9 Consolidating duplication |

## 0 Orientation

Done when: you can name the authority file for ingress, routing, dispatch, registry, and config without guessing.

1. State first: `git status --short` + `git diff --stat`. Uncommitted work is the real state — a mid-change tree beats any doc, including this one.
2. Navigate by authority:
   - `README.md` (product/runtime) → `ARCHITECTURE.md` (map, canonical paths) → `AGENTS.md` (repo rules) → `CHANGELOG.md` head (`## Unreleased` first).
   - Then the **one** layer doc for your area: exactly one per top-level `src/` folder, named for the layer in caps, covering its whole subtree (`TRANSPORT.md` also covers `middleware/`, `surface/`, `request/`, `translation/`, `routing/`, `dispatch/`; `PROVIDERS.md` also covers `integrations/`, `operations/`, `authentication/`, `quota/`, `discovery/`). No subfolder has its own doc. Read it *before* opening source — fastest way in.
3. "How/where/what calls X" → the code index: `.codegraph/codegraph.db` at the repo root; `codegraph_explore` returns verbatim source + call paths in one call, including dynamic-dispatch hops grep misses. Re-verify hits with `Grep`/`Read` when the file changed after the index sync point — map, not oracle.
4. Then `package.json` scripts, then the boot chain `src/main.ts` → `src/runtime/lifecycle.ts` → `src/runtime/dependencies.ts` → `src/app.ts`.

**Authority map (current).** Repo beats this file on any disagreement — fix this file in the same change.

- **Ingress:** `src/transport/middleware/pipeline.ts` fixes the stage order; the factories are grouped by responsibility — `body-policy.ts` (single-read body policy, `isProxyDispatchRoute`), `request-context.ts` (state, identity, canonical parse, route prepare), `gateway-guards.ts` (auth, CSRF, readiness, per-IP abuse), `error-lifecycle.ts` (public error normalization, `finalizeRequestTelemetry`, cleanup).
- **Eligibility:** `src/transport/routing/router.ts` only (`RoutingEngine.plan`, admission reading `candidate.max_inflight`).
- **Model/errors:** `src/transport/canonical-model.ts` (wire families, canonical request/event vocabulary); `src/transport/gateway-error.ts` (`GatewayError`, stable codes, public-detail sanitizers).
- **Surfaces:** `src/transport/surface/` (`chat/adapter.ts`, `responses/adapter.ts`, `messages/adapter.ts`, `completion.ts`).
- **Codecs:** `src/protocol/request/`, `src/protocol/response/` (`chat.ts`, `responses.ts`, `messages.ts`, `codex.ts`, `gemini.ts`), `src/protocol/registry.ts`, `src/protocol/transport/openai.ts`, `src/protocol/primitives.ts`. Codex and Gemini bypass the registry by design.
- **Capabilities:** `src/transport/translation/capabilities.ts` plus `src/transport/request/preparer.ts`.
- **Dispatch:** `src/providers/compatible-adapter.ts` (awaited `buildExtraHeaders`), `src/transport/dispatch/proxy-request.ts`, `attempt-finalize.ts` (`completeAttempt`), `leases.ts`, `upstream.ts`, `retry-policy.ts`.
- **Registry:** `src/providers/provider-registry.ts`, `default-registry.ts`, `provider-metadata.ts`, `model-definition.ts` (`defineModel`).
- **Config:** `src/config.ts` is the only sanctioned multi-subsystem env reader; single-subsystem reads live next to their consumer and must be documented in `.env.example` (`test/config-env-drift.test.ts` enforces this).
- **Network:** `src/network/ssrf.ts`, `outbound-fetch.ts`, `pool/`.
- **Observability:** `src/observability/log-ring.ts`, `payload-capture.ts`, `telemetry-buffer.ts`, `telemetry-status.ts` (the one definition of "is this a gateway error").
- **Console:** `src/console/providers/catalog/`, `providers/detail/`, `observability/` (logs, live streams, performance, usage stats).
- **Persistence:** `src/persistence/schema.ts`, `postgres.ts` (migration ledger), `migrations/` (tracked numbered `NNNN_*.sql`, applied in order at boot; `0000_baseline.sql` is the whole schema for a database created today).
- **Scripts** are flat under `scripts/` (`ops-run-tests.ts`, `ops-setup.ts`, `ops-doctor.ts`, `build-aot.ts`, `ci-check-coverage.ts`); no `scripts/ops/` subdirectory exists.

```bash
git status --short
git diff --stat
bun run typecheck
```

**Watch out:** stale layer doc never overrides `router.ts` / `route-catalog.ts` / `compatible-adapter.ts`; a doc naming a path the repo lacks is a doc bug — fix it / provider identity is mirrored, not imported: dashboard keeps hand-copied names, icons, id sets; a backend rename isn't done until the mirrors move (K9) / capability flags change the upstream payload; telemetry is metadata-only, never blocks requests / bare model-id ambiguity is rejected, not guessed; route-contract changes need `dashboard:typecheck`; renames must pass `test/architecture/*-naming.test.ts`; dispatch errors use `GatewayError`.

## 0.1 Goal-first testing

Done when: the test asserts one observable behavior, you predicted how it fails, and you proved it has teeth.

1. **Goal sentence first.** "A `<surface>` request carrying `<input>` produces `<observable outcome>`." Observable = result, boundary, error, transition, security invariant, persistence contract. "Does not throw" / "the function was called" are not goals.
2. **Predict the failure.** Which line reads which value, and why it's wrong today. Can't predict → hypothesis: run one probe first, don't write the test yet. A test written before the cause is known tests your guess, not the code.
3. **Run once.** Predicted failure = model confirmed. Unpredicted failure = new information: read it, correct the model, then change the implementation. Re-running while nudging code is a search loop — each iteration costs more than the probe that would have answered it.
4. **Change what you observe, not how often.** Unexplained failure → switch the layer: raw vs parsed, request vs response, one provider vs one surface, stub fetch vs pipeline. Never re-instrument the same path.
5. **Prove teeth (mutation test).** Break the fix → test must fail *on the intended assertion* → restore → passes. A test that passes both ways proves nothing.
6. **Keep it where infrastructure exists:** `test/` mirroring `src/`, or `dashboard/test/` for browser code. Delete throwaways before reporting — they prove only the path they ran.

**Watch out:** "see what happens" tests encode the buggy behavior and pass after the wrong fix / asserting implementation detail (`toHaveBeenCalled`, internals, source text) breaks on correct refactors — assert the outcome / full-suite re-runs to find a failure one probe would name / leaving the mutation in — verify the restore took effect.

## 1 Add provider

Done when: the provider dispatches end-to-end, appears in the dashboard, and its catalog seeds without endpoint conflicts.

1. Identity row in `provider-metadata.ts` (`RAW_BUNDLED_PROVIDER_METADATA`): `id`, `displayName`, `baseUrl` as the true origin root (no version segment unless genuine). Optional `wireFamilyDefault` (default `chat`), `requiresAccount` (`false` only for genuinely public endpoints), `defaultBypassProxy`, `jwtVerification`, `credentialUrl`, `credentialHint`, `hasAdapterUserAgent`. `BundledProviderId` derives from this array — no second id list exists.
2. Capabilities entry in `default-registry.ts` (`PROVIDER_CAPABILITIES.<id>`) — missing key is a compile error via the `satisfies Record<BundledProviderId, …>` check. Every loader lazy (`await import()`; `oauthCapability()`, `quotaCapability()`, `openAIModelDiscovery()`). Key-only hosts reuse `configuredProvider(id)` via `GENERIC_API_KEY_SPECS`.
3. Integration module under `src/providers/integrations/`: mirror a sibling. Nested dirs for OAuth/quota providers: `<id>.ts` (adapter + `withBearerAuthentication`), `<id>-shared.ts` (awaited `buildExtraHeaders`, in-place `prePayload`, `defineModel`), `<id>-oauth.ts`, `<id>-quota.ts`. Versioned providers register their resolver in `client-versions.ts`. Flat files for simple/bespoke wires. Catalog rows use `defineModel({ id, endpoint, vision, reasoning, toolCall })`; `endpoint` becomes `ModelDefinition.endpointPath` (family defaults when omitted).
4. Endpoint gotcha: dispatch reads each row's `ModelDefinition.endpointPath`, not `endpoint_paths_by_wire_family` (only the `resolveEndpoint` fallback). `bundledModelCatalog()` throws on same-family conflicts — a version-less `baseUrl` plus a versioned chat path means explicit `endpoint` on every row of that family.
5. Dashboard mirrors (hand-maintained — browser code must never import a backend module): display name in `BUILT_IN_PROVIDER_DISPLAY_NAMES`, `iconAssets` entry in `ProviderIcon.tsx`, section placement plus `FOUNDING_IDS`/`FREE_LIMITED_IDS`/`FREE_AVAILABLE_IDS` in `ProvidersPage.tsx`, `PROXY_UNSUPPORTED_HINT_PROVIDERS` when the provider can't route through a pool. OAuth section derives from `oauthFlows` — no list edit. Two parity tests fail the moment an id is missing from the name/icon map, so run `dashboard:test` before claiming the provider is wired.
6. Seed/restart: `seedBundledModels()` upserts on `(provider_id, model_id, endpoint_path)` and deletes stale `source = 'builtin'` rows; `enabled` is operator-owned, never reset. Static catalog changes need a backend restart.
7. Tests in `test/providers/integrations/<id>/`: stub fetch as `as typeof fetch`, never hit the network. **No file pins a provider count** — the contract is set equality (`default-registry.test.ts` + dashboard parity tests). A new id lands in every mirror; bumping a number is never the change. No count in `README.md` either — it drifts on the next provider.

```bash
bun run typecheck
bun run scripts/ops-run-tests.ts test/providers
bun run test:contracts
bun run dashboard:typecheck
```

**Watch out:** eager imports pull protobuf-heavy adapters into startup — keep `await import()` lazy / conflicting row endpoints throw at boot: fix rows, not the map / dashboard names and `PROXY_UNSUPPORTED_HINT_PROVIDERS` are intentional copies — sync strings, never imports / DB-gated suites skip without `CARTETHYIA_TEST_DATABASE_URL` — report skips, not passes.

## 2 Version resolver

Done when: the first dispatch already carries the current version with no race, and offline mode works on the pinned fallback.

1. The race: `prepareHeaders()` awaits `buildExtraHeaders`, but a sync builder calling only sync `get()` + fire-and-forget `refresh()` stamps the pinned fallback until discovery lands. Fix: `await` the resolver's `ensure()` inside the async header builder before `get()`. Fallback applies only on a real network error.
2. Add/change a provider entry in `VERSION_SOURCES` + its `resolvers` instance (same file, `client-versions.ts`): unique `key`, pinned `fallback`, source URLs/parsers. The factory lives in `client-version-resolver.ts`. Keep non-version fingerprint parsing in its dedicated helper. The shared cache dedupes concurrent fetches, evicts failures, keeps dispatch on the fallback offline.
3. Await the resolver at every async header builder needing a fresh version; sync builders use `get()` only after an awaited warm-up.
4. Tests mirror the provider surface: reset the shared resolver, stub fetch as `as typeof fetch`, assert the discovered value and the fallback on failure.

```ts
import { VERSION_SOURCES, resolveQoderVersion } from "../providers/operations/client-versions";

// One table entry; consumers await the shared resolver before first dispatch.
const qoderFallback = VERSION_SOURCES.qoder.fallback;
await resolveQoderVersion();
console.log(qoderFallback);
```

```bash
bun run typecheck
bun run scripts/ops-run-tests.ts test/providers/integrations/qoder.test.ts
```

**Watch out:** `get()` before an awaited `resolve*Version()` serves the fallback on cold start — intended only for offline/error paths / discovery moves a client forward, never backward (`minVersion` discards below-it discoveries) / duplicate table keys or provider-specific parsers in the shared table cross-wire versions — keep keys unique, isolate non-version fingerprints.

## 3 Schema and routing-setting change

Done when: the value survives from dashboard through snapshot to the dispatch decision with no silent drop.

1. Fold the column into `0000_baseline.sql` at the same position/order as `src/persistence/schema.ts`, same commit. The baseline is the whole schema for a database created today (`migration-integrity` asserts the folded shape; `isolated-db` compares a freshly migrated DB against `schema.ts` column by column). Null-means-inherit/unlimited pattern: omit `.notNull()` and `.default()` — `maxInflight: integer("max_inflight")` is the template.
2. Add the next numbered file so existing databases converge (`0001_…`, `0002_…`). `applySqlMigrations()` reads numbered `NNNN_*.sql` top-level (non-recursive), applies each in order at boot, records it in the ledger — deployments migrate themselves, no hand-run. Every file idempotent (`IF NOT EXISTS`/`IF EXISTS`/`EXCEPTION WHEN`): a mid-file failure leaves no ledger row and retries next boot.
   ```sql
   ALTER TABLE provider_routing_settings
     ADD COLUMN IF NOT EXISTS max_inflight integer;
   ```
   DB URL from `.env`; docs use `<tenant-id>` placeholders, never real secrets.
3. Thread every point or the value drops. Backend order: console catalog contracts (`ProviderRoutingResponse` + `UpdateProviderRoutingRequest`) → `route-model.ts` (`RouteCandidate`/`ProviderRoutingSetting`/`ProviderRoutingMap`) → `route-catalog.ts` (`loadRouteCatalogSnapshot`; precedence: account value → tenant setting → global `__global__` → `DEFAULT_PROXY_BYPASS_PROVIDER_IDS`; `null`/`undefined` = unlimited/globally-routable) → detail store (`updateRouting`: extend `values` + `setClause` guard `if (patch.x !== undefined)`; `null` clears, `undefined` leaves untouched; upsert on `[tenantId, providerId]` or the global partial unique index) → detail routes (`updateRoutingBody = t.Object({ … })` AND operation validation — Elysia strips unknown keys, so a field missing from either never reaches the store). Prove the consumer read site first (e.g. `router.ts` reads `candidate.max_inflight` in `admit`).
4. Dashboard, same change: `data/contracts.ts` (re-export, no second type source) → `assertProviderRouting` in `hooks/common.ts` → `hooks/routing.ts` + `use-routing-strategy.ts` (saves via `use-debounced-save.ts`) → `RoutingStrategyCard.tsx` (parity with `Proxy.tsx`). Backend `updateRouting` calls `await snapshotInvalidator?.invalidate()` so the next `/v1/*` request picks up edits; new static columns still need the numbered migration applied at boot (restart to run it).

```bash
bun run typecheck
bun run dashboard:typecheck
bun run scripts/ops-run-tests.ts test/console/providers
bun run test:contracts
bun run scripts/ops-run-tests.ts test/transport/routing
```

**Watch out:** Elysia strips unknown keys — update `t.Object` and validation together or store-only additions drop silently / `undefined` = leave untouched, `null` = clear to unlimited — swapping them freezes or wipes / precedence lives in three places (`route-catalog.ts`, `detail/store.ts getRouting`, `resolveTenantOverride`) — change one and dashboard disagrees with dispatch / missing `snapshotInvalidator.invalidate()` leaves dispatch on the old snapshot while the dashboard shows the new value.

## 4 Console-log field

Done when: the value flows from dispatch to the SSE tail to the dashboard row with no missing layer.

1. Source: `pushStructuredConsoleLog` in `src/observability/log-ring.ts`. Add the optional key to BOTH `ConsoleLogLine` and `ConsoleLogMetadata` or it never emits.
2. Thread the backend chain in order: `route-model.ts` (`RouteCandidate`, by reference, never serialized) → `request/state.ts` (`ProxyRequestOutcome`: `status` = internal terminal state, `httpStatus` = its wire projection) → `attempt-finalize.ts` (`completeAttempt` copies each field via explicit `=== undefined ? {} : {…}` spreads — an unspread field vanishes even when passed; capture + `finalizeRequestTelemetry` run only when `terminal: true` under the `state.completed` idempotency guard, one telemetry row per request) → every `completeAttempt(…)` site in `proxy-request.ts` that knows the value (grep — the count changes) → finalize emit in `error-lifecycle.ts` (`finalizeRequestTelemetry` spreads `state.outcome` + `model` from the canonical request + `routedModel` from `preparedRequest.plan`; `request_complete` vs `request_error`; `request_start` emitted separately; non-dispatch `/v1` routes like `/v1/models` return early via `isProxyDispatchRoute`). Console `logs.ts` serves snapshot + SSE; nothing touches the database.
3. Dashboard: extend `ConsoleLogLine` in `dashboard/src/hooks/logs.ts`, add the field to the search haystack and `LogRow` in `ConsoleLogPage.tsx` (single-line row, `title` + ellipsis for long values).
4. Labels, not secrets: log `accountLabel`, never credential material; never enrich via a dashboard-side account lookup — thread from the backend candidate (network pools are the one exception, via `useNetworkPools()`).
5. The ring is an in-memory SSE tail — restarts clear it by design. Backend emit changes need an operator restart; pure display changes need only `dashboard:build` + reload.

```bash
bun run typecheck
bun run dashboard:typecheck
bun run scripts/ops-run-tests.ts test/observability
bun run scripts/ops-run-tests.ts test/transport/middleware
bun run dashboard:test
```

**Watch out:** missing `completeAttempt` spread = classic silent drop (caller passes it, type allows it, line stays empty) / `state.completed` idempotency: fields set after terminal completion never render — set them before the terminal call / dashboard `isLogLine` drops malformed `ts`/`level`/`msg` — a backend rename without the dashboard type update blanks the whole tail / flood-prone warns must throttle (once per minute per key) or they push real lines out of the bounded ring.

## 5 Change gate and commit

Done when: every gate passes from a clean tree; history split, documented, never pushed unasked.

1. Gates from the root, escalating: `typecheck` → `dashboard:typecheck` → `test` → `dashboard:test` → `build` (`dashboard:build`, then `build:aot`, then `build:binary` — compiles `dist/main.js` with `NODE_ENV=production` baked in). Deeper: `test:contracts`, `test:integration` (needs `CARTETHYIA_TEST_DATABASE_URL` at an isolated DB — the gate repoints `DATABASE_URL` there before any pool opens), `check:coverage` (floor 90%, same as CI). Focused loop: `scripts/ops-run-tests.ts <dir>` (thin `bun test --parallel --timeout 60000` wrapper pinning the encryption key).
2. Changelog in the same change under `## Unreleased` — backend, provider, dashboard bullets each.
3. Commit subjects are plain imperative sentences; no `type(scope):` prefix, no attribution trailer. Never push to `origin` unasked. Restart the built binary after landing when runtime behavior changed.
4. Strays: `git status --short` shows only intended paths; `.env*` stays untracked except `.env.example`.
5. Constraints: schema + baseline same commit; `await import()` stays lazy in `default-registry.ts`; explicit exported types, `import type` for types, no `index.ts` barrels; `quota_exhausted` → account `cooldown`; `await snapshotInvalidator?.invalidate()` after writes in detail/catalog/oauth routes (plus pool/model mutating contracts).
6. TSX: typecheck immediately after structural cut-or-paste (over-deletion is silent); unused imports are typecheck's call; no screenshot daemon — the operator verifies visually. Test doubles mirror the full field set on create + update, then mutation-test by deleting the field from the double and confirming failure.

```bash
bun run typecheck
bun run dashboard:typecheck
bun run test
bun run dashboard:test
bun run test:contracts
bun run test:integration
bun run check:coverage
bun run dashboard:build
bun run build
git status --short
```

**Watch out:** zero-fail, no pinned counts — baseline BEFORE the change. `--parallel` means a load-only failure is a real defect: DB-gated suites share one isolated DB as concurrent workers, so a suite with table-wide cleanup (or a table-wide-read assertion) clobbers other suites' fixtures. Scope the over-reaching suite by id/`tenant_id` — never re-run until green / DB-gated suites skip without a database — report skips, never green / build order: `dashboard:build` before `bun run build` (server embeds `dist/`) / docs use POSIX `bun run …`; PowerShell env is `$env:NAME="value"`; never `find | xargs` in instructions / never lower the coverage floor or delete a test to reach green — coverage signals untested change, not an obstacle.

## 6 Feature removal

Done when: no fallback, shim, or dead code remains and the report states what was deliberately not cut.

1. Measure import edges, not LOC: dependents = files OUTSIDE the cluster importing INTO it. Table `candidate | files | LOC | prod dependents | test dependents` via case-insensitive grep across `src`, `test`, `scripts`, `dashboard/src`, `Dockerfile`, `package.json`, `README.md` — every hit path-qualified (false positives abound). The owner picks scope from this table.
2. Cut in order, staying compilable: composition root (`app.ts`, `runtime/dependencies.ts`, console domain registration) → config (`config.ts`, `.env.example`) → registration (`default-registry.ts`, console routes) → modules (integrations, quota/discovery/operations) → schema (`schema.ts` + `0000_baseline.sql`, same commit) → tests (`test/` mirroring `src/`) → dashboard (routes, hooks, `data/contracts.ts`) → `scripts/`, `Dockerfile`, `package.json`. Typecheck after EACH cluster (+ `dashboard:typecheck` when the dashboard moved). Files over half affected get rewritten. Confirm `.tsx` range bounds (first/last kept lines) before deleting.
3. Schema pins: `migration-integrity` pins `network_pools` columns/indexes/checks and asserts the baseline carries no orphan `backup_status` table; `isolated-db` compares a freshly migrated DB against `schema.ts` column by column — update migration assertions, fixture, schema together.
4. Report what was NOT cut and why (shared helper, facade, sub-union) with the deleted-path listing + post-cut keyword sweep. Edit tangled `.tsx` directly, never via subagent, typecheck immediately. Update `toHaveLength(N)` count assertions in the cut commit.

```bash
bun run typecheck
bun run dashboard:typecheck
bun run scripts/ops-run-tests.ts test/console
bun run test:contracts
```

**Watch out:** hiding a control (`false` flag, commented route) instead of deleting = dead code — delete registration, module, and test / cutting modules before the composition root breaks every intermediate step / `dashboard/src` copies aren't dead on arrival — grep it separately before declaring a backend symbol unreferenced / `generated/` protobuf looks hand-written but isn't — trace its importer before dropping.

## 7 Safe removal and measurement

Done when: fresh numbers plus a reader list prove the deletion safe.

1. Measure with Python `os.walk` — never `find | xargs` (Windows PowerShell). Re-measure at deletion time, skip `generated/`, count `.ts` vs `.test.ts` separately, `encoding="utf-8", errors="ignore"`:
   ```python
   import os
   SKIP = {"node_modules", ".git", "dist", "generated"}
   for root, dirs, files in os.walk("src/providers/integrations/buddy"):
       dirs[:] = [d for d in dirs if d not in SKIP]
       ts = [f for f in files if f.endswith(".ts") and not f.endswith(".test.ts")]
       tests = [f for f in files if f.endswith(".test.ts")]
       print(root, len(ts), len(tests))
   ```
2. Trace readers BEFORE deleting: `src`, `test`, `scripts`, `dashboard`, `package.json`, `Dockerfile`, `*.sh`, `*.yml`. Generated output drops only with its importer. Confirm hits with word-boundary `Grep` on the exact symbol. A `.codegraph` query surfaces call paths grep misses — use both; neither alone is proof.
3. Critical path: typecheck = `tsc --noEmit`; build = `dashboard:build && build:aot && build:binary` (compile entrypoint is the AOT output `dist/main.js`, never `src/main.ts` — raw-source bundling leaves Elysia's lazy `require("typebox/type")` unresolved and the binary dies at startup); tests via `scripts/ops-run-tests.ts`; `scripts/` is flat (no `scripts/ops/`).
4. `git ls-files <path>` decides tracked vs ignored; removing a path Docker/the build reads means removing that reader in the same change. `git diff --stat` must match expectations — no silent extras, no missing halves.

```bash
git ls-files src/providers/integrations/buddy
git status --short
git diff --stat
bun run typecheck
bun run dashboard:typecheck
```

**Watch out:** `git status` omits ignored output (`dist/`, `coverage/`); `git ls-files` is the arbiter / skipping `dashboard/src` misses `../../../src/…` contract imports / `generated/` skews LOC — exclude from measurement, include its importers in tracing / stale numbers are fiction — re-measure in the deletion commit.

## 8 Compat shims

Done when: dead shims are gone, live consumers repointed, and only genuine sub-unions or untouched facades remain.

1. Enumerate: grep `^export \{` and `^export type \{` across `src/`; narrow via `git diff HEAD -- src/` + per-file `export|Backward|compat` scan.
2. Classify: dead (zero consumers — delete) / live (repoint every consumer to the canonical symbol, then delete) / genuine (real sub-union, narrowed alias, untouched console facade — keep + one-line reason).
3. Map consumers with word boundaries — `\bSymbolName\b` over `src/`, `test/`, `dashboard/src/` (`.ts` + `.tsx`), including the defining file's own use. Repoint dashboard relative imports (`../../../src/…`) to the canonical module, preferring top-level `import type`.
4. Blanket-rename guard: a rename producing a self-reference (`export type New = New`) is always wrong — delete those lines. Delete shims after repointing, then both typechecks; green backend + red dashboard = a dashboard relative import still points at the old name.

```bash
bun run typecheck
bun run dashboard:typecheck
bun run scripts/ops-run-tests.ts test/console
bun run scripts/ops-run-tests.ts test/transport
```

**Watch out:** substring grep (`Old` matching `OldV2`) invents consumers — always `\b` / dashboard-only consumers are invisible to backend-only tracing — the dashboard tree is mandatory / deleting a live shim before repointing breaks every consumer at once — repoint-then-delete stays green / console facades imported for route mounting are load-bearing — confirm the mount chain before calling one dead.

## 9 Consolidating duplication

Done when: exactly one module owns it, every caller reads that owner, and the copies are gone.

1. **Diff before believing.** "Looks the same" usually isn't. Extract the bodies and `diff`/hash them before merging: four `formatBytes` copies disagreed on unit threshold, decimals, *and* placeholder — so "dedupe" was really a behaviour decision. Identical bodies merge mechanically; divergent ones need the owner chosen + the losing policy stated.
2. **Owner by layering, not call-site count.** The lower layer both sides already import owns the helper. A guard used 169× against a copy used 41× still moves *down*: `protocol/primitives` owned `isRecord` because `surface` already imports `protocol` — the reverse was a cross-layer cycle.
3. **Consolidate the caller shape too.** Eleven handlers with the same six-line access block, 95 with the same `try/catch` — the win is deleting the repetition at the call site. A helper plus eleven copies of the boilerplate is not consolidation. For repeated wrappers, look for a framework hook (Elysia's global `error(handler)`) before a per-call helper.
4. **Migrate in one pass, then delete.** Repoint every caller, remove the copy. Typecheck between the two catches the missed call site; a repo-wide rename script that also rewrites strings/unrelated identifiers corrupts files — verify per file, never trust a count.
5. **Re-verify behaviour, not just the typecheck.** A merged guard must still reject what the strictest original rejected. Where the merge changes a *number* (query count, allocation), assert the invariant the test actually cares about, not the moved implementation detail.
6. **Keep deliberate divergence.** Resemblance with different protocol behaviour stays separate, with a comment saying so. `chat`/`completion` share an SSE frame shape; `responses`/`messages` don't (one carries a `[DONE]` sentinel + wire-derived event name).

```bash
bun run typecheck
bun run scripts/ops-run-tests.ts test/<area>
bun run test:contracts
```

**Watch out:** identical-looking bodies differing in a throw path/default/wire shape silently change behaviour — diff first / a guard can be load-bearing for a partially-implemented test double even when production always takes the same arm; removing it can change query counts — the experiment is a typecheck + the affected suite, not an argument / deleting a copy while a caller imports it through a re-export/relative dashboard path breaks both trees differently — run `dashboard:typecheck` too / same-basename files (`adapter.ts`) collide in temp-file schemes (`/tmp/<basename>.keep`) — key backups by full path / loose helper return (`Record<string, unknown>`) starves every spread site of the callee's required fields — type against the destination / rebuilding a lookup table inside its reader (three `Record`s per rejection) is duplication's hot-path cost — hoist to module scope.

## Verify

```bash
bun run typecheck
bun run test                          # focused: bun run scripts/ops-run-tests.ts <dir>
bun run test:contracts
bun run test:integration              # needs CARTETHYIA_TEST_DATABASE_URL (isolated: the gate repoints DATABASE_URL at it)
bun run dashboard:typecheck           # whenever dashboard/ or route contracts touched
bun run dashboard:test                # whenever dashboard/ touched
bun run dashboard:build               # whenever dashboard/ touched, before bun run build
```

0 fail always (never pin pass counts); diff against the pre-change baseline captured BEFORE the change. `--parallel` means a load-only failure is a real defect: find the over-reaching suite (table-wide cleanup or table-wide-read assertion) and scope it by id/`tenant_id` instead of re-running. DB-gated suites skip without a database — report skips separately. Coverage floor 90% via `check:coverage` when at risk.
