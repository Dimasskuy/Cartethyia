
# Repo invariants

Checks that stop silent drift: duplicate authorities, dead compatibility paths, hidden symptoms, verification loops, unsafe cleanup. Pick the sections your change touches. For a one-line typecheck fix, skip the report — no ceremony for trivial work.

Two apply to almost every change:

- **Fix, don't hide:** state the cause as a mechanism; classify the change as fix vs hiding vs intended design.
- **Test with a goal:** predict the failure, run once, change the observation instead of re-running.

## No compatibility aliases

Removals, renames, contract cutovers.

1. Search runtime, tests, scripts, dashboard, active docs for every old symbol/path.
2. Migrate every caller; remove the obsolete export in the same change.
3. Reject aliases, deprecated re-exports, migration facades, silent fallback branches — unless an explicit external compatibility promise requires one.
4. If retained, document the consumer and when it goes away.

Good report: old-name search result + replacement call path. Clean cutover = zero runtime references to the old name.

## Single source of truth

A value/contract mirrored across backend, dashboard, tests, generated output, or docs.

1. Name the authority before editing.
2. Trace all consumers; separate generated/mirrored copies from a second source of truth.
3. Move shared logic to the authority or generate the mirror.
4. Remove stale duplicates.

Good report: authority, consumers, and the command/inspection proving no competing source remains.

## Provider registry authority

Provider identity, capability, alias, addition, removal, rename, count changes.

- `src/providers/provider-metadata.ts` owns identity.
- `src/providers/default-registry.ts` owns capability + lazy-loader entries.
- Dashboard names, tests, docs, catalogs are synchronized consumers.
- Every bundled identity needs exactly one capability entry; custom/BYOK paths stay separate.

Good report: registry keys checked, mirrors updated, stale aliases removed, intentionally custom paths retained.

## Wire bytes

Parser, codec, endpoint, header, query, adapter changes.

1. Name the surface codec + provider adapter that own the bytes.
2. Separate structural cleanup from intentional protocol changes.
3. Preserve exact paths, prefixes, content types, headers, query params, serialized shapes — unless the upstream contract changed.
4. Verify with a focused fixture or captured request/response shape.

Good report: before/after wire contract + focused proof. Never swap a wire requirement for a generic helper because it looks redundant.

## Naming and location

File moves, splits, merges, role-oriented layout changes.

1. Confirm the canonical path from `AGENTS.md`, `ARCHITECTURE.md`, neighboring modules.
2. Trace imports, dynamic imports, scripts, tests, Docker/build readers, active docs before moving.
3. Clean cutover: update callers, remove old path, update naming tests and maps.
4. No barrels or compatibility files to preserve the old location.

Good report: old-path search, new path, synchronized architecture/docs/test references.

## Envelope and version boundary

Quota, telemetry, cache, API, database, persisted envelope changes.

1. Define canonical shape + version marker.
2. Decide whether reads tolerate prior data; state when the old-read branch goes away.
3. Write the new envelope consistently at every producer.
4. Preserve bounded retention, validation, failure behavior while migrating callers and docs.

Good report: producer/consumer coverage, old-data handling, exact migration/removal condition.

## Dead keys and branches

Env vars, settings fields, feature flags, fallback constants, dead branches.

1. Search literal readers + semantic consumers across source, tests, scripts, dashboard, Docker, active docs.
2. Separate live kill-switches/safety fallbacks from obsolete keys.
3. Remove dead key, parser/schema field, docs, tests together.
4. Re-run a zero-reference search; note intentional historical changelog hits.

Good report: reader inventory + why each retained key is live or each removed key unreachable.

## Fix, don't hide

Every bug fix, especially validation, error handling, timeouts, retries, capability checks.

1. State the cause as a mechanism first: "X reads Y, which is undefined/wrong when Z". Can't state it → still guessing, and a guess encoded in production outlives the symptom.
2. Classify the change. **Hiding** removes the report: deleting/widening a throw, loosening a validator, catching an exception, raising a timeout, adding a fallback, special-casing an input, pinning a fixture. **Fix** removes the cause. Hiding is fine only as a named temporary boundary with a removal condition.
3. Separate intended design from hiding. Capability degradation, operator-configured fallback, documented compatibility path = product behavior. Keep, name in a comment + layer doc, never describe as a bug fix.
4. For a guard/probe, ask what the *other* arm does before deleting. A check load-bearing for a partially-implemented dependency looks like defensive noise until that dependency runs.

Good report: stated mechanism, classification (fix / hiding / intended design), reproduction that fails before and passes after. A timeout bump / retry / schema loosening without a reproduction removes evidence, not a cause.

## Test with a goal, no search loops

Adding a test or stalled diagnosis.

1. A test asserts one **observable** behavior: result, boundary, error, transition, security invariant, persistence contract. Never "does not throw", never an implementation detail, never "the function was called".
2. Predict the failure *before* running. A test written before the cause is known encodes the buggy behavior and passes after the wrong fix.
3. Run once, read the result. Unpredicted failure = information: correct the model, then act. Re-running while nudging code is a search; each iteration costs more than one good probe.
4. Unexplained failure → change **what** you observe (raw vs parsed, request vs response, one provider vs one surface, stub vs pipeline). Never add the same log or assertion twice.
5. Prove it bites: break the fix → test fails on the intended assertion → restore → passes. A test that passes both ways proves nothing.

Good report: goal sentence, predicted failure, single run result, break-test outcome.

## Docs in sync

Every behavior, setting, route, provider, schema, worker, file-layout change.

1. Name the code authority + every active doc describing it.
2. Update the smallest authoritative docs in the same change; never copy implementation detail into `AGENTS.md`.
3. Remove dead links, stale counts, obsolete names, contradicted claims.
4. Cite symbols and paths, never line numbers — committed docs forbid line numbers (they drift on every edit). Line numbers are for throwaway reports only.
5. Keep historical changelog entries historical; correct active docs and env templates.

Good report: docs updated, links/counts checked, unresolved evidence stated instead of guessed.

## Bundled-provider coverage

Bundled providers added, removed, renamed, de-aliased.

1. Enumerate canonical identities from `RAW_BUNDLED_PROVIDER_METADATA` — not dashboard labels or aliases.
2. Keep every mirror in step: `BUNDLED_PROVIDER_IDS` + registered modules, `PROVIDER_CAPABILITIES` + `BUNDLED_PROVIDER_MODULES`, dashboard hand copies (display name, icon asset, section/free-tier sets).
3. Exclude BYOK/custom providers and removed aliases.
4. No file pins a provider *number*: the contract is set equality. Prove coverage with `test/providers/default-registry.test.ts` + `dashboard/test/provider-display-names-parity.test.ts` / `provider-lists-parity.test.ts`; confirm no stale id remains in any mirror.

Good report: identity source, mirrors checked, coverage test result, intentionally custom paths retained.

## Skill self-improvement

After a cleanup review, rejected change, or newly discovered drift class.

1. Lesson must be procedural/reusable, not a one-off implementation note.
2. Search the skill folder before adding; extend the closest owner instead of creating another file.
3. State trigger, required check, failure mode, expected evidence.
4. Keep examples tied to current repo authorities; update `AGENTS.md` only when the rule is required repo-wide.

Good report: repeated failure/drift class, owning section, why no competing file exists.

## Proved deadness

Every deletion; every guard/fallback branch proposed as redundant.

1. A symbol is not dead because grep finds only its declaration. Rule out interface dispatch, callback fields, re-exports, dynamic imports, test doubles, own-file use, dashboard copies.
2. For a guard/probe, ask what the *other* arm does first. A skipped transaction or advisory lock can be load-bearing for a partially-implemented dependency.
3. Easiest proof: delete, run `typecheck` + directly affected suites, read the failure. Green output is evidence; confident reading is not.
4. Wrong removal → restore **with a comment stating why it stays**. A silent restore invites the next agent to delete it again.

Good report: traced call chain, paths ruled out, typecheck/test output. A deletion claim without a traced chain is not evidence.

## How to report

For every invariant you applied:

```text
Check: <name>
Authority: <canonical file/symbol>
Scope: <files/surfaces checked>
Evidence: <search/test/command result>
Exceptions: <intentional compatibility/history, or none>
```

Run only the checks for the changed boundary first, then the repo baseline from the engineering skill. Never call a check satisfied from prose alone — evidence comes from current source, search results, generated artifacts, or executed checks.
