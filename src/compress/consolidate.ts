// ============================================================
// src/compress/consolidate.ts
// Sleep cycle memory consolidation coordinator.
// Synthesizes clusters of memories sharing a tag into unified summaries.
// ============================================================

import { getMetadataStore } from "../store/metadata.js";
import { getVectorStore } from "../store/vector.js";
import { getSummarizer } from "./summarize.js";
import { embed } from "../embedding/embed.js";
import { v4 as uuidv4 } from "uuid";
import type { MemoryRecord } from "../types.js";

/**
 * Consolidates memories that share a tag. If no tag is provided, auto-discovers
 * a tag with 3 or more active memories and consolidates those.
 */
export async function consolidateMemories(targetTag?: string): Promise<{
  consolidatedCount: number;
  newSummaryId?: string;
  summaryText?: string;
  consolidatedIds: string[];
}> {
  const metaStore = getMetadataStore();
  const vectorStore = getVectorStore();
  const summarizer = getSummarizer();

  const allActive = metaStore.getAll(false); // exclude archived

  let tagToConsolidate = targetTag;
  let memoriesToConsolidate: typeof allActive = [];

  if (tagToConsolidate) {
    memoriesToConsolidate = allActive.filter(m => m.tags.includes(tagToConsolidate!));
  } else {
    // Auto-discover a tag with >= 3 active memories
    const allActiveTags: Record<string, number> = {};
    for (const mem of allActive) {
      for (const tag of mem.tags) {
        allActiveTags[tag] = (allActiveTags[tag] ?? 0) + 1;
      }
    }

    const eligibleTags = Object.entries(allActiveTags)
      .filter(([_, count]) => count >= 3)
      .sort((a, b) => b[1] - a[1]); // take the one with the most active memories first

    if (eligibleTags.length > 0) {
      tagToConsolidate = eligibleTags[0]![0];
      memoriesToConsolidate = allActive.filter(m => m.tags.includes(tagToConsolidate!));
    }
  }

  if (!tagToConsolidate || memoriesToConsolidate.length < 3) {
    return { consolidatedCount: 0, consolidatedIds: [] };
  }

  const ids = memoriesToConsolidate.map(m => m.id);
  const contents = memoriesToConsolidate.map(m => m.content);

  // Trigger LLM consolidation
  const summaryText = await summarizer.consolidate(contents, tagToConsolidate);

  // Create consolidated summary record
  const summaryId = uuidv4();
  const now = Date.now();
  const embedding = await embed(summaryText);

  // Compute average importance
  const totalImportance = memoriesToConsolidate.reduce((acc, m) => acc + (m.importance ?? 5), 0);
  const avgImportance = Math.round(totalImportance / memoriesToConsolidate.length);

  const record: Omit<MemoryRecord, "embedding"> = {
    id: summaryId,
    content: summaryText,
    type: "summary",
    source: "consolidation",
    created_at: now,
    last_accessed: now,
    access_count: 1,
    decay_weight: 1.0,
    merged_from: ids,
    tags: [tagToConsolidate],
    importance: avgImportance,
    access_history: [{ timestamp: now, action: "created" }]
  };

  // Insert summary
  metaStore.insert(record);
  await vectorStore.upsert(summaryId, embedding, {
    type: "summary",
    source: "consolidation",
    created_at: now
  });

  // Archive originals and create consolidation links
  for (const orig of memoriesToConsolidate) {
    metaStore.archive(orig.id);
    metaStore.addLink(summaryId, orig.id, "consolidates");
  }

  return {
    consolidatedCount: memoriesToConsolidate.length,
    newSummaryId: summaryId,
    summaryText,
    consolidatedIds: ids
  };
}
