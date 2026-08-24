# LookaBerry — Migration Guide

## Prerequisites

- PostgreSQL 16+ with `pgvector` extension installed
- Prisma CLI (`npx prisma`)

## Quick Start (Fresh Database)

```bash
# 1. Set DATABASE_URL
export DATABASE_URL="postgresql://postgres:postgrespassword@127.0.0.1:5433/lookaberry?schema=public"

# 2. Run all migrations (idempotent — safe to run multiple times)
npx prisma migrate deploy

# 3. Generate Prisma Client
npx prisma generate

# 4. (Optional) Seed with sample data
npm run db:seed
```

## Existing Databases (Upgrading)

The migration scripts are designed to be **idempotent** and safe for existing databases:

- All `CREATE TABLE` statements use `IF NOT EXISTS`
- All `CREATE INDEX` statements use `IF NOT EXISTS`
- All `CREATE TYPE` statements are wrapped in `DO $$ BEGIN ... EXCEPTION WHEN duplicate_object THEN NULL; END $$`
- All `ALTER TABLE ADD COLUMN` statements use `IF NOT EXISTS`
- Foreign key constraints are wrapped in `DO $$` blocks that check `pg_constraint`

### Common Issues & Solutions

#### P3005: "The database schema is not empty"

This happens when the database has tables that don't match Prisma's migration history. The solution depends on the scenario:

**Scenario A: Database was created with `prisma db push` (no migration history)**
```bash
# Mark the init migration as applied (it's idempotent and will no-op on existing tables)
npx prisma migrate resolve --applied 0_init

# Then apply remaining migrations
npx prisma migrate deploy
```

**Scenario B: Database was created with `prisma migrate dev` but some migrations failed**
```bash
# Check which migrations are in a failed state
npx prisma migrate status

# For each failed migration, resolve it as rolled-back so it can be retried
npx prisma migrate resolve --rolled-back <migration_name>

# Then re-apply
npx prisma migrate deploy
```

**Scenario C: Production database with unknown migration history**
```bash
# 1. Create a baseline of the current schema
npx prisma migrate diff \
  --from-empty \
  --to-schema-datamodel prisma/schema.prisma \
  --script > baseline.sql

# 2. Mark baseline migration as applied (do NOT run baseline.sql)
npx prisma migrate resolve --applied <baseline_migration_name>

# After baseline, normal migrations can be applied
```

#### Duplicate constraint errors

All FK constraints in the migration scripts check `pg_constraint` before adding:

```sql
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'constraint_name') THEN
    ALTER TABLE ... ADD CONSTRAINT ...;
  END IF;
END $$;
```

If you encounter `duplicate_object` on a constraint, it means the constraint already exists. The migration will skip it safely.

#### Partially applied migrations

Each migration file is self-contained and idempotent. If a migration fails mid-way:
1. Fix the underlying issue (e.g., start PostgreSQL, install pgvector)
2. `npx prisma migrate resolve --rolled-back <name>` to allow retry
3. `npx prisma migrate deploy` to re-apply

## Migration Order

| # | Migration | Description |
|---|-----------|-------------|
| 0 | `0_init` | Core schema: ICP profiles, companies, leads, campaigns, sequences, messages, HNSW indexes |
| 1 | `1_sprint2_intent_indexes` | Additional intent signal indexes |
| 2 | `2_sprint5_outreach` | Outreach sequences, accounts, lead-sequence many-to-many |
| 3 | `3_sprint6_analytics` | Campaign metrics, lead interaction feedback, interaction/sentiment types |
| 4 | `4_sprint1_entity_evidence_graph` | Entity graph: sources, people, identities, evidence tables, FK wiring |
| 5 | `5_sprint2_intent_providers` | Intent provider provenance, scoring inputs, deduplication |
| 6 | `6_sprint4_channel_abstraction` | Channel abstraction: channel_id columns + backfill |
| 7 | `s9-whatsapp-accounts` | WhatsApp execution, multi-account LinkedIn, phone/account status enums |
| 8 | `s10-campaign-engine` | Campaign engine: smart scheduling, branching, A/B testing, versioning, lead states |

## Production Deployment Checklist

- [ ] Backup database: `pg_dump $DATABASE_URL > backup_$(date +%Y%m%d).sql`
- [ ] Run `npx prisma migrate deploy` (non-destructive, idempotent)
- [ ] Run `npx prisma generate`
- [ ] Verify with `npx prisma validate`
- [ ] Check migration status: `npx prisma migrate status`
- [ ] Smoke test: `npm run test:smoke`

## Development Workflow

When making schema changes:

1. Edit `prisma/schema.prisma`
2. Run `npx prisma migrate dev --name <descriptive_name>` (this auto-generates the SQL)
3. Review the generated SQL for idempotency — add `IF NOT EXISTS` where needed
4. Commit both the SQL file and `schema.prisma`
5. Never edit already-applied migrations unless fixing an idempotency bug
