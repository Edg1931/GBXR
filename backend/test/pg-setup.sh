#!/usr/bin/env bash
# Prepare a plain Postgres database to look enough like Supabase for the store tests:
# an auth schema with users and auth.uid(), then the real migration.
# Usage: PG_TEST_URL=postgres://... ./test/pg-setup.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
psql "$PG_TEST_URL" -v ON_ERROR_STOP=1 -q <<'SQL'
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key);
create or replace function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
SQL
psql "$PG_TEST_URL" -v ON_ERROR_STOP=1 -q -f "$here/../../supabase/migrations/20261124000000_init.sql"
