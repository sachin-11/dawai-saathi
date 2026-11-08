-- M11: interaction checker. The curated core list lives in `interactions`; findings per user in
-- `medication_warnings`.

-- AlterTable
ALTER TABLE "interactions"
  ADD COLUMN "mechanism" TEXT,
  ADD COLUMN "effect_code" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "management_en" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "management_hi" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "hi_reviewed" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "evidence_level" TEXT,
  ADD COLUMN "source_ref" TEXT,
  ADD COLUMN "source_version" TEXT;

-- CreateEnum
CREATE TYPE "medication_warning_type" AS ENUM ('interaction', 'duplicate_ingredient');

-- CreateEnum
CREATE TYPE "medication_warning_status" AS ENUM ('active', 'acknowledged', 'resolved');

-- CreateTable
CREATE TABLE "medication_warnings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "type" "medication_warning_type" NOT NULL,
    "medication_ids" UUID[],
    "salt_a" TEXT NOT NULL,
    "salt_b" TEXT NOT NULL,
    "severity" "interaction_severity",
    "interaction_id" UUID,
    "status" "medication_warning_status" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "medication_warnings_pkey" PRIMARY KEY ("id"),
    -- a pair is stored once, in canonical order; a duplicate ingredient has salt_a = salt_b
    CONSTRAINT "medication_warnings_salt_order" CHECK ("salt_a" <= "salt_b")
);

-- CreateIndex
CREATE INDEX "medication_warnings_user_id_status_idx" ON "medication_warnings"("user_id", "status");

-- One ACTIVE warning per (user, type, pair): the same finding is never stored (or announced) twice.
-- Hand-written: Prisma cannot model a partial unique index.
CREATE UNIQUE INDEX "medication_warnings_active_uniq"
  ON "medication_warnings"("user_id", "type", "salt_a", "salt_b") WHERE "status" = 'active';

-- (The pair lookup is already served by the UNIQUE index interactions_salt_a_salt_b_key.)

-- AddForeignKey
ALTER TABLE "medication_warnings" ADD CONSTRAINT "medication_warnings_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "medication_warnings" ADD CONSTRAINT "medication_warnings_interaction_id_fkey"
  FOREIGN KEY ("interaction_id") REFERENCES "interactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The AI service stays read-only and only reads `interactions` (granted in the init migration); it
-- never touches `medication_warnings` (the gateway owns user state, CLAUDE.md §4).
