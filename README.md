# 🧠 Memory Manager Agent

An MCP (Model Context Protocol) server that intelligently decides what's worth storing to long-term memory, compresses old memories, and surfaces relevant ones on demand.

## How It Decides What to Keep

Every new piece of information gets scored on **three axes**:

| Axis | Weight | Description |
|------|--------|-------------|
| **Relevance** | 40% | Cosine similarity of the candidate to current active goals/context |
| **Novelty** | 30% | `1 - max_similarity` to existing memories — penalizes duplicates |
| **Recurrence** | 30% | How often this topic appeared in recent history — recurring = important |

```
final_score = 0.4 × relevance + 0.3 × novelty + 0.3 × recurrence
```

Then routed:
- `score >= 0.7` → **STORE** as new long-term memory
- `0.35 <= score < 0.7` → **COMPRESS** — merge with most similar existing memory via Claude Haiku
- `score < 0.35` → **DISCARD**

---

## Architecture

```
src/
├── server.ts              # MCP entry point (stdio transport)
├── types.ts               # MemoryRecord schema + all types
├── embedding/
│   └── embed.ts           # @xenova/transformers, all-MiniLM-L6-v2 (local, 384-dim)
├── scoring/
│   ├── score.ts           # Relevance + novelty + recurrence calculation
│   └── router.ts          # STORE / COMPRESS / DISCARD routing
├── store/
│   ├── metadata.ts        # better-sqlite3 for all non-vector fields
│   └── vector.ts          # ChromaDB client wrapper
├── compress/
│   └── summarize.ts       # Claude claude-haiku-4-5 for merge + archive
├── decay/
│   └── scheduler.ts       # node-cron daily decay (3%/day) + archive job
├── retrieve/
│   └── rank.ts            # similarity × decay_weight ranking + reinforcement
└── cli/
    └── mem.ts             # CLI: mem add / search / stats / decay / compress
```

---

## Memory Schema

```typescript
{
  id: string                 // UUID v4
  content: string            // compressed/raw memory text
  embedding: number[]        // 384-dim vector (stored in ChromaDB)
  type: "fact" | "decision" | "event" | "summary"
  source: string             // tool/session that created this
  created_at: number         // Unix ms
  last_accessed: number      // Unix ms
  access_count: number       // retrieval reinforcement counter
  decay_weight: number       // 0-1, decays 3%/day, bumped on access
  merged_from: string[]      // IDs of memories compressed into this
  tags: string[]             // topic/entity tags for cluster archiving
}
```

---

## Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js + TypeScript (strict) |
| MCP Protocol | `@modelcontextprotocol/sdk` (stdio) |
| Embeddings | `@xenova/transformers` — `all-MiniLM-L6-v2` (local, no API cost) |
| Vector Store | ChromaDB (cosine similarity search) |
| Metadata Store | `better-sqlite3` (WAL mode) |
| Summarization | Anthropic Claude `claude-haiku-4-5` |
| Scheduling | `node-cron` (daily decay at midnight UTC) |

---

## Prerequisites

### 1. ChromaDB Server

ChromaDB requires a running Python server:

```bash
pip install chromadb
chroma run --path ./data/chroma
```

This starts ChromaDB at `http://localhost:8000` (default).

### 2. Anthropic API Key

Get an API key from [console.anthropic.com](https://console.anthropic.com) and add it to `.env`.

---

## Setup

```bash
# 1. Clone the repo
git clone https://github.com/vinay3254/Memory-Manager-Agent.git
cd Memory-Manager-Agent

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env
# Edit .env and set ANTHROPIC_API_KEY

# 4. Start ChromaDB (in a separate terminal)
pip install chromadb
chroma run --path ./data/chroma

# 5. (Optional) Build TypeScript
npm run build
```

---

## CLI Usage

Run commands using `npm run cli` (no build required — uses `tsx`):

```bash
# Add a fact to memory
npm run cli -- add "TypeScript is a statically typed superset of JavaScript"

# Add with options
npm run cli -- add "We decided to use PostgreSQL for the project" \
  --type decision \
  --tag database \
  --tag architecture \
  --context "backend infrastructure planning"

# Search memories
npm run cli -- search "typed programming languages"

# Search with filters (tags and type)
npm run cli -- search "database decisions" --limit 10 --tag database --type decision

# View statistics
npm run cli -- stats

# Manually run the decay pass
npm run cli -- decay

# Force-compress all memories on a topic
npm run cli -- compress "TypeScript"

# Link two memories semantically (sourceId, targetId, relation)
npm run cli -- link <sourceId> <targetId> contradicts

# View all links for a memory ID
npm run cli -- links <memoryId>

# Export all database data to a backup file
npm run cli -- export backup.json

# Import and merge database data from a backup file
npm run cli -- import backup.json
```

---

## MCP Tools

Connect to a host like Claude Desktop by pointing it at this server.

### `memory_evaluate`
Scores a memory candidate and routes it to store/compress/discard.

```json
{
  "content": "TypeScript was chosen over JavaScript for type safety",
  "context": "project technology decisions",
  "type": "decision",
  "source": "planning-session",
  "tags": ["typescript", "architecture"]
}
```

**Response:**
```json
{
  "action": "stored",
  "memoryId": "uuid-...",
  "reason": "Score 0.742 >= 0.7 → stored as new memory",
  "score": {
    "final": 0.742,
    "relevance": 0.85,
    "novelty": 0.72,
    "recurrence": 0.50
  }
}
```

### `memory_retrieve`
Retrieves top-K memories ranked by `similarity × decay_weight`. Supports optional type and tag filters.

```json
{
  "query": "technology stack decisions",
  "limit": 5,
  "tags": ["database"],
  "types": ["decision"]
}
```

### `memory_compress_now`
Force-compresses all memories matching a topic into one summary.

```json
{ "topic": "typescript" }
```

### `memory_stats`
Returns aggregate store statistics.

### `memory_decay_run`
Manually triggers the daily decay pass.

### `memory_link`
Create a directional semantic relation link between two memories.

```json
{
  "sourceId": "source-memory-uuid",
  "targetId": "target-memory-uuid",
  "relation": "contradicts"
}
```

### `memory_get_links`
Retrieve all incoming and outgoing linked memories for a specific memory ID.

```json
{ "id": "memory-uuid" }
```

### `memory_export`
Exports all memories and links as a stringified JSON backup payload.

### `memory_import`
Imports and merges memories and links from a stringified JSON backup payload.

```json
{ "backupData": "{...}" }
```

---

## Claude Desktop Configuration

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "memory-manager": {
      "command": "node",
      "args": ["path/to/dist/server.js"],
      "env": {
        "ANTHROPIC_API_KEY": "sk-ant-...",
        "CHROMA_URL": "http://localhost:8000"
      }
    }
  }
}
```

Or with `tsx` for development (no build step):

```json
{
  "mcpServers": {
    "memory-manager": {
      "command": "npx",
      "args": ["tsx", "path/to/src/server.ts"],
      "env": {
        "ANTHROPIC_API_KEY": "sk-ant-...",
        "CHROMA_URL": "http://localhost:8000"
      }
    }
  }
}
```

---

## How Decay Works

Every stored memory starts with `decay_weight = 1.0`. The decay scheduler (cron, midnight UTC) applies:

```
decay_weight *= 0.97  (per day)
```

After ~76 days without access, `decay_weight` drops to ~0.1. Memories meeting:
- `decay_weight < 0.1` **AND**
- `age > 30 days`

...are **cluster-archived** — Claude Haiku compresses the group into one dense archive node. Nothing is deleted; it's compressed and the weight is partially reset.

On retrieval, accessed memories are reinforced:
```
new_weight = old_weight + (1 - old_weight) * 0.3
```

This means frequently-retrieved memories stay alive indefinitely.

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | *(required)* | Claude API key |
| `CHROMA_URL` | `http://localhost:8000` | ChromaDB server URL |
| `CHROMA_COLLECTION` | `memory_manager` | ChromaDB collection name |
| `SQLITE_DB_PATH` | `./data/memories.db` | SQLite database file path |
| `TRANSFORMERS_CACHE` | `./data/model_cache` | Local model cache directory |
| `SCORE_STORE_THRESHOLD` | `0.7` | Min score to store |
| `SCORE_COMPRESS_THRESHOLD` | `0.35` | Min score to compress (vs discard) |
| `DEFAULT_RETRIEVE_LIMIT` | `5` | Default number of retrieval results |

---

## License

MIT