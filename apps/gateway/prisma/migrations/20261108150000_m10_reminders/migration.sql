-- CreateEnum
CREATE TYPE "reminder_schedule_status" AS ENUM ('active', 'paused', 'completed', 'cancelled');

-- CreateEnum
CREATE TYPE "caregiver_status" AS ENUM ('pending', 'verified', 'declined', 'removed');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "reminder_status" ADD VALUE 'snoozed';
ALTER TYPE "reminder_status" ADD VALUE 'skipped';

-- DropIndex
DROP INDEX "reminders_user_id_idx";

-- AlterTable
ALTER TABLE "caregivers" ADD COLUMN     "alerts_day" DATE,
ADD COLUMN     "alerts_today" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "invited_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "last_alert_at" TIMESTAMPTZ(6),
ADD COLUMN     "last_inbound_at" TIMESTAMPTZ(6),
ADD COLUMN     "status" "caregiver_status" NOT NULL DEFAULT 'pending';

-- Nothing before M10 wrote to `reminders`; the new NOT NULL columns need an empty table.
DELETE FROM "reminders";

-- AlterTable
ALTER TABLE "reminders" ADD COLUMN     "job_id" TEXT NOT NULL,
ADD COLUMN     "schedule_id" UUID NOT NULL,
ADD COLUMN     "snooze_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "wa_message_id" TEXT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "consecutive_misses" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "quiet_hours_end" TEXT NOT NULL DEFAULT '06:30',
ADD COLUMN     "quiet_hours_start" TEXT NOT NULL DEFAULT '22:30',
ADD COLUMN     "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata';

-- CreateTable
CREATE TABLE "reminder_schedules" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "medication_id" UUID NOT NULL,
    "times" TEXT[],
    "start_date" DATE NOT NULL,
    "end_date" DATE,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "status" "reminder_schedule_status" NOT NULL DEFAULT 'active',
    "renewal_notified_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reminder_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "reminder_schedules_medication_id_key" ON "reminder_schedules"("medication_id");

-- CreateIndex
CREATE INDEX "reminder_schedules_status_idx" ON "reminder_schedules"("status");

-- CreateIndex
CREATE INDEX "reminder_schedules_user_id_idx" ON "reminder_schedules"("user_id");

-- CreateIndex
CREATE INDEX "reminders_user_id_scheduled_at_idx" ON "reminders"("user_id", "scheduled_at");

-- CreateIndex
CREATE UNIQUE INDEX "reminders_schedule_id_scheduled_at_key" ON "reminders"("schedule_id", "scheduled_at");

-- AddForeignKey
ALTER TABLE "reminder_schedules" ADD CONSTRAINT "reminder_schedules_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reminder_schedules" ADD CONSTRAINT "reminder_schedules_medication_id_fkey" FOREIGN KEY ("medication_id") REFERENCES "medications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "reminder_schedules"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Backfill: a caregiver that already had verified_at is verified.
UPDATE "caregivers" SET "status" = 'verified' WHERE "verified_at" IS NOT NULL;
