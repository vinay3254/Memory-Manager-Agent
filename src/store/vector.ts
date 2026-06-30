// ============================================================
// src/store/vector.ts
// ChromaDB vector store wrapper for embedding storage + search.
// Connects to a locally-running ChromaDB server.
// ============================================================

import { ChromaClient, type Collection } from "chromadb";
import type { VectorSearchResult } from "../types.js";

// ---------------------------------------------------------------------------
// VectorStore
// ---------------------------------------------------------------------------

export class VectorStore {
  private client: ChromaClient;
  private collectionName: string;
  private _collection: Collection | null = null;

  constructor(
    chromaUrl: string = "http://localhost:8000",
    collectionName: string = "memory_manager"
  ) {
    this.client = new ChromaClient({ path: chromaUrl });
    this.collectionName = collectionName;
  }

  // -------------------------------------------------------------------------
  // Lazy collection accessor
  // -------------------------------------------------------------------------

  private async getCollection(): Promise<Collection> {
    if (!this._collection) {
      this._collection = await this.client.getOrCreateCollection({
        name: this.collectionName,
        metadata: {
          description: "Memory Manager Agent long-term memory store",
          "hnsw:space": "cosine",
        },
      });
    }
    return this._collection;
  }

  // -------------------------------------------------------------------------
  // Write operations
  // -------------------------------------------------------------------------

  /**
   * Upserts a memory's embedding into ChromaDB.
   * If the ID already exists, it is overwritten.
   */
  async upsert(
    id: string,
    embedding: number[],
    metadata: Record<string, string | number | boolean>
  ): Promise<void> {
    const collection = await this.getCollection();
    await collection.upsert({
      ids: [id],
      embeddings: [embedding],
      metadatas: [metadata],
    });
  }

  /**
   * Deletes a memory's embedding from ChromaDB.
   */
  async delete(id: string): Promise<void> {
    const collection = await this.getCollection();
    await collection.delete({ ids: [id] });
  }

  /**
   * Deletes multiple memories at once.
   */
  async deleteMany(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const collection = await this.getCollection();
    await collection.delete({ ids });
  }

  // -------------------------------------------------------------------------
  // Read / search operations
  // -------------------------------------------------------------------------

  /**
   * Finds the top-N most similar memories to a query embedding.
   * Returns results sorted by similarity descending (closest first).
   *
   * ChromaDB returns distances where 0 = identical, 2 = opposite (cosine space).
   * We convert to similarity = 1 - (distance / 2) for a [0,1] scale.
   */
  async query(
    embedding: number[],
    nResults: number = 5
  ): Promise<VectorSearchResult[]> {
    const collection = await this.getCollection();
    const count = await collection.count();
    if (count === 0) return [];

    const actualN = Math.min(nResults, count);

    const results = await collection.query({
      queryEmbeddings: [embedding],
      nResults: actualN,
    });

    const ids = results.ids[0] ?? [];
    const distances = results.distances?.[0] ?? [];

    return ids.map((id, i) => {
      const dist = distances[i] ?? 1;
      // ChromaDB cosine distance: 0 = identical, 1 = orthogonal, 2 = opposite
      // Convert to similarity in [0,1]
      const similarity = Math.max(0, 1 - dist);
      return { id, distance: dist, similarity };
    });
  }

  /**
   * Returns the embedding stored for a given ID, or null if not found.
   */
  async getEmbedding(id: string): Promise<number[] | null> {
    const collection = await this.getCollection();
    const result = await collection.get({
      ids: [id],
      include: ["embeddings" as never],
    });
    const emb = result.embeddings?.[0];
    return emb ? Array.from(emb) : null;
  }

  /**
   * Returns the total number of entries in the collection.
   */
  async count(): Promise<number> {
    const collection = await this.getCollection();
    return collection.count();
  }

  /**
   * Drops and recreates the collection (use for testing only).
   */
  async reset(): Promise<void> {
    await this.client.deleteCollection({ name: this.collectionName });
    this._collection = null;
    await this.getCollection();
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _vectorStore: VectorStore | null = null;

export function getVectorStore(): VectorStore {
  if (!_vectorStore) {
    const chromaUrl =
      process.env["CHROMA_URL"] ?? "http://localhost:8000";
    const collectionName =
      process.env["CHROMA_COLLECTION"] ?? "memory_manager";
    _vectorStore = new VectorStore(chromaUrl, collectionName);
  }
  return _vectorStore;
}
