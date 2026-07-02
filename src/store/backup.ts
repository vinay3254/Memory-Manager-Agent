// ============================================================
// src/store/backup.ts
// Export and import database utilities for Memory Manager Agent.
// ============================================================

import { getMetadataStore } from "./metadata.js";
import { getVectorStore } from "./vector.js";
import type { MemoryRecord, MemoryLink } from "../types.js";

export interface BackupPayload {
  version: string;
  timestamp: number;
  memories: Array<{
    record: Omit<MemoryRecord, "embedding">;
    embedding: number[];
  }>;
  links: MemoryLink[];
}

/**
 * Exports all memories and links to a JSON backup payload.
 */
export async function exportBackup(): Promise<string> {
  const metaStore = getMetadataStore();
  const vectorStore = getVectorStore();

  const memories = metaStore.getAll();
  const links = metaStore.getAllLinks();

  const exportedMemories: BackupPayload["memories"] = [];

  for (const record of memories) {
    const embedding = await vectorStore.getEmbedding(record.id);
    exportedMemories.push({
      record,
      embedding: embedding ?? [],
    });
  }

  const payload: BackupPayload = {
    version: "1.0.0",
    timestamp: Date.now(),
    memories: exportedMemories,
    links,
  };

  return JSON.stringify(payload, null, 2);
}

/**
 * Imports memories and links from a stringified JSON backup payload.
 * Merges/upserts them into the current active stores.
 */
export async function importBackup(
  payloadStr: string
): Promise<{ importedMemories: number; importedLinks: number }> {
  const metaStore = getMetadataStore();
  const vectorStore = getVectorStore();

  const payload = JSON.parse(payloadStr) as BackupPayload;

  if (!payload || typeof payload !== "object" || !Array.isArray(payload.memories)) {
    throw new Error("Invalid backup payload format");
  }

  let importedMemories = 0;
  for (const item of payload.memories) {
    const { record, embedding } = item;
    // Insert/update in metadata store
    const existing = metaStore.getById(record.id);
    if (existing) {
      metaStore.update(record.id, record);
    } else {
      metaStore.insert(record);
    }

    // Insert/update in vector store
    await vectorStore.upsert(record.id, embedding, {
      type: record.type,
      source: record.source,
      created_at: record.created_at,
    });

    importedMemories++;
  }

  // Import links after memories are present
  const linksToImport = payload.links ?? [];
  metaStore.importLinks(linksToImport);

  return {
    importedMemories,
    importedLinks: linksToImport.length,
  };
}
