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
import type { MemoryType } from "./types.js";

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
  },
  async ({ content, context, type, source, tags }) => {
    try {
      const scoreEngine = getScoreEngine();
      const router = getMemoryRouter();

      const score = await scoreEngine.score(content, context);
      const result = await router.route(
        content,
        score,
        (type as MemoryType) ?? "fact",
        source ?? "mcp-client",
        tags ?? []
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
  },
  async ({ query, limit }) => {
    try {
      const retriever = getRetriever();
      const result = await retriever.retrieve(query, limit ?? 5);

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
