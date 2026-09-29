# Verification

Every change is verified at its real boundary before completion. This consolidates the checklist, bug-fix loop, pre-existing failure triage, and test-hygiene rules that previously lived in separate skills.

## Standard gates (in order)

```bash
bun run typecheck
bun run dashboard:typecheck
bun run dashboard:test
bun test test/                      # serial; do NOT use `bun run test` --parallel (exhausts Postgres)
```

For DB-gated suites, export `CARTETHYIA_TEST_DATABASE_URL` first (value in repo `.env`). Without it the `dbDescribe` suites are silently skipped.

Full gate when the change touches transport/provider/dashboard contracts:

```bash
bun run test:contracts
bun run build                      # dashboard -> AOT -> dist/cartethyia.exe
```

Report DB-gated skips separately from failures. Typecheck alone is never proof of a behavior change.

## Gotchas that actually bite

**Strict TS (`strict` + `exactOptionalPropertyTypes`).** Assigning `undefined` to an optional property raises TS2375/TS2379. Fix by widening (`readonly x?: string | undefined`) or conditionally spreading: `...(x !== undefined ? { x } : {})`. Applies to object literals passed as args, not just returns.

**DB-gated test filtering.** `dbDescribe` wraps a `beforeAll` that assigns the shared `db`. Running `bun test <file> -t "<filter>"` that excludes that setup leaves `db` undefined → `TypeError: undefined is not an object (db.insert)`. Run the whole file.

**Provider-id mirrors.** The dashboard cannot import backend modules, so sets like `RESET_PROVIDER_IDS` are text-compared against the backend predicate in `dashboard/src/provider-lists-parity.test.ts`. Add a case there when adding such a set.

**User-Agent / client versions.** Never hardcode. Codex → `getCodexVersion()` (`src/providers/operations/client-versions.ts`); use the cached getter, not `resolveCodexVersion()`. Claude → `CLAUDE_CODE_USER_AGENT` from `claude-fingerprint.ts`. Assert with `toMatch(/^codex_cli_rs\//)` / `/^claude-cli\//` in tests.

**Clean cutover.** No compatibility aliases, no dead branches, no mirrored second source of truth. If a value is derivable from one authority, delete the copy.

**Changelog.** Add an entry under the matching `###` section in `CHANGELOG.md` describing the behavior change and the exact routes/endpoints, not just "added feature".

## Bug-fix loop

1. **Reproduce against the real function before changing code.** Write a throwaway `.tmp-<topic>.ts` at the repo root (gitignored via `.tmp-*`) and run it with `bun .tmp-<topic>.ts`. Print the actual output — the real pipeline, not a hand-built stub. This step has found every real root cause in the repo; guessing has not.
2. **Expect existing tests to pin the buggy behavior.** Fixes repeatedly break assertions like `expect(assistant.reasoning_content).toBe("")` or a cooldown equal to the generic fallback. Updating those assertions is part of the fix; mention it in the commit. Never revert code to keep a stale assertion green. Time-dependent assertions build timestamps dynamically (`new Date(Date.now() + 10 * 3600_000)`), never hardcoded.
3. **Full gate before declaring done** (see above).
4. **Sync docs in the same change** (`src/transport/TRANSPORT.md`, `src/providers/PROVIDERS.md`, `src/network/NETWORK.md`, `src/console/CONSOLE.md`, `CHANGELOG.md`, `.env.example`, and this skill's references when a documented rule is reversed).
5. **Hand off:** `git add -A` — new source files are often untracked and `-a` misses them. `dist/` and `.env` are gitignored; `.env.example` is tracked. Tell the user the gateway must be restarted for transport/health changes to take effect.

## Reproducing wire/encoding bugs

When a bug shows up as an upstream 400/422 or malformed payload and the cause is not obvious from the stack, drive the **real** pipeline — not a reimplementation — from a `.tmp-<topic>.ts`:

1. **Parse the client surface** — `new MessagesAdapter().parse({ body, headers })` (or Chat/Responses adapter) with a realistic body: `thinking`, `tools`, completed tool rounds, follow-up user turn. A minimal body hides the bug.
2. **Apply the same repair passes the dispatcher does** — for the buddy family (`cb`/`cbcn`/`workbuddy`), `dropIncompleteToolRounds` runs **before** `repairRequestToolCalls`; every other route runs repair alone (see `src/transport/request/preparer.ts`).
3. **Encode for the target wire** — `canonicalToChatPayload(request)` / `canonicalToClaudeMessagesPayload(request)`, then the provider's `prePayload` hook (e.g. `workbuddyPrePayload(payload, request, candidate)`) since that is where system prompt, tool-name normalization, and reasoning fields land.
4. **Print the final `payload.messages` per turn** with `JSON.stringify`, plus reasoning/tool fields. Look for: `tool_calls` present while `role:"tool"` follows, `reasoning_content` on tool-call turns, empty-string vs absent fields, dangling results. Probe the whole space of turn shapes (assistant+toolCall+reasoning, reasoning-only, user-turn results, omitted-display thinking with empty text + signature) — the failing shape is often the one you did not think of.

**Fix rule:** if the same fact is re-derived in multiple call sites, do not patch the failing one. Hoist it next to the type it describes (e.g. `src/transport/canonical-model.ts`) and switch every consumer, then add one shared contract test (see `test/transport/translation/tool-result-placement.test.ts`). Prefer extending an existing invariant test over adding a one-off.

Gotchas:
- The Messages ledger re-homes tool results into `user` turns; a payload printed straight from `canonicalToChatPayload` without the repair passes can hide the bug.
- `git add -A` sweeps stray scratch/transcript files into a commit; check `git status` for `.tmp-*` and root `*.txt` before committing.
- Telemetry payload bodies are not stored by default, so a failed request id alone usually cannot be replayed — reproduce from a constructed body instead.

## Pre-existing test failure triage

When `bun test` reports failures and you must decide whether you caused them:

1. **Prove whether you caused it.** Stash only the files you touched, re-run just the failing tests:
   ```bash
   git stash push -m wip-check -- <changed src files>
   bun test <failing test file>
   git stash pop
   ```
   If it still fails, it pre-exists. Report that honestly in the commit message; prefer fixing it anyway.

2. **Locate the file from a test name.** `bun test <path>` errors if the path guess is wrong: `grep -rln "<exact test name>" test/`.

3. **Count-mismatch failures: check the migration ledger FIRST.** `test/integration/isolated-db.test.ts` asserts the live schema equals `src/persistence/schema.ts` and fails like `Expected length: 229 / Received length: 232`. Usually NOT a code bug — `applySqlMigrations` skips any file already in `cartethyia_schema_migrations`, so editing `drizzle/migrations/0000_baseline.sql` never re-runs on an existing database. Hand-written follow-ups live in `drizzle/migrations/manual/` and must be applied by hand to every database. Tell the user Railway/prod needs the same manual migration. Then diff actual vs expected columns scoped to the test's table list (`information_schema.columns` with `table_name = ANY($1::text[])`).

4. **Decide code bug vs stale test.** Read the implementation and the repo's own docs before assuming. If the code deliberately differs from the test's assertion AND that difference is documented, **the test is stale** — update it and assert the real behavior. If the test encodes a guard the code never implemented (e.g. `prepareNativeCompact` planning without checking `provider_allowlist`), that is a **real security gap** — add the gate; do not weaken the test.

5. **Verify:** `bun run typecheck && bun test` and aim for 0 failures. A 5-minute TTL on the in-memory version cache may hold a bad value; restart the gateway after a version-resolver fix.

## Mutation-check any new test

Every regression test is proven to have teeth: revert (or short-circuit) the fix, run the test, confirm it fails on the intended assertion, restore, confirm it passes. Report the mutation and the observed failure. This is the repo's standard — a green test that cannot fail is not a test.

## Delete probe/temp scripts

Remove every `.tmp-*` or `dashboard/tmp-*` before yielding. Leave no throwaway files in the tree.
