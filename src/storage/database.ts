import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AppError } from "../contracts/errors.js";
import { MIGRATIONS } from "./migrations.js";

// SQLite access (spec Step 3, §Security and privacy). One synchronous connection per process role;
// transactions never await, so no other JavaScript runs between a check and its write.

export type Database = DatabaseSync;

export interface OpenOptions {
  // How long SQLite itself waits on a locked database before reporting SQLITE_BUSY.
  busyTimeoutMs?: number;
}

export function openDatabase(path: string, options: OpenOptions = {}): Database {
  const inMemory = path === ":memory:";
  if (!inMemory) mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: true, timeout: options.busyTimeoutMs ?? 1000 });
  if (!inMemory) {
    db.exec("PRAGMA journal_mode = WAL");
    // Owner-only access. Best effort: on Windows chmod only toggles the read-only bit (see DECISIONS.md).
    chmodSync(path, 0o600);
  }
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}

// Applies pending migrations in order, each in its own transaction. Safe to run repeatedly.
export function migrate(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  ) STRICT`);
  const applied = new Set(
    db.prepare("SELECT version FROM schema_migrations").all().map((row) => Number(row.version)),
  );
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    transaction(db, () => {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        migration.version,
        migration.name,
        new Date().toISOString(),
      );
    });
  }
}

const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;

function isContention(error: unknown): boolean {
  const errcode = (error as { errcode?: unknown } | null)?.errcode;
  if (typeof errcode !== "number") return false;
  const primary = errcode & 0xff; // extended result codes share the primary code's low byte
  return primary === SQLITE_BUSY || primary === SQLITE_LOCKED;
}

export interface TransactionOptions {
  // Extra attempts after SQLite's own busy wait is exhausted (spec Step 3: bounded retries).
  maxRetries?: number;
}

// Runs fn inside BEGIN IMMEDIATE ... COMMIT, rolling back on any error. fn must be synchronous and
// free of external effects, which is what makes retrying it after contention safe. If the lock cannot
// be obtained within the retry budget, nothing was written and a retryable TIMEOUT is raised.
export function transaction<T>(db: Database, fn: () => T, options: TransactionOptions = {}): T {
  if (db.isTransaction) throw new Error("Nested transactions are not supported");
  const maxRetries = options.maxRetries ?? 3;
  for (let attempt = 0; ; attempt++) {
    try {
      db.exec("BEGIN IMMEDIATE");
    } catch (error) {
      if (isContention(error) && attempt < maxRetries) continue;
      if (isContention(error)) {
        throw new AppError("TIMEOUT", "Database is busy; no changes were made", { retryable: true, cause: error });
      }
      throw error;
    }
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    }
  }
}
