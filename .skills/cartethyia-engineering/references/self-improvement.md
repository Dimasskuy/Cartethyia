
# Skill self-improvement

After a cleanup review, rejected change, or newly discovered drift class.

1. Lesson must be procedural and reusable, not a one-off implementation note. A recurring drift class belongs here; a single bug's fix belongs in a regression test.
2. Search existing `.skills/` files before adding or changing a skill; extend the closest owner instead of duplicating. One Cartethyia skill exists for a reason — a second folder is always the wrong answer.
3. State the trigger, required check, failure mode, and expected evidence.
4. Register the guard in `AGENTS.md` when it is a required repo rule; keep examples tied to current repo authorities.
5. **Keep the authority map true.** Every path, symbol, and script name cited here must exist in the repo, and a cited function must be exported. A skill naming a deleted path sends the next agent to the wrong file — verify before adding, re-verify when a refactor moves things.

Evidence: the repeated failure/drift class, the owning skill, why no competing skill now exists.
