#!/bin/sh
# Read-only role for the AI service (CLAUDE.md §4 ownership rule: the AI service never writes user data).
# The role is created here; the SELECT grants on the catalog tables (drugs, interactions, lab_tests)
# are applied by the Prisma init migration, because those tables don't exist yet at init time.
set -e

psql -v ON_ERROR_STOP=1 -v ro_password="${AI_RO_PASSWORD:-dawai_ai_ro}" \
  --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
SELECT 'CREATE ROLE dawai_ai_ro LOGIN PASSWORD ' || quote_literal(:'ro_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dawai_ai_ro')
\gexec

GRANT CONNECT ON DATABASE :"DBNAME" TO dawai_ai_ro;
GRANT USAGE ON SCHEMA public TO dawai_ai_ro;
SQL
