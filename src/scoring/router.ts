// ============================================================
// src/scoring/router.ts
// Routes a scored memory candidate to STORE, COMPRESS, or DISCARD.
//
// Thresholds:
//   score >= 0.7         → STORE  (new long-term memory entry)
//   0.35 <= score < 0.7  → COMPRESS (merge with most similar existing)
//   score < 0.35         → DISCARD
// ============================================================

import { v4 as uuidv4 } from "uuid";
import { embed } from "../embedding/embed.js";
import { getVectorStore } from "../store/vector.js";
import { getMetadataStore } from "../store/metadata.js";
import { getSummarizer } from "../compress/summarize.js";
import { getConfigStore } from "../store/config.js";
import type {
  MemoryRecord,
  MemoryType,
  RouteAction,
  EvaluateResult,
  ScoreResult,
} from "../types.js";



// ---------------------------------------------------------------------------
// MemoryRouter
// ---------------------------------------------------------------------------

export class MemoryRouter {
  /**
   * Routes a scored memory candidate through the store/compress/discard pipeline.
   *
   * @param content   - Raw candidate text
   * @param score     - Pre-computed ScoreResult from ScoreEngine
   * @param type      - Semantic type of the candidate
   * @param source    - Origin identifier (tool/session/CLI)
   * @param tags      - Optional topic tags
   * @returns EvaluateResult with action taken and memoryId if persisted
   */
  async route(
    content: string,
    score: ScoreResult,
    type: MemoryType = "fact",
    source: string = "unknown",
    tags: string[] = [],
    expires_at?: number,
    importance?: number
  ): Promise<EvaluateResult> {
    const { final_score } = score;
    const config = getConfigStore();
    const storeThreshold = config.get("STORE_THRESHOLD");
    const compressThreshold = config.get("COMPRESS_THRESHOLD");

    if (final_score >= storeThreshold) {
      return this.store(content, score, type, source, tags, undefined, expires_at, importance);
    } else if (final_score >= compressThreshold) {
      return this.compress(content, score, type, source, tags, expires_at, importance);
    } else {
      return this.discard(score);
    }
  }

  // -------------------------------------------------------------------------
  // STORE
  // -------------------------------------------------------------------------

  private async store(
    content: string,
    score: ScoreResult,
    type: MemoryType,
    source: string,
    tags: string[],
    fallbackReason?: string,
    expires_at?: number,
    importance?: number
  ): Promise<EvaluateResult> {
    const id = uuidv4();
    const now = Date.now();
    const embedding = await embed(content);

    const record: Omit<MemoryRecord, "embedding"> = {
      id,
      content,
      type,
      source,
      created_at: now,
      last_accessed: now,
      access_count: 0,
      decay_weight: 1.0,
      merged_from: [],
      tags,
      expires_at,
      importance: importance ?? 5,
    };

    const metaStore = getMetadataStore();
    const vectorStore = getVectorStore();

    metaStore.insert(record);
    await vectorStore.upsert(id, embedding, {
      type,
      source,
      created_at: now,
    });

    const contradictionWarning = await this.checkAndLinkContradictions(id, content, tags);

    const config = getConfigStore();
    const storeThreshold = config.get("STORE_THRESHOLD");

    return {
      action: "stored" as RouteAction,
      memoryId: id,
      score,
      reason: contradictionWarning
        ? `${fallbackReason ?? `Score ${score.final_score.toFixed(3)} >= ${storeThreshold.toFixed(2)} → stored as new memory`}. ${contradictionWarning}`
        : fallbackReason ?? `Score ${score.final_score.toFixed(3)} >= ${storeThreshold.toFixed(2)} → stored as new memory`,
    };
  }

  // -------------------------------------------------------------------------
  // COMPRESS
  // -------------------------------------------------------------------------

  private async compress(
    content: string,
    score: ScoreResult,
    type: MemoryType,
    source: string,
    tags: string[],
    expires_at?: number,
    importance?: number
  ): Promise<EvaluateResult> {
    const embedding = await embed(content);
    const vectorStore = getVectorStore();
    const metaStore = getMetadataStore();

    // Find the most similar existing memory
    const similar = await vectorStore.query(embedding, 1);

    const config = getConfigStore();
    const mergeSimilarityThreshold = config.get("MERGE_SIMILARITY_THRESHOLD");

    if (
      similar.length === 0 ||
      (similar[0]?.similarity ?? 0) < mergeSimilarityThreshold
    ) {
      // No close enough existing memory → fall back to STORE
      const simVal = similar[0] ? similar[0].similarity.toFixed(3) : "N/A";
      return this.store(
        content,
        score,
        type,
        source,
        tags,
        `Score ${score.final_score.toFixed(3)} is in compression range but no similar memory exists (max similarity: ${simVal}) → stored as new memory`,
        expires_at,
        importance
      );
    }

    const existingId = similar[0]!.id;
    const existing = metaStore.getById(existingId);

    if (!existing) {
      // Stale vector reference → store fresh
      return this.store(
        content,
        score,
        type,
        source,
        tags,
        `Score ${score.final_score.toFixed(3)} is in compression range but the matched memory has stale metadata → stored as new memory`,
        expires_at,
        importance
      );
    }

    // Merge via LLM summarization
    const summarizer = getSummarizer();
    const mergedContent = await summarizer.merge(existing.content, content);
    const mergedEmbedding = await embed(mergedContent);

    const newId = uuidv4();
    const now = Date.now();

    const mergedRecord: Omit<MemoryRecord, "embedding"> = {
      id: newId,
      content: mergedContent,
      type: "summary",
      source: `merged:${source}`,
      created_at: now,
      last_accessed: now,
      access_count: existing.access_count,
      decay_weight: Math.max(existing.decay_weight, 0.5), // preserve some weight
      merged_from: [existingId, ...existing.merged_from],
      tags: [...new Set([...existing.tags, ...tags])],
      expires_at: existing.expires_at || expires_at,
      importance: Math.max(existing.importance ?? 5, importance ?? 5),
    };

    // Remove old entry, insert merged entry
    metaStore.delete(existingId);
    await vectorStore.delete(existingId);

    metaStore.insert(mergedRecord);
    await vectorStore.upsert(newId, mergedEmbedding, {
      type: mergedRecord.type,
      source: mergedRecord.source,
      created_at: now,
    });

    metaStore.incrementCompress();

    const storeThreshold = config.get("STORE_THRESHOLD");
    const compressThreshold = config.get("COMPRESS_THRESHOLD");

    return {
      action: "compressed" as RouteAction,
      memoryId: newId,
      score,
      reason:
        `Score ${score.final_score.toFixed(3)} in [${compressThreshold.toFixed(2)}, ${storeThreshold.toFixed(2)}) ` +
        `→ merged with memory ${existingId} (similarity ${(similar[0]?.similarity ?? 0).toFixed(3)})`,
    };
  }

  // -------------------------------------------------------------------------
  // DISCARD
  // -------------------------------------------------------------------------

  private discard(score: ScoreResult): EvaluateResult {
    const metaStore = getMetadataStore();
    metaStore.incrementDiscard();

    const config = getConfigStore();
    const compressThreshold = config.get("COMPRESS_THRESHOLD");

    return {
      action: "discarded" as RouteAction,
      score,
      reason: `Score ${score.final_score.toFixed(3)} < ${compressThreshold.toFixed(2)} → discarded`,
    };
  }

  private async checkAndLinkContradictions(
    newId: string,
    content: string,
    tags: string[]
  ): Promise<string | null> {
    const vectorStore = getVectorStore();
    const metaStore = getMetadataStore();
    const embedding = await embed(content);

    // Query for similar memories
    const similar = await vectorStore.query(embedding, 3);
    for (const match of similar) {
      if (match.id === newId) continue;
      if (match.similarity >= 0.60) {
        const existing = metaStore.getById(match.id);
        if (existing) {
          const summarizer = getSummarizer();
          const isContradiction = await summarizer.detectContradiction(existing.content, content);
          if (isContradiction) {
            // Found a contradiction! Link them.
            metaStore.addLink(newId, existing.id, "contradicts");
            return `Contradiction detected with memory ${existing.id.slice(0, 8)}... ("${existing.content}"). Automatically created 'contradicts' relationship link.`;
          }
        }
      }
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _router: MemoryRouter | null = null;

export function getMemoryRouter(): MemoryRouter {
  if (!_router) {
    _router = new MemoryRouter();
  }
  return _router;
}
