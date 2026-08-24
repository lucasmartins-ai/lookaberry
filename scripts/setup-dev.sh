#!/usr/bin/env bash
# LookaBerry — Local environment setup (PostgreSQL 16 + pgvector + Redis)
#
# Usage:
#   ./scripts/setup-dev.sh          # Start infra + run migrations + generate client
#   ./scripts/setup-dev.sh --down   # Stop infra containers
#   ./scripts/setup-dev.sh --reset  # Stop, remove volumes, and restart from scratch
#
# Requirements: Docker (with compose plugin), Node 20+

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

COMPOSE_CMD="docker compose"
if ! $COMPOSE_CMD version >/dev/null 2>&1; then
  COMPOSE_CMD="docker-compose"
fi

log()  { printf '\033[1;36m[setup-dev]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[setup-dev]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[setup-dev]\033[0m %s\n' "$*" >&2; exit 1; }

# ────────────────────────────── .env bootstrapping ──────────────────────────────

if [ ! -f .env ]; then
  log "No .env found — creating from .env.example"
  cp .env.example .env
fi

# Ensure DATABASE_URL points at the Dockerized PostgreSQL (port 5433)
if ! grep -q '^DATABASE_URL=' .env; then
  echo 'DATABASE_URL="postgresql://postgres:postgrespassword@127.0.0.1:5433/lookaberry?schema=public"' >> .env
  log "Added DATABASE_URL to .env"
fi

# ────────────────────────────── Commands ──────────────────────────────

case "${1:-}" in
  --down)
    log "Stopping infrastructure containers..."
    $COMPOSE_CMD down
    log "Done. Data volumes preserved."
    exit 0
    ;;
  --reset)
    log "Stopping and REMOVING volumes (data will be lost)..."
    $COMPOSE_CMD down -v
    ;;
esac

# ────────────────────────────── Start infrastructure ──────────────────────────────

log "Starting PostgreSQL 16 (pgvector) + Redis via Docker..."
$COMPOSE_CMD up -d

log "Waiting for PostgreSQL to accept connections..."
for i in $(seq 1 60); do
  if $COMPOSE_CMD exec -T postgres pg_isready -U postgres >/dev/null 2>&1; then
    break
  fi
  if [ "$i" -eq 60 ]; then
    fail "PostgreSQL did not become ready in time. Check: $COMPOSE_CMD logs postgres"
  fi
  sleep 1
done
log "PostgreSQL is ready."

log "Waiting for Redis to answer PING..."
for i in $(seq 1 30); do
  if $COMPOSE_CMD exec -T redis redis-cli ping 2>/dev/null | grep -q PONG; then
    break
  fi
  if [ "$i" -eq 30 ]; then
    fail "Redis did not become ready in time. Check: $COMPOSE_CMD logs redis"
  fi
  sleep 1
done
log "Redis is ready."

# ────────────────────────────── Verify pgvector ──────────────────────────────

log "Verifying pgvector extension availability..."
if ! $COMPOSE_CMD exec -T postgres psql -U postgres -d lookaberry -c \
  "CREATE EXTENSION IF NOT EXISTS vector; SELECT extversion FROM pg_extension WHERE extname='vector';" >/dev/null 2>&1; then
  fail "pgvector extension is NOT available. Ensure you use the pgvector/pgvector:pg16 image."
fi
log "pgvector OK."

# ────────────────────────────── Migrations + Prisma Client ──────────────────────────────

log "Installing Node dependencies (if needed)..."
if [ ! -d node_modules ]; then
  npm install
fi

log "Applying database migrations (idempotent)..."
npx prisma migrate deploy

log "Generating Prisma Client..."
npx prisma generate

log "Validating Prisma schema..."
npx prisma validate

# ────────────────────────────── Summary ──────────────────────────────

log ""
log "✅ Environment ready!"
log "   PostgreSQL (pgvector): 127.0.0.1:5433  (db: lookaberry, user: postgres)"
log "   Redis:                  127.0.0.1:6379"
log ""
log "Next steps:"
log "   npm run dev        # start the API + workers"
log "   npm test           # run the test suite"
log "   ./scripts/setup-dev.sh --down   # stop containers (keep data)"
log "   ./scripts/setup-dev.sh --reset  # stop and wipe all data"
