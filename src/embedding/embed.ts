// ============================================================
// src/embedding/embed.ts
// Singleton embedding service using @xenova/transformers
// Model: Xenova/all-MiniLM-L6-v2 (384-dim, local, no API cost)
// ============================================================

import { pipeline, type FeatureExtractionPipeline } from "@xenova/transformers";

// Allow overriding cache directory via env
if (process.env["TRANSFORMERS_CACHE"]) {
  process.env["XENOVA_CACHE_DIR"] = process.env["TRANSFORMERS_CACHE"];
}

let _pipelineInstance: FeatureExtractionPipeline | null = null;
let _loadingPromise: Promise<FeatureExtractionPipeline> | null = null;

/**
 * Returns the singleton feature-extraction pipeline.
 * Downloads the model on first call (~90MB), cached thereafter.
 */
async function getPipeline(): Promise<FeatureExtractionPipeline> {
  if (_pipelineInstance) return _pipelineInstance;

  if (!_loadingPromise) {
    _loadingPromise = pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
      progress_callback: (progress: { status: string; name?: string; file?: string; progress?: number }) => {
        if (progress.status === "downloading") {
          const pct = progress.progress ? progress.progress.toFixed(1) : "?";
          process.stderr.write(
            `\r[Embedding] Downloading model ${progress.file ?? ""} … ${pct}%`
          );
        }
      },
    }) as Promise<FeatureExtractionPipeline>;

    _pipelineInstance = await _loadingPromise;
    process.stderr.write("\n[Embedding] Model loaded.\n");
  }

  return _loadingPromise;
}

/**
 * Embeds a text string into a 384-dimensional normalized vector.
 * Uses mean pooling + L2 normalization as recommended for all-MiniLM-L6-v2.
 */
export async function embed(text: string): Promise<number[]> {
  const extractor = await getPipeline();
  const output = await extractor(text.trim(), {
    pooling: "mean",
    normalize: true,
  });
  // output.data is a Float32Array; convert to plain number[]
  return Array.from(output.data as Float32Array) as number[];
}

/**
 * Computes the cosine similarity between two normalized vectors.
 * Since we normalize during embedding, dot product == cosine similarity.
 *
 * @param a - First normalized vector
 * @param b - Second normalized vector
 * @returns Similarity score in [-1, 1]; typically [0, 1] for text
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(
      `Vector dimension mismatch: ${a.length} vs ${b.length}`
    );
  }
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
  }
  return Math.max(-1, Math.min(1, dot)); // clamp for floating-point safety
}

/**
 * Returns the maximum cosine similarity between a query vector and
 * a list of candidate vectors.
 */
export function maxSimilarity(query: number[], candidates: number[][]): number {
  if (candidates.length === 0) return 0;
  return Math.max(...candidates.map((c) => cosineSimilarity(query, c)));
}

/**
 * Pre-warms the embedding pipeline so the first real call is instant.
 * Call this once at server startup.
 */
export async function warmup(): Promise<void> {
  await embed("warmup");
}
