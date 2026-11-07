-- CreateEnum
CREATE TYPE "delivery_status" AS ENUM ('sent', 'delivered', 'read', 'failed');

-- (The DROP INDEX "drugs_brand_name_trgm_idx" that Prisma proposes was removed on purpose: see M1/M2 notes.)

-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "delivery_status" "delivery_status",
ADD COLUMN     "error_code" TEXT,
ADD COLUMN     "status_updated_at" TIMESTAMPTZ(6);
