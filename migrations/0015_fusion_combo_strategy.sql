-- Fusion combo strategy: parallel panel fan-out + judge synthesis.
--
-- Adds the `fusion` label to `model_combo_strategy`. Per-strategy tuning
-- lives in `model_combos.config` (added by 0014); the fusion section holds
-- the judge model, quorum/grace/timeout knobs, and an optional judge-prompt
-- override.
--
-- The enum is rebuilt rather than `ALTER TYPE ... ADD VALUE` because the
-- migration runner executes each file inside a transaction, and Postgres
-- forbids adding an enum label in a transaction block. The guarded DO block
-- makes a second run a no-op. This mirrors
-- `0014_cascade_combo_strategy.sql`.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
     WHERE t.typname = 'model_combo_strategy'
       AND e.enumlabel = 'fusion'
  ) THEN
    -- Postgres cannot add an enum label in place inside a transaction, so
    -- the type is rebuilt. The column default is dropped first because it
    -- would otherwise block the type swap.
    ALTER TYPE "public"."model_combo_strategy" RENAME TO "model_combo_strategy_old";
    CREATE TYPE "public"."model_combo_strategy" AS ENUM('fallback', 'round_robin', 'cascade', 'fusion');

    ALTER TABLE "public"."model_combos"
      ALTER COLUMN "strategy" DROP DEFAULT,
      ALTER COLUMN "strategy" TYPE "public"."model_combo_strategy"
        USING "strategy"::text::"public"."model_combo_strategy";

    ALTER TABLE "public"."model_combos"
      ALTER COLUMN "strategy" SET DEFAULT 'fallback';

    DROP TYPE "public"."model_combo_strategy_old";
  END IF;
END
$$;
