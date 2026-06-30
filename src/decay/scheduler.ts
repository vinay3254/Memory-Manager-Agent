// ============================================================
// src/decay/scheduler.ts
// Daily decay job using node-cron.
//
// Algorithm:
//   1. Apply global daily decay: each memory's decay_weight *= 0.97
//   2. Find memories with decay_weight < 0.1 AND age > 30 days
//   3. Group them by topic tag (or extract a topic via Claude)
//   4. Compress each cluster into one "archive summary" memory
//   5. Delete the original memories
//
// The cron runs at midnight (00:00) every day.
// Can also be triggered manually via memory_decay_run MCP tool.
// ============================================================

import cron from "node-cron";
import { v4 as uuidv4 } from "uuid";
import { embed } from "../embedding/embed.js";
import { getMetadataStore } from "../store/metadata.js";
import { getVectorStore } from "../store/vector.js";
import { getSummarizer } from "../compress/summarize.js";
import type { DecayRunResult, MemoryRecord } from "../types.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const DECAY_WEIGHT_THRESHOLD = 0.1;
const AGE_DAYS_THRESHOLD     = 30;

// ---------------------------------------------------------------------------
// Core decay logic (callable directly or via cron)
// ---------------------------------------------------------------------------

/**
 * Runs a full decay pass:
 *  - Applies daily 3% decay to all memories
 *  - Archives memories that are old + low-decay into cluster summaries
 */
export async function runDecayPass(): Promise<DecayRunResult> {
  const metaStore = getMetadataStore();
  const vectorStore = getVectorStore();
  const summarizer = getSummarizer();

  // Step 1: Apply global decay
  metaStore.applyDailyDecay();
  process.stderr.write("[Decay] Applied daily 3% decay to all memories.\n");

  // Step 2: Find memories eligible for archiving
  const candidates = metaStore.getDecayedMemories(
    DECAY_WEIGHT_THRESHOLD,
    AGE_DAYS_THRESHOLD
  );

  if (candidates.length === 0) {
    process.stderr.write("[Decay] No memories eligible for archiving.\n");
    return { processed: 0, archived: 0, archiveSummaries: [] };
  }

  process.stderr.write(
    `[Decay] Found ${candidates.length} memories eligible for archiving.\n`
  );

  // Step 3: Group by primary tag (or "untagged" if no tags)
  const clusters = groupByTopic(candidates);

  const archiveSummaries: string[] = [];
  let archived = 0;

  // Step 4: Compress each cluster
  for (const [topic, clusterMemories] of Object.entries(clusters)) {
    if (clusterMemories.length === 0) continue;

    process.stderr.write(
      `[Decay] Archiving cluster "${topic}" (${clusterMemories.length} memories)...\n`
    );

    const contents = clusterMemories.map((m) => m.content);
    let archiveContent: string;

    try {
      archiveContent = await summarizer.archiveCluster(contents, topic);
    } catch (err) {
      process.stderr.write(
        `[Decay] Error archiving cluster "${topic}": ${String(err)}\n`
      );
      continue;
    }

    // Create the archive summary memory
    const archiveId = uuidv4();
    const now = Date.now();
    const allMergedFrom = clusterMemories.flatMap((m) => [
      m.id,
      ...m.merged_from,
    ]);
    const allTags = [...new Set(clusterMemories.flatMap((m) => m.tags))];

    const archiveRecord: Omit<MemoryRecord, "embedding"> = {
      id: archiveId,
      content: archiveContent,
      type: "summary",
      source: "decay-scheduler",
      created_at: now,
      last_accessed: now,
      access_count: 0,
      decay_weight: 0.5, // start fresh but below 1.0
      merged_from: allMergedFrom,
      tags: allTags.length > 0 ? allTags : [topic],
    };

    const archiveEmbedding = await embed(archiveContent);

    // Delete old memories
    const idsToDelete = clusterMemories.map((m) => m.id);
    metaStore.deleteMany(idsToDelete);
    await vectorStore.deleteMany(idsToDelete);

    // Insert archive
    metaStore.insert(archiveRecord);
    await vectorStore.upsert(archiveId, archiveEmbedding, {
      type: "summary",
      source: "decay-scheduler",
      created_at: now,
    });

    archived += clusterMemories.length;
    archiveSummaries.push(archiveContent);

    process.stderr.write(
      `[Decay] Cluster "${topic}" archived into ${archiveId}.\n`
    );
  }

  return {
    processed: candidates.length,
    archived,
    archiveSummaries,
  };
}

// ---------------------------------------------------------------------------
// Topic grouping
// ---------------------------------------------------------------------------

/**
 * Groups memories into clusters by their primary tag.
 * Memories without tags are placed under "untagged".
 */
function groupByTopic(
  memories: Omit<MemoryRecord, "embedding">[]
): Record<string, Omit<MemoryRecord, "embedding">[]> {
  const clusters: Record<string, Omit<MemoryRecord, "embedding">[]> = {};

  for (const memory of memories) {
    const topic = memory.tags[0] ?? "untagged";
    if (!clusters[topic]) clusters[topic] = [];
    clusters[topic]!.push(memory);
  }

  return clusters;
}

// ---------------------------------------------------------------------------
// Cron scheduler
// ---------------------------------------------------------------------------

let _cronTask: cron.ScheduledTask | null = null;

/**
 * Starts the daily cron job for decay.
 * Runs at midnight (00:00) every day.
 */
export function startDecayScheduler(): void {
  if (_cronTask) return; // already running

  _cronTask = cron.schedule(
    "0 0 * * *", // Every day at midnight
    async () => {
      process.stderr.write(
        `[Decay] Cron triggered at ${new Date().toISOString()}\n`
      );
      try {
        const result = await runDecayPass();
        process.stderr.write(
          `[Decay] Pass complete: ${result.processed} processed, ${result.archived} archived.\n`
        );
      } catch (err) {
        process.stderr.write(`[Decay] Error during decay pass: ${String(err)}\n`);
      }
    },
    {
      timezone: "UTC",
    }
  );

  process.stderr.write("[Decay] Scheduler started (runs daily at midnight UTC).\n");
}

/**
 * Stops the cron job (for graceful shutdown).
 */
export function stopDecayScheduler(): void {
  if (_cronTask) {
    _cronTask.stop();
    _cronTask = null;
    process.stderr.write("[Decay] Scheduler stopped.\n");
  }
}
