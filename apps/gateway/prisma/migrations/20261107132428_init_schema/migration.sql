-- Extensions first: Prisma can't declare them, and the trigram index below needs pg_trgm.
-- (docker-compose also creates them at first boot; IF NOT EXISTS keeps both paths safe.
--  pg_trgm and pgcrypto are "trusted" extensions, so a non-superuser DB owner can create them.)
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- CreateEnum
CREATE TYPE "language" AS ENUM ('hi', 'en');

-- CreateEnum
CREATE TYPE "message_direction" AS ENUM ('in', 'out');

-- CreateEnum
CREATE TYPE "message_type" AS ENUM ('text', 'image', 'document', 'audio', 'button', 'template');

-- CreateEnum
CREATE TYPE "document_kind" AS ENUM ('prescription', 'lab_report', 'unknown');

-- CreateEnum
CREATE TYPE "document_status" AS ENUM ('queued', 'processing', 'done', 'failed', 'needs_review');

-- CreateEnum
CREATE TYPE "relation_to_food" AS ENUM ('before', 'after', 'with', 'any');

-- CreateEnum
CREATE TYPE "reminder_status" AS ENUM ('pending', 'sent', 'taken', 'missed', 'cancelled');

-- CreateEnum
CREATE TYPE "interaction_severity" AS ENUM ('minor', 'moderate', 'major');

-- CreateEnum
CREATE TYPE "lab_sex" AS ENUM ('any', 'm', 'f');

-- CreateEnum
CREATE TYPE "audit_actor" AS ENUM ('user', 'system', 'admin');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "wa_phone_hash" TEXT NOT NULL,
    "wa_phone_enc" TEXT NOT NULL,
    "language" "language" NOT NULL DEFAULT 'hi',
    "consent_at" TIMESTAMPTZ(6),
    "last_inbound_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "caregivers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "wa_phone_enc" TEXT NOT NULL,
    "wa_phone_hash" TEXT NOT NULL,
    "relation" TEXT NOT NULL,
    "verified_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "caregivers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "direction" "message_direction" NOT NULL,
    "wa_message_id" TEXT NOT NULL,
    "type" "message_type" NOT NULL,
    "body_redacted" TEXT,
    "media_s3_key" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "documents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "kind" "document_kind" NOT NULL DEFAULT 'unknown',
    "s3_key" TEXT NOT NULL,
    "status" "document_status" NOT NULL DEFAULT 'queued',
    "extraction" JSONB,
    "overall_confidence" DECIMAL(4,3),
    "prompt_version" TEXT,
    "model" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "medications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "raw_name" TEXT NOT NULL,
    "drug_id" UUID,
    "salt" TEXT,
    "strength" TEXT,
    "form" TEXT,
    "dose" TEXT,
    "frequency_per_day" INTEGER NOT NULL,
    "timings" TEXT[],
    "relation_to_food" "relation_to_food" NOT NULL DEFAULT 'any',
    "duration_days" INTEGER,
    "start_date" DATE NOT NULL,
    "end_date" DATE,
    "confidence" DECIMAL(4,3) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "medications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reminders" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "medication_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "scheduled_at" TIMESTAMPTZ(6) NOT NULL,
    "status" "reminder_status" NOT NULL DEFAULT 'pending',
    "sent_at" TIMESTAMPTZ(6),
    "ack_at" TIMESTAMPTZ(6),

    CONSTRAINT "reminders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drugs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "brand_name" TEXT NOT NULL,
    "salt_composition" TEXT NOT NULL,
    "strength" TEXT NOT NULL,
    "form" TEXT NOT NULL,
    "pack_size" TEXT,
    "mrp" DECIMAL(10,2),
    "manufacturer" TEXT,
    "is_generic" BOOLEAN NOT NULL DEFAULT false,
    "janaushadhi_code" TEXT,
    "source" TEXT NOT NULL,

    CONSTRAINT "drugs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interactions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "salt_a" TEXT NOT NULL,
    "salt_b" TEXT NOT NULL,
    "severity" "interaction_severity" NOT NULL,
    "summary" TEXT NOT NULL,
    "source" TEXT NOT NULL,

    CONSTRAINT "interactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lab_tests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "aliases" TEXT[],
    "unit" TEXT NOT NULL,
    "ref_low" DECIMAL(65,30),
    "ref_high" DECIMAL(65,30),
    "sex" "lab_sex" NOT NULL DEFAULT 'any',
    "age_min" INTEGER,
    "age_max" INTEGER,
    "explanation_en" TEXT NOT NULL,
    "explanation_hi" TEXT NOT NULL,
    "source" TEXT NOT NULL,

    CONSTRAINT "lab_tests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "actor" "audit_actor" NOT NULL,
    "user_id" UUID,
    "action" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_wa_phone_hash_key" ON "users"("wa_phone_hash");

-- CreateIndex
CREATE INDEX "caregivers_wa_phone_hash_idx" ON "caregivers"("wa_phone_hash");

-- CreateIndex
CREATE UNIQUE INDEX "caregivers_user_id_wa_phone_hash_key" ON "caregivers"("user_id", "wa_phone_hash");

-- CreateIndex
CREATE UNIQUE INDEX "messages_wa_message_id_key" ON "messages"("wa_message_id");

-- CreateIndex
CREATE INDEX "messages_user_id_created_at_idx" ON "messages"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "documents_user_id_created_at_idx" ON "documents"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "documents_status_idx" ON "documents"("status");

-- CreateIndex
CREATE INDEX "medications_user_id_active_idx" ON "medications"("user_id", "active");

-- CreateIndex
CREATE INDEX "medications_document_id_idx" ON "medications"("document_id");

-- CreateIndex
CREATE INDEX "medications_drug_id_idx" ON "medications"("drug_id");

-- CreateIndex
CREATE INDEX "reminders_status_scheduled_at_idx" ON "reminders"("status", "scheduled_at");

-- CreateIndex
CREATE INDEX "reminders_user_id_idx" ON "reminders"("user_id");

-- CreateIndex
CREATE INDEX "reminders_medication_id_idx" ON "reminders"("medication_id");

-- CreateIndex
CREATE INDEX "drugs_salt_composition_strength_form_idx" ON "drugs"("salt_composition", "strength", "form");

-- CreateIndex
CREATE UNIQUE INDEX "interactions_salt_a_salt_b_key" ON "interactions"("salt_a", "salt_b");

-- CreateIndex
CREATE INDEX "lab_tests_code_idx" ON "lab_tests"("code");

-- CreateIndex
CREATE INDEX "audit_logs_user_id_idx" ON "audit_logs"("user_id");

-- CreateIndex
CREATE INDEX "audit_logs_action_created_at_idx" ON "audit_logs"("action", "created_at");

-- AddForeignKey
ALTER TABLE "caregivers" ADD CONSTRAINT "caregivers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "medications" ADD CONSTRAINT "medications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "medications" ADD CONSTRAINT "medications_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "medications" ADD CONSTRAINT "medications_drug_id_fkey" FOREIGN KEY ("drug_id") REFERENCES "drugs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_medication_id_fkey" FOREIGN KEY ("medication_id") REFERENCES "medications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written part (Prisma cannot express these)
-- ---------------------------------------------------------------------------

-- Fuzzy brand-name search ("dolo650" ~ "Dolo 650") used by drug_matcher (M8).
CREATE INDEX "drugs_brand_name_trgm_idx" ON "drugs" USING GIN ("brand_name" gin_trgm_ops);

-- Each interaction pair is stored exactly once, in canonical order (salt_a < salt_b).
-- Combined with the UNIQUE (salt_a, salt_b) index, "A+B" and "B+A" can never both exist.
ALTER TABLE "interactions"
  ADD CONSTRAINT "interactions_salt_order_check" CHECK ("salt_a" < "salt_b");

-- Read-only AI service role (CLAUDE.md §4): it may read ONLY the shared catalog tables,
-- never users, messages, documents, medications, reminders or caregivers.
-- The role is created by infra/docker/postgres/init/02-roles.sh locally; on RDS create it
-- manually (Terraform, M17). The guard keeps this migration runnable where the role doesn't exist (CI).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dawai_ai_ro') THEN
    GRANT SELECT ON TABLE "drugs", "interactions", "lab_tests" TO dawai_ai_ro;
  END IF;
END
$$;
