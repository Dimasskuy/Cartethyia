
# K10 Skill self-improvement

Use after a cleanup review, rejected change, or newly discovered drift class.

## Required check

1. Confirm the lesson is procedural and reusable, not a one-off implementation note. A drift class that will recur belongs here; a single bug's fix belongs in a regression test.
2. Search existing `.skills/` files before adding or changing a skill; extend the closest owner instead of duplicating it. There is one Cartethyia skill for a reason — a second folder is always the wrong answer.
3. State the trigger, required check, failure mode, and evidence expected from the skill.
4. Register the guard in `AGENTS.md` when it is a required repository rule, and keep examples tied to current repository authorities.
5. **Keep the authority map true.** Every path, symbol, and script name cited in these references must exist in the repo, and a function cited as callable must be exported. A skill that names a path the repo deleted sends the next agent to the wrong file — verify before adding, and re-verify when a refactor moves things.

## Evidence

Report the repeated failure or drift class, the skill that owns it, and why no competing skill now exists.
