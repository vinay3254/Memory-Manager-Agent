// ============================================================
// src/scoring/score.ts
// Scores a memory candidate on three axes:
//   - relevance  (0.4 weight): cosine similarity to context
//   - novelty    (0.3 weight): 1 - max similarity to existing memories
//   - recurrence (0.3 weight): topic frequency in recent history
//
// final_score = 0.4 * relevance + 0.3 * novelty + 0.3 * recurrence
// ============================================================

import { embed, cosineSimilarity, maxSimilarity } from "../embedding/embed.js";
import { getVectorStore } from "../store/vector.js";
import { getMetadataStore } from "../store/metadata.js";
import type { AxisScores, ScoreResult } from "../types.js";

// ---------------------------------------------------------------------------
// Weights
// ---------------------------------------------------------------------------
const W_RELEVANCE  = 0.4;
const W_NOVELTY    = 0.3;
const W_RECURRENCE = 0.3;

// Number of recent memories to scan for recurrence
const RECURRENCE_WINDOW = 50;

// Number of top existing memories to check for novelty
const NOVELTY_TOP_K = 5;

// ---------------------------------------------------------------------------
// ScoreEngine
// ---------------------------------------------------------------------------

export class ScoreEngine {
  /**
   * Scores an incoming memory candidate.
   *
   * @param content   - The candidate memory text to score
   * @param context   - Optional context string (current goals, session summary).
   *                    If absent, relevance is measured against the content itself.
   * @returns Full ScoreResult with axis scores + final_score
   */
  async score(content: string, context?: string): Promise<ScoreResult> {
    const candidateEmbedding = await embed(content);

    const [relevance, novelty, recurrence] = await Promise.all([
      this.scoreRelevance(candidateEmbedding, context, content),
      this.scoreNovelty(candidateEmbedding),
      this.scoreRecurrence(content),
    ]);

    const axes: AxisScores = { relevance, novelty, recurrence };
    const final_score =
      W_RELEVANCE * relevance +
      W_NOVELTY * novelty +
      W_RECURRENCE * recurrence;

    return {
      ...axes,
      final_score: Math.max(0, Math.min(1, final_score)),
    };
  }

  // -------------------------------------------------------------------------
  // Axis: Relevance
  // -------------------------------------------------------------------------

  /**
   * Cosine similarity between the candidate and the provided context.
   * If no context is given, uses the candidate's self-similarity (returns 0.5
   * as a neutral score — neither highly relevant nor irrelevant without context).
   */
  private async scoreRelevance(
    candidateEmbedding: number[],
    context: string | undefined,
    content: string
  ): Promise<number> {
    if (!context || context.trim() === "") {
      // No context provided — return a neutral-ish score.
      // The candidate is relevant to itself, but we have no goal to compare.
      return 0.5;
    }

    const contextEmbedding = await embed(context);
    const similarity = cosineSimilarity(candidateEmbedding, contextEmbedding);

    // Cosine similarity is in [-1, 1]; normalize to [0, 1]
    return (similarity + 1) / 2;
  }

  // -------------------------------------------------------------------------
  // Axis: Novelty
  // -------------------------------------------------------------------------

  /**
   * novelty = 1 - max(similarity to top-K existing memories)
   *
   * A candidate identical to stored memories scores 0 novelty.
   * A brand-new idea with no similar memories scores 1.0 novelty.
   */
  private async scoreNovelty(candidateEmbedding: number[]): Promise<number> {
    const vectorStore = getVectorStore();

    // Query the vector store for the most similar existing memories
    const results = await vectorStore.query(candidateEmbedding, NOVELTY_TOP_K);

    if (results.length === 0) {
      // No memories stored yet → completely novel
      return 1.0;
    }

    const maxSim = Math.max(...results.map((r) => r.similarity));
    return Math.max(0, 1 - maxSim);
  }

  // -------------------------------------------------------------------------
  // Axis: Recurrence
  // -------------------------------------------------------------------------

  /**
   * Measures how frequently this topic/entity has appeared across
   * recent memories. Uses simple term-frequency overlap on the
   * most significant words extracted from the content.
   *
   * Normalized to [0, 1] via: count / RECURRENCE_WINDOW
   */
  private async scoreRecurrence(content: string): Promise<number> {
    const metaStore = getMetadataStore();
    const recent = metaStore.getRecent(RECURRENCE_WINDOW);

    if (recent.length === 0) return 0;

    const candidateTokens = tokenize(content);
    if (candidateTokens.size === 0) return 0;

    // Count how many recent memories share at least one significant token
    let matchCount = 0;
    for (const memory of recent) {
      const memTokens = tokenize(memory.content);
      const intersection = [...candidateTokens].filter((t) =>
        memTokens.has(t)
      );
      if (intersection.length > 0) matchCount++;
    }

    return Math.min(1, matchCount / RECURRENCE_WINDOW);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Common English stop words to ignore during tokenization */
const STOP_WORDS = new Set([
  "a","an","the","and","or","but","in","on","at","to","for","of","with",
  "by","from","is","are","was","were","be","been","being","have","has",
  "had","do","does","did","will","would","could","should","may","might",
  "shall","can","need","dare","ought","used","this","that","these","those",
  "it","its","it's","i","me","my","we","our","you","your","he","she","they",
  "them","their","what","which","who","whom","when","where","why","how",
  "all","each","every","both","few","more","most","other","some","such",
  "no","not","only","same","so","than","too","very","just","as","if",
]);

/**
 * Extracts significant tokens from text for recurrence matching.
 * Returns a Set of lowercase word stems (4+ chars, not stop words).
 */
function tokenize(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOP_WORDS.has(w));
  return new Set(words);
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _scoreEngine: ScoreEngine | null = null;

export function getScoreEngine(): ScoreEngine {
  if (!_scoreEngine) {
    _scoreEngine = new ScoreEngine();
  }
  return _scoreEngine;
}
