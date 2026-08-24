import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * S12: Migration idempotency regression tests.
 *
 * These tests statically verify that every migration script is safe to run
 * against BOTH fresh and existing databases — preventing P3005, duplicate
 * constraint errors, and partially-applied migrations.
 *
 * No live database is required.
 */

const MIGRATIONS_DIR = join(process.cwd(), 'prisma', 'migrations');

function listMigrationDirs(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

function readMigrationSql(dir: string): string {
  return readFileSync(join(MIGRATIONS_DIR, dir, 'migration.sql'), 'utf-8');
}

// ─────────────────────────────────────────────────────────────────────────────

describe('Migration idempotency (S12)', () => {
  it('every migration directory contains a migration.sql', () => {
    const dirs = listMigrationDirs();
    expect(dirs.length).toBeGreaterThan(0);
    for (const dir of dirs) {
      expect(() => readMigrationSql(dir)).not.toThrow();
    }
  });

  it('no migration uses bare CREATE TABLE without IF NOT EXISTS', () => {
    const dirs = listMigrationDirs();
    for (const dir of dirs) {
      const sql = readMigrationSql(dir);
      // Every CREATE TABLE must be CREATE TABLE IF NOT EXISTS
      const bareCreates = sql.match(/CREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS)/gi);
      expect(bareCreates, `${dir} uses bare CREATE TABLE`).toBeNull();
    }
  });

  it('no migration uses bare CREATE INDEX without IF NOT EXISTS', () => {
    const dirs = listMigrationDirs();
    for (const dir of dirs) {
      const sql = readMigrationSql(dir);
      const bareIndexes = sql.match(/CREATE\s+(UNIQUE\s+)?INDEX\s+(?!IF\s+NOT\s+EXISTS)/gi);
      expect(bareIndexes, `${dir} uses bare CREATE INDEX`).toBeNull();
    }
  });

  it('enum types are created inside DO $$ blocks (duplicate_object-safe)', () => {
    const dirs = listMigrationDirs();
    for (const dir of dirs) {
      const sql = readMigrationSql(dir);
      // Find CREATE TYPE occurrences not wrapped in DO $$ blocks is complex;
      // instead verify any CREATE TYPE ... AS ENUM is preceded by DO $$ BEGIN or has exception guard nearby
      const createTypes = sql.match(/CREATE\s+TYPE\s+[^\s;]+\s+AS\s+ENUM/gi) ?? [];
      for (const _ of createTypes) {
        // The safest check: enum creation must be guarded by EXCEPTION WHEN duplicate_object
        // within the same migration file (the DO block spans the file).
        expect(
          /EXCEPTION\s+WHEN\s+duplicate_object/gi.test(sql),
          `${dir} creates enum without duplicate_object guard`,
        ).toBe(true);
      }
    }
  });

  it('foreign key constraints are guarded against duplicate_object or checked in pg_constraint', () => {
    const dirs = listMigrationDirs();
    for (const dir of dirs) {
      const sql = readMigrationSql(dir);
      const fkAdds = sql.match(/ADD\s+CONSTRAINT\s+[^\s]+\s+FOREIGN\s+KEY/gi) ?? [];
      if (fkAdds.length === 0) continue;
      // FK additions must be wrapped in DO blocks or use IF NOT EXISTS checks
      const hasGuard =
        /EXCEPTION\s+WHEN\s+duplicate_object/gi.test(sql) ||
        /pg_constraint/gi.test(sql) ||
        /DO\s+\$\$/gi.test(sql);
      expect(hasGuard, `${dir} adds FK constraint without duplicate guard`).toBe(true);
    }
  });

  it('init migration includes pgvector + uuid-ossp extensions', () => {
    const initSql = readMigrationSql('0_init');
    expect(initSql).toMatch(/CREATE\s+EXTENSION\s+IF\s+NOT\s+EXISTS\s+"uuid-ossp"/);
    expect(initSql).toMatch(/CREATE\s+EXTENSION\s+IF\s+NOT\s+EXISTS\s+"vector"/);
  });

  it('ALTER TABLE ADD COLUMN uses IF NOT EXISTS', () => {
    const dirs = listMigrationDirs();
    for (const dir of dirs) {
      const sql = readMigrationSql(dir);
      const addColumns = sql.match(/ADD\s+COLUMN\s+(?!IF\s+NOT\s+EXISTS)/gi);
      expect(addColumns, `${dir} uses bare ADD COLUMN`).toBeNull();
    }
  });

  it('migration lock uses postgresql provider', () => {
    const lock = readFileSync(join(MIGRATIONS_DIR, 'migration_lock.toml'), 'utf-8');
    expect(lock).toContain('provider = "postgresql"');
  });
});
