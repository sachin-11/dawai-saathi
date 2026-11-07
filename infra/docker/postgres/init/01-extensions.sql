-- Runs once, when the data volume is first created (docker-entrypoint-initdb.d).
-- pg_trgm: fuzzy brand-name matching (drug_matcher, M8). pgcrypto: gen_random_uuid() + crypto helpers.
-- The Prisma init migration also runs CREATE EXTENSION IF NOT EXISTS, so managed Postgres (RDS, CI) works too.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
