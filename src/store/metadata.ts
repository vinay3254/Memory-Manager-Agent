// ============================================================
// src/store/metadata.ts
// SQLite metadata store for all non-vector memory fields.
// Uses better-sqlite3 (synchronous API) for reliability.
// ============================================================

import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { dirname } from "path";
import type { MemoryRecord, MemoryType } from "../types.js";

// ---------------------------------------------------------------------------
// Row shape as stored in SQLite (flat, serialized arrays as JSON strings)
// ---------------------------------------------------------------------------
interface MemoryRow {
  id: string;
  content: string;
  type: string;
  source: string;
  created_at: number;
  last_accessed: number;
  access_count: number;
  decay_weight: number;
  merged_from: string; // JSON array
  tags: string;        // JSON array
}

function rowToRecord(row: MemoryRow): Omit<MemoryRecord, "embedding"> {
  return {
    id: row.id,
    content: row.content,
    type: row.type as MemoryType,
    source: row.source,
    created_at: row.created_at,
    last_accessed: row.last_accessed,
    access_count: row.access_count,
    decay_weight: row.decay_weight,
    merged_from: JSON.parse(row.merged_from) as string[],
    tags: JSON.parse(row.tags) as string[],
  };
}

// ---------------------------------------------------------------------------
// MetadataStore
// ---------------------------------------------------------------------------

export class MetadataStore {
  private db: Database.Database;

  /** Discard counter — kept in memory (reset on restart) */
  private discardCount = 0;
  /** Compress counter — how many times COMPRESS action happened */
  private compressCount = 0;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.initialize();
  }

  // -------------------------------------------------------------------------
  // Schema
  // -------------------------------------------------------------------------

  private initialize(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS memories (
        id            TEXT PRIMARY KEY,
        content       TEXT NOT NULL,
        type          TEXT NOT NULL CHECK(type IN ('fact','decision','event','summary')),
        source        TEXT NOT NULL DEFAULT 'unknown',
        created_at    INTEGER NOT NULL,
        last_accessed INTEGER NOT NULL,
        access_count  INTEGER NOT NULL DEFAULT 0,
        decay_weight  REAL NOT NULL DEFAULT 1.0,
        merged_from   TEXT NOT NULL DEFAULT '[]',
        tags          TEXT NOT NULL DEFAULT '[]'
      );

      CREATE TABLE IF NOT EXISTS counters (
        key   TEXT PRIMARY KEY,
        value INTEGER NOT NULL DEFAULT 0
      );

      INSERT OR IGNORE INTO counters (key, value) VALUES
        ('discard_count', 0),
        ('compress_count', 0);

      CREATE INDEX IF NOT EXISTS idx_decay ON memories(decay_weight);
      CREATE INDEX IF NOT EXISTS idx_created ON memories(created_at);
      CREATE INDEX IF NOT EXISTS idx_last_accessed ON memories(last_accessed);
    `);
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  insert(record: Omit<MemoryRecord, "embedding">): void {
    const stmt = this.db.prepare(`
      INSERT INTO memories
        (id, content, type, source, created_at, last_accessed,
         access_count, decay_weight, merged_from, tags)
      VALUES
        (@id, @content, @type, @source, @created_at, @last_accessed,
         @access_count, @decay_weight, @merged_from, @tags)
    `);
    stmt.run({
      ...record,
      merged_from: JSON.stringify(record.merged_from),
      tags: JSON.stringify(record.tags),
    });
  }

  update(
    id: string,
    patch: Partial<Omit<MemoryRecord, "id" | "embedding">>
  ): void {
    const current = this.getById(id);
    if (!current) throw new Error(`Memory not found: ${id}`);

    const merged = { ...current, ...patch };
    const stmt = this.db.prepare(`
      UPDATE memories SET
        content       = @content,
        type          = @type,
        source        = @source,
        created_at    = @created_at,
        last_accessed = @last_accessed,
        access_count  = @access_count,
        decay_weight  = @decay_weight,
        merged_from   = @merged_from,
        tags          = @tags
      WHERE id = @id
    `);
    stmt.run({
      id,
      content: merged.content,
      type: merged.type,
      source: merged.source,
      created_at: merged.created_at,
      last_accessed: merged.last_accessed,
      access_count: merged.access_count,
      decay_weight: merged.decay_weight,
      merged_from: JSON.stringify(merged.merged_from),
      tags: JSON.stringify(merged.tags),
    });
  }

  delete(id: string): void {
    this.db.prepare("DELETE FROM memories WHERE id = ?").run(id);
  }

  deleteMany(ids: string[]): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => "?").join(",");
    this.db
      .prepare(`DELETE FROM memories WHERE id IN (${placeholders})`)
      .run(...ids);
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  getById(id: string): Omit<MemoryRecord, "embedding"> | null {
    const row = this.db
      .prepare("SELECT * FROM memories WHERE id = ?")
      .get(id) as MemoryRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  getByIds(ids: string[]): Omit<MemoryRecord, "embedding">[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT * FROM memories WHERE id IN (${placeholders})`)
      .all(...ids) as MemoryRow[];
    return rows.map(rowToRecord);
  }

  getAll(): Omit<MemoryRecord, "embedding">[] {
    const rows = this.db
      .prepare("SELECT * FROM memories ORDER BY created_at DESC")
      .all() as MemoryRow[];
    return rows.map(rowToRecord);
  }

  /** Returns memories older than `ageDays` with decay_weight below threshold */
  getDecayedMemories(
    decayThreshold: number,
    ageDays: number
  ): Omit<MemoryRecord, "embedding">[] {
    const cutoff = Date.now() - ageDays * 24 * 60 * 60 * 1000;
    const rows = this.db
      .prepare(
        `SELECT * FROM memories
         WHERE decay_weight < ? AND created_at < ?`
      )
      .all(decayThreshold, cutoff) as MemoryRow[];
    return rows.map(rowToRecord);
  }

  /** Returns the N most recent memories (for recurrence calculation) */
  getRecent(limit: number): Omit<MemoryRecord, "embedding">[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM memories ORDER BY last_accessed DESC LIMIT ?"
      )
      .all(limit) as MemoryRow[];
    return rows.map(rowToRecord);
  }

  // -------------------------------------------------------------------------
  // Decay & Access
  // -------------------------------------------------------------------------

  /**
   * Bumps a memory's access stats.
   * Resets decay_weight toward 1.0 using: new = old + (1-old)*0.3
   */
  bumpAccess(id: string): void {
    const stmt = this.db.prepare(`
      UPDATE memories
      SET
        last_accessed = ?,
        access_count  = access_count + 1,
        decay_weight  = MIN(1.0, decay_weight + (1.0 - decay_weight) * 0.3)
      WHERE id = ?
    `);
    stmt.run(Date.now(), id);
  }

  updateDecayWeight(id: string, newWeight: number): void {
    this.db
      .prepare("UPDATE memories SET decay_weight = ? WHERE id = ?")
      .run(Math.max(0, Math.min(1, newWeight)), id);
  }

  /** Apply daily decay to all memories: weight *= 0.97 */
  applyDailyDecay(): void {
    this.db.exec(
      "UPDATE memories SET decay_weight = MAX(0.0, decay_weight * 0.97)"
    );
  }

  // -------------------------------------------------------------------------
  // Counters
  // -------------------------------------------------------------------------

  incrementDiscard(): void {
    this.db
      .prepare(
        "UPDATE counters SET value = value + 1 WHERE key = 'discard_count'"
      )
      .run();
  }

  incrementCompress(): void {
    this.db
      .prepare(
        "UPDATE counters SET value = value + 1 WHERE key = 'compress_count'"
      )
      .run();
  }

  getCounter(key: string): number {
    const row = this.db
      .prepare("SELECT value FROM counters WHERE key = ?")
      .get(key) as { value: number } | undefined;
    return row?.value ?? 0;
  }

  // -------------------------------------------------------------------------
  // Stats
  // -------------------------------------------------------------------------

  getStats(): {
    totalStored: number;
    averageDecayWeight: number;
    oldestCreatedAt: number | null;
    newestCreatedAt: number | null;
  } {
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*) as total,
           AVG(decay_weight) as avg_decay,
           MIN(created_at) as oldest,
           MAX(created_at) as newest
         FROM memories`
      )
      .get() as {
      total: number;
      avg_decay: number | null;
      oldest: number | null;
      newest: number | null;
    };

    return {
      totalStored: row.total,
      averageDecayWeight: row.avg_decay ?? 0,
      oldestCreatedAt: row.oldest,
      newestCreatedAt: row.newest,
    };
  }

  close(): void {
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _store: MetadataStore | null = null;

export function getMetadataStore(): MetadataStore {
  if (!_store) {
    const dbPath =
      process.env["SQLITE_DB_PATH"] ?? "./data/memories.db";
    _store = new MetadataStore(dbPath);
  }
  return _store;
}
