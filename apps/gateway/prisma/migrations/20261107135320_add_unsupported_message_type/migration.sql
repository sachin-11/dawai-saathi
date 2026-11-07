-- AlterEnum
-- Inbound messages we do not process (sticker, location, video, ...) are still stored.
ALTER TYPE "message_type" ADD VALUE 'unsupported';

-- NOTE for future migrations: `prisma migrate dev` always proposes
--   DROP INDEX "drugs_brand_name_trgm_idx";
-- because Prisma cannot model the hand-written GIN trigram index from init_schema. That statement
-- was deliberately removed here. Delete it from every generated migration (see docs/modules/M1.md).
