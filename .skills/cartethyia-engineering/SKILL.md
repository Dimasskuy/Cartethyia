---
name: cartethyia-engineering
description: "Use for any Cartethyia repository development, debugging, refactor, provider, routing, schema, dashboard/API contract, live verification, feature removal, or skill-maintenance task. Start with the relevant procedure and finish with evidence-backed verification."
---

# Cartethyia Engineering

Single entry point for repo work. Pick the row, read that reference, act.

| Work | Read first |
|---|---|
| Orientation, provider, version, schema, console-log, gates, removal, cutover, dedup | `references/development.md` |
| Dispatch failure, routing, proxy proof, tool calling, duplicates, live request, DB reset | `references/debugging.md` |
| Verify a change, reproduce a wire bug, bug-fix loop, failing-test triage, mutation-test | `references/verification.md` |
| Health classification, cooldown policy, model cooldown display, tool-history repair order | `references/health-and-pool.md` |
| Payload decode, request failure trace, abort-source elimination | `references/payload-and-tracing.md` |
| Dashboard chrome, social meta, share page, SSR or browser verification | `references/dashboard.md` |
| Add / remove / BYOK / OAuth / handshake / live-verify provider, account action, catalog gap | `references/provider-lifecycle.md` |
| Schema migration, telemetry column, full-stack rename, model metadata, availability, in-flight leak, reasoning replay | `references/schema-telemetry-catalog.md` |
| Cleanup mistake pattern, new drift class, improving this skill | `references/self-improvement.md` |
| K1–K11 contract, architecture, wire, naming, dead-key, docs, deadness, suppression (K7b), test-loop (K7c) | `references/guards.md` |

Load only the reference the task needs. It holds the authority map, procedure, pitfalls, commands, and checklist. Never copy those details here or into product READMEs.

## Fast path (before you search)

Grep-and-read loops are the slowest way in and end in plausible guesses. Navigate by authority instead:

1. **Name the layer.** Each top-level `src/` folder has one doc named for it (`src/transport/TRANSPORT.md`, `src/providers/PROVIDERS.md`, …) covering its whole subtree. Read it before opening source.
2. **Ask the index.** `.codegraph/codegraph.db` sits at the repo root. `codegraph_explore` returns the symbols' verbatim source plus call paths between them — including dynamic-dispatch hops grep misses — in one call. Use it for "how does X work" / "who calls X". `Read` for a known range, `Grep` for a known literal.
3. **Re-verify indexed hits** when the file changed after the index sync point. Map, not oracle.
4. **Find the owner before the fix.** One behavior, one canonical owner. Editing the nearest matching file is how symptoms get suppressed instead of fixed.

Then load the reference for your section.

## Operating loop

1. Goal + acceptance criteria.
2. Scope, protected surfaces, compatibility/data-safety boundaries, required checks.
3. Read target, direct callers, relevant tests, nearest layer doc.
4. Name the authority file and the failure/contract boundary.
5. Act immediately: read, search, reproduce, edit, or run a focused command. Never spend a turn on planning alone.
6. Fix the root cause in the canonical owner; migrate every caller.
7. Update active docs/configuration in the same change.
8. Verify the changed behavior at its real boundary, then run broader gates per impact.
9. Audit acceptance criteria, stale names, aliases, dead code, unverified areas before reporting.

## Fix or suppression

The common way this repo gets worse: a change that hides a failure without removing its cause. Answer in writing before committing to an approach:

1. **Cause?** State it as a mechanism ("X reads Y, which is undefined when Z"). Can't state it → not ready to fix.
2. **Fix or suppression?** Removing a throw, loosening validation, widening a type, adding a fallback, raising a timeout, catching an exception = suppression until proven otherwise.
3. **Other arm?** A guard/probe/capability branch that looks "obviously dead" may be load-bearing for a partially-implemented dependency. Check before deleting (K11).
4. **Intended design?** Capability degradation, operator-configured fallback, documented compatibility boundary = legitimate. Name it in a comment + layer doc; never masquerade it as a bug fix.

A workaround is acceptable only as a named release boundary with a removal condition. Otherwise it is a defect you are adding.

## Test with a goal, not a loop

- State the **observable** behavior first (result, boundary, error, transition, security invariant, persistence contract). Never "does not throw" or an implementation detail.
- State **how it fails today** and why. Can't predict it → hypothesis, not a test.
- Write the assertion, run **once**. Predicted failure = model confirmed. Unpredicted failure = new information; read it, update the model, then change code.
- Never re-run the same test while nudging code — that is a search. Change what you observe: raw vs parsed, request vs response, one provider vs one surface.
- After green, **mutation-test**: break the fix → test must fail on the intended assertion → restore → green.

## Reasoning and loop control

High reasoning fits ambiguous architecture, security, data safety, hard reproduction, research. Wasteful for obvious edits.

- First tool action as soon as the target is known.
- After each result, pick the next evidence-producing action.
- Never restart the same cycle without new evidence.
- Two failed approaches → inspect the failure, change approach.
- Three actions with no repo progress → report the concrete blocker with evidence.
- A turn counts only if it reads/searches, edits, runs a command, fetches authoritative docs, asks a necessary question, or reports a blocker with evidence.

## External research

Local source first. For APIs, versions, frameworks, protocols, current facts: search authoritative sources, fetch and read the actual page before deciding. Snippets are not evidence. Prefer primary docs/specs/source/papers. Cite fetched sources when the decision depends on them.

## Implementation boundary

Fix root causes. No error suppression, validation loosening, fixture pinning, single-input special-casing, failure swallowing, or path-specific fallback to hide a symptom. Throwaway tests/scripts exercise the real path only — never bypass the failing layer, never become production workarounds.

Rename / move / new feature / contract cutover:

1. Search every runtime, test, script, dashboard, docs, config caller.
2. Change the canonical definition.
3. Migrate all callers.
4. Delete the obsolete export/path/implementation.
5. Search the old name again; prove only intentional history remains.

No alias or forwarding shim to keep old imports compiling. Compatibility is allowed only when explicitly required, documented, with a removal condition.

Deletion needs proof, not grep: rule out interface dispatch, callback fields, re-exports, dynamic imports, test doubles, own-file use, dashboard copies — and for a guard/probe, check what the other arm does. See K11 in `references/guards.md`.

## Verification baseline

Narrowest check first, from the repo root:

```bash
bun run typecheck
bun run test
bun run check:coverage
```

Dashboard/API contract changes add:

```bash
bun run dashboard:typecheck
bun run dashboard:test
bun run test:contracts
```

Report DB-gated skips separately from failures. Typecheck alone never proves a behavior change. UI work: verify against the real browser/HTTP surface when available; state the limitation when not.

## Boundaries

- `src/` = production backend; tests under `test/`.
- `dashboard/` stays browser-safe: no Elysia, DB, filesystem, secret, or Node-only imports.
- `scripts/` flat, `ops-*` / `build-*` / `ci-*` prefixes.
- No `index.ts` barrels. Concrete modules, role filenames.
- Never hand-edit generated output; change its source/generator.
- Typecheck/build must not need Buf, network, or external generators.
- Preserve security boundaries and intentional provider wire bytes.
- Never commit, push, deploy, alter production data, or discard unrelated working-tree changes unless explicitly asked.

## Completion contract

Report done only when the goal checks out against current evidence: acceptance criteria, callers, exports, tests, docs/config, generated artifacts, known failures. Otherwise continue with the next useful tool action, or report the exact blocker and the evidence needed.
