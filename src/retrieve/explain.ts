// ============================================================
// src/retrieve/explain.ts
// Concept hierarchy explanation service.
// Traverses semantic sub-graph and generates cohesive LLM explanations.
// ============================================================

import { getMetadataStore } from "../store/metadata.js";
import { getVectorStore } from "../store/vector.js";
import { getSummarizer } from "../compress/summarize.js";
import { embed } from "../embedding/embed.js";

/**
 * Searches for matching memories for a concept, retrieves its local semantic
 * relationship sub-graph, and asks Claude to synthesize a structured explanation.
 */
export async function explainConcept(concept: string): Promise<string> {
  const metaStore = getMetadataStore();
  const vectorStore = getVectorStore();
  const summarizer = getSummarizer();

  const queryEmbedding = await embed(concept);
  const vectorResults = await vectorStore.query(queryEmbedding, 3);

  if (vectorResults.length === 0) {
    return `No memories found matching the concept "${concept}".`;
  }

  const seedIds = vectorResults.map((r) => r.id);
  const seeds = metaStore.getByIds(seedIds, false);
  if (seeds.length === 0) {
    return `No active memories found matching the concept "${concept}".`;
  }

  const actualSeedIds = seeds.map((s) => s.id);
  const subGraph = metaStore.getSubGraph(actualSeedIds, 2);

  const memoriesStr = subGraph.nodes.map((n) => n.content);

  const contentMap = new Map<string, string>();
  for (const n of subGraph.nodes) {
    contentMap.set(n.id, n.content);
  }

  const relationshipsStr = subGraph.links
    .map((link) => {
      const srcContent = contentMap.get(link.sourceId);
      const tgtContent = contentMap.get(link.targetId);
      if (srcContent && tgtContent) {
        return `"${srcContent}" [${link.relation.toUpperCase()}] "${tgtContent}"`;
      }
      return null;
    })
    .filter((r): r is string => r !== null);

  return await summarizer.explainConcept(concept, memoriesStr, relationshipsStr);
}
