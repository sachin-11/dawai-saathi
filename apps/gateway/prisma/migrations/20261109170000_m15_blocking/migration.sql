-- M15: abuse guard. A blocked user gets one notice; emergencies, DELETE and HELP still work.
ALTER TABLE "users" ADD COLUMN "blocked_until" TIMESTAMPTZ(6);
ALTER TABLE "users" ADD COLUMN "block_reason" TEXT;
