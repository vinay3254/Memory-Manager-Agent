// ============================================================
// src/server.ts
// MCP entry point — exposes all 5 memory tools via stdio transport.
//
// Tools:
//   memory_evaluate      — score + route a memory candidate
//   memory_retrieve      — vector search with decay-boosted ranking
//   memory_compress_now  — force-compress memories on a topic
//   memory_stats         — aggregate counts + storage info
//   memory_decay_run     — manually trigger the decay pass
// ============================================================

import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { statSync } from "fs";

import { warmup } from "./embedding/embed.js";
import { getScoreEngine } from "./scoring/score.js";
import { getMemoryRouter } from "./scoring/router.js";
import { getRetriever } from "./retrieve/rank.js";
import { getMetadataStore } from "./store/metadata.js";
import { getVectorStore } from "./store/vector.js";
import { getSummarizer } from "./compress/summarize.js";
import { runDecayPass, startDecayScheduler } from "./decay/scheduler.js";
import { embed } from "./embedding/embed.js";
import { v4 as uuidv4 } from "uuid";
import { exportBackup, importBackup } from "./store/backup.js";
import { parseTTL } from "./utils/ttl.js";
import { consolidateMemories } from "./compress/consolidate.js";
import type { MemoryType, MemoryLink, LinkedMemory } from "./types.js";

// ---------------------------------------------------------------------------
// MCP Server setup
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "memory-manager-agent",
  version: "1.0.0",
});

// ---------------------------------------------------------------------------
// Tool: memory_evaluate
// ---------------------------------------------------------------------------

server.tool(
  "memory_evaluate",
  "Score a memory candidate and route it to store, compress, or discard. Returns the action taken and score breakdown.",
  {
    content: z
      .string()
      .min(1)
      .describe("The memory text to evaluate (fact, decision, event, etc.)"),
    context: z
      .string()
      .optional()
      .describe("Optional current goals or session context to measure relevance against"),
    type: z
      .enum(["fact", "decision", "event", "summary"])
      .optional()
      .default("fact")
      .describe("Semantic type of the memory"),
    source: z
      .string()
      .optional()
      .default("mcp-client")
      .describe("Identifier for the tool/session that generated this memory"),
    tags: z
      .array(z.string())
      .optional()
      .default([])
      .describe("Topic or entity tags for clustering"),
    expiresAt: z
      .number()
      .optional()
      .describe("Optional absolute expiration timestamp (Unix milliseconds)"),
    ttl: z
      .string()
      .optional()
      .describe("Optional time-to-live string (e.g., '30d', '24h', '10m')"),
    importance: z
      .number()
      .min(1)
      .max(10)
      .optional()
      .describe("Optional importance rating (1-10)"),
  },
  async ({ content, context, type, source, tags, expiresAt, ttl, importance }) => {
    try {
      const scoreEngine = getScoreEngine();
      const router = getMemoryRouter();

      let expires_at: number | undefined = expiresAt;
      if (!expires_at && ttl) {
        const parsed = parseTTL(ttl);
        if (parsed) {
          expires_at = Date.now() + parsed;
        }
      }

      const score = await scoreEngine.score(content, context);
      const result = await router.route(
        content,
        score,
        (type as MemoryType) ?? "fact",
        source ?? "mcp-client",
        tags ?? [],
        expires_at,
        importance
      );

      const output = {
        action: result.action,
        memoryId: result.memoryId ?? null,
        reason: result.reason,
        score: {
          final: parseFloat(result.score.final_score.toFixed(4)),
          relevance: parseFloat(result.score.relevance.toFixed(4)),
          novelty: parseFloat(result.score.novelty.toFixed(4)),
          recurrence: parseFloat(result.score.recurrence.toFixed(4)),
        },
      };

      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${String(err)}` }],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: memory_retrieve
// ---------------------------------------------------------------------------

server.tool(
  "memory_retrieve",
  "Retrieve the top-K most relevant memories for a query, ranked by similarity × decay_weight. Bumps access count on results.",
  {
    query: z
      .string()
      .min(1)
      .describe("Natural language query to search memories"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .default(5)
      .describe("Maximum number of memories to return"),
    tags: z
      .array(z.string())
      .optional()
      .describe("Filter results to memories containing at least one of these tags"),
    types: z
      .array(z.enum(["fact", "decision", "event", "summary"]))
      .optional()
      .describe("Filter results to memories matching any of these types"),
  },
  async ({ query, limit, tags, types }) => {
    try {
      const retriever = getRetriever();
      const result = await retriever.retrieve(query, limit ?? 5, {
        tags,
        types: types as MemoryType[] | undefined,
      });

      const output = {
        count: result.memories.length,
        memories: result.memories.map((rm) => ({
          id: rm.memory.id,
          content: rm.memory.content,
          type: rm.memory.type,
          source: rm.memory.source,
          tags: rm.memory.tags,
          similarity: parseFloat(rm.similarity.toFixed(4)),
          decayWeight: parseFloat(rm.memory.decay_weight.toFixed(4)),
          rankScore: parseFloat(rm.rankScore.toFixed(4)),
          accessCount: rm.memory.access_count,
          lastAccessed: new Date(rm.memory.last_accessed).toISOString(),
        })),
        contextString: result.contextString,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${String(err)}` }],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: memory_compress_now
// ---------------------------------------------------------------------------

server.tool(
  "memory_compress_now",
  "Force-compress all memories matching a topic into one summary. Useful for manual housekeeping.",
  {
    topic: z
      .string()
      .min(1)
      .describe("Topic keyword or tag to match memories against"),
  },
  async ({ topic }) => {
    try {
      const metaStore = getMetadataStore();
      const vectorStore = getVectorStore();
      const summarizer = getSummarizer();

      const all = metaStore.getAll();
      const matching = all.filter(
        (m) =>
          m.tags.some((t) =>
            t.toLowerCase().includes(topic.toLowerCase())
          ) ||
          m.content.toLowerCase().includes(topic.toLowerCase())
      );

      if (matching.length < 2) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "skipped",
                reason: `Found ${matching.length} matching memories — need at least 2 to compress`,
                matched: matching.length,
              }),
            },
          ],
        };
      }

      const contents = matching.map((m) => m.content);
      const archiveContent = await summarizer.archiveCluster(contents, topic);
      const archiveEmbedding = await embed(archiveContent);
      const archiveId = uuidv4();
      const now = Date.now();

      const allMergedFrom = matching.flatMap((m) => [m.id, ...m.merged_from]);
      const allTags = [...new Set(matching.flatMap((m) => m.tags))];

      const idsToDelete = matching.map((m) => m.id);
      metaStore.deleteMany(idsToDelete);
      await vectorStore.deleteMany(idsToDelete);

      metaStore.insert({
        id: archiveId,
        content: archiveContent,
        type: "summary",
        source: "memory_compress_now",
        created_at: now,
        last_accessed: now,
        access_count: 0,
        decay_weight: 0.8,
        merged_from: allMergedFrom,
        tags: allTags.length > 0 ? allTags : [topic],
      });

      await vectorStore.upsert(archiveId, archiveEmbedding, {
        type: "summary",
        source: "memory_compress_now",
        created_at: now,
      });

      metaStore.incrementCompress();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "compressed",
              archiveId,
              merged: matching.length,
              archiveContent,
            }),
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${String(err)}` }],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: memory_stats
// ---------------------------------------------------------------------------

server.tool(
  "memory_stats",
  "Returns aggregate statistics: total stored, compressed, discarded, average decay weight, and storage size.",
  {},
  async () => {
    try {
      const metaStore = getMetadataStore();
      const vectorStore = getVectorStore();

      const dbStats = metaStore.getStats();
      const vectorCount = await vectorStore.count();
      const discardCount = metaStore.getCounter("discard_count");
      const compressCount = metaStore.getCounter("compress_count");

      // Try to read SQLite file size
      let storageSizeBytes = 0;
      try {
        const dbPath = process.env["SQLITE_DB_PATH"] ?? "./data/memories.db";
        storageSizeBytes = statSync(dbPath).size;
      } catch {
        // File might not exist yet
      }

      const output = {
        totalStored: dbStats.totalStored,
        totalInVectorStore: vectorCount,
        totalCompressed: compressCount,
        totalDiscarded: discardCount,
        averageDecayWeight: parseFloat(
          dbStats.averageDecayWeight.toFixed(4)
        ),
        storageSizeBytes,
        oldestMemory: dbStats.oldestCreatedAt
          ? new Date(dbStats.oldestCreatedAt).toISOString()
          : null,
        newestMemory: dbStats.newestCreatedAt
          ? new Date(dbStats.newestCreatedAt).toISOString()
          : null,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${String(err)}` }],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: memory_decay_run
// ---------------------------------------------------------------------------

server.tool(
  "memory_decay_run",
  "Manually triggers the daily decay pass: applies 3%/day weight decay and archives old low-decay memories.",
  {},
  async () => {
    try {
      const result = await runDecayPass();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                status: "complete",
                processed: result.processed,
                archived: result.archived,
                archiveSummaries: result.archiveSummaries,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${String(err)}` }],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: memory_link
// ---------------------------------------------------------------------------

server.tool(
  "memory_link",
  "Create a directional/semantic link between two memories (e.g. relates_to, contradicts, supersedes, details).",
  {
    sourceId: z.string().describe("The ID of the source memory"),
    targetId: z.string().describe("The ID of the target memory"),
    relation: z.string().describe("The relationship name, e.g. 'supersedes', 'relates_to', 'details'"),
  },
  async ({ sourceId, targetId, relation }) => {
    try {
      const metaStore = getMetadataStore();
      metaStore.addLink(sourceId, targetId, relation);
      return {
        content: [{ type: "text", text: `Successfully linked ${sourceId} to ${targetId} as '${relation}'` }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${String(err)}` }],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: memory_get_links
// ---------------------------------------------------------------------------

server.tool(
  "memory_get_links",
  "Retrieve all linked memories (incoming and outgoing) for a specific memory ID.",
  {
    id: z.string().describe("The ID of the memory to check links for"),
  },
  async ({ id }) => {
    try {
      const metaStore = getMetadataStore();
      const links = metaStore.getLinks(id);
      return {
        content: [{ type: "text", text: JSON.stringify(links, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${String(err)}` }],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: memory_export
// ---------------------------------------------------------------------------

server.tool(
  "memory_export",
  "Export all memories and relationship links as a stringified JSON backup payload.",
  {},
  async () => {
    try {
      const backupStr = await exportBackup();
      return {
        content: [{ type: "text", text: backupStr }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${String(err)}` }],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: memory_import
// ---------------------------------------------------------------------------

server.tool(
  "memory_import",
  "Import and merge memories and links from a stringified JSON backup payload.",
  {
    backupData: z.string().describe("The stringified JSON backup payload"),
  },
  async ({ backupData }) => {
    try {
      const stats = await importBackup(backupData);
      return {
        content: [{
          type: "text",
          text: `Successfully imported ${stats.importedMemories} memories and ${stats.importedLinks} relationship links.`,
        }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${String(err)}` }],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: memory_tag_stats
// ---------------------------------------------------------------------------

server.tool(
  "memory_tag_stats",
  "Retrieve list of all tags currently in the memory store along with their frequency counts.",
  {},
  async () => {
    try {
      const metaStore = getMetadataStore();
      const stats = metaStore.getTagStats();
      return {
        content: [{ type: "text", text: JSON.stringify(stats, null, 2) }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${String(err)}` }],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: memory_bulk_tag
// ---------------------------------------------------------------------------

server.tool(
  "memory_bulk_tag",
  "Add or remove a tag from multiple memories that match a semantic search query.",
  {
    tag: z.string().describe("The tag name to add or remove"),
    query: z.string().describe("A semantic search query to select matching memories"),
    action: z.enum(["add", "remove"]).default("add").describe("Whether to add or remove the tag"),
  },
  async ({ tag, query, action }) => {
    try {
      const retriever = getRetriever();
      const metaStore = getMetadataStore();

      const searchResult = await retriever.retrieve(query, 20);
      const ids = searchResult.memories.map(m => m.memory.id);

      let count = 0;
      if (action === "add") {
        count = metaStore.bulkAddTag(ids, tag);
      } else {
        count = metaStore.bulkRemoveTag(ids, tag);
      }

      return {
        content: [{ type: "text", text: `Successfully ${action === "add" ? "added" : "removed"} tag '#${tag}' ${action === "add" ? "to" : "from"} ${count} memories.` }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${String(err)}` }],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Tool: memory_consolidate
// ---------------------------------------------------------------------------

server.tool(
  "memory_consolidate",
  "Consolidate memories that share a tag into a single summary memory and archive the originals.",
  {
    tag: z.string().optional().describe("Optional tag to consolidate. If omitted, auto-discovers tag with >= 3 memories."),
  },
  async ({ tag }) => {
    try {
      const stats = await consolidateMemories(tag);
      if (stats.consolidatedCount === 0) {
        return {
          content: [{ type: "text", text: "No memory clusters eligible/found for consolidation." }],
        };
      }
      return {
        content: [{
          type: "text",
          text: `Consolidated ${stats.consolidatedCount} memories into new summary memory [${stats.newSummaryId}].\nSummary content: "${stats.summaryText}"`
        }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${String(err)}` }],
        isError: true,
      };
    }
  }
);

// ---------------------------------------------------------------------------
// Main — connect transport and start cron
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  process.stderr.write("[MemoryManager] Starting server...\n");

  // Pre-warm embedding model
  process.stderr.write("[MemoryManager] Warming up embedding model...\n");
  await warmup();

  // Start daily decay cron
  startDecayScheduler();

  // Connect stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write("[MemoryManager] MCP server running on stdio.\n");
  process.stderr.write(
    "[MemoryManager] Tools: memory_evaluate, memory_retrieve, memory_compress_now, memory_stats, memory_decay_run\n"
  );
}

main().catch((err) => {
  process.stderr.write(`[MemoryManager] Fatal error: ${String(err)}\n`);
  process.exit(1);
});

