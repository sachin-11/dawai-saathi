-- CreateEnum
CREATE TYPE "onboarding_step" AS ENUM ('language', 'consent', 'done');

-- (The DROP INDEX "drugs_brand_name_trgm_idx" that Prisma proposes was removed on purpose: see M1/M2 notes.)

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "consent_version" TEXT,
ADD COLUMN     "onboarding_step" "onboarding_step" NOT NULL DEFAULT 'language',
ADD COLUMN     "reminders_enabled" BOOLEAN NOT NULL DEFAULT true;

-- Users who already accepted consent before this migration are fully onboarded.
UPDATE "users" SET "onboarding_step" = 'done', "consent_version" = COALESCE("consent_version", 'v1')
WHERE "consent_at" IS NOT NULL;
