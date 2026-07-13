// ============================================================
// src/store/backup.ts
// Export and import database utilities for Memory Manager Agent.
// Supports JSON, CSV, and Markdown formats.
// ============================================================

import { getMetadataStore } from "./metadata.js";
import { getVectorStore } from "./vector.js";
import { embed } from "../embedding/embed.js";
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

/**
 * Exports memories and links to a Markdown payload.
 */
export function exportToMarkdown(
  memories: Omit<MemoryRecord, "embedding">[],
  links: MemoryLink[]
): string {
  let md = "# Memory Manager Agent Backup\n\n## Memories\n\n";
  for (const record of memories) {
    md += `### Memory ${record.id}\n`;
    md += `- **Content**: ${record.content}\n`;
    md += `- **Type**: ${record.type}\n`;
    md += `- **Source**: ${record.source}\n`;
    md += `- **Tags**: ${record.tags.join(",")}\n`;
    md += `- **Importance**: ${record.importance ?? 5}\n`;
    md += `- **Created At**: ${record.created_at}\n`;
    md += `- **Last Accessed**: ${record.last_accessed}\n`;
    md += `- **Access Count**: ${record.access_count}\n`;
    md += `- **Decay Weight**: ${record.decay_weight}\n`;
    if (record.expires_at) {
      md += `- **Expires At**: ${record.expires_at}\n`;
    }
    md += "\n";
  }

  md += "## Links\n\n";
  for (const link of links) {
    md += `- **Link**: ${link.sourceId} -> ${link.targetId} [${link.relation}]\n`;
  }

  return md;
}

/**
 * Exports memories to a CSV payload.
 */
export function exportToCSV(
  memories: Omit<MemoryRecord, "embedding">[],
  links: MemoryLink[]
): string {
  let csv = "id,content,type,source,created_at,last_accessed,access_count,decay_weight,tags,expires_at,importance\n";
  
  const escapeCSV = (str: string) => {
    const escaped = str.replace(/"/g, '""');
    return `"${escaped}"`;
  };

  for (const record of memories) {
    const fields = [
      record.id,
      escapeCSV(record.content),
      record.type,
      record.source,
      record.created_at,
      record.last_accessed,
      record.access_count,
      record.decay_weight,
      escapeCSV(record.tags.join(",")),
      record.expires_at ?? "",
      record.importance ?? 5
    ];
    csv += fields.join(",") + "\n";
  }
  return csv;
}

/**
 * Imports memories from a CSV payload and generates vector embeddings on-the-fly.
 */
export async function importFromCSV(
  csvStr: string
): Promise<{ importedMemories: number; importedLinks: number }> {
  const metaStore = getMetadataStore();
  const vectorStore = getVectorStore();

  const lines = csvStr.split("\n");
  const headers = lines[0]?.split(",");
  if (!headers || headers[0] !== "id" || headers[1] !== "content") {
    throw new Error("Invalid CSV format headers");
  }

  let importedMemories = 0;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;

    const fields: string[] = [];
    let currentField = "";
    let inQuotes = false;
    for (let c = 0; c < line.length; c++) {
      const char = line[c];
      if (char === '"') {
        if (inQuotes && line[c + 1] === '"') {
          currentField += '"';
          c++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === ',' && !inQuotes) {
        fields.push(currentField);
        currentField = "";
      } else {
        currentField += char;
      }
    }
    fields.push(currentField);

    if (fields.length < 9) continue;

    const id = fields[0]!;
    const content = fields[1]!;
    const type = fields[2] as any;
    const source = fields[3]!;
    const created_at = parseInt(fields[4]!, 10) || Date.now();
    const last_accessed = parseInt(fields[5]!, 10) || Date.now();
    const access_count = parseInt(fields[6]!, 10) || 0;
    const decay_weight = parseFloat(fields[7]!) || 1.0;
    const tags = fields[8]!.split(",").filter(Boolean);
    const expires_at = fields[9] ? parseInt(fields[9]!, 10) : undefined;
    const importance = fields[10] ? parseInt(fields[10]!, 10) : 5;

    const record: Omit<MemoryRecord, "embedding"> = {
      id,
      content,
      type,
      source,
      created_at,
      last_accessed,
      access_count,
      decay_weight,
      merged_from: [],
      tags,
      expires_at,
      importance,
    };

    const embedding = await embed(content);

    const existing = metaStore.getById(id);
    if (existing) {
      metaStore.update(id, record);
    } else {
      metaStore.insert(record);
    }

    await vectorStore.upsert(id, embedding, {
      type,
      source,
      created_at,
    });

    importedMemories++;
  }

  return { importedMemories, importedLinks: 0 };
}

/**
 * Imports memories and links from a Markdown payload and generates vector embeddings on-the-fly.
 */
export async function importFromMarkdown(
  mdStr: string
): Promise<{ importedMemories: number; importedLinks: number }> {
  const metaStore = getMetadataStore();
  const vectorStore = getVectorStore();

  const lines = mdStr.split("\n");
  let importedMemories = 0;
  let currentRecord: Partial<Omit<MemoryRecord, "embedding">> = {};
  const linksToImport: MemoryLink[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("### Memory ")) {
      if (currentRecord.id && currentRecord.content) {
        await saveMarkdownMemory(currentRecord, metaStore, vectorStore);
        importedMemories++;
      }
      currentRecord = { id: trimmed.substring("### Memory ".length).trim() };
    } else if (trimmed.startsWith("- **Content**: ")) {
      currentRecord.content = trimmed.substring("- **Content**: ".length).trim();
    } else if (trimmed.startsWith("- **Type**: ")) {
      currentRecord.type = trimmed.substring("- **Type**: ".length).trim() as any;
    } else if (trimmed.startsWith("- **Source**: ")) {
      currentRecord.source = trimmed.substring("- **Source**: ".length).trim();
    } else if (trimmed.startsWith("- **Tags**: ")) {
      const tagStr = trimmed.substring("- **Tags**: ".length).trim();
      currentRecord.tags = tagStr.split(",").filter(Boolean);
    } else if (trimmed.startsWith("- **Importance**: ")) {
      currentRecord.importance = parseInt(trimmed.substring("- **Importance**: ".length).trim(), 10) || 5;
    } else if (trimmed.startsWith("- **Created At**: ")) {
      currentRecord.created_at = parseInt(trimmed.substring("- **Created At**: ".length).trim(), 10) || Date.now();
    } else if (trimmed.startsWith("- **Last Accessed**: ")) {
      currentRecord.last_accessed = parseInt(trimmed.substring("- **Last Accessed**: ".length).trim(), 10) || Date.now();
    } else if (trimmed.startsWith("- **Access Count**: ")) {
      currentRecord.access_count = parseInt(trimmed.substring("- **Access Count**: ".length).trim(), 10) || 0;
    } else if (trimmed.startsWith("- **Decay Weight**: ")) {
      currentRecord.decay_weight = parseFloat(trimmed.substring("- **Decay Weight**: ".length).trim()) || 1.0;
    } else if (trimmed.startsWith("- **Expires At**: ")) {
      currentRecord.expires_at = parseInt(trimmed.substring("- **Expires At**: ".length).trim(), 10);
    } else if (trimmed.startsWith("- **Link**: ")) {
      const linkMatch = trimmed.match(/- \*\*Link\*\*: ([a-f0-9-]+) -> ([a-f0-9-]+) \[(.+)\]/i);
      if (linkMatch && linkMatch[1] && linkMatch[2] && linkMatch[3]) {
        linksToImport.push({
          sourceId: linkMatch[1],
          targetId: linkMatch[2],
          relation: linkMatch[3]
        });
      }
    }
  }

  if (currentRecord.id && currentRecord.content) {
    await saveMarkdownMemory(currentRecord, metaStore, vectorStore);
    importedMemories++;
  }

  metaStore.importLinks(linksToImport);

  return { importedMemories, importedLinks: linksToImport.length };
}

async function saveMarkdownMemory(
  record: Partial<Omit<MemoryRecord, "embedding">>,
  metaStore: any,
  vectorStore: any
) {
  const fullRecord: Omit<MemoryRecord, "embedding"> = {
    id: record.id!,
    content: record.content!,
    type: record.type ?? "fact",
    source: record.source ?? "markdown-import",
    created_at: record.created_at ?? Date.now(),
    last_accessed: record.last_accessed ?? Date.now(),
    access_count: record.access_count ?? 0,
    decay_weight: record.decay_weight ?? 1.0,
    merged_from: [],
    tags: record.tags ?? [],
    expires_at: record.expires_at,
    importance: record.importance ?? 5,
  };

  const embedding = await embed(fullRecord.content);

  const existing = metaStore.getById(fullRecord.id);
  if (existing) {
    metaStore.update(fullRecord.id, fullRecord);
  } else {
    metaStore.insert(fullRecord);
  }

  await vectorStore.upsert(fullRecord.id, embedding, {
    type: fullRecord.type,
    source: fullRecord.source,
    created_at: fullRecord.created_at,
  });
}
