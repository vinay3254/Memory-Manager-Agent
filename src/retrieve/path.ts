// ============================================================
// src/retrieve/path.ts
// Cognitive pathfinder service.
// Traces relationship paths between concepts and synthesizes narrative links.
// ============================================================

import { getMetadataStore } from "../store/metadata.js";
import { getVectorStore } from "../store/vector.js";
import { getSummarizer } from "../compress/summarize.js";
import { embed } from "../embedding/embed.js";

/**
 * Resolves two concepts to vector memories, runs a BFS to find the shortest path of links,
 * and calls Claude to explain the narrative link between them.
 */
export async function findAndExplainPath(startConcept: string, endConcept: string): Promise<string> {
  const metaStore = getMetadataStore();
  const vectorStore = getVectorStore();
  const summarizer = getSummarizer();

  const startEmbedding = await embed(startConcept);
  const startResults = await vectorStore.query(startEmbedding, 1);
  if (startResults.length === 0) return `Could not resolve start concept "${startConcept}" to any memory.`;
  const startId = startResults[0]!.id;

  const endEmbedding = await embed(endConcept);
  const endResults = await vectorStore.query(endEmbedding, 1);
  if (endResults.length === 0) return `Could not resolve end concept "${endConcept}" to any memory.`;
  const endId = endResults[0]!.id;

  const path = metaStore.findShortestPath(startId, endId);
  if (!path) {
    return `No path of relationships connects "${startConcept}" to "${endConcept}".`;
  }

  if (path.length === 0) {
    return `Both concepts resolved to the same memory: "${startConcept}" and "${endConcept}".`;
  }

  const pathSteps: string[] = [];
  const allNodes = metaStore.getAll(true);
  const contentMap = new Map<string, string>();
  for (const n of allNodes) {
    contentMap.set(n.id, n.content);
  }

  for (const link of path) {
    const src = contentMap.get(link.sourceId) ?? link.sourceId;
    const tgt = contentMap.get(link.targetId) ?? link.targetId;
    pathSteps.push(`"${src}" -[${link.relation.toUpperCase()}]-> "${tgt}"`);
  }

  const narrative = await summarizer.explainPath(startConcept, endConcept, pathSteps);

  return `Chain of Links:\n${pathSteps.map((s, i) => `  ${i + 1}. ${s}`).join("\n")}\n\nNarrative Connection:\n${narrative}`;
}
