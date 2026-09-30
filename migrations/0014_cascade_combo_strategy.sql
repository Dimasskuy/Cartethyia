-- Cascade combo strategy: progressive escalation from cheap to capable models.
--
-- Adds the `cascade` label to `model_combo_strategy` and a `config` JSONB
-- column on `model_combos` for per-strategy tuning (cascade thresholds,
-- prompts, max stages). Strategies that don't read `config` ignore it.
--
-- The enum is rebuilt rather than `ALTER TYPE ... ADD VALUE` because the
-- migration runner executes each file inside a transaction, and Postgres
-- forbids adding an enum label in a transaction block. The guarded DO block
-- makes a second run a no-op. This mirrors
-- `0002_retire_degraded_health_status.sql`.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
     WHERE t.typname = 'model_combo_strategy'
       AND e.enumlabel = 'cascade'
  ) THEN
    -- Postgres cannot add an enum label in place inside a transaction, so
    -- the type is rebuilt. The column default is dropped first because it
    -- would otherwise block the type swap.
    ALTER TYPE "public"."model_combo_strategy" RENAME TO "model_combo_strategy_old";
    CREATE TYPE "public"."model_combo_strategy" AS ENUM('fallback', 'round_robin', 'cascade');

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

ALTER TABLE "public"."model_combos"
  ADD COLUMN IF NOT EXISTS "config" jsonb;
