---
name: cartethyia-engineering
description: "Use for any Cartethyia repository development, debugging, refactor, provider, routing, schema, dashboard/API contract, live verification, feature removal, or skill-maintenance task. Start with the relevant procedure and finish with evidence-backed verification."
---

# Cartethyia Engineering

This is the single entry point for repository work. Use the smallest relevant
section below, then load the detailed reference named by that section. The
references preserve the full development and debugging procedures without
creating competing skills.

## Choose the procedure

| Work | Read first |
|---|---|
| Repository orientation, provider, version, schema, console-log, gates, removal, clean cutover, or consolidating duplicated logic | `references/development.md` |
| Dispatch failure, routing, proxy proof, tool calling, duplicates, live request, or local DB reset | `references/debugging.md` |
| Verifying a change, reproducing a wire bug, bug-fix loop, failing-test triage, or mutation-testing a regression | `references/verification.md` |
| Account / pool health classification, cooldown policy, model cooldown display, or tool-history repair ordering | `references/health-and-pool.md` |
| Telemetry payload decode, request failure trace, or abort-source elimination | `references/payload-and-tracing.md` |
| Dashboard chrome, social meta, share page, SSR or browser verification | `references/dashboard.md` |
| Adding / removing / BYOK / OAuth / handshake / live-verify a provider, account action, model catalog gap | `references/provider-lifecycle.md` |
| Schema migration, telemetry column, full-stack rename, model metadata, availability, in-flight leak, or reasoning replay | `references/schema-telemetry-catalog.md` |
| Repeated cleanup mistake, new drift class, or improving this skill | `references/self-improvement.md` |
| Any K1–K11 contract, architecture, provider, wire, schema, naming, dead-key, docs, deadness, suppression (K7b), test-loop (K7c), or skill guard | `references/guards.md` |

This is intentionally one discoverable Cartethyia skill. Use progressive
disclosure: load only the reference needed for the current task.

Read the detailed reference before editing the owned subsystem. It contains the
canonical authority map, procedures, pitfalls, commands, and verification
checklists. Do not copy those details into this entry point or into product
README files.

## The fast path (read this before you search)

The repository is large enough that a grep-and-read loop is the slowest way to
work and the most likely to end in a plausible guess. Navigate by authority
instead:

1. **Name the layer, not the file.** Every top-level `src/` folder has exactly
   one doc named for it (`src/transport/TRANSPORT.md`,
   `src/providers/PROVIDERS.md`, …). That doc is the index for its whole
   subtree. Read it before opening source.
2. **Ask the index, not the filesystem.** A `.codegraph/codegraph.db` index
   exists at the repo root. `codegraph_explore` returns the relevant symbols'
   verbatim source plus the call paths between them — including dynamic-dispatch
   hops grep cannot follow — in one call. Use it for "how does X work" and
   "who calls X". Reserve `Read` for a specific range, and `Grep` for a literal
   you already know.
3. **Re-verify indexed hits** when the file changed after the index's sync
   point. The index is a map, not an oracle.
4. **Find the owner before the fix.** One behavior has one canonical owner.
   Editing the nearest matching file is how a symptom gets suppressed instead of
   fixed (see "Fix or suppression" below).

Then load the reference for your section. Orientation costs a few minutes and
replaces an unbounded search.

## Mandatory operating loop

1. Set a concrete goal and acceptance criteria.
2. Set scope, protected surfaces, compatibility/data-safety boundaries, and
   required checks.
3. Read the target implementation, direct callers, relevant tests, and nearest
   canonical layer doc (one `*.md` per top-level `src/` folder, named for the
   layer).
4. Identify the authority file and the actual failure/contract boundary.
5. Make one evidence-producing action immediately: read, search, reproduce,
   edit, or run a focused command. Do not spend a turn on planning alone.
6. Implement the root fix in the canonical owner and migrate every caller.
7. Update active docs/configuration in the same change.
8. Verify the changed behavior at its real boundary, then run broader gates
   appropriate to the impact.
9. Audit acceptance criteria, stale names, aliases, dead code, and unverified
   areas before reporting completion.

## Fix or suppression

The most common way this repository gets worse is a change that makes a failure
stop being visible without removing its cause. Before you commit to an approach,
answer these four questions in writing:

1. **What is the cause?** If you cannot state it as a mechanism ("X reads Y,
   which is undefined when Z"), you are not ready to fix.
2. **Does my change remove the cause, or stop it being reported?** Removing a
   throw, loosening validation, widening a type, adding a fallback, raising a
   timeout, or catching an exception is suppression until proven otherwise.
3. **What does the other arm do?** For a guard, probe, or capability check, the
   branch you find "obviously dead" may be load-bearing for a partially
   implemented dependency. Check before deleting (K11).
4. **Is the degraded path the intended product behavior?** Capability
   degradation, an operator-configured fallback, and a documented
   compatibility boundary are legitimate design. Name them as such in a comment
   and in the layer doc; do not let them masquerade as a bug fix.

A workaround is acceptable only when it is a named release boundary with a
removal condition. Otherwise it is a defect you are adding.

## Test with a goal, not with a loop

A test is an assertion about a goal, not an exploration tool. Write the goal
first:

- State the **observable** behavior you expect (result, boundary, error,
  transition, security invariant, persistence contract — never "does not
  throw" or an implementation detail).
- State **how it fails today**, and why. If you cannot predict the failure, you
  have a hypothesis, not a test.
- Write the assertion, then run it **once**. A failing run that fails for the
  predicted reason is confirmation of your model. A failing run you did not
  predict is new information — read it, update the model, then change the code.
- Re-running the same test repeatedly while poking at the implementation is a
  search, not a verification, and it is the most expensive way to work. Change
  what you observe instead: raw bytes vs parsed, request vs response, one
  provider vs one surface.
- After the fix passes, **mutation-test it**: break the fix, confirm the test
  fails on the intended assertion, restore, confirm it passes.

## Deep-reasoning and loop control

This rule applies to DeepSeek and every other reasoning model. High reasoning
is useful for ambiguous architecture, security, data safety, difficult
reproduction, and research; it is wasteful for obvious edits.

- Take the first relevant tool action as soon as the target is known.
- After each tool result, choose the next evidence-producing action.
- Never restart the same thought cycle without new evidence.
- After two failed approaches, inspect the failure and change the approach.
- After three actions with no repository progress, report the concrete blocker
  instead of continuing speculative thought.
- A turn is not progress unless it reads/searches, edits, runs a command,
  fetches authoritative docs, asks a necessary question, or reports a blocker
  with evidence.

## External research

Use local source first. For APIs, versions, frameworks, protocols, or other
current facts: search authoritative sources, then fetch/read the actual result
before deciding. Search snippets are not evidence. Prefer primary docs,
specifications, source repositories, and papers. Cite fetched sources when the
final decision depends on them. Use the goal/task feature for multi-path
research and define confirmed, approximate, blocked, and unknown outcomes.

## Clean implementation boundary

Solve root causes. Do not suppress errors, loosen validation, pin fixtures,
special-case one input, swallow failures, or add a path-specific fallback to
make a symptom disappear. Temporary tests/scripts may exercise the real path
only; they must not bypass the failing layer or become production workarounds.

For a rename, move, new feature, or contract cutover:

1. Search every runtime, test, script, dashboard, docs, and configuration
   caller.
2. Change the canonical definition.
3. Migrate all callers.
4. Delete the obsolete export/path/implementation.
5. Search the old name again and prove only intentional history remains.

Never add an alias or forwarding shim merely to keep old imports compiling. A
compatibility boundary is allowed only when explicitly required, documented,
and given a removal condition.

Deletion claims need proof, not a grep: rule out interface dispatch, callback
fields, re-exports, dynamic imports, test doubles, use inside the declaring
file, and dashboard copies before removing a symbol — and for a guard or probe,
check what the other arm does before calling it noise. See K11 in
`references/guards.md`.

## Verification baseline

From the repository root, use the narrowest useful check first:

```bash
bun run typecheck
bun run test
bun run check:coverage
```

Dashboard/API contract changes also require:

```bash
bun run dashboard:typecheck
bun run dashboard:test
bun run test:contracts
```

Report DB-gated skips separately from failures. Typecheck alone is never proof
of a behavior change. UI work should be verified against the real browser or
HTTP surface when the browser runtime is available; state the limitation when
it is not.

## Repository-specific boundaries

- `src/` is production backend; tests belong under `test/`.
- `dashboard/` must remain browser-safe and must not import backend-only Elysia,
  database, filesystem, secret, or Node runtime dependencies.
- `scripts/` is flat with `ops-*`, `build-*`, and `ci-*` role prefixes.
- Do not add `index.ts` barrels. Use concrete modules and role filenames.
- Do not edit generated output manually; edit its source/generator.
- Typecheck/build must not require Buf, network access, or external generators.
- Preserve security boundaries and intentional provider wire bytes.
- Never commit, push, deploy, alter production data, or discard unrelated
  working-tree changes unless explicitly requested.

## Completion contract

Do not report done until the goal is checked against current evidence: all
acceptance criteria, callers, exports, tests, docs/configuration, generated
artifacts, and known failures. If incomplete, continue with the next useful
tool action or report the exact blocker and evidence needed to unblock it.
