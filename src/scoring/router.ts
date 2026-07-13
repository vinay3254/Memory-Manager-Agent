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
import type {
  MemoryRecord,
  MemoryType,
  RouteAction,
  EvaluateResult,
  ScoreResult,
} from "../types.js";

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------
const STORE_THRESHOLD    = parseFloat(process.env["SCORE_STORE_THRESHOLD"]    ?? "0.7");
const COMPRESS_THRESHOLD = parseFloat(process.env["SCORE_COMPRESS_THRESHOLD"] ?? "0.35");

/** Minimum similarity to consider two memories "merge-able" during compression */
const MERGE_SIMILARITY_THRESHOLD = 0.8;

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
    expires_at?: number
  ): Promise<EvaluateResult> {
    const { final_score } = score;

    if (final_score >= STORE_THRESHOLD) {
      return this.store(content, score, type, source, tags, undefined, expires_at);
    } else if (final_score >= COMPRESS_THRESHOLD) {
      return this.compress(content, score, type, source, tags, expires_at);
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
    expires_at?: number
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
    };

    const metaStore = getMetadataStore();
    const vectorStore = getVectorStore();

    metaStore.insert(record);
    await vectorStore.upsert(id, embedding, {
      type,
      source,
      created_at: now,
    });

    return {
      action: "stored" as RouteAction,
      memoryId: id,
      score,
      reason: fallbackReason ?? `Score ${score.final_score.toFixed(3)} >= ${STORE_THRESHOLD} → stored as new memory`,
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
    expires_at?: number
  ): Promise<EvaluateResult> {
    const embedding = await embed(content);
    const vectorStore = getVectorStore();
    const metaStore = getMetadataStore();

    // Find the most similar existing memory
    const similar = await vectorStore.query(embedding, 1);

    if (
      similar.length === 0 ||
      (similar[0]?.similarity ?? 0) < MERGE_SIMILARITY_THRESHOLD
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
        expires_at
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
        expires_at
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

    return {
      action: "compressed" as RouteAction,
      memoryId: newId,
      score,
      reason:
        `Score ${score.final_score.toFixed(3)} in [${COMPRESS_THRESHOLD}, ${STORE_THRESHOLD}) ` +
        `→ merged with memory ${existingId} (similarity ${(similar[0]?.similarity ?? 0).toFixed(3)})`,
    };
  }

  // -------------------------------------------------------------------------
  // DISCARD
  // -------------------------------------------------------------------------

  private discard(score: ScoreResult): EvaluateResult {
    const metaStore = getMetadataStore();
    metaStore.incrementDiscard();

    return {
      action: "discarded" as RouteAction,
      score,
      reason: `Score ${score.final_score.toFixed(3)} < ${COMPRESS_THRESHOLD} → discarded`,
    };
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
