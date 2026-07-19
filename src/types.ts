// ============================================================
// src/types.ts
// Core type definitions for the Memory Manager Agent
// ============================================================

/**
 * The canonical memory record stored in SQLite + ChromaDB.
 * Embedding is stored in ChromaDB; all other fields live in SQLite.
 */
export interface MemoryRecord {
  /** Unique identifier (UUID v4) */
  id: string;

  /** The compressed or raw memory text */
  content: string;

  /** 384-dimensional vector from all-MiniLM-L6-v2 */
  embedding: number[];

  /** Semantic type of this memory */
  type: MemoryType;

  /** Which tool/session/CLI command created this memory */
  source: string;

  /** Creation timestamp (Unix milliseconds) */
  created_at: number;

  /** Last access timestamp (Unix milliseconds) */
  last_accessed: number;

  /** How many times this memory has been retrieved */
  access_count: number;

  /**
   * Current relevance weight, starts at 1.0, decays 3% per day.
   * On retrieval, bumped back toward 1.0.
   */
  decay_weight: number;

  /** IDs of memories that were merged into this one */
  merged_from: string[];

  /** Free-form topic/entity tags for cluster-based archiving */
  tags: string[];

  /** Expiration timestamp (Unix milliseconds) after which memory is discarded */
  expires_at?: number;

  /** Historical log of reads, modifications, or creation events */
  access_history?: Array<{ timestamp: number; action: string }>;

  /** User or agent designated importance rating (1-10), default 5 */
  importance?: number;

  /** Whether the memory is soft-deleted/archived */
  archived?: boolean;
}

/** Semantic types a memory can hold */
export type MemoryType = "fact" | "decision" | "event" | "summary";

// ------------------------------------------------------------
// Scoring
// ------------------------------------------------------------

/** Raw scores on all three axes before weighting */
export interface AxisScores {
  /** Cosine similarity to current goals/context (0-1) */
  relevance: number;

  /** 1 - max similarity to existing memories; penalizes duplicates (0-1) */
  novelty: number;

  /**
   * Normalized recurrence of this topic across recent history (0-1).
   * Higher = topic has appeared many times, signaling importance.
   */
  recurrence: number;
}

/** Full scoring result with final weighted score */
export interface ScoreResult extends AxisScores {
  /**
   * Weighted combination:
   *   final_score = 0.4 * relevance + 0.3 * novelty + 0.3 * recurrence
   */
  final_score: number;
}

// ------------------------------------------------------------
// Routing
// ------------------------------------------------------------

/** The action taken after scoring a memory candidate */
export type RouteAction = "stored" | "compressed" | "discarded";

/** Result returned by memory_evaluate MCP tool */
export interface EvaluateResult {
  /** What happened to the candidate */
  action: RouteAction;

  /** ID of the memory created or updated (absent for discard) */
  memoryId?: string;

  /** The full score breakdown */
  score: ScoreResult;

  /** Human-readable explanation of the decision */
  reason: string;
}

// ------------------------------------------------------------
// Retrieval
// ------------------------------------------------------------

/** A ranked memory returned by retrieval */
export interface RankedMemory {
  memory: MemoryRecord;

  /** Raw cosine similarity to query (0-1) */
  similarity: number;

  /**
   * Final rank score = similarity * decay_weight.
   * Used to surface fresh, frequently-accessed memories.
   */
  rankScore: number;
}

// Result returned by memory_retrieve MCP tool
export interface RetrieveFilters {
  tags?: string[];
  types?: MemoryType[];
}

/** Result returned by memory_retrieve MCP tool */
export interface RetrieveResult {
  /** Ordered list of top-K ranked memories */
  memories: RankedMemory[];

  /** Context-injectable formatted string for LLM consumption */
  contextString: string;
}

// ------------------------------------------------------------
// Stats
// ------------------------------------------------------------

/** Aggregate statistics about the memory store */
export interface MemoryStats {
  totalStored: number;
  totalCompressed: number;
  totalDiscarded: number;
  averageDecayWeight: number;
  /** Approximate storage size in bytes (SQLite file size) */
  storageSizeBytes: number;
}

// ------------------------------------------------------------
// Vector store
// ------------------------------------------------------------

/** A single result from a vector similarity search */
export interface VectorSearchResult {
  id: string;
  /** ChromaDB distance (lower = more similar); convert to similarity = 1 - distance */
  distance: number;
  /** Similarity score = 1 - distance */
  similarity: number;
}

// ------------------------------------------------------------
// Decay
// ------------------------------------------------------------

/** Result from a decay pass */
export interface DecayRunResult {
  processed: number;
  archived: number;
  archiveSummaries: string[];
}

// ------------------------------------------------------------
// Linkage
// ------------------------------------------------------------

export interface MemoryLink {
  sourceId: string;
  targetId: string;
  relation: string;
}

export interface LinkedMemory {
  memory: Omit<MemoryRecord, "embedding">;
  relation: string;
  /** Direction of the relation: "outgoing" (source -> target) or "incoming" (target -> source) */
  direction: "outgoing" | "incoming";
}
