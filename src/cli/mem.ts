#!/usr/bin/env node
// ============================================================
// src/cli/mem.ts
// CLI wrapper for the Memory Manager Agent.
//
// Commands:
//   mem add "some fact"              → memory_evaluate
//   mem add "fact" --type decision   → evaluate with type
//   mem add "fact" --tag ai --tag ml → evaluate with tags
//   mem search "query"               → memory_retrieve
//   mem search "query" --limit 10    → retrieve with custom limit
//   mem stats                        → memory_stats
//   mem decay                        → memory_decay_run
//   mem compress "topic"             → memory_compress_now
// ============================================================

import "dotenv/config";
import { getScoreEngine } from "../scoring/score.js";
import { getMemoryRouter } from "../scoring/router.js";
import { getRetriever } from "../retrieve/rank.js";
import { getMetadataStore } from "../store/metadata.js";
import { getVectorStore } from "../store/vector.js";
import { runDecayPass } from "../decay/scheduler.js";
import { getSummarizer } from "../compress/summarize.js";
import { embed } from "../embedding/embed.js";
import { statSync } from "fs";
import { v4 as uuidv4 } from "uuid";
import type { MemoryType } from "../types.js";

// ---------------------------------------------------------------------------
// ANSI colors for terminal output
// ---------------------------------------------------------------------------
const C = {
  reset:  "\x1b[0m",
  bold:   "\x1b[1m",
  dim:    "\x1b[2m",
  green:  "\x1b[32m",
  yellow: "\x1b[33m",
  blue:   "\x1b[34m",
  cyan:   "\x1b[36m",
  red:    "\x1b[31m",
  gray:   "\x1b[90m",
  white:  "\x1b[97m",
};

function colorize(text: string, color: keyof typeof C): string {
  return `${C[color]}${text}${C.reset}`;
}

function printBanner(): void {
  console.log(
    colorize("\n╔══════════════════════════════════════╗", "cyan")
  );
  console.log(
    colorize("║   🧠  Memory Manager Agent CLI       ║", "cyan")
  );
  console.log(
    colorize("╚══════════════════════════════════════╝\n", "cyan")
  );
}

// ---------------------------------------------------------------------------
// Argument parser (no external deps — pure stdlib)
// ---------------------------------------------------------------------------

interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
  /** --tag values collected as array */
  tags: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2); // strip node + script path
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  const tags: string[] = [];

  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (key === "tag" || key === "tags") {
        if (next && !next.startsWith("--")) {
          tags.push(next);
          i += 2;
        } else {
          i++;
        }
      } else if (next && !next.startsWith("--")) {
        flags[key] = next;
        i += 2;
      } else {
        flags[key] = true;
        i++;
      }
    } else {
      positional.push(arg);
      i++;
    }
  }

  const [command, ...rest] = positional;
  return { command: command ?? "", positional: rest, flags, tags };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdAdd(args: ParsedArgs): Promise<void> {
  const content = args.positional[0];
  if (!content) {
    console.error(colorize("Error: provide content to add. e.g. mem add \"some fact\"", "red"));
    process.exit(1);
  }

  const type = (args.flags["type"] as MemoryType | undefined) ?? "fact";
  const source = (args.flags["source"] as string | undefined) ?? "cli";
  const context = args.flags["context"] as string | undefined;
  const tags = args.tags;

  console.log(colorize("⏳ Evaluating memory...", "dim"));

  const scoreEngine = getScoreEngine();
  const router = getMemoryRouter();

  const score = await scoreEngine.score(content, context);
  const result = await router.route(content, score, type, source, tags);

  const actionColor: Record<string, keyof typeof C> = {
    stored: "green",
    compressed: "yellow",
    discarded: "red",
  };
  const color = actionColor[result.action] ?? "white";
  const icon = { stored: "✅", compressed: "🔀", discarded: "🗑️" }[result.action] ?? "❓";

  console.log(
    `\n${icon} ${colorize(result.action.toUpperCase(), color as keyof typeof C)} ${result.memoryId ? colorize(`[${result.memoryId.slice(0, 8)}...]`, "gray") : ""}`
  );
  console.log(colorize(`   ${result.reason}`, "dim"));
  console.log(`\n${colorize("Score breakdown:", "bold")}`);
  console.log(`  Final:      ${colorize(result.score.final_score.toFixed(4), "cyan")}`);
  console.log(`  Relevance:  ${result.score.relevance.toFixed(4)}`);
  console.log(`  Novelty:    ${result.score.novelty.toFixed(4)}`);
  console.log(`  Recurrence: ${result.score.recurrence.toFixed(4)}\n`);
}

async function cmdSearch(args: ParsedArgs): Promise<void> {
  const query = args.positional[0];
  if (!query) {
    console.error(colorize("Error: provide a search query. e.g. mem search \"typescript\"", "red"));
    process.exit(1);
  }

  const limit = parseInt((args.flags["limit"] as string | undefined) ?? "5", 10);
  const tags = args.tags.length > 0 ? args.tags : undefined;
  const types = args.flags["type"]
    ? [args.flags["type"] as MemoryType]
    : undefined;

  console.log(colorize(`\n🔍 Searching memories for: "${query}"`, "dim"));
  if (tags) console.log(colorize(`   Filter tags: ${tags.join(", ")}`, "gray"));
  if (types) console.log(colorize(`   Filter type: ${types.join(", ")}`, "gray"));

  const retriever = getRetriever();
  const result = await retriever.retrieve(query, limit, { tags, types });

  if (result.memories.length === 0) {
    console.log(colorize("\n  No memories found.\n", "yellow"));
    return;
  }

  console.log(
    `\n${colorize(`Found ${result.memories.length} memories:`, "bold")}\n`
  );

  for (let i = 0; i < result.memories.length; i++) {
    const rm = result.memories[i]!;
    const m = rm.memory;
    const date = new Date(m.last_accessed).toISOString().slice(0, 10);

    console.log(
      `${colorize(`${i + 1}.`, "cyan")} ${colorize(`[${m.type.toUpperCase()}]`, "blue")} ${m.content}`
    );
    console.log(
      colorize(
        `   rank=${rm.rankScore.toFixed(3)} | sim=${rm.similarity.toFixed(3)} | decay=${m.decay_weight.toFixed(3)} | accessed=${date}`,
        "gray"
      )
    );
    if (m.tags.length > 0) {
      console.log(colorize(`   tags: ${m.tags.join(", ")}`, "dim"));
    }
    console.log();
  }
}

async function cmdStats(): Promise<void> {
  console.log(colorize("\n📊 Memory Store Statistics\n", "bold"));

  const metaStore = getMetadataStore();
  const vectorStore = getVectorStore();

  const dbStats = metaStore.getStats();
  const vectorCount = await vectorStore.count();
  const discardCount = metaStore.getCounter("discard_count");
  const compressCount = metaStore.getCounter("compress_count");

  let storageSizeBytes = 0;
  try {
    const dbPath = process.env["SQLITE_DB_PATH"] ?? "./data/memories.db";
    storageSizeBytes = statSync(dbPath).size;
  } catch {
    // file might not exist yet
  }

  const rows = [
    ["Total stored", String(dbStats.totalStored)],
    ["In vector store", String(vectorCount)],
    ["Total compressed", String(compressCount)],
    ["Total discarded", String(discardCount)],
    ["Avg decay weight", dbStats.averageDecayWeight.toFixed(4)],
    ["Storage size", `${(storageSizeBytes / 1024).toFixed(1)} KB`],
    ["Oldest memory", dbStats.oldestCreatedAt
      ? new Date(dbStats.oldestCreatedAt).toISOString().slice(0, 10)
      : "N/A"],
    ["Newest memory", dbStats.newestCreatedAt
      ? new Date(dbStats.newestCreatedAt).toISOString().slice(0, 10)
      : "N/A"],
  ];

  for (const [label, value] of rows) {
    console.log(
      `  ${colorize(label!.padEnd(20), "dim")} ${colorize(value!, "white")}`
    );
  }
  console.log();
}

async function cmdDecay(): Promise<void> {
  console.log(colorize("\n⏳ Running decay pass...", "dim"));

  const result = await runDecayPass();

  console.log(colorize("\n✅ Decay pass complete\n", "green"));
  console.log(`  Processed: ${colorize(String(result.processed), "white")}`);
  console.log(`  Archived:  ${colorize(String(result.archived), "white")}\n`);

  if (result.archiveSummaries.length > 0) {
    console.log(colorize("Archive summaries created:", "bold"));
    for (const s of result.archiveSummaries) {
      console.log(`  ${colorize("→", "cyan")} ${s}`);
    }
    console.log();
  }
}

async function cmdCompress(args: ParsedArgs): Promise<void> {
  const topic = args.positional[0];
  if (!topic) {
    console.error(colorize("Error: provide a topic. e.g. mem compress \"typescript\"", "red"));
    process.exit(1);
  }

  console.log(colorize(`\n🔀 Force-compressing memories on topic: "${topic}"...`, "dim"));

  const metaStore = getMetadataStore();
  const vectorStore = getVectorStore();
  const summarizer = getSummarizer();

  const all = metaStore.getAll();
  const matching = all.filter(
    (m) =>
      m.tags.some((t) => t.toLowerCase().includes(topic.toLowerCase())) ||
      m.content.toLowerCase().includes(topic.toLowerCase())
  );

  if (matching.length < 2) {
    console.log(
      colorize(
        `\n  Only ${matching.length} memories match "${topic}" — need at least 2 to compress.\n`,
        "yellow"
      )
    );
    return;
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
    source: "cli-compress",
    created_at: now,
    last_accessed: now,
    access_count: 0,
    decay_weight: 0.8,
    merged_from: allMergedFrom,
    tags: allTags.length > 0 ? allTags : [topic],
  });

  await vectorStore.upsert(archiveId, archiveEmbedding, {
    type: "summary",
    source: "cli-compress",
    created_at: now,
  });

  metaStore.incrementCompress();

  console.log(colorize(`\n✅ Compressed ${matching.length} memories into:`, "green"));
  console.log(colorize(`   ID: ${archiveId}`, "gray"));
  console.log(`\n${colorize("Archive summary:", "bold")}`);
  console.log(`  ${archiveContent}\n`);
}

function printHelp(): void {
  console.log(colorize("\nUsage:", "bold"));
  console.log("  mem add <content> [--type fact|decision|event|summary]");
  console.log("                    [--source <name>] [--context <ctx>]");
  console.log("                    [--tag <tag>] [--tag <tag>...]");
  console.log("  mem search <query> [--limit <n>]");
  console.log("  mem stats");
  console.log("  mem decay");
  console.log("  mem compress <topic>\n");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  printBanner();

  const args = parseArgs(process.argv);

  switch (args.command) {
    case "add":
      await cmdAdd(args);
      break;
    case "search":
      await cmdSearch(args);
      break;
    case "stats":
      await cmdStats();
      break;
    case "decay":
      await cmdDecay();
      break;
    case "compress":
      await cmdCompress(args);
      break;
    default:
      if (args.command) {
        console.error(colorize(`Unknown command: ${args.command}`, "red"));
      }
      printHelp();
      process.exit(args.command ? 1 : 0);
  }
}

main().catch((err) => {
  console.error(colorize(`\nFatal error: ${String(err)}\n`, "red"));
  process.exit(1);
});
