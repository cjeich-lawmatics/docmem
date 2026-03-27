# DocMem

Token-efficient documentation retrieval for AI coding agents via [Model Context Protocol (MCP)](https://modelcontextprotocol.io/).

DocMem indexes your project's markdown documentation into a PostgreSQL database with vector embeddings, then serves it to AI agents through MCP tools. Instead of stuffing entire docs into context, agents search semantically and load only the chunks they need.

## How It Works

1. **Index** — DocMem reads your markdown files, splits them into chunks by heading, generates embeddings (locally via Hugging Face transformers), extracts entities and cross-references, and stores everything in PostgreSQL with pgvector.

2. **Search** — Agents call `docmem_search` with a natural language query. DocMem combines vector similarity (cosine distance) with BM25 full-text search via Reciprocal Rank Fusion, then applies a composite scoring model:

   | Signal | Weight | Description |
   |--------|--------|-------------|
   | Similarity | 65% | Vector cosine similarity |
   | Heat | 10% | Access frequency (most-loaded chunks rank higher) |
   | Recency | 10% | How recently the source file was modified |
   | Usefulness | 10% | Feedback from agents on whether chunks were helpful |
   | Topic | 5% | Bonus when query terms match the topic name |

3. **Load** — Agents call `docmem_load_chunk` to retrieve full content for specific chunks. Only the chunks they actually need enter the context window.

## Features

- **Hybrid search** — Vector similarity + BM25 full-text search with RRF fusion
- **Branch-aware** — Feature branch docs are isolated; only merged docs appear by default
- **Entity extraction** — Automatically identifies classes, methods, files, and concepts across chunks
- **Relationship graph** — Cross-references between chunks via documentation links and entity co-occurrence
- **Session tracking** — Tracks which chunks are accessed together to power co-access suggestions
- **Feedback loop** — Agents report chunk usefulness, improving future search ranking
- **Git staleness detection** — Flags chunks whose source files have been modified since last index
- **Local embeddings** — Uses Hugging Face transformers (no external API calls for embeddings)
- **Team mode** — Shared PostgreSQL instance so the whole team benefits from the same index

## MCP Tools

| Tool | Description |
|------|-------------|
| `docmem_search` | Semantic search across indexed docs. Returns summaries and metadata. |
| `docmem_load_chunk` | Load full content of a specific chunk by ID. |
| `docmem_list_topics` | List all topics with chunk counts and staleness info. |
| `docmem_overview` | Get section-level overview of a topic with token counts. |
| `docmem_related` | Find chunks related via links and shared entities. |
| `docmem_suggest` | Suggest chunks based on co-access patterns from past sessions. |
| `docmem_feedback` | Record whether a chunk was useful (improves future ranking). |
| `docmem_index` | Reindex a project's documentation. |

## Setup

### Prerequisites

- Node.js >= 20
- PostgreSQL with [pgvector](https://github.com/pgvector/pgvector) extension

### Quick Start

```bash
# Start PostgreSQL with pgvector
docker compose up -d

# Install dependencies and run migrations
npm install

# Create a .docmem.json in your project root
cat > /path/to/your-project/.docmem.json << 'EOF'
{
  "project": "my-project",
  "doc_paths": ["docs/**/*.md", "CLAUDE.md"],
  "exclude": ["docs/archive/**"]
}
EOF

# Index your project
npx docmem index /path/to/your-project
```

### Configure with Claude Code

Add to your `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "docmem": {
      "command": "node",
      "args": ["/path/to/docmem/dist/server.js"],
      "env": {
        "DATABASE_URL": "postgresql://docmem:docmem@localhost:5433/docmem"
      }
    }
  }
}
```

### Environment Variables

```bash
# Required — PostgreSQL connection string (must have pgvector)
DATABASE_URL=postgresql://docmem:docmem@localhost:5433/docmem

# Optional — enable team/shared database mode
DOCMEM_TEAM_DB=true
```

## CLI

```
docmem index [path]       Index a project (defaults to current directory)
docmem reindex-all        Reindex all known projects
docmem promote <branch>   Promote a branch's chunks to merged status
docmem branches           List all indexed branches with chunk counts
docmem generate-hooks     Print Claude Code hook config for auto-reindexing
docmem setup-team         Print team setup instructions
```

## Auto-Reindexing

Generate a Claude Code hook that reindexes all projects when a session ends:

```bash
npx docmem generate-hooks
```

## Team Mode

DocMem supports a shared PostgreSQL instance so multiple team members can search the same indexed documentation:

```bash
# Start shared database
docker compose up -d postgres

# Run migrations
docker compose run --rm migrate

# Index projects
docker compose run --rm cli index /repos/your-project
```

Each team member points their MCP config at the shared database. Feature branch docs are scoped per-branch — only merged docs appear in search results by default.

## Architecture

```
.docmem.json          Project config (doc paths, excludes)
src/
  server.ts           MCP server (stdio transport) — registers all tools
  cli.ts              CLI entry point (index, reindex-all, promote, etc.)
  scoring.ts          Composite scoring model (similarity, heat, recency, usefulness, topic)
  hybrid-search.ts    RRF fusion of vector + BM25 search
  sessions.ts         Session tracking for co-access patterns
  git-staleness.ts    Detect stale chunks via git timestamps
  branch-manager.ts   Branch detection, promotion, and cleanup
  indexer/
    index-project.ts  Main indexing pipeline
    chunker.ts        Markdown → chunks (split by headings)
    embedder.ts       Local embedding generation via Hugging Face
    entity-extractor.ts  Extract classes, methods, files from content
    link-extractor.ts    Extract cross-document links
  db/
    pool.ts           PostgreSQL connection pool
    migrate.ts        Database migrations (pgvector, FTS, schemas)
```

## License

MIT
