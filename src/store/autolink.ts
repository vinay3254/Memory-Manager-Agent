// ============================================================
// src/store/autolink.ts
// Relationship auto-linker.
// Scans active memories, matches conceptually similar entries, and suggests relations.
// ============================================================

import { getMetadataStore } from "./metadata.js";
import { getVectorStore } from "./vector.js";
import { getSummarizer } from "../compress/summarize.js";
import { embed } from "../embedding/embed.js";

/**
 * Sweeps the database of active memories, finds conceptually similar entries,
 * and calls the LLM to suggest relations and link them automatically.
 */
export async function autoLinkMemories(): Promise<{ linksCreated: number; details: string[] }> {
  const metaStore = getMetadataStore();
  const vectorStore = getVectorStore();
  const summarizer = getSummarizer();

  const activeMemories = metaStore.getAll(); // exclude archived
  let linksCreated = 0;
  const details: string[] = [];

  for (const A of activeMemories) {
    const embedding = await embed(A.content);
    // Retrieve top 4 matches
    const similar = await vectorStore.query(embedding, 4);

    for (const item of similar) {
      if (item.id === A.id) continue;
      if (item.similarity < 0.4) continue;

      // Check if already linked
      const links = metaStore.getLinks(A.id);
      const isLinked = links.some(l => l.memory.id === item.id);
      if (isLinked) continue;

      // Get B metadata
      const B = metaStore.getById(item.id);
      if (!B || B.archived) continue;

      try {
        const relation = await summarizer.suggestRelation(A.content, B.content);
        if (relation) {
          metaStore.addLink(A.id, B.id, relation);
          linksCreated++;
          details.push(`Linked: "${A.content.slice(0, 30)}..." -[${relation.toUpperCase()}]-> "${B.content.slice(0, 30)}..."`);
        }
      } catch (err) {
        process.stderr.write(`[AutoLinker] Error querying LLM: ${String(err)}\n`);
      }
    }
  }

  return { linksCreated, details };
}
