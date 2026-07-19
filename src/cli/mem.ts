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
import { readFileSync, writeFileSync, statSync } from "fs";
import { v4 as uuidv4 } from "uuid";
import readline from "readline";
import {
  exportBackup,
  importBackup,
  exportToMarkdown,
  exportToCSV,
  importFromCSV,
  importFromMarkdown,
} from "../store/backup.js";
import { parseTTL } from "../utils/ttl.js";
import { getConfigStore } from "../store/config.js";
import { exportVisualizerHTML } from "../store/visualize.js";
import { consolidateMemories } from "../compress/consolidate.js";
import { findAndExplainPath } from "../retrieve/path.js";
import { explainConcept } from "../retrieve/explain.js";
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
  const ttl = args.flags["ttl"] as string | undefined;
  const importanceStr = args.flags["importance"] as string | undefined;

  let expires_at: number | undefined;
  if (ttl) {
    const duration = parseTTL(ttl);
    if (duration !== undefined) {
      expires_at = Date.now() + duration;
    } else {
      console.warn(colorize(`⚠️  Invalid TTL format "${ttl}". Ignoring TTL.`, "yellow"));
    }
  }

  let importance: number | undefined;
  if (importanceStr) {
    const val = parseInt(importanceStr, 10);
    if (val >= 1 && val <= 10) {
      importance = val;
    } else {
      console.warn(colorize(`⚠️  Importance rating must be an integer between 1 and 10. Defaulting to 5.`, "yellow"));
    }
  }

  console.log(colorize("⏳ Evaluating memory...", "dim"));

  const scoreEngine = getScoreEngine();
  const router = getMemoryRouter();

  const score = await scoreEngine.score(content, context);
  const result = await router.route(content, score, type, source, tags, expires_at, importance);

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

async function cmdLink(args: ParsedArgs): Promise<void> {
  const sourceId = args.positional[0];
  const targetId = args.positional[1];
  const relation = args.positional[2] ?? "relates_to";

  if (!sourceId || !targetId) {
    console.error(colorize("Error: provide sourceId and targetId. e.g. mem link <sourceId> <targetId> [relation]", "red"));
    process.exit(1);
  }

  const metaStore = getMetadataStore();
  try {
    metaStore.addLink(sourceId, targetId, relation);
    console.log(colorize(`\n✅ Linked ${sourceId} to ${targetId} as '${relation}'\n`, "green"));
  } catch (err) {
    console.error(colorize(`\n❌ Error: ${String(err)}\n`, "red"));
    process.exit(1);
  }
}

async function cmdLinks(args: ParsedArgs): Promise<void> {
  const id = args.positional[0];
  if (!id) {
    console.error(colorize("Error: provide a memory ID. e.g. mem links <id>", "red"));
    process.exit(1);
  }

  const metaStore = getMetadataStore();
  try {
    const links = metaStore.getLinks(id);
    if (links.length === 0) {
      console.log(colorize(`\nNo links found for memory ${id}\n`, "yellow"));
      return;
    }
    console.log(colorize(`\n🔗 Links for memory ${id}:\n`, "bold"));
    for (const link of links) {
      const dirText = link.direction === "outgoing" ? "→" : "←";
      console.log(
        `  ${colorize(dirText, "cyan")} ${colorize(`[${link.relation.toUpperCase()}]`, "blue")} ${link.memory.content} ${colorize(`(${link.memory.id})`, "gray")}`
      );
    }
    console.log();
  } catch (err) {
    console.error(colorize(`\n❌ Error: ${String(err)}\n`, "red"));
    process.exit(1);
  }
}

async function cmdExport(args: ParsedArgs): Promise<void> {
  const filePath = args.positional[0];
  if (!filePath) {
    console.error(colorize("Error: provide a file path to save the backup. e.g. mem export backup.json", "red"));
    process.exit(1);
  }

  let format = args.flags["format"] as string | undefined;
  if (!format) {
    if (filePath.endsWith(".csv")) format = "csv";
    else if (filePath.endsWith(".md") || filePath.endsWith(".markdown")) format = "md";
    else format = "json";
  }

  console.log(colorize(`⏳ Exporting memories and links as ${format.toUpperCase()}...`, "dim"));
  try {
    const metaStore = getMetadataStore();
    const memories = metaStore.getAll();
    const links = metaStore.getAllLinks();
    let backupStr = "";

    if (format === "csv") {
      backupStr = exportToCSV(memories, links);
    } else if (format === "md") {
      backupStr = exportToMarkdown(memories, links);
    } else {
      backupStr = await exportBackup();
    }

    writeFileSync(filePath, backupStr, "utf-8");
    console.log(colorize(`\n✅ Backup successfully saved to ${filePath}\n`, "green"));
  } catch (err) {
    console.error(colorize(`\n❌ Error: ${String(err)}\n`, "red"));
    process.exit(1);
  }
}

async function cmdImport(args: ParsedArgs): Promise<void> {
  const filePath = args.positional[0];
  if (!filePath) {
    console.error(colorize("Error: provide a file path to load the backup from. e.g. mem import backup.json", "red"));
    process.exit(1);
  }

  let format = args.flags["format"] as string | undefined;
  if (!format) {
    if (filePath.endsWith(".csv")) format = "csv";
    else if (filePath.endsWith(".md") || filePath.endsWith(".markdown")) format = "md";
    else format = "json";
  }

  console.log(colorize(`⏳ Importing backup from ${filePath} as ${format.toUpperCase()}...`, "dim"));
  try {
    const backupStr = readFileSync(filePath, "utf-8");
    let stats: { importedMemories: number; importedLinks: number };

    if (format === "csv") {
      stats = await importFromCSV(backupStr);
    } else if (format === "md") {
      stats = await importFromMarkdown(backupStr);
    } else {
      stats = await importBackup(backupStr);
    }

    console.log(
      colorize(
        `\n✅ Successfully imported ${stats.importedMemories} memories and ${stats.importedLinks} relationship links!\n`,
        "green"
      )
    );
  } catch (err) {
    console.error(colorize(`\n❌ Error: ${String(err)}\n`, "red"));
    process.exit(1);
  }
}

async function cmdTags(): Promise<void> {
  const metaStore = getMetadataStore();
  const stats = metaStore.getTagStats();

  const entries = Object.entries(stats).sort((a, b) => b[1] - a[1]);

  if (entries.length === 0) {
    console.log(colorize("\n  No tags found in the database.\n", "yellow"));
    return;
  }

  console.log(colorize("\n🏷️  Memory Store Tags & Frequencies:\n", "bold"));
  for (const [tag, count] of entries) {
    console.log(`  ${colorize(`#${tag}`, "cyan")} (${count} ${count === 1 ? "memory" : "memories"})`);
  }
  console.log();
}

async function cmdChat(): Promise<void> {
  console.log(colorize("\n💬 Entering Memory Manager Agent Chat Mode.", "bold"));
  console.log(colorize("   Type statements to store them, or ask questions to query memories.", "dim"));
  console.log(colorize("   Type /exit or /quit to leave.\n", "dim"));

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const questionWords = ["what", "how", "who", "why", "where", "is", "can", "are", "do", "does", "did", "which", "whose", "whom", "will", "would", "should"];

  const promptUser = () => {
    rl.question(colorize("You > ", "green"), async (input) => {
      const query = input.trim();
      if (query.toLowerCase() === "/exit" || query.toLowerCase() === "/quit") {
        rl.close();
        return;
      }

      if (!query) {
        promptUser();
        return;
      }

      const isQuestion = query.endsWith("?") ||
        questionWords.some(word => query.toLowerCase().startsWith(word + " "));

      if (isQuestion) {
        console.log(colorize("🔍 Searching memories...", "dim"));
        const metaStore = getMetadataStore();
        const retriever = getRetriever();

        const searchResult = await retriever.retrieve(query, 5);
        const retrievedMemories = searchResult.memories.map(m => m.memory.content);

        if (retrievedMemories.length === 0) {
          console.log(colorize("\nAgent > ", "blue") + "I don't have any memories stored yet.\n");
        } else {
          try {
            const summarizer = getSummarizer();
            const answer = await summarizer.answerQuestion(query, retrievedMemories);
            console.log(`\n${colorize("Agent >", "blue")} ${answer}\n`);
          } catch (err) {
            console.error(colorize(`\nError: ${String(err)}\n`, "red"));
          }
        }
      } else {
        console.log(colorize("⏳ Evaluating memory...", "dim"));
        try {
          const scoreEngine = getScoreEngine();
          const router = getMemoryRouter();

          const score = await scoreEngine.score(query);
          const result = await router.route(query, score, "fact", "cli-chat", []);

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
          console.log(colorize(`   ${result.reason}\n`, "dim"));
        } catch (err) {
          console.error(colorize(`\nError: ${String(err)}\n`, "red"));
        }
      }
      promptUser();
    });
  };

  promptUser();
}

async function cmdHistory(args: ParsedArgs): Promise<void> {
  const id = args.positional[0];
  if (!id) {
    console.error(colorize("Error: provide a memory ID. e.g. mem history <id>", "red"));
    process.exit(1);
  }

  const metaStore = getMetadataStore();
  const mem = metaStore.getById(id);
  if (!mem) {
    console.error(colorize(`Error: memory with ID ${id} not found.`, "red"));
    process.exit(1);
  }

  console.log(colorize(`\n📜 Access history for memory ${id}:`, "bold"));
  console.log(`  Content: "${mem.content}"\n`);

  const history = mem.access_history ?? [];
  if (history.length === 0) {
    console.log(colorize("  No access history recorded.\n", "yellow"));
    return;
  }

  for (const log of history) {
    const timeStr = new Date(log.timestamp).toISOString();
    console.log(`  ${colorize(`[${timeStr}]`, "gray")} ${colorize(log.action.toUpperCase(), "cyan")}`);
  }
  console.log();
}

async function cmdTag(args: ParsedArgs): Promise<void> {
  const tag = args.positional[0];
  const query = args.positional[1];

  if (!tag || !query) {
    console.error(colorize("Error: provide a tag and search query. e.g. mem tag <tag_name> <search_query>", "red"));
    process.exit(1);
  }

  console.log(colorize(`⏳ Bulk tagging memories containing "${query}" with #${tag}...`, "dim"));
  try {
    const retriever = getRetriever();
    const metaStore = getMetadataStore();

    const searchResult = await retriever.retrieve(query, 20);
    const ids = searchResult.memories.map(m => m.memory.id);

    const count = metaStore.bulkAddTag(ids, tag);
    console.log(colorize(`\n✅ Successfully added tag '#${tag}' to ${count} memories!\n`, "green"));
  } catch (err) {
    console.error(colorize(`\n❌ Error: ${String(err)}\n`, "red"));
    process.exit(1);
  }
}

async function cmdUntag(args: ParsedArgs): Promise<void> {
  const tag = args.positional[0];
  const query = args.positional[1];

  if (!tag || !query) {
    console.error(colorize("Error: provide a tag and search query. e.g. mem untag <tag_name> <search_query>", "red"));
    process.exit(1);
  }

  console.log(colorize(`⏳ Bulk untagging memories containing "${query}" with #${tag}...`, "dim"));
  try {
    const retriever = getRetriever();
    const metaStore = getMetadataStore();

    const searchResult = await retriever.retrieve(query, 20);
    const ids = searchResult.memories.map(m => m.memory.id);

    const count = metaStore.bulkRemoveTag(ids, tag);
    console.log(colorize(`\n✅ Successfully removed tag '#${tag}' from ${count} memories!\n`, "green"));
  } catch (err) {
    console.error(colorize(`\n❌ Error: ${String(err)}\n`, "red"));
    process.exit(1);
  }
}

async function cmdConfig(args: ParsedArgs): Promise<void> {
  const action = args.positional[0]; // "get" or "set"
  const key = args.positional[1];
  const valueStr = args.positional[2];

  const configStore = getConfigStore();

  if (!action) {
    const all = configStore.getAll();
    console.log(colorize("\n⚙️  Current Configurations:\n", "bold"));
    for (const [k, v] of Object.entries(all)) {
      console.log(`  ${colorize(k, "cyan")}: ${v}`);
    }
    console.log();
    return;
  }

  if (action === "get") {
    if (!key) {
      console.error(colorize("Error: provide a config key to get. e.g. mem config get DECAY_RATE", "red"));
      process.exit(1);
    }
    const val = configStore.get(key as any);
    if (val === undefined) {
      console.error(colorize(`Error: unknown config key "${key}"`, "red"));
      process.exit(1);
    }
    console.log(`\n${colorize(key, "cyan")}: ${val}\n`);
    return;
  }

  if (action === "set") {
    if (!key || !valueStr) {
      console.error(colorize("Error: provide key and value. e.g. mem config set DECAY_RATE 0.05", "red"));
      process.exit(1);
    }
    const currentVal = configStore.get(key as any);
    if (currentVal === undefined) {
      console.error(colorize(`Error: unknown config key "${key}"`, "red"));
      process.exit(1);
    }
    const parsedVal = parseFloat(valueStr);
    if (isNaN(parsedVal)) {
      console.error(colorize("Error: value must be a number", "red"));
      process.exit(1);
    }
    configStore.set(key as any, parsedVal);
    console.log(colorize(`\n✅ Configuration updated: ${key} = ${parsedVal}\n`, "green"));
    return;
  }

  console.error(colorize(`Error: unknown action "${action}". Use "get" or "set".`, "red"));
  process.exit(1);
}

async function cmdVisualize(args: ParsedArgs): Promise<void> {
  const filePath = args.positional[0] ?? "memories_graph.html";

  console.log(colorize(`⏳ Generating interactive visualizer at ${filePath}...`, "dim"));
  try {
    exportVisualizerHTML(filePath);
    console.log(colorize(`\n✅ Graph visualizer successfully exported to ${filePath}!\n`, "green"));
  } catch (err) {
    console.error(colorize(`\n❌ Error: ${String(err)}\n`, "red"));
    process.exit(1);
  }
}

async function cmdConsolidate(args: ParsedArgs): Promise<void> {
  const tag = args.positional[0];

  console.log(colorize("⏳ Consolidating memories...", "dim"));
  try {
    const stats = await consolidateMemories(tag);
    if (stats.consolidatedCount === 0) {
      console.log(colorize("\nℹ️  No memory clusters eligible/found for consolidation (needs tag with >= 3 memories).\n", "yellow"));
      return;
    }

    console.log(colorize(`\n✅ Successfully consolidated ${stats.consolidatedCount} memories into a single summary!\n`, "green"));
    console.log(`Summary Memory ID: ${colorize(stats.newSummaryId!, "cyan")}`);
    console.log(`Content: "${stats.summaryText!}"\n`);
  } catch (err) {
    console.error(colorize(`\n❌ Error: ${String(err)}\n`, "red"));
    process.exit(1);
  }
}

async function cmdPath(args: ParsedArgs): Promise<void> {
  const start = args.positional[0];
  const end = args.positional[1];
  if (!start || !end) {
    console.error(colorize("Error: provide a starting concept and destination concept. e.g. mem path \"React\" \"JavaScript\"", "red"));
    process.exit(1);
  }

  console.log(colorize(`⏳ Tracing relationship path from "${start}" to "${end}"...\n`, "dim"));
  try {
    const result = await findAndExplainPath(start, end);
    console.log(colorize("📍 Pathfinder Result:\n", "bold"));
    console.log(result);
    console.log();
  } catch (err) {
    console.error(colorize(`\n❌ Error: ${String(err)}\n`, "red"));
    process.exit(1);
  }
}

async function cmdExplain(args: ParsedArgs): Promise<void> {
  const concept = args.positional[0];
  if (!concept) {
    console.error(colorize("Error: provide a concept to explain. e.g. mem explain \"typescript\"", "red"));
    process.exit(1);
  }

  console.log(colorize(`⏳ Generating conceptual explanation for: "${concept}"...\n`, "dim"));
  try {
    const explanation = await explainConcept(concept);
    console.log(colorize("📚 Explanation:\n", "bold"));
    console.log(explanation);
    console.log();
  } catch (err) {
    console.error(colorize(`\n❌ Error: ${String(err)}\n`, "red"));
    process.exit(1);
  }
}

function printHelp(): void {
  console.log(colorize("\nUsage:", "bold"));
  console.log("  mem add <content> [--type fact|decision|event|summary]");
  console.log("                    [--source <name>] [--context <ctx>] [--ttl <duration>] [--importance <1-10>]");
  console.log("                    [--tag <tag>] [--tag <tag>...]");
  console.log("  mem search <query> [--limit <n>] [--tag <tag>] [--type <type>]");
  console.log("  mem stats");
  console.log("  mem tags");
  console.log("  mem decay");
  console.log("  mem compress <topic>");
  console.log("  mem link <sourceId> <targetId> [relation]");
  console.log("  mem links <memoryId>");
  console.log("  mem export <file_path>");
  console.log("  mem import <file_path>");
  console.log("  mem chat");
  console.log("  mem history <memoryId>");
  console.log("  mem tag <tag_name> <search_query>");
  console.log("  mem untag <tag_name> <search_query>");
  console.log("  mem config [get|set] [key] [value]");
  console.log("  mem consolidate [tag]");
  console.log("  mem explain <concept>");
  console.log("  mem path <startConcept> <endConcept>");
  console.log("  mem visualize [file_path.html]\n");
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
    case "tags":
      await cmdTags();
      break;
    case "decay":
      await cmdDecay();
      break;
    case "compress":
      await cmdCompress(args);
      break;
    case "link":
      await cmdLink(args);
      break;
    case "links":
      await cmdLinks(args);
      break;
    case "export":
      await cmdExport(args);
      break;
    case "import":
      await cmdImport(args);
      break;
    case "chat":
      await cmdChat();
      break;
    case "history":
      await cmdHistory(args);
      break;
    case "tag":
      await cmdTag(args);
      break;
    case "untag":
      await cmdUntag(args);
      break;
    case "config":
      await cmdConfig(args);
      break;
    case "visualize":
      await cmdVisualize(args);
      break;
    case "consolidate":
      await cmdConsolidate(args);
      break;
    case "path":
      await cmdPath(args);
      break;
    case "explain":
      await cmdExplain(args);
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
