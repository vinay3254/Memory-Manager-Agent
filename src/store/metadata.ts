// ============================================================
// src/store/metadata.ts
// Pure TypeScript/JSON metadata store.
// Replaces better-sqlite3 to run without native dependencies on Node 25.
// ============================================================

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { dirname } from "path";
import { getConfigStore } from "./config.js";
import type { MemoryRecord, MemoryType, MemoryLink, LinkedMemory } from "../types.js";

interface JSONStoreData {
  memories: Record<string, Omit<MemoryRecord, "embedding">>;
  counters: Record<string, number>;
  links?: MemoryLink[];
}

export class MetadataStore {
  private dbPath: string;
  private memories: Map<string, Omit<MemoryRecord, "embedding">> = new Map();
  private counters: Map<string, number> = new Map();
  private links: MemoryLink[] = [];

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
        if (data.links) {
          this.links = data.links;
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
      links: this.links,
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
    const history = record.access_history ?? [];
    if (history.length === 0) {
      history.push({ timestamp: Date.now(), action: "created" });
    }
    this.memories.set(record.id, { ...record, access_history: history });
    this.save();
  }

  update(
    id: string,
    patch: Partial<Omit<MemoryRecord, "id" | "embedding">>
  ): void {
    const current = this.memories.get(id);
    if (!current) throw new Error(`Memory not found: ${id}`);

    const history = [...(current.access_history ?? [])];
    history.push({ timestamp: Date.now(), action: "updated" });

    const merged = { ...current, ...patch, access_history: history };
    this.memories.set(id, merged);
    this.save();
  }

  delete(id: string): void {
    this.memories.delete(id);
    this.links = this.links.filter(l => l.sourceId !== id && l.targetId !== id);
    this.save();
  }

  deleteMany(ids: string[]): void {
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    for (const id of ids) {
      this.memories.delete(id);
    }
    this.links = this.links.filter(l => !idSet.has(l.sourceId) && !idSet.has(l.targetId));
    this.save();
  }

  archive(id: string): void {
    const mem = this.memories.get(id);
    if (mem) {
      mem.archived = true;
      if (!mem.access_history) mem.access_history = [];
      mem.access_history.push({ timestamp: Date.now(), action: "archived" });
      this.save();
    }
  }

  restore(id: string): void {
    const mem = this.memories.get(id);
    if (mem) {
      mem.archived = false;
      mem.decay_weight = 1.0;
      mem.last_accessed = Date.now();
      if (!mem.access_history) mem.access_history = [];
      mem.access_history.push({ timestamp: Date.now(), action: "restored" });
      this.save();
    }
  }

  getArchived(): Omit<MemoryRecord, "embedding">[] {
    return Array.from(this.memories.values())
      .filter(m => !!m.archived)
      .map(m => ({ ...m }))
      .sort((a, b) => b.created_at - a.created_at);
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  getById(id: string): Omit<MemoryRecord, "embedding"> | null {
    const mem = this.memories.get(id);
    return mem ? { ...mem } : null;
  }

  getByIds(ids: string[], includeArchived = false): Omit<MemoryRecord, "embedding">[] {
    const results: Omit<MemoryRecord, "embedding">[] = [];
    for (const id of ids) {
      const mem = this.memories.get(id);
      if (mem && (includeArchived || !mem.archived)) results.push({ ...mem });
    }
    return results;
  }

  getAll(includeArchived = false): Omit<MemoryRecord, "embedding">[] {
    return Array.from(this.memories.values())
      .filter(m => includeArchived || !m.archived)
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
      .filter(m => !m.archived && m.decay_weight < decayThreshold && m.created_at < cutoff)
      .map(m => ({ ...m }));
  }

  /** Returns the N most recent memories (for recurrence calculation) */
  getRecent(limit: number): Omit<MemoryRecord, "embedding">[] {
    return Array.from(this.memories.values())
      .filter(m => !m.archived)
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
      if (!mem.access_history) mem.access_history = [];
      mem.access_history.push({ timestamp: Date.now(), action: "retrieved" });
      this.save();
    }
  }

  bumpAccessLinked(id: string): void {
    const links = this.getLinks(id);
    let count = 0;
    for (const link of links) {
      const linkedId = link.memory.id;
      const mem = this.memories.get(linkedId);
      if (mem) {
        mem.decay_weight = Math.min(1.0, mem.decay_weight + (1.0 - mem.decay_weight) * 0.1);
        if (!mem.access_history) mem.access_history = [];
        mem.access_history.push({ timestamp: Date.now(), action: "spreading-activation" });
        count++;
      }
    }
    if (count > 0) {
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

  /** Apply daily decay to all memories, scaled by importance rating (1-10) using ConfigStore DECAY_RATE */
  applyDailyDecay(): void {
    const config = getConfigStore();
    const baseDecay = config.get("DECAY_RATE");
    for (const mem of this.memories.values()) {
      const imp = mem.importance ?? 5;
      // Scale decay factor: lower importance decays faster, higher decays slower.
      const decayFactor = 1.0 - (baseDecay * (10 - imp) / 5);
      mem.decay_weight = Math.max(0.0, mem.decay_weight * decayFactor);
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

  addLink(sourceId: string, targetId: string, relation: string): void {
    if (!this.memories.has(sourceId)) {
      throw new Error(`Source memory not found: ${sourceId}`);
    }
    if (!this.memories.has(targetId)) {
      throw new Error(`Target memory not found: ${targetId}`);
    }
    // Check if link already exists
    const exists = this.links.some(
      l => l.sourceId === sourceId && l.targetId === targetId && l.relation === relation
    );
    if (!exists) {
      this.links.push({ sourceId, targetId, relation });
      this.save();
    }
  }

  removeLink(sourceId: string, targetId: string, relation: string): void {
    const lenBefore = this.links.length;
    this.links = this.links.filter(
      l => !(l.sourceId === sourceId && l.targetId === targetId && l.relation === relation)
    );
    if (this.links.length !== lenBefore) {
      this.save();
    }
  }

  getLinks(id: string): LinkedMemory[] {
    const result: LinkedMemory[] = [];
    for (const link of this.links) {
      if (link.sourceId === id) {
        const target = this.memories.get(link.targetId);
        if (target) {
          result.push({
            memory: { ...target },
            relation: link.relation,
            direction: "outgoing",
          });
        }
      } else if (link.targetId === id) {
        const source = this.memories.get(link.sourceId);
        if (source) {
          result.push({
            memory: { ...source },
            relation: link.relation,
            direction: "incoming",
          });
        }
      }
    }
    return result;
  }

  getAllLinks(): MemoryLink[] {
    return this.links.map(l => ({ ...l }));
  }

  getSubGraph(seedIds: string[], maxDepth = 2): { nodes: Omit<MemoryRecord, "embedding">[], links: MemoryLink[] } {
    const visited = new Set<string>();
    const queue: { id: string; depth: number }[] = seedIds.map(id => ({ id, depth: 0 }));
    const nodes: Omit<MemoryRecord, "embedding">[] = [];
    const linkSet = new Set<string>();
    const resultLinks: MemoryLink[] = [];

    while (queue.length > 0) {
      const { id, depth } = queue.shift()!;
      if (visited.has(id)) continue;
      visited.add(id);

      const mem = this.memories.get(id);
      if (!mem) continue;

      nodes.push({ ...mem });

      if (depth < maxDepth) {
        for (const link of this.links) {
          if (link.sourceId === id) {
            const linkKey = `${link.sourceId}->${link.targetId}:${link.relation}`;
            if (!linkSet.has(linkKey)) {
              linkSet.add(linkKey);
              resultLinks.push({ ...link });
            }
            if (!visited.has(link.targetId)) {
              queue.push({ id: link.targetId, depth: depth + 1 });
            }
          } else if (link.targetId === id) {
            const linkKey = `${link.sourceId}->${link.targetId}:${link.relation}`;
            if (!linkSet.has(linkKey)) {
              linkSet.add(linkKey);
              resultLinks.push({ ...link });
            }
            if (!visited.has(link.sourceId)) {
              queue.push({ id: link.sourceId, depth: depth + 1 });
            }
          }
        }
      }
    }

    return { nodes, links: resultLinks };
  }

  importLinks(links: MemoryLink[]): void {
    for (const link of links) {
      const exists = this.links.some(
        l => l.sourceId === link.sourceId && l.targetId === link.targetId && l.relation === link.relation
      );
      if (!exists && this.memories.has(link.sourceId) && this.memories.has(link.targetId)) {
        this.links.push({ ...link });
      }
    }
    this.save();
  }

  getTagStats(): Record<string, number> {
    const stats: Record<string, number> = {};
    for (const mem of this.memories.values()) {
      for (const tag of mem.tags) {
        stats[tag] = (stats[tag] ?? 0) + 1;
      }
    }
    return stats;
  }

  bulkAddTag(ids: string[], tag: string): number {
    let count = 0;
    for (const id of ids) {
      const mem = this.memories.get(id);
      if (mem && !mem.tags.includes(tag)) {
        mem.tags.push(tag);
        count++;
      }
    }
    if (count > 0) this.save();
    return count;
  }

  bulkRemoveTag(ids: string[], tag: string): number {
    let count = 0;
    for (const id of ids) {
      const mem = this.memories.get(id);
      if (mem && mem.tags.includes(tag)) {
        mem.tags = mem.tags.filter(t => t !== tag);
        count++;
      }
    }
    if (count > 0) this.save();
    return count;
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
