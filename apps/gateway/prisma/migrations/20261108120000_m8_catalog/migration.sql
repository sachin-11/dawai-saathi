-- M8: medicine catalog keys, prices, salt aliases and the match fields on medications.
-- (The DROP INDEX "drugs_brand_name_trgm_idx" that Prisma proposes was removed on purpose: see M1/M2 notes.)

-- CreateEnum
CREATE TYPE "release_type" AS ENUM ('ir', 'sr', 'er', 'xr', 'cr', 'mr', 'dr', 'na');
CREATE TYPE "match_method" AS ENUM ('exact', 'trgm', 'vector', 'salt_written', 'none');

-- AlterTable drugs
ALTER TABLE "drugs"
  ADD COLUMN "brand_key" TEXT,
  ADD COLUMN "salt_key" TEXT,
  ADD COLUMN "strength_key" TEXT,
  ADD COLUMN "form_key" TEXT,
  ADD COLUMN "release_type" "release_type" NOT NULL DEFAULT 'na',
  ADD COLUMN "pack_qty" DECIMAL(10,2),
  ADD COLUMN "pack_unit" TEXT,
  ADD COLUMN "price_per_unit" DECIMAL(12,4),
  ADD COLUMN "price_source_date" DATE,
  ADD COLUMN "is_janaushadhi" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "source_ref" TEXT;

-- Idempotent seeding: one row per (source, source_ref).
CREATE UNIQUE INDEX "drugs_source_source_ref_key" ON "drugs"("source", "source_ref");
-- The generic finder's exact four-key lookup.
CREATE INDEX "drugs_salt_key_strength_key_form_key_release_type_idx"
  ON "drugs"("salt_key", "strength_key", "form_key", "release_type");
-- Fuzzy matching of brand names ("dolo650") and salt keys.
CREATE INDEX "drugs_brand_key_trgm_idx" ON "drugs" USING gin ("brand_key" gin_trgm_ops);
CREATE INDEX "drugs_salt_key_trgm_idx" ON "drugs" USING gin ("salt_key" gin_trgm_ops);
CREATE INDEX "drugs_brand_key_idx" ON "drugs"("brand_key");

-- CreateTable
CREATE TABLE "salt_aliases" (
  "alias" TEXT NOT NULL,
  "canonical" TEXT NOT NULL,
  CONSTRAINT "salt_aliases_pkey" PRIMARY KEY ("alias")
);

-- AlterTable medications: what the catalog match found (needed by the interaction checker, M11)
ALTER TABLE "medications"
  ADD COLUMN "salt_key" TEXT,
  ADD COLUMN "strength_key" TEXT,
  ADD COLUMN "form_key" TEXT,
  ADD COLUMN "release_type" "release_type",
  ADD COLUMN "match_score" DECIMAL(4,3),
  ADD COLUMN "match_method" "match_method";

-- The AI service stays read-only: it may read the new catalog table too.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dawai_ai_ro') THEN
    GRANT SELECT ON TABLE "salt_aliases" TO dawai_ai_ro;
  END IF;
END
$$;
