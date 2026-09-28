# Cartethyia Agent Contract

Operating contract for coding agents. Read once at the start of a task.
Sections 5–9 decide whether a change is acceptable; 2–4 are how to work;
10–16 are boundaries and the closing audit.

The intent behind every rule here is one thing: **leave the repository in a
state where the next reader can trust the code and the docs.** The rules are
defaults, not ceremonies. Apply judgment, and when a rule and the goal visibly
conflict, follow the goal and say in your report that you did.

## Section index

Titles are stable: other files cite a section by name or number. Renaming a
section means updating every citation.

| § | Title |
| --- | --- |
| 1 | Mission and priority |
| 2 | Required start-of-task protocol |
| 3 | Action gate and context budget |
| 4 | Research and web-source protocol |
| 5 | Hard implementation boundaries |
| 6 | Clean cutover: no aliases for new features |
| 7 | Real fix, and temporary-test limits |
| 8 | Proving deadness before deletion |
| 9 | Evidence discipline (9.1–9.6) |
| 10 | Repository boundaries |
| 11 | TypeScript and implementation rules |
| 12 | Tests and verification |
| 13 | Documentation and configuration currency |
| — | Required guard registry |
| 14 | Deletion and data safety |
| 15 | Completion contract |
| 16 | Default execution loop |

Companion documents: `README.md` / `.env.example` (product + runtime config),
`ARCHITECTURE.md` (repo map), `CONTRIBUTING.md` (human workflow), and one layer
doc per top-level `src/` folder named for the layer
(`src/transport/TRANSPORT.md`, `src/providers/PROVIDERS.md`).

## 1. Mission and priority

Implement the change and prove its observable behavior. Do not stop at advice
when the work is reachable.

1. User request and acceptance criteria.
2. Data safety, security, public-contract preservation.
3. Correct root fix integrated through every caller.
4. Evidence from current source, tests, commands, docs.
5. Maintainability and conventions.
6. Brevity of the patch.

A shorter patch is not better if it leaves dead code, stale imports, fragile
fallbacks, or an unverified contract. Equally, a longer patch is not better for
its own sake — do not expand scope to satisfy a checklist item.

## 2. Required start-of-task protocol

For non-trivial work, before extended reasoning:

1. Goal in one sentence.
2. Concrete acceptance criteria.
3. Hard constraints and protected surfaces.
4. Read the target, direct callers, relevant tests, and nearest layer doc.
   If the target is unknown, search immediately.
5. One concrete tool action before more prose.

Use the goal/task feature for multi-step work. For a one-file or obvious edit,
read, edit, and run the smallest useful check — do not build a plan.

Scale this to the task. A typo fix does not need a written goal; a routing
change does. The point of the protocol is that you act on evidence rather than
on a mental model of the code.

## 3. Action gate and context budget

**A turn counts only when it acts:** read a file/symbol, search a caller or
config, edit source, run a targeted command/test/reproduction, fetch
authoritative docs, ask one necessary question, or report a concrete blocker
with evidence.

Never spend consecutive turns only restating the plan, describing intent,
listing hypothetical approaches, or deliberating without a tool call. If the
next action is clear, do it. After two failed approaches, inspect the failure
and change approach. After three no-progress actions, report the exact blocker.

**Spend context deliberately.**

- Reach for the index first: if `.codegraph/` exists, `codegraph_explore`
  answers most "how/where/what calls X" questions in one call. Reserve `Read`
  for a specific range the index cannot surface.
- Delegate wide, independent searches to a subagent; keep a single known file
  local.
- Break long work into verifiable pieces; land and verify one before the next.
- Do not paste source you already read — quote the line, symbol, or diff.
- Match the report to the reader: evidence plus decisions, not a walkthrough.

**Match reasoning effort to the problem.** Use low/normal reasoning for
straightforward edits; reserve high for ambiguous architecture, security, data
safety, or hard debugging. Even then, take the first tool action immediately
after identifying the target, and after every tool result choose the next
evidence-producing action.

**Failure patterns worth avoiding** (observed, not hypothetical):

- Re-instrumenting the same path more than once. If a tap/log did not show the
  cause, change what you observe (raw bytes vs parsed, request vs response) or
  read the code that transforms it.
- Restart/reload loops. Confirm the process actually picked up the change
  (version, a log line) before re-running; a hot-reload that silently missed
  the edit wastes a whole cycle.
- Running a broad harness when one targeted probe answers the question. Test
  the single model/case in question first; only widen after the cause is known.
- Adding a test before the cause is understood, then re-running it to "see".
  A test is for the confirmed fix, not for exploration.
- Reporting a plan, a hypothesis, or an unchanged state as progress. State only
  what a tool produced.

## 4. Research and web-source protocol

Local source first. Do not web-search what the repository already answers.

For external or time-sensitive facts: search for the primary source, fetch and
read the actual page (snippets are not evidence), prefer official docs/specs/
source over summaries, extract the exact behavior, apply it, verify locally,
and cite the fetched source when the answer depends on it. If a page cannot be
fetched, say so and use a second source or mark the claim unverified.

## 5. Hard implementation boundaries

**Root rule, applied by §6 and §7 rather than restated: fix the cause, never
the symptom.** A change that makes a failure disappear without removing its
cause is a defect in the change.

- Do not suppress errors, special-case one input, loosen validation, swallow
  exceptions, pin a fixture, or add a path-specific fallback to hide a symptom.
- Do not add a workaround, compatibility path, fake fallback, or dead-code
  escape hatch for a new feature or bug fix.
- Do not add retries, caching, telemetry, validation, abstraction, migration,
  or compatibility behavior "while here" unless the contract or verified
  failure requires it.
- Preserve observable public behavior, security boundaries, and intentional
  upstream wire bytes unless the goal says otherwise.
- Keep unrelated working-tree changes untouched.
- Never use destructive git commands (`reset --hard`, `checkout --`, `clean`,
  or equivalent) to discard work.
- Do not commit, push, deploy, alter production resources, or delete user data
  unless explicitly requested.
- Do not hand-edit generated output; change its source/generator and run the
  documented command.
- Never leave a stub, fake, TODO implementation, debug logging, or misleading
  placeholder in production code.

The spirit of this section is narrower than a literal reading: the ban is on
*hiding a cause*, not on legitimate design. A deliberate capability-degradation
path, a documented fallback an operator configures, and a guard for a
partially-implemented dependency are all normal engineering — each is fine when
it is the intended behavior and is named as such. What is never fine is a
branch whose only purpose is to make a known failure stop being visible.

## 6. Clean cutover: no aliases for new features

When adding, renaming, moving, or replacing a feature/API/symbol/module:

1. Identify every caller, import, export, test, doc, script, and config ref.
2. Change the canonical definition.
3. Migrate every caller.
4. Delete the obsolete symbol/path/export unless an explicit release boundary
   requires it.
5. Search again for the old name; prove only intentional historical refs remain.
6. Run the affected tests and typecheck.

Never alias to keep old imports compiling, never forward a new function to an
old name, never leave the old implementation as dead code.

```ts
// Forbidden: new feature behind an old name.
export const newFeature = oldFeature;
// Forbidden: forwarding shim.
export function oldName(...args: Args) { return newName(...args); }
```

If compatibility is genuinely required, it must be an explicit release boundary
named in the task, documented in the layer doc, with a removal condition.
Otherwise migrate and remove.

A `CHANGELOG.md` entry or a historical doc mentioning the old name is not a
caller; leave history historical and correct the active docs instead.

## 7. Real fix, and temporary-test limits

A temporary test or script is allowed only when it executes the real affected
path and proves the real fix. §5 applies in full. It must never mock away the
defect, hardcode success, disable validation/security, replace required
integration, create an alias, or remain as fake production behavior.

For a bug fix:

1. Reproduce the failure or establish the failing invariant.
2. Read the implementation and direct callers.
3. Fix the root cause.
4. Rerun the same reproduction.
5. Keep a regression test when suitable infrastructure exists.
6. Remove throwaway artifacts.

A passing temporary script is evidence only for the path it ran.

## 8. Proving deadness before deletion

Removal claims must be *proved*, not pattern-matched. A symbol is not dead
because grep finds only its declaration. Before deleting, rule out: interface/
abstract members, callback and hook fields, re-exports, dynamic imports, test
doubles (a partially-implemented fake is still a consumer), own-file use (an
exported helper used only in its file is not dead), and dashboard/doc copies.

For a *guard* (`typeof x === "function"`, a capability probe, a fallback
branch), ask what the other arm does — it can be load-bearing for a
partially-implemented dependency.

Prefer the experiment: delete the symbol, run `typecheck` and the affected
suites, read what fails. When a removal turns out wrong, restore it **with a
comment stating why it stays**.

Report the chain, not just the conclusion:

```text
Deletion: <symbol> in <file>
Ruled out: interface dispatch, callback field, re-export, dynamic import,
           test double, own-file use, dashboard copy
Evidence: <search results + typecheck/test output>
```

This applies to symbols *reachable from the change*. Do not treat it as a
licence to audit unrelated code that nobody asked about.

## 9. Evidence discipline

### 9.1 Derive facts from source; never restate them from memory

Every number, status, mapping, or count in a comment, doc, or report must come
from reading the source. Prefer a throwaway script that extracts the fact over
prose that asserts it. A table generated this way cannot drift on the day it is
written; a hand-written one usually already has.

### 9.2 Measure before recommending

Do not recommend a change to a hot path, pool size, cache, or error mapping
without observing current behavior. If the measurement contradicts the
proposal, report the contradiction — do not soften it.

### 9.3 Prove a new test has teeth (mutation test)

For every regression test: break the fix, run the test, confirm it **fails on
the intended assertion**, restore the fix, confirm it passes. Report the
mutation and the observed failure. Verify the restore actually took effect.

### 9.4 Trace the blast radius of a shared contract

Before changing a shared mapping, code, flag, or envelope field, search for
everything that **branches on it** — a change to a value changes every decision
made from it. Ask: what reads this field and what does it decide? Does it flip
a retry, cooldown, rotation, or security outcome? Does it move work between
layers? Which tests pin the old value — a contract or a fixture? State the
answer before editing.

### 9.5 Correct your own wrong claims in place

When a claim you made turns out false, correct it where it stands and say what
is true. Mark it:

```markdown
> **Correction.** The premise above is wrong. Verification found <X>; the truth
> is <Y>.
```

### 9.6 Report the shape of the evidence

Distinguish what was **executed** (command, test, probe + output), what was
**read** (file:line + what it establishes), and what is **unverified/skipped/
blocked** with the reason. Never present a read as a run or a plan as a result.
"The tests pass" means you ran them this turn.

## 10. Repository boundaries

- `src/` is production backend code only; backend tests live in `test/`. The
  exception is a script's own co-located `scripts/<name>.test.ts`.
- `dashboard/src/` is production browser code; tests mirror it under
  `dashboard/test/`, with shared scaffolding in `dashboard/test/helpers/`.
- Browser code must not import backend modules that pull in Elysia, DB drivers,
  filesystem, secrets, or Node-only runtime deps.
- `scripts/` is flat, using role prefixes (`ops-*`, `build-*`, `ci-*`).
- `test/` is the backend test source of truth; cross-cutting suites live under
  `test/contracts`, `test/integration`, `test/architecture`, `test/frontend`,
  `test/helpers`.
- Committed protobuf (`src/providers/integrations/*/generated/`) is build
  input; normal typecheck/build must not need Buf, network, or codegen.
- Import concrete modules directly. No `index.ts` barrels.
- Entity dirs use role files: `contracts.ts`, `routes.ts`, `store.ts`,
  `service.ts`, `errors.ts`.
- Keep protocol parsing, encoding, adapters, and errors separated.

These describe the shape the repo actually has. A new folder that fits none of
them is a reason to update this list, not a violation.

## 11. TypeScript and implementation rules

Backend (`tsconfig.json`, covering `src/`, `test/`, `scripts/`) is strict with
exact optional properties, unchecked-index safety, isolated modules, verbatim
module syntax, and unused-local checks. Dashboard sets its own subset (strict,
unchecked index, isolated modules, unused locals/params) — no
`exactOptionalPropertyTypes` or `verbatimModuleSyntax`.

- Use `import type` for type-only imports.
- Prefer `unknown` plus explicit narrowing at boundaries.
- No `any`, suppression directives, needless assertions, or weakened settings
  without a documented reason.
- Keep exported APIs explicitly typed.
- Comments explain policy, security, protocol, or a non-obvious tradeoff.
- Never name an external reference project in production code, a test name, a
  shipped doc, or a commit message. State the behavior and why it must hold.
  Keep comments self-contained.
- Treat network responses, env vars, DB rows, request bodies, and user values as
  untrusted. Security boundaries fail closed.
- Preserve intentional upstream wire bytes; do not normalize or reorder provider
  payloads unless the protocol requires it.
- Keep one source of truth for provider metadata, persisted contracts, env
  names, and dashboard mirrors.

## 12. Tests and verification

Tests assert observable behavior: results, boundaries, errors, transitions,
security invariants, persistence contracts, or explicit layout contracts. Do
not add tests for implementation details, source text, or "does not throw".

Do not delete a valid test to make a suite pass. If behavior is removed, remove
only redundant coverage and preserve the contract.

Run the narrowest useful check first, then expand by impact. Standard gates:

```bash
bun run typecheck
bun run test
bun run check:coverage
```

Dashboard or API-contract changes also require:

```bash
bun run dashboard:typecheck
bun run dashboard:test
bun run test:contracts
```

Focused backend tests:

```bash
bun run scripts/ops-run-tests.ts test/console
bun run scripts/ops-run-tests.ts test/providers/integrations/codex
```

Report DB-gated skips separately from failures. Never claim a command passed
unless executed. For UI changes use the real browser surface; for CLI/TUI,
launch and exercise it — but if that surface is genuinely unavailable, say so
explicitly rather than implying you verified visually. Do not declare
completion from typecheck alone.

## 13. Documentation and configuration currency

Documentation is part of the change — the doc that describes what you changed.

- `README.md` is product/runtime usage.
- `.env.example` documents every literal `process.env.*` read; drift test is
  `test/config-env-drift.test.ts`, derived from `CONFIG_SPEC` in `src/config.ts`.
- Do not add an env var to bound an in-process cache or tune an internal safety
  margin — use a constant beside the code or a constructor parameter. Env is for
  deployment settings. A new knob is one `CONFIG_SPEC` row plus a `.env.example`
  line, or the drift test fails.
- `ARCHITECTURE.md` is the repo map with canonical paths.
- Each top-level `src/` folder documents its subtree in one layer doc named for
  the layer (`src/transport/TRANSPORT.md`), so no two docs share a basename.
  Subfolders fold into the parent doc. Only the repo root, `dashboard/`, and
  `migrations/` keep `README.md`.
- `CONTRIBUTING.md` is human setup/workflow.
- `.skills/cartethyia-engineering` is the single dev/debugging/guard skill. Read
  the relevant reference before subsystem work; guards K1–K11 live in
  `references/guards.md`.

- A new route group, provider capability, env var, DB table, generated
  contract, or persisted envelope requires source, tests, layer doc, and
  config/migration updates together.
- A move/rename requires updated imports, tests, docs, map, and naming-contract
  tests.
- Do not document volatile test counts, line numbers, dependency versions,
  generated hashes, secrets, or temporary debug output. State the invariant a
  count expresses instead of the count, or cite the test that pins it.
- If code and docs disagree, inspect the code and fix stale docs in the same
  change unless the code is the defect.

Update the docs that your change made wrong. Do not rewrite a layer doc you
were not working in, and do not paste implementation detail into `AGENTS.md` —
it belongs in the layer doc beside the code.

## Required guard registry

Owned by `.skills/cartethyia-engineering/references/guards.md`:

- K1 no compatibility aliases
- K2 single source of truth
- K3 provider registry authority
- K4 provider wire bytes
- K5 canonical naming/location
- K6 persisted envelope/version boundaries
- K7 dead keys and branches
- K7b no suppression, no workaround
- K7c goal-first testing, no search loops
- K8 documentation synchronization
- K9 bundled-provider coverage
- K10 reusable skill self-improvement
- K11 proved deadness before deletion

Report the applied guard and evidence in the change summary. Do not create a
second skill or guard folder.

Apply the guard that the change actually implicates; a one-line typecheck fix
does not need a K1 report.

## 14. Deletion and data safety

Before deleting a file, symbol, dependency, script, env key, or table:

1. Search callers in `src`, `test`, `dashboard`, `scripts`, package files,
   Docker files, and active docs.
2. Check setup, build, typecheck, migrations, container refs.
3. Remove all callers in the same change; no silent alias.
4. Run the affected checks.

For DB/production operations, verify the target environment first; use a
transaction, backup, dry run, or reversible migration where practical. Never
expose credentials, tokens, keys, or sensitive payloads in output.

## 15. Completion contract

Before reporting completion, audit against current evidence:

- every acceptance criterion satisfied;
- every affected caller/import/export migrated;
- obsolete aliases, shims, dead implementations removed;
- the changed behavior exercised at its real boundary;
- required tests/checks actually executed;
- active docs/config match the source;
- failures, skips, blockers, unverified areas reported honestly.

If incomplete, do not call it complete. Continue with the next useful tool
action, or report the exact blocker and the evidence needed.

## 16. Default execution loop

```text
set goal + constraints
→ read target + callers + tests + layer doc
→ make one evidence-backed decision
→ edit the canonical implementation
→ migrate callers and remove old paths
→ run the real targeted check
→ inspect failures and fix the root cause
→ update docs/configuration
→ run broader gates required by impact
→ audit acceptance criteria and report evidence
```

For straightforward work, skip planning and follow the loop immediately. For
research or multi-step work, use the goal/task features — never as a substitute
for tool action.
