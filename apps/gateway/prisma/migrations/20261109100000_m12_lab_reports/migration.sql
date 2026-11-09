-- M12: lab report explainer. Reference data columns on `lab_tests` and one row per result in `lab_results`.

-- AlterTable
ALTER TABLE "lab_tests"
  ADD COLUMN "section" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "unit_conversions" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "critical_low" DECIMAL(65,30),
  ADD COLUMN "critical_high" DECIMAL(65,30),
  ADD COLUMN "doctor_questions_en" TEXT[],
  ADD COLUMN "doctor_questions_hi" TEXT[],
  ADD COLUMN "qualitative_normal" TEXT[],
  ADD COLUMN "hi_reviewed" BOOLEAN NOT NULL DEFAULT false;

-- CreateEnum
CREATE TYPE "lab_result_status" AS ENUM ('normal', 'high', 'low', 'borderline', 'critical_high', 'critical_low', 'qualitative_abnormal', 'unknown');

-- CreateTable
CREATE TABLE "lab_results" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "test_code" TEXT,
    "value_num_canonical" DECIMAL(65,30),
    "unit_canonical" TEXT,
    "value_raw" TEXT NOT NULL,
    "unit_raw" TEXT,
    "status" "lab_result_status" NOT NULL,
    "report_date" DATE,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lab_results_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "lab_results_user_id_test_code_report_date_idx" ON "lab_results"("user_id", "test_code", "report_date");

-- CreateIndex
CREATE INDEX "lab_results_document_id_idx" ON "lab_results"("document_id");

-- AddForeignKey
ALTER TABLE "lab_results" ADD CONSTRAINT "lab_results_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lab_results" ADD CONSTRAINT "lab_results_document_id_fkey"
  FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The AI service stays read-only: its SELECT grant on `lab_tests` (init migration) covers the new columns,
-- and it has NO grant on `lab_results` (the gateway owns user state, CLAUDE.md §4).
