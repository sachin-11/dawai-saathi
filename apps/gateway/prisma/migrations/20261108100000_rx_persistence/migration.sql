-- M7: prescription persistence.
-- (The DROP INDEX "drugs_brand_name_trgm_idx" that Prisma proposes was removed on purpose: see M1/M2 notes.)

-- As-needed (SOS) medicines have no per-day frequency.
ALTER TABLE "medications" ADD COLUMN "as_needed" BOOLEAN NOT NULL DEFAULT false,
ALTER COLUMN "frequency_per_day" DROP NOT NULL;

-- One document per inbound message: re-processing the same WhatsApp message cannot duplicate it.
CREATE UNIQUE INDEX "documents_message_id_key" ON "documents"("message_id");
