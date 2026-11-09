-- M13: spoken replies are opt-in per user (VOICE ON / VOICE OFF).
ALTER TABLE "users" ADD COLUMN "voice_replies" BOOLEAN NOT NULL DEFAULT false;
