# DocMem Phase 2: Relationships & Navigation

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add entity extraction, relationship tracking, and three new MCP tools (`list_topics`, `overview`, `related`) to complete the progressive disclosure flow.

**Architecture:** Heuristic entity extraction parses backtick-wrapped terms from markdown chunks during indexing. Relationships are built from explicit markdown links between docs and entity co-occurrence across chunks. Three new read-only MCP tools expose topic navigation and relationship traversal — no embeddings needed, pure SQL.

**Tech Stack:** TypeScript, PostgreSQL (existing docmem schema), node:test for testing, existing MCP server (`@modelcontextprotocol/sdk`)

---

### Context for the implementer

**Project location:** `~/Code/docmem`

**Build & run:**
```bash
npm run build                    # Compile TypeScript
node --test dist/**/*.test.js    # Run tests
npm start                        # Start MCP server (stdio)
node dist/cli.js index /path     # Index a project
```

**Database:** Postgres 16 + pgvector on port 5433. Schema `docmem` with tables: `projects`, `chunks`, `entities`, `relationships`, `access_stats`. The `entities` and `relationships` tables already exist but are currently empty.

**Existing files you'll touch:**
- `src/server.ts` — MCP server, currently has `docmem_search` and `docmem_load_chunk` tools
- `src/indexer/index-project.ts` — indexing pipeline, currently: discover → chunk → embed → upsert
- `src/indexer/chunker.ts` — markdown splitter, exports `Chunk` interface and `chunkMarkdown()`

**New files you'll create:**
- `src/indexer/entity-extractor.ts` — heuristic entity extraction from markdown
- `src/indexer/entity-extractor.test.ts` — tests for entity extraction
- `src/indexer/link-extractor.ts` — markdown link parser for relationships
- `src/indexer/link-extractor.test.ts` — tests for link extraction

**Database tables (already exist, currently empty):**
```sql
-- entities: extracted models, services, workers, concepts
CREATE TABLE docmem.entities (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES docmem.projects(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  type       TEXT NOT NULL,       -- 'model', 'identifier', 'term'
  chunk_ids  UUID[] DEFAULT '{}', -- which chunks mention this entity
  UNIQUE (project_id, name)
);

-- relationships: edges between chunks
CREATE TABLE docmem.relationships (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id   UUID REFERENCES docmem.chunks(id) ON DELETE CASCADE,
  target_id   UUID REFERENCES docmem.chunks(id) ON DELETE CASCADE,
  rel_type    TEXT NOT NULL,       -- 'link', 'shared_entity'
  confidence  FLOAT DEFAULT 1.0
);
```

---

### Task 1: `docmem_list_topics` MCP tool

The simplest possible tool — returns all topics with chunk counts. Lets agents discover what documentation exists without loading any content.

**Files:**
- Modify: `src/server.ts`

**Step 1: Add the `docmem_list_topics` tool registration**

Add this after the existing `docmem_load_chunk` registration in `src/server.ts`:

```typescript
server.registerTool(
  'docmem_list_topics',
  {
    description: 'List all available documentation topics for a project with chunk counts. Cheapest possible operation — use this first to discover what documentation exists.',
    inputSchema: {
      project: z.string().describe('Project name (e.g., "boost-api")'),
    },
  },
  async ({ project }) => {
    const projResult = await pool.query(
      'SELECT id FROM docmem.projects WHERE name = $1',
      [project]
    );
    if (projResult.rows.length === 0) {
      return { content: [{ type: 'text' as const, text: `Project "${project}" not found.` }] };
    }
    const projectId = projResult.rows[0].id;

    const result = await pool.query(
      `SELECT
        c.topic,
        COUNT(*) AS chunk_count,
        SUM(c.token_count) AS total_tokens,
        MAX(c.last_modified) AS last_modified
      FROM docmem.chunks c
      WHERE c.project_id = $1
      GROUP BY c.topic
      ORDER BY c.topic`,
      [projectId]
    );

    const output = result.rows.map(row => ({
      topic: row.topic,
      chunk_count: parseInt(row.chunk_count),
      total_tokens: parseInt(row.total_tokens),
      last_modified: row.last_modified,
    }));

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(output, null, 2),
      }],
    };
  }
);
```

**Step 2: Build and verify**

```bash
npm run build
```

Expected: Compiles with no errors.

**Step 3: Manual smoke test**

Start the MCP server and verify the tool is registered:
```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node dist/server.js 2>/dev/null | head -1
```

Expected: JSON response listing `docmem_list_topics` among the tools.

**Step 4: Commit**

```bash
git add src/server.ts
git commit -m "Add docmem_list_topics MCP tool"
```

---

### Task 2: `docmem_overview` MCP tool

Returns a topic-level overview with section paths and chunk metadata. Lets agents understand the landscape of a topic before searching.

**Files:**
- Modify: `src/server.ts`

**Step 1: Add the `docmem_overview` tool registration**

Add after `docmem_list_topics` in `src/server.ts`:

```typescript
server.registerTool(
  'docmem_overview',
  {
    description: 'Get an overview of a specific documentation topic — lists all sections with token counts and access frequency. Use after list_topics to understand a topic before searching.',
    inputSchema: {
      project: z.string().describe('Project name (e.g., "boost-api")'),
      topic: z.string().describe('Topic name from list_topics (e.g., "features/automations")'),
    },
  },
  async ({ project, topic }) => {
    const projResult = await pool.query(
      'SELECT id FROM docmem.projects WHERE name = $1',
      [project]
    );
    if (projResult.rows.length === 0) {
      return { content: [{ type: 'text' as const, text: `Project "${project}" not found.` }] };
    }
    const projectId = projResult.rows[0].id;

    const result = await pool.query(
      `SELECT
        c.id,
        c.source_file,
        c.section_path,
        c.token_count,
        c.last_modified,
        COALESCE(a.access_count, 0) AS access_count
      FROM docmem.chunks c
      LEFT JOIN docmem.access_stats a ON a.chunk_id = c.id
      WHERE c.project_id = $1 AND c.topic = $2
      ORDER BY c.source_file, c.section_path`,
      [projectId, topic]
    );

    if (result.rows.length === 0) {
      return { content: [{ type: 'text' as const, text: `No chunks found for topic "${topic}".` }] };
    }

    const totalTokens = result.rows.reduce((sum, r) => sum + r.token_count, 0);

    const output = {
      topic,
      total_chunks: result.rows.length,
      total_tokens: totalTokens,
      sections: result.rows.map(row => ({
        chunk_id: row.id,
        source_file: row.source_file,
        section_path: row.section_path,
        token_count: row.token_count,
        access_count: parseInt(row.access_count),
        last_modified: row.last_modified,
      })),
    };

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(output, null, 2),
      }],
    };
  }
);
```

**Step 2: Build and verify**

```bash
npm run build
```

Expected: Compiles with no errors.

**Step 3: Commit**

```bash
git add src/server.ts
git commit -m "Add docmem_overview MCP tool"
```

---

### Task 3: Entity extractor module

Heuristic extraction of entities from markdown chunk content. Parses backtick-wrapped terms and classifies them by naming convention. No LLM needed.

**Classification rules:**
- `PascalCase` (e.g., `AutomationTarget`, `ContactableReindexWorker`) → type `"model"`
- `snake_case` or `camelCase` (e.g., `reindex_contact`, `findById`) → type `"identifier"`
- `SCREAMING_SNAKE` (e.g., `BATCH_SIZE`, `MAX_RETRIES`) → type `"constant"`
- Everything else in backticks (e.g., `sidekiq`, `pgvector`) → type `"term"`

**Files:**
- Create: `src/indexer/entity-extractor.ts`
- Create: `src/indexer/entity-extractor.test.ts`

**Step 1: Write the failing tests**

Create `src/indexer/entity-extractor.test.ts`:

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { extractEntities, type ExtractedEntity } from './entity-extractor.js';

describe('extractEntities', () => {
  it('extracts backtick-wrapped PascalCase as model', () => {
    const entities = extractEntities('The `AutomationTarget` model handles execution.');
    const found = entities.find(e => e.name === 'AutomationTarget');
    assert.ok(found, 'Should find AutomationTarget');
    assert.strictEqual(found.type, 'model');
  });

  it('extracts backtick-wrapped snake_case as identifier', () => {
    const entities = extractEntities('Call `reindex_contact` to refresh.');
    const found = entities.find(e => e.name === 'reindex_contact');
    assert.ok(found, 'Should find reindex_contact');
    assert.strictEqual(found.type, 'identifier');
  });

  it('extracts backtick-wrapped camelCase as identifier', () => {
    const entities = extractEntities('Use `findById` to look up records.');
    const found = entities.find(e => e.name === 'findById');
    assert.ok(found, 'Should find findById');
    assert.strictEqual(found.type, 'identifier');
  });

  it('extracts SCREAMING_SNAKE as constant', () => {
    const entities = extractEntities('Set `BATCH_SIZE` to 32.');
    const found = entities.find(e => e.name === 'BATCH_SIZE');
    assert.ok(found, 'Should find BATCH_SIZE');
    assert.strictEqual(found.type, 'constant');
  });

  it('extracts other backtick terms as term', () => {
    const entities = extractEntities('Install `pgvector` extension.');
    const found = entities.find(e => e.name === 'pgvector');
    assert.ok(found, 'Should find pgvector');
    assert.strictEqual(found.type, 'term');
  });

  it('deduplicates entities within a single text', () => {
    const entities = extractEntities('The `Foo` model. Also see `Foo` again.');
    const foos = entities.filter(e => e.name === 'Foo');
    assert.strictEqual(foos.length, 1, 'Should deduplicate');
  });

  it('ignores short backtick terms (1-2 chars)', () => {
    const entities = extractEntities('Use `x` or `id` for lookups.');
    assert.strictEqual(entities.length, 0, 'Should ignore short terms');
  });

  it('ignores backtick terms that look like code snippets', () => {
    const entities = extractEntities('Run `npm install` and `git commit -m "foo"`.');
    // Multi-word backtick content with spaces = code snippet, not entity
    assert.strictEqual(entities.length, 0, 'Should ignore code snippets');
  });

  it('extracts multiple entities from one text', () => {
    const entities = extractEntities(
      'The `AutomationTarget` uses `ContactableReindexWorker` with `BATCH_SIZE` set.'
    );
    assert.strictEqual(entities.length, 3);
  });

  it('returns empty array for text with no backtick terms', () => {
    const entities = extractEntities('Plain text with no code references.');
    assert.strictEqual(entities.length, 0);
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
npm run build 2>&1 | tail -5
```

Expected: Compile error — `entity-extractor.js` doesn't exist yet.

**Step 3: Write the implementation**

Create `src/indexer/entity-extractor.ts`:

```typescript
export interface ExtractedEntity {
  name: string;
  type: 'model' | 'identifier' | 'constant' | 'term';
}

const BACKTICK_RE = /`([^`]+)`/g;
const MIN_LENGTH = 3;

function classifyEntity(name: string): ExtractedEntity['type'] {
  // Skip multi-word (likely code snippets)
  if (/\s/.test(name)) return null as unknown as ExtractedEntity['type'];

  // SCREAMING_SNAKE_CASE → constant
  if (/^[A-Z][A-Z0-9_]+$/.test(name)) return 'constant';

  // PascalCase (starts uppercase, has lowercase) → model
  if (/^[A-Z][a-zA-Z0-9]+$/.test(name) && /[a-z]/.test(name)) return 'model';

  // snake_case → identifier
  if (/^[a-z][a-z0-9_]+$/.test(name) && name.includes('_')) return 'identifier';

  // camelCase → identifier
  if (/^[a-z][a-zA-Z0-9]+$/.test(name) && /[A-Z]/.test(name)) return 'identifier';

  // Anything else → term
  return 'term';
}

/**
 * Extract named entities from markdown text using backtick-wrapped terms.
 * Returns deduplicated entities classified by naming convention.
 */
export function extractEntities(text: string): ExtractedEntity[] {
  const seen = new Set<string>();
  const entities: ExtractedEntity[] = [];

  let match: RegExpExecArray | null;
  while ((match = BACKTICK_RE.exec(text)) !== null) {
    const name = match[1].trim();

    if (name.length < MIN_LENGTH) continue;
    if (seen.has(name)) continue;

    const type = classifyEntity(name);
    if (!type) continue;

    seen.add(name);
    entities.push({ name, type });
  }

  return entities;
}
```

**Step 4: Run tests to verify they pass**

```bash
npm run build && node --test dist/indexer/entity-extractor.test.js
```

Expected: All 10 tests pass.

**Step 5: Commit**

```bash
git add src/indexer/entity-extractor.ts src/indexer/entity-extractor.test.ts
git commit -m "Add heuristic entity extractor from backtick terms"
```

---

### Task 4: Link extractor module

Parses markdown links between documentation files. These become explicit relationships between chunks.

**What it extracts:**
- `[text](../other-doc.md)` → relative link to another doc
- `[text](./sibling.md#section)` → link with section anchor
- Ignores external URLs (`http://`, `https://`)
- Ignores image links (`![alt](path)`)
- Resolves relative paths against the source file's directory

**Files:**
- Create: `src/indexer/link-extractor.ts`
- Create: `src/indexer/link-extractor.test.ts`

**Step 1: Write the failing tests**

Create `src/indexer/link-extractor.test.ts`:

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { extractLinks, type ExtractedLink } from './link-extractor.js';

describe('extractLinks', () => {
  it('extracts relative markdown links', () => {
    const links = extractLinks(
      'See [automations](../features/automations.md) for details.',
      'docs/guides/overview.md'
    );
    assert.strictEqual(links.length, 1);
    assert.strictEqual(links[0].targetFile, 'docs/features/automations.md');
  });

  it('extracts same-directory links', () => {
    const links = extractLinks(
      'See [billing](./billing.md).',
      'docs/features/payments.md'
    );
    assert.strictEqual(links.length, 1);
    assert.strictEqual(links[0].targetFile, 'docs/features/billing.md');
  });

  it('extracts links without ./ prefix', () => {
    const links = extractLinks(
      'See [billing](billing.md).',
      'docs/features/payments.md'
    );
    assert.strictEqual(links.length, 1);
    assert.strictEqual(links[0].targetFile, 'docs/features/billing.md');
  });

  it('strips section anchors from target path', () => {
    const links = extractLinks(
      'See [section](automations.md#guard-pattern).',
      'docs/features/overview.md'
    );
    assert.strictEqual(links[0].targetFile, 'docs/features/automations.md');
    assert.strictEqual(links[0].anchor, 'guard-pattern');
  });

  it('ignores external URLs', () => {
    const links = extractLinks(
      'Visit [docs](https://example.com/docs) and [api](http://api.example.com).',
      'docs/readme.md'
    );
    assert.strictEqual(links.length, 0);
  });

  it('ignores image links', () => {
    const links = extractLinks(
      '![diagram](./architecture.png)',
      'docs/overview.md'
    );
    assert.strictEqual(links.length, 0);
  });

  it('extracts multiple links from one text', () => {
    const links = extractLinks(
      'See [a](./a.md) and [b](../b.md) for more.',
      'docs/features/c.md'
    );
    assert.strictEqual(links.length, 2);
  });

  it('returns empty array for text with no links', () => {
    const links = extractLinks('No links here.', 'docs/test.md');
    assert.strictEqual(links.length, 0);
  });

  it('normalizes paths (removes double slashes, dots)', () => {
    const links = extractLinks(
      'See [x](../../CLAUDE.md).',
      'docs/features/deep/nested.md'
    );
    assert.strictEqual(links[0].targetFile, 'CLAUDE.md');
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
npm run build 2>&1 | tail -5
```

Expected: Compile error — `link-extractor.js` doesn't exist yet.

**Step 3: Write the implementation**

Create `src/indexer/link-extractor.ts`:

```typescript
import { resolve, dirname, normalize } from 'path';

export interface ExtractedLink {
  targetFile: string;   // Resolved relative path (e.g., 'docs/features/automations.md')
  anchor: string | null; // Section anchor if present (e.g., 'guard-pattern')
  linkText: string;      // The display text of the link
}

// Match [text](path) but NOT ![text](path) (images)
const LINK_RE = /(?<!!)\[([^\]]+)\]\(([^)]+)\)/g;

/**
 * Extract markdown links to other documentation files.
 * Resolves relative paths against the source file's directory.
 * Ignores external URLs and image links.
 */
export function extractLinks(text: string, sourceFile: string): ExtractedLink[] {
  const links: ExtractedLink[] = [];
  const sourceDir = dirname(sourceFile);

  let match: RegExpExecArray | null;
  while ((match = LINK_RE.exec(text)) !== null) {
    const linkText = match[1];
    let href = match[2].trim();

    // Skip external URLs
    if (/^https?:\/\//.test(href)) continue;

    // Skip non-markdown links
    if (!href.replace(/#.*$/, '').endsWith('.md')) continue;

    // Split anchor
    let anchor: string | null = null;
    const hashIdx = href.indexOf('#');
    if (hashIdx !== -1) {
      anchor = href.slice(hashIdx + 1);
      href = href.slice(0, hashIdx);
    }

    // Resolve relative path
    const resolved = normalize(`${sourceDir}/${href}`);

    // Clean up: remove leading ./ or /
    const targetFile = resolved.replace(/^\.\//, '').replace(/^\//, '');

    links.push({ targetFile, anchor, linkText });
  }

  return links;
}
```

**Step 4: Run tests to verify they pass**

```bash
npm run build && node --test dist/indexer/link-extractor.test.js
```

Expected: All 9 tests pass.

**Step 5: Commit**

```bash
git add src/indexer/link-extractor.ts src/indexer/link-extractor.test.ts
git commit -m "Add markdown link extractor for doc relationships"
```

---

### Task 5: Integrate entity + link extraction into indexing pipeline

Update `index-project.ts` to extract entities and links during indexing, store them in the `entities` and `relationships` tables.

**Files:**
- Modify: `src/indexer/index-project.ts`

**Step 1: Add imports**

At the top of `src/indexer/index-project.ts`, add:

```typescript
import { extractEntities } from './entity-extractor.js';
import { extractLinks } from './link-extractor.js';
```

**Step 2: Add entity extraction + storage after chunk upsert**

After the existing upsert loop (the `if (toEmbed.length > 0) { ... }` block, around line 143), and before the orphan cleanup, add this code:

```typescript
  // --- Phase 2: Entity extraction ---
  console.log('Extracting entities...');

  // Clear existing entities and relationships for this project (full refresh)
  await pool.query('DELETE FROM docmem.relationships WHERE source_id IN (SELECT id FROM docmem.chunks WHERE project_id = $1)', [projectId]);
  await pool.query('DELETE FROM docmem.entities WHERE project_id = $1', [projectId]);

  // Get all current chunk IDs and content for this project
  const allChunksDb = await pool.query(
    'SELECT id, source_file, section_path, content FROM docmem.chunks WHERE project_id = $1',
    [projectId]
  );

  // Build a map of source_file -> chunk IDs for link resolution
  const fileToChunkIds = new Map<string, string[]>();
  for (const row of allChunksDb.rows) {
    const ids = fileToChunkIds.get(row.source_file) ?? [];
    ids.push(row.id);
    fileToChunkIds.set(row.source_file, ids);
  }

  // Extract entities from each chunk and collect entity -> chunk_ids mapping
  const entityChunkMap = new Map<string, { type: string; chunkIds: Set<string> }>();
  for (const row of allChunksDb.rows) {
    const entities = extractEntities(row.content);
    for (const entity of entities) {
      const existing = entityChunkMap.get(entity.name);
      if (existing) {
        existing.chunkIds.add(row.id);
      } else {
        entityChunkMap.set(entity.name, { type: entity.type, chunkIds: new Set([row.id]) });
      }
    }
  }

  // Insert entities
  let entityCount = 0;
  for (const [name, { type, chunkIds }] of entityChunkMap) {
    await pool.query(
      `INSERT INTO docmem.entities (project_id, name, type, chunk_ids)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (project_id, name) DO UPDATE SET type = $3, chunk_ids = $4`,
      [projectId, name, type, [...chunkIds]]
    );
    entityCount++;
  }
  console.log(`Extracted ${entityCount} entities`);

  // --- Phase 2: Link extraction → relationships ---
  console.log('Extracting links...');
  let linkCount = 0;
  for (const row of allChunksDb.rows) {
    const links = extractLinks(row.content, row.source_file);
    for (const link of links) {
      const targetChunkIds = fileToChunkIds.get(link.targetFile);
      if (!targetChunkIds) continue; // Target file not indexed

      // Create relationship from this chunk to each chunk in the target file
      // If anchor is present, we could narrow to a specific section — for now, link to all chunks in file
      for (const targetId of targetChunkIds) {
        if (targetId === row.id) continue; // Skip self-links
        await pool.query(
          `INSERT INTO docmem.relationships (source_id, target_id, rel_type, confidence)
           VALUES ($1, $2, 'link', 1.0)`,
          [row.id, targetId]
        );
        linkCount++;
      }
    }
  }
  console.log(`Created ${linkCount} link relationships`);

  // --- Phase 2: Entity co-occurrence relationships ---
  console.log('Building co-occurrence relationships...');
  let cooccurrenceCount = 0;
  const relationshipPairs = new Set<string>();

  for (const [, { chunkIds }] of entityChunkMap) {
    // Only create co-occurrence links if entity appears in 2+ chunks but not too many (noise)
    if (chunkIds.size < 2 || chunkIds.size > 20) continue;

    const ids = [...chunkIds];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        // Avoid duplicate pairs
        const pairKey = [ids[i], ids[j]].sort().join('::');
        if (relationshipPairs.has(pairKey)) continue;
        relationshipPairs.add(pairKey);

        await pool.query(
          `INSERT INTO docmem.relationships (source_id, target_id, rel_type, confidence)
           VALUES ($1, $2, 'shared_entity', 0.5)`,
          [ids[i], ids[j]]
        );
        cooccurrenceCount++;
      }
    }
  }
  console.log(`Created ${cooccurrenceCount} co-occurrence relationships`);
```

**Step 3: Update the IndexResult type**

At the top of the file, update the interface:

```typescript
interface IndexResult {
  chunksAdded: number;
  chunksUpdated: number;
  chunksRemoved: number;
  totalChunks: number;
  entitiesExtracted: number;
  relationshipsCreated: number;
}
```

**Step 4: Update the return value**

Change the result construction at the bottom of `indexProject()`:

```typescript
  const result: IndexResult = {
    chunksAdded: added,
    chunksUpdated: updated,
    chunksRemoved: toRemove.length,
    totalChunks: allChunks.length,
    entitiesExtracted: entityCount,
    relationshipsCreated: linkCount + cooccurrenceCount,
  };

  console.log(`Done: +${added} ~${updated} -${toRemove.length} = ${allChunks.length} total chunks, ${entityCount} entities, ${linkCount + cooccurrenceCount} relationships`);
```

**Step 5: Build and verify**

```bash
npm run build
```

Expected: Compiles with no errors.

**Step 6: Test by reindexing boost-api**

```bash
node dist/cli.js index ~/Code/boost-api
```

Expected output (approximate):
```
Indexing project "boost-api" at /Users/ceich/Code/boost-api
Found ~77 files to index
Generated ~654 chunks
654 unchanged, 0 to embed
Extracting entities...
Extracted [100-500] entities
Extracting links...
Created [N] link relationships
Building co-occurrence relationships...
Created [N] co-occurrence relationships
Done: ...
```

**Step 7: Verify data in database**

```bash
echo "SELECT type, COUNT(*) FROM docmem.entities GROUP BY type ORDER BY count DESC;" | PGPASSWORD=docmem psql -h localhost -p 5433 -U docmem -d docmem
echo "SELECT rel_type, COUNT(*) FROM docmem.relationships GROUP BY rel_type;" | PGPASSWORD=docmem psql -h localhost -p 5433 -U docmem -d docmem
```

Expected: Non-zero counts for entities and relationships.

**Step 8: Commit**

```bash
git add src/indexer/index-project.ts
git commit -m "Integrate entity and link extraction into indexing pipeline"
```

---

### Task 6: `docmem_related` MCP tool

Finds chunks related to a given chunk via relationships (explicit links and entity co-occurrence).

**Files:**
- Modify: `src/server.ts`

**Step 1: Add the `docmem_related` tool registration**

Add after `docmem_overview` in `src/server.ts`:

```typescript
server.registerTool(
  'docmem_related',
  {
    description: 'Find chunks related to a given chunk via documentation links and shared entities. Use after loading a chunk to discover connected documentation.',
    inputSchema: {
      chunk_id: z.string().describe('The chunk ID to find related chunks for'),
      max_results: z.number().optional().default(10).describe('Max related chunks to return (default 10)'),
    },
  },
  async ({ chunk_id, max_results }) => {
    // Get relationships in both directions
    const result = await pool.query(
      `SELECT
        CASE WHEN r.source_id = $1 THEN r.target_id ELSE r.source_id END AS related_id,
        r.rel_type,
        r.confidence,
        c.source_file,
        c.section_path,
        c.topic,
        c.token_count
      FROM docmem.relationships r
      JOIN docmem.chunks c ON c.id = CASE WHEN r.source_id = $1 THEN r.target_id ELSE r.source_id END
      WHERE r.source_id = $1 OR r.target_id = $1
      ORDER BY r.confidence DESC, r.rel_type
      LIMIT $2`,
      [chunk_id, max_results ?? 10]
    );

    if (result.rows.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No related chunks found.' }] };
    }

    // Deduplicate (a chunk may be related via both link and shared_entity)
    const seen = new Map<string, { rel_types: string[]; confidence: number; source_file: string; section_path: string; topic: string; token_count: number }>();
    for (const row of result.rows) {
      const existing = seen.get(row.related_id);
      if (existing) {
        if (!existing.rel_types.includes(row.rel_type)) {
          existing.rel_types.push(row.rel_type);
        }
        existing.confidence = Math.max(existing.confidence, row.confidence);
      } else {
        seen.set(row.related_id, {
          rel_types: [row.rel_type],
          confidence: row.confidence,
          source_file: row.source_file,
          section_path: row.section_path,
          topic: row.topic,
          token_count: row.token_count,
        });
      }
    }

    const output = [...seen.entries()].map(([id, data]) => ({
      chunk_id: id,
      source_file: data.source_file,
      section_path: data.section_path,
      topic: data.topic,
      token_count: data.token_count,
      rel_types: data.rel_types,
      confidence: data.confidence,
    }));

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(output, null, 2),
      }],
    };
  }
);
```

**Step 2: Also add shared entities to the `docmem_load_chunk` response**

In the existing `docmem_load_chunk` handler, after the access_stats upsert, add an entities query. Change the output construction:

```typescript
    // Fetch entities mentioned in this chunk
    const entitiesResult = await pool.query(
      `SELECT name, type FROM docmem.entities
       WHERE project_id = (SELECT project_id FROM docmem.chunks WHERE id = $1)
       AND $1 = ANY(chunk_ids)`,
      [chunk_id]
    );

    // Count relationships
    const relCount = await pool.query(
      `SELECT COUNT(*) FROM docmem.relationships
       WHERE source_id = $1 OR target_id = $1`,
      [chunk_id]
    );

    const output = {
      source_file: row.source_file,
      section_path: row.section_path,
      topic: row.topic,
      token_count: row.token_count,
      content: row.content,
      entities: entitiesResult.rows.map(e => ({ name: e.name, type: e.type })),
      related_count: parseInt(relCount.rows[0].count),
    };
```

**Step 3: Build and verify**

```bash
npm run build
```

Expected: Compiles with no errors.

**Step 4: Commit**

```bash
git add src/server.ts
git commit -m "Add docmem_related tool and entities to load_chunk response"
```

---

### Task 7: Reindex all projects and verify end-to-end

Run the updated indexer on both projects, then verify all tools work.

**Files:** None — this is a verification task.

**Step 1: Reindex boost-api**

```bash
cd ~/Code/docmem && node dist/cli.js index ~/Code/boost-api
```

Expected: Entities and relationships extracted with non-zero counts.

**Step 2: Reindex boost-client**

```bash
node dist/cli.js index ~/Code/boost-client
```

Expected: Entities and relationships extracted.

**Step 3: Verify list_topics via MCP**

Start a new Claude Code session or use the existing MCP connection. Call:
```
docmem_list_topics({ project: "boost-api" })
```

Expected: JSON array of topics with chunk_count and total_tokens.

**Step 4: Verify overview via MCP**

```
docmem_overview({ project: "boost-api", topic: "features/automations" })
```

Expected: JSON with topic summary, section listing, access counts.

**Step 5: Verify related via MCP**

First search for a chunk, then check its relationships:
```
docmem_search({ project: "boost-api", query: "automation target processing" })
# Take a chunk_id from results
docmem_related({ chunk_id: "<id from above>" })
```

Expected: Related chunks via shared_entity and/or link relationships.

**Step 6: Verify load_chunk includes entities**

```
docmem_load_chunk({ chunk_id: "<id from above>" })
```

Expected: Response includes `entities` array and `related_count`.

**Step 7: Commit docs plan**

```bash
git add docs/plans/2026-03-11-docmem-phase2-plan.md
git commit -m "Add Phase 2 implementation plan"
```

---

## Summary

| Task | What | New/Modified Files |
|------|------|--------------------|
| 1 | `docmem_list_topics` tool | Modify: `server.ts` |
| 2 | `docmem_overview` tool | Modify: `server.ts` |
| 3 | Entity extractor + tests | Create: `entity-extractor.ts`, `entity-extractor.test.ts` |
| 4 | Link extractor + tests | Create: `link-extractor.ts`, `link-extractor.test.ts` |
| 5 | Integrate into indexing pipeline | Modify: `index-project.ts` |
| 6 | `docmem_related` tool + enriched load_chunk | Modify: `server.ts` |
| 7 | Reindex & verify all tools | No files — verification only |

**After Phase 2, the progressive disclosure flow is complete:**
```
list_topics()           ~50 tokens   → what docs exist?
overview("automations") ~100 tokens  → what sections exist?
search("guard pattern") ~200 tokens  → which chunk has the answer?
load_chunk("abc-123")   ~100 tokens  → get the content + entities
related("abc-123")      ~150 tokens  → what's connected?
```
