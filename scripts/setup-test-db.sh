#!/usr/bin/env bash
# Creates the dedicated e2e database (triage_test) and applies migrations to it.
# Separate database, same container: the e2e suite truncates tables, which is
# not something you want pointed at a dev database by accident.
set -eo pipefail

if [ -f .env ]; then set -a; . ./.env; set +a; fi
DB_PORT="${DB_PORT:-5433}"

CONTAINER="$(docker compose ps -q db)"
if [ -z "$CONTAINER" ]; then
  echo "Postgres is not running. Start it with: docker compose up -d db" >&2
  exit 1
fi

if ! docker exec "$CONTAINER" psql -U triage -d triage -tAc \
  "SELECT 1 FROM pg_database WHERE datname='triage_test'" | grep -q 1; then
  docker exec "$CONTAINER" createdb -U triage triage_test
  echo "created database triage_test"
fi

DATABASE_URL="postgresql://triage:triage@localhost:${DB_PORT}/triage_test?schema=public" \
  pnpm prisma migrate deploy
