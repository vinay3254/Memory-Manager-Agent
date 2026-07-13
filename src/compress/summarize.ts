// ============================================================
// src/compress/summarize.ts
// LLM-powered summarization using Claude claude-haiku-4-5 (via Anthropic SDK).
// Handles two scenarios:
//   1. merge(memA, memB) — merge two memories into one denser entry
//   2. archiveCluster(memories[]) — collapse a cluster of old memories
//      into a single archive summary node
// ============================================================

import Anthropic from "@anthropic-ai/sdk";
import "dotenv/config";

// ---------------------------------------------------------------------------
// Summarizer
// ---------------------------------------------------------------------------

export class Summarizer {
  private client: Anthropic;
  private model: string;

  constructor(model: string = "claude-haiku-4-5") {
    this.client = new Anthropic({
      apiKey: process.env["ANTHROPIC_API_KEY"],
    });
    this.model = model;
  }

  // -------------------------------------------------------------------------
  // merge — combine two related memories into one denser summary
  // -------------------------------------------------------------------------

  /**
   * Merges two related memories into a single, denser representation.
   * The result should preserve all unique facts from both inputs.
   *
   * @param memA - First memory content
   * @param memB - Second memory content (new candidate)
   * @returns A single compressed string containing the merged knowledge
   */
  async merge(memA: string, memB: string): Promise<string> {
    const prompt = `You are a memory compression system. Your task is to merge two related memory entries into a single, dense, information-preserving summary.

MEMORY A:
${memA}

MEMORY B:
${memB}

Rules:
- Preserve ALL distinct facts, decisions, and events from both memories
- Remove redundant or duplicate information
- Write in a factual, neutral tone (no filler phrases)
- Output ONLY the merged memory text, no preamble or explanation
- Keep it concise but complete — aim for 1-3 sentences
- Do not lose any unique detail from either memory`;

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 512,
      messages: [{ role: "user", content: prompt }],
    });

    const content = response.content[0];
    if (content?.type !== "text") {
      throw new Error("Unexpected response type from Claude");
    }

    return content.text.trim();
  }

  // -------------------------------------------------------------------------
  // archiveCluster — collapse many old memories into one archive node
  // -------------------------------------------------------------------------

  /**
   * Compresses a cluster of old, low-decay memories into a single
   * archive summary. Used by the decay scheduler.
   *
   * @param memories - Array of memory content strings to archive
   * @param topic    - The topic/theme of this cluster (for context)
   * @returns A single archive summary string
   */
  async archiveCluster(memories: string[], topic: string): Promise<string> {
    if (memories.length === 0) {
      throw new Error("Cannot archive an empty cluster");
    }
    if (memories.length === 1) {
      return memories[0]!;
    }

    const memoriesList = memories
      .map((m, i) => `${i + 1}. ${m}`)
      .join("\n");

    const prompt = `You are a long-term memory archiving system. These are old memories on the topic "${topic}" that have not been accessed recently and need to be compressed into a single archive entry.

MEMORIES TO ARCHIVE:
${memoriesList}

Rules:
- Create ONE comprehensive summary that captures the key facts and patterns from all entries
- Prioritize information that appears multiple times (recurring = important)
- Discard trivial or ephemeral details
- Write in a factual, dense style — this is an archive, not a story
- Output ONLY the archive summary text, no preamble
- Label it as an archive summary implicitly through content density
- Aim for 2-4 sentences maximum`;

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 768,
      messages: [{ role: "user", content: prompt }],
    });

    const content = response.content[0];
    if (content?.type !== "text") {
      throw new Error("Unexpected response type from Claude");
    }

    return content.text.trim();
  }

  // -------------------------------------------------------------------------
  // topicExtract — extract a topic label from memory content
  // -------------------------------------------------------------------------

  /**
   * Extracts a short topic label from a memory's content.
   * Used to group memories into clusters for archiving.
   */
  async extractTopic(content: string): Promise<string> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 64,
      messages: [
        {
          role: "user",
          content: `Extract a 1-3 word topic label for this memory. Output ONLY the topic label:\n\n${content}`,
        },
      ],
    });

    const text = response.content[0];
    if (text?.type !== "text") return "general";
    return text.text.trim().toLowerCase().slice(0, 50);
  }

  /**
   * Detects if two memories contradict each other.
   * Returns true if they are mutually exclusive or express conflicting facts/decisions.
   */
  async detectContradiction(memA: string, memB: string): Promise<boolean> {
    const prompt = `You are a memory consistency engine. Your task is to detect if two memory entries contradict each other.
Contradiction means they assert conflicting facts, opposing decisions, or mutually exclusive states.
Examples of contradiction:
- "The server port is 3000" vs "The server port is 8080"
- "Decided to use MySQL" vs "Decided to use PostgreSQL"

Examples of non-contradiction (related or complementary):
- "TypeScript adds types to JS" vs "JavaScript has no static types" (different ways of saying consistent concepts)
- "Port is 3000" vs "Server is written in Node.js"

MEMORY A:
${memA}

MEMORY B:
${memB}

Output ONLY "CONTRADICTION" if they contradict, or "OK" if they do not. Do not include any explanation or other text.`;

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 16,
      messages: [{ role: "user", content: prompt }],
    });

    const content = response.content[0];
    if (content?.type !== "text") {
      return false;
    }

    const textResult = content.text.trim().toUpperCase();
    return textResult.includes("CONTRADICTION");
  }

  /**
   * Answers a user's question using retrieved memories as context.
   */
  async answerQuestion(question: string, contextMemories: string[]): Promise<string> {
    const prompt = `You are a helpful assistant. Answer the user's question based ONLY on the provided memories.
If the memories do not contain the answer, say "I don't have enough memories to answer that."

MEMORIES:
${contextMemories.map((m, i) => `${i + 1}. ${m}`).join("\n")}

QUESTION:
${question}

Answer:`;

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 512,
      messages: [{ role: "user", content: prompt }],
    });

    const content = response.content[0];
    if (content?.type !== "text") {
      return "Error: Unexpected response type from assistant.";
    }

    return content.text.trim();
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _summarizer: Summarizer | null = null;

export function getSummarizer(): Summarizer {
  if (!_summarizer) {
    _summarizer = new Summarizer("claude-haiku-4-5");
  }
  return _summarizer;
}
