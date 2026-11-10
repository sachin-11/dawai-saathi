-- M16: admin review queue verdicts (operator label per document; the e-mail is only in the audit row)
CREATE TYPE "review_label" AS ENUM ('correct', 'extraction_wrong', 'unreadable', 'not_a_document');
ALTER TABLE "documents" ADD COLUMN "review_label" "review_label";
ALTER TABLE "documents" ADD COLUMN "reviewed_at" TIMESTAMPTZ(6);
ALTER TABLE "documents" ADD COLUMN "reviewed_by_hash" TEXT;
CREATE INDEX "documents_review_idx" ON "documents" ("status", "reviewed_at");
