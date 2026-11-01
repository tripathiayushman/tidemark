#!/usr/bin/env bash
# Applies supabase/migrations to the Tidemark project ONLY (ref pinned below),
# using the project-scoped DB password from .env.local — no account-wide token.
set -euo pipefail
cd "$(dirname "$0")/.."
REF="zjaauejhpkwfewdilzlv"
PASS=$(grep -E '^SUPABASE_DB_PASSWORD=' .env.local | cut -d= -f2-)
[ -n "$PASS" ] || { echo "SUPABASE_DB_PASSWORD is empty in .env.local" >&2; exit 1; }
ENC=$(python3 -I -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1],safe=""))' "$PASS")
supabase db push --db-url "postgresql://postgres:${ENC}@db.${REF}.supabase.co:5432/postgres" "$@"
