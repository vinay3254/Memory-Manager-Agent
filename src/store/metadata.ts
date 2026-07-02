// ============================================================
// src/store/metadata.ts
// Pure TypeScript/JSON metadata store.
// Replaces better-sqlite3 to run without native dependencies on Node 25.
// ============================================================

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { dirname } from "path";
import type { MemoryRecord, MemoryType } from "../types.js";

interface JSONStoreData {
  memories: Record<string, Omit<MemoryRecord, "embedding">>;
  counters: Record<string, number>;
}

export class MetadataStore {
  private dbPath: string;
  private memories: Map<string, Omit<MemoryRecord, "embedding">> = new Map();
  private counters: Map<string, number> = new Map();

  constructor(dbPath: string) {
    // If the path ends in .db, convert it to .json for clarity
    this.dbPath = dbPath.replace(/\.db$/, ".json");
    mkdirSync(dirname(this.dbPath), { recursive: true });
    this.initialize();
  }

  private initialize(): void {
    this.counters.set("discard_count", 0);
    this.counters.set("compress_count", 0);

    if (existsSync(this.dbPath)) {
      try {
        const raw = readFileSync(this.dbPath, "utf-8");
        const data = JSON.parse(raw) as JSONStoreData;
        if (data.memories) {
          for (const [id, record] of Object.entries(data.memories)) {
            this.memories.set(id, record);
          }
        }
        if (data.counters) {
          for (const [key, val] of Object.entries(data.counters)) {
            this.counters.set(key, val);
          }
        }
      } catch (err) {
        process.stderr.write(`[MetadataStore] Warning: Failed to read store: ${String(err)}\n`);
      }
    } else {
      this.save();
    }
  }

  private save(): void {
    const data: JSONStoreData = {
      memories: Object.fromEntries(this.memories),
      counters: Object.fromEntries(this.counters),
    };
    try {
      writeFileSync(this.dbPath, JSON.stringify(data, null, 2), "utf-8");
    } catch (err) {
      process.stderr.write(`[MetadataStore] Error: Failed to write store: ${String(err)}\n`);
    }
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  insert(record: Omit<MemoryRecord, "embedding">): void {
    this.memories.set(record.id, { ...record });
    this.save();
  }

  update(
    id: string,
    patch: Partial<Omit<MemoryRecord, "id" | "embedding">>
  ): void {
    const current = this.memories.get(id);
    if (!current) throw new Error(`Memory not found: ${id}`);

    const merged = { ...current, ...patch };
    this.memories.set(id, merged);
    this.save();
  }

  delete(id: string): void {
    this.memories.delete(id);
    this.save();
  }

  deleteMany(ids: string[]): void {
    if (ids.length === 0) return;
    for (const id of ids) {
      this.memories.delete(id);
    }
    this.save();
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  getById(id: string): Omit<MemoryRecord, "embedding"> | null {
    const mem = this.memories.get(id);
    return mem ? { ...mem } : null;
  }

  getByIds(ids: string[]): Omit<MemoryRecord, "embedding">[] {
    const results: Omit<MemoryRecord, "embedding">[] = [];
    for (const id of ids) {
      const mem = this.memories.get(id);
      if (mem) results.push({ ...mem });
    }
    return results;
  }

  getAll(): Omit<MemoryRecord, "embedding">[] {
    return Array.from(this.memories.values())
      .map(m => ({ ...m }))
      .sort((a, b) => b.created_at - a.created_at);
  }

  /** Returns memories older than `ageDays` with decay_weight below threshold */
  getDecayedMemories(
    decayThreshold: number,
    ageDays: number
  ): Omit<MemoryRecord, "embedding">[] {
    const cutoff = Date.now() - ageDays * 24 * 60 * 60 * 1000;
    return Array.from(this.memories.values())
      .filter(m => m.decay_weight < decayThreshold && m.created_at < cutoff)
      .map(m => ({ ...m }));
  }

  /** Returns the N most recent memories (for recurrence calculation) */
  getRecent(limit: number): Omit<MemoryRecord, "embedding">[] {
    return Array.from(this.memories.values())
      .map(m => ({ ...m }))
      .sort((a, b) => b.last_accessed - a.last_accessed)
      .slice(0, limit);
  }

  // -------------------------------------------------------------------------
  // Decay & Access
  // -------------------------------------------------------------------------

  /**
   * Bumps a memory's access stats.
   * Resets decay_weight toward 1.0 using: new = old + (1-old)*0.3
   */
  bumpAccess(id: string): void {
    const mem = this.memories.get(id);
    if (mem) {
      mem.last_accessed = Date.now();
      mem.access_count += 1;
      mem.decay_weight = Math.min(1.0, mem.decay_weight + (1.0 - mem.decay_weight) * 0.3);
      this.save();
    }
  }

  updateDecayWeight(id: string, newWeight: number): void {
    const mem = this.memories.get(id);
    if (mem) {
      mem.decay_weight = Math.max(0, Math.min(1, newWeight));
      this.save();
    }
  }

  /** Apply daily decay to all memories: weight *= 0.97 */
  applyDailyDecay(): void {
    for (const mem of this.memories.values()) {
      mem.decay_weight = Math.max(0.0, mem.decay_weight * 0.97);
    }
    this.save();
  }

  // -------------------------------------------------------------------------
  // Counters
  // -------------------------------------------------------------------------

  incrementDiscard(): void {
    const val = this.counters.get("discard_count") ?? 0;
    this.counters.set("discard_count", val + 1);
    this.save();
  }

  incrementCompress(): void {
    const val = this.counters.get("compress_count") ?? 0;
    this.counters.set("compress_count", val + 1);
    this.save();
  }

  getCounter(key: string): number {
    return this.counters.get(key) ?? 0;
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
    const total = this.memories.size;
    if (total === 0) {
      return {
        totalStored: 0,
        averageDecayWeight: 0,
        oldestCreatedAt: null,
        newestCreatedAt: null,
      };
    }

    let sumDecay = 0;
    let oldest = Infinity;
    let newest = -Infinity;

    for (const mem of this.memories.values()) {
      sumDecay += mem.decay_weight;
      if (mem.created_at < oldest) oldest = mem.created_at;
      if (mem.created_at > newest) newest = mem.created_at;
    }

    return {
      totalStored: total,
      averageDecayWeight: sumDecay / total,
      oldestCreatedAt: oldest === Infinity ? null : oldest,
      newestCreatedAt: newest === -Infinity ? null : newest,
    };
  }

  close(): void {
    // No-op for JSON store
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
