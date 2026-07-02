// ============================================================
// src/retrieve/rank.ts
// Memory retrieval with decay-boosted ranking.
//
// Algorithm:
//   1. Embed the query
//   2. Run vector similarity search against all stored memories
//   3. Fetch metadata for results
//   4. Rank by: rank_score = similarity * decay_weight
//   5. Bump access stats for retrieved memories (reinforcement)
//   6. Return top-K memories + context-injectable string
// ============================================================

import { embed } from "../embedding/embed.js";
import { getVectorStore } from "../store/vector.js";
import { getMetadataStore } from "../store/metadata.js";
import type { RankedMemory, RetrieveResult, MemoryRecord, RetrieveFilters } from "../types.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const DEFAULT_LIMIT = parseInt(process.env["DEFAULT_RETRIEVE_LIMIT"] ?? "5", 10);

// How many raw candidates to fetch from vector search before reranking
const RETRIEVAL_CANDIDATE_MULTIPLIER = 3;

// ---------------------------------------------------------------------------
// Retriever
// ---------------------------------------------------------------------------

export class Retriever {
  /**
   * Retrieves the top-K most relevant memories for a query.
   *
   * @param query  - Natural language query string
   * @param limit  - Number of results to return (default: 5)
   * @returns RetrieveResult with ranked memories + context string
   */
  async retrieve(
    query: string,
    limit: number = DEFAULT_LIMIT,
    filters?: RetrieveFilters
  ): Promise<RetrieveResult> {
    const vectorStore = getVectorStore();
    const metaStore = getMetadataStore();

    // Step 1: Embed the query
    const queryEmbedding = await embed(query);

    // Step 2: Fetch more candidates than needed so we can rerank
    const hasFilters = filters && ((filters.tags && filters.tags.length > 0) || (filters.types && filters.types.length > 0));
    const candidateCount = hasFilters
      ? Math.max(limit * 10, 100)
      : limit * RETRIEVAL_CANDIDATE_MULTIPLIER;
    const vectorResults = await vectorStore.query(queryEmbedding, candidateCount);

    if (vectorResults.length === 0) {
      return { memories: [], contextString: "" };
    }

    // Step 3: Fetch metadata for all candidates
    const ids = vectorResults.map((r) => r.id);
    const metaRecords = metaStore.getByIds(ids);

    // Build a lookup map: id → { meta, similarity }
    const metaMap = new Map<string, Omit<MemoryRecord, "embedding">>();
    for (const record of metaRecords) {
      metaMap.set(record.id, record);
    }

    const similarityMap = new Map<string, number>();
    for (const vr of vectorResults) {
      similarityMap.set(vr.id, vr.similarity);
    }

    // Step 4: Compute rank scores and filter out stale vector refs & non-matching filters
    const ranked: RankedMemory[] = [];
    for (const vr of vectorResults) {
      const meta = metaMap.get(vr.id);
      if (!meta) continue; // stale reference in Chroma

      // Apply type filters
      if (filters?.types && filters.types.length > 0) {
        if (!filters.types.includes(meta.type)) {
          continue;
        }
      }

      // Apply tag filters (matches at least one tag case-insensitively)
      if (filters?.tags && filters.tags.length > 0) {
        const hasMatchingTag = filters.tags.some((t) =>
          meta.tags.some((mt) => mt.toLowerCase() === t.toLowerCase())
        );
        if (!hasMatchingTag) {
          continue;
        }
      }

      const similarity = vr.similarity;
      const rankScore = similarity * meta.decay_weight;

      ranked.push({
        memory: { ...meta, embedding: [] }, // omit embedding from response
        similarity,
        rankScore,
      });
    }

    // Sort descending by rank score
    ranked.sort((a, b) => b.rankScore - a.rankScore);

    // Take top-K
    const topK = ranked.slice(0, limit);

    // Step 5: Bump access stats for retrieved memories (reinforcement)
    for (const result of topK) {
      metaStore.bumpAccess(result.memory.id);
    }

    // Step 6: Format context-injectable string
    const contextString = formatContextString(topK, query);

    return { memories: topK, contextString };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Formats retrieved memories as a context-injectable string for LLM consumption.
 * Format mirrors common RAG context injection patterns.
 */
function formatContextString(memories: RankedMemory[], query: string): string {
  if (memories.length === 0) return "";

  const header = `## Relevant Memories for: "${query}"\n`;
  const entries = memories
    .map((rm, i) => {
      const m = rm.memory;
      const date = new Date(m.last_accessed).toISOString().slice(0, 10);
      const score = rm.rankScore.toFixed(3);
      const type = m.type.toUpperCase();
      return [
        `### Memory ${i + 1} [${type}] (rank=${score}, accessed=${date})`,
        m.content,
        m.tags.length > 0 ? `*Tags: ${m.tags.join(", ")}*` : "",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");

  return `${header}\n${entries}`;
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _retriever: Retriever | null = null;

export function getRetriever(): Retriever {
  if (!_retriever) {
    _retriever = new Retriever();
  }
  return _retriever;
}
