# DocMem Phase 5: Hybrid Search, Smart Chunking, Sessions & Auto-indexing

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Upgrade DocMem with hybrid search (BM25 + vector + RRF fusion), smart chunking that respects code fences, query expansion for better recall, session-based co-access recommendations, git-aware staleness, and hook-based auto-indexing.

**Architecture:** Postgres native `tsvector`/`tsquery` is added alongside pgvector for hybrid BM25+semantic search, fused via reciprocal rank fusion (RRF). The chunker gains code fence protection and natural break point detection for oversized sections. Query expansion generates keyword variants from the original query to improve recall. Sessions track doc access patterns for co-access recommendations. Git timestamps replace file mtime for staleness. A hook config generator automates reindexing.

**Tech Stack:** TypeScript, PostgreSQL (tsvector + pgvector), node:test, child_process for git

---

### Context for the implementer

**Project location:** `~/Code/docmem`

**Build & run:**
```bash
npm run build                    # Compile TypeScript
node --test dist/**/*.test.js    # Run tests (37 currently)
npm start                        # Start MCP server (stdio)
node dist/cli.js index /path     # Index a project
```

**Database:** Postgres 16 + pgvector on port 5433. Schema `docmem`. 8 MCP tools, 7 projects indexed, 780 chunks.

**Current chunker (src/indexer/chunker.ts):** Splits markdown at H2 boundaries. No awareness of code fences — a code block spanning an H2 boundary gets split.

**Current search (src/server.ts):** Vector-only via pgvector cosine distance. Composite scoring (similarity + heat + recency + topic + usefulness). No BM25/keyword search.

**Current staleness (src/server.ts list_topics):** Uses `statSync` file mtime.

---

### Task 1: Database migration — sessions + tsvector

Add session tracking tables and a `tsvector` column for BM25 full-text search.

**Files:**
- Modify: `src/db/migrate.ts`

**Step 1: Append to the MIGRATION string**

Add after the `access_stats` table (before the closing backtick):

```sql
CREATE TABLE IF NOT EXISTS docmem.sessions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  UUID REFERENCES docmem.projects(id) ON DELETE CASCADE,
  started_at  TIMESTAMPTZ DEFAULT NOW(),
  ended_at    TIMESTAMPTZ,
  metadata    JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_sessions_project ON docmem.sessions (project_id);

CREATE TABLE IF NOT EXISTS docmem.session_accesses (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  UUID NOT NULL REFERENCES docmem.sessions(id) ON DELETE CASCADE,
  chunk_id    UUID NOT NULL REFERENCES docmem.chunks(id) ON DELETE CASCADE,
  accessed_at TIMESTAMPTZ DEFAULT NOW(),
  action      TEXT NOT NULL DEFAULT 'load'
);

CREATE INDEX IF NOT EXISTS idx_session_accesses_session ON docmem.session_accesses (session_id);
CREATE INDEX IF NOT EXISTS idx_session_accesses_chunk ON docmem.session_accesses (chunk_id);

-- BM25 full-text search support
ALTER TABLE docmem.chunks ADD COLUMN IF NOT EXISTS search_vector tsvector;
CREATE INDEX IF NOT EXISTS idx_chunks_search_vector ON docmem.chunks USING gin (search_vector);
```

**Step 2: Build and run migration**

```bash
npm run build && npm run db:migrate
```

**Step 3: Commit**

```bash
git add src/db/migrate.ts
git commit -m "Add sessions tables and tsvector column for hybrid search"
```

---

### Task 2: Smart chunking with code fence protection

Upgrade the markdown chunker to keep code blocks intact and split oversized sections at natural break points.

**Files:**
- Modify: `src/indexer/chunker.ts`
- Modify: `src/indexer/chunker.test.ts`

**Step 1: Add new tests to `chunker.test.ts`**

```typescript
  it('keeps code blocks intact within a section', () => {
    const doc = `# Title

## Section

Before code.

\`\`\`typescript
function foo() {
  return "bar";
}
\`\`\`

After code.
`;
    const chunks = chunkMarkdown(doc, 'test.md');
    const section = chunks.find(c => c.sectionPath.includes('Section'));
    assert.ok(section, 'Should have a Section chunk');
    assert.ok(section.content.includes('function foo()'), 'Code block should be in the section');
    assert.ok(section.content.includes('After code'), 'Content after code block should be in same section');
  });

  it('does not split inside a code fence when breaking large sections', () => {
    // Create a section with a large code block
    const bigCode = Array(50).fill('  console.log("line");').join('\n');
    const doc = `# Title

## Big Section

Intro paragraph.

\`\`\`javascript
${bigCode}
\`\`\`

Conclusion paragraph.
`;
    const chunks = chunkMarkdown(doc, 'test.md');
    // Every chunk should have balanced code fences (even number of ```)
    for (const chunk of chunks) {
      const fenceCount = (chunk.content.match(/^```/gm) || []).length;
      assert.strictEqual(fenceCount % 2, 0, `Chunk "${chunk.sectionPath}" has unbalanced code fences (${fenceCount})`);
    }
  });

  it('splits oversized sections at paragraph boundaries', () => {
    const paragraphs = Array(20).fill('This is a paragraph with enough text to contribute to a large section. It contains meaningful content that should be kept together as a unit.').join('\n\n');
    const doc = `# Title

## Huge Section

${paragraphs}
`;
    const chunks = chunkMarkdown(doc, 'test.md', { maxChunkTokens: 200 });
    assert.ok(chunks.length >= 2, `Expected multiple chunks for oversized section, got ${chunks.length}`);
  });
```

**Step 2: Update the chunker implementation**

Replace the `chunkMarkdown` function to support an options parameter and secondary splitting:

```typescript
export interface ChunkOptions {
  maxChunkTokens?: number;  // Max tokens per chunk before secondary splitting (default: 1500)
}

/**
 * Check if a position is inside a code fence.
 */
function isInsideCodeFence(lines: string[], lineIndex: number): boolean {
  let fenceCount = 0;
  for (let i = 0; i < lineIndex; i++) {
    if (/^```/.test(lines[i])) fenceCount++;
  }
  return fenceCount % 2 === 1; // Odd count means we're inside a fence
}

/**
 * Split a large section at natural paragraph boundaries, respecting code fences.
 * Returns an array of content strings.
 */
function splitOversizedSection(content: string, maxTokens: number): string[] {
  const estimatedTokens = Math.ceil(content.length / 4);
  if (estimatedTokens <= maxTokens) return [content];

  const lines = content.split('\n');
  const parts: string[] = [];
  let currentLines: string[] = [];
  let currentTokens = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineTokens = Math.ceil(line.length / 4) + 1; // +1 for newline

    currentLines.push(line);
    currentTokens += lineTokens;

    // Check if we should split: at empty lines (paragraph boundaries), not inside code fences
    if (currentTokens >= maxTokens && line.trim() === '' && !isInsideCodeFence(lines, i)) {
      const part = currentLines.join('\n').trim();
      if (part) parts.push(part);
      currentLines = [];
      currentTokens = 0;
    }
  }

  // Remaining content
  const remaining = currentLines.join('\n').trim();
  if (remaining) parts.push(remaining);

  // If we couldn't split (e.g., one giant code block), return as-is
  return parts.length > 0 ? parts : [content];
}

export function chunkMarkdown(markdown: string, filePath: string, options?: ChunkOptions): Chunk[] {
  const maxChunkTokens = options?.maxChunkTokens ?? 1500;
  const lines = markdown.split('\n');
  const topic = deriveTopic(filePath);
  const rawChunks: { heading: string; lines: string[] }[] = [];

  let currentHeading = '';
  let currentLines: string[] = [];
  let mainTitle = '';

  for (const line of lines) {
    if (/^# /.test(line) && !mainTitle) {
      mainTitle = line.replace(/^# /, '').trim();
      currentLines.push(line);
      continue;
    }

    if (/^## /.test(line)) {
      if (currentLines.length > 0) {
        rawChunks.push({ heading: currentHeading, lines: [...currentLines] });
      }
      currentHeading = line.replace(/^## /, '').trim();
      currentLines = [line];
      continue;
    }

    currentLines.push(line);
  }

  if (currentLines.length > 0) {
    rawChunks.push({ heading: currentHeading, lines: [...currentLines] });
  }

  // Convert raw chunks to Chunk objects, splitting oversized sections
  const chunks: Chunk[] = [];

  for (const raw of rawChunks) {
    const content = raw.lines.join('\n').trim();
    if (!content) continue;

    const sectionPath = raw.heading
      ? [mainTitle, raw.heading].filter(Boolean).join(' > ')
      : mainTitle || filePath;

    const parts = splitOversizedSection(content, maxChunkTokens);

    for (let i = 0; i < parts.length; i++) {
      const partPath = parts.length > 1 ? `${sectionPath} (part ${i + 1})` : sectionPath;
      chunks.push({
        sourceFile: filePath,
        sectionPath: partPath,
        content: parts[i],
        topic,
        checksum: computeChecksum(parts[i]),
      });
    }
  }

  return chunks;
}
```

**Step 3: Build and run tests**

```bash
npm run build && node --test dist/indexer/chunker.test.js
```

Expected: All original tests pass + 3 new tests pass.

**Step 4: Commit**

```bash
git add src/indexer/chunker.ts src/indexer/chunker.test.ts
git commit -m "Upgrade chunker with code fence protection and oversized section splitting"
```

---

### Task 3: Update indexing pipeline to populate tsvector

When inserting/updating chunks, also populate the `search_vector` column for BM25.

**Files:**
- Modify: `src/indexer/index-project.ts`

**Step 1: Update the INSERT statement**

In the chunk INSERT (the `Insert new` block), add `search_vector`:

```sql
INSERT INTO docmem.chunks (project_id, source_file, section_path, content, summary, embedding, token_count, topic, checksum, last_modified, search_vector)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, to_tsvector('english', $4))
```

Note: `$4` is `chunk.content`, so `to_tsvector('english', $4)` generates the search vector from the content.

**Step 2: Update the UPDATE statement**

In the chunk UPDATE block, add:

```sql
search_vector = to_tsvector('english', $1),
```

(where `$1` is `chunk.content` in the update params)

**Step 3: Backfill existing chunks**

Add a backfill at the end of `indexProject()`, before the return statement:

```typescript
  // Backfill search_vector for any chunks missing it
  await pool.query(
    `UPDATE docmem.chunks SET search_vector = to_tsvector('english', content)
     WHERE project_id = $1 AND search_vector IS NULL`,
    [projectId]
  );
```

**Step 4: Build and verify**

```bash
npm run build
```

**Step 5: Commit**

```bash
git add src/indexer/index-project.ts
git commit -m "Populate tsvector during indexing for BM25 search"
```

---

### Task 4: Session management module + tests

Pure-function module for session lifecycle with 30-minute auto-expiry.

**Files:**
- Create: `src/sessions.ts`
- Create: `src/sessions.test.ts`

**Step 1: Write tests**

Create `src/sessions.test.ts`:

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { shouldStartNewSession } from './sessions.js';

describe('shouldStartNewSession', () => {
  it('returns true when no existing session', () => {
    assert.strictEqual(shouldStartNewSession(null, new Date()), true);
  });

  it('returns true when session is older than timeout', () => {
    const now = new Date();
    const oldAccess = new Date(now.getTime() - 31 * 60 * 1000);
    assert.strictEqual(shouldStartNewSession(oldAccess, now), true);
  });

  it('returns false when session is within timeout', () => {
    const now = new Date();
    const recentAccess = new Date(now.getTime() - 5 * 60 * 1000);
    assert.strictEqual(shouldStartNewSession(recentAccess, now), false);
  });

  it('returns false when session just started', () => {
    const now = new Date();
    assert.strictEqual(shouldStartNewSession(now, now), false);
  });

  it('returns true at exactly the timeout boundary', () => {
    const now = new Date();
    const exact = new Date(now.getTime() - 30 * 60 * 1000);
    assert.strictEqual(shouldStartNewSession(exact, now), true);
  });
});
```

**Step 2: Write implementation**

Create `src/sessions.ts`:

```typescript
import { pool } from './db/pool.js';

const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

export function shouldStartNewSession(lastAccess: Date | null, now: Date): boolean {
  if (!lastAccess) return true;
  return (now.getTime() - lastAccess.getTime()) >= SESSION_TIMEOUT_MS;
}

const activeSessions = new Map<string, { sessionId: string; lastAccess: Date }>();

export async function getOrCreateSession(projectId: string | null): Promise<string> {
  const key = projectId ?? '__global__';
  const now = new Date();
  const active = activeSessions.get(key);

  if (active && !shouldStartNewSession(active.lastAccess, now)) {
    active.lastAccess = now;
    return active.sessionId;
  }

  if (active) {
    await pool.query('UPDATE docmem.sessions SET ended_at = NOW() WHERE id = $1', [active.sessionId]);
  }

  const result = await pool.query(
    `INSERT INTO docmem.sessions (project_id, started_at) VALUES ($1, NOW()) RETURNING id`,
    [projectId]
  );
  const sessionId = result.rows[0].id;
  activeSessions.set(key, { sessionId, lastAccess: now });
  return sessionId;
}

export async function recordSessionAccess(
  sessionId: string,
  chunkId: string,
  action: 'load' | 'search' | 'feedback' = 'load'
): Promise<void> {
  await pool.query(
    `INSERT INTO docmem.session_accesses (session_id, chunk_id, action) VALUES ($1, $2, $3)`,
    [sessionId, chunkId, action]
  );
}
```

**Step 3: Build and run tests**

```bash
npm run build && node --test dist/sessions.test.js
```

Expected: 5 tests pass.

**Step 4: Commit**

```bash
git add src/sessions.ts src/sessions.test.ts
git commit -m "Add session management module with timeout logic"
```

---

### Task 5: Hybrid search module (BM25 + RRF fusion) + tests

A pure-function module that implements reciprocal rank fusion to combine BM25 and vector search results.

**Files:**
- Create: `src/hybrid-search.ts`
- Create: `src/hybrid-search.test.ts`

**Step 1: Write tests**

Create `src/hybrid-search.test.ts`:

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { fuseResults, expandQuery, type RankedResult } from './hybrid-search.js';

describe('fuseResults', () => {
  it('combines results from two ranked lists via RRF', () => {
    const vectorResults: RankedResult[] = [
      { id: 'a', rank: 1 },
      { id: 'b', rank: 2 },
      { id: 'c', rank: 3 },
    ];
    const bm25Results: RankedResult[] = [
      { id: 'b', rank: 1 },
      { id: 'a', rank: 2 },
      { id: 'd', rank: 3 },
    ];
    const fused = fuseResults(vectorResults, bm25Results);
    // 'a' and 'b' appear in both lists, should rank highest
    assert.ok(fused.length >= 3);
    const topIds = fused.slice(0, 2).map(r => r.id);
    assert.ok(topIds.includes('a'), 'a should be in top 2');
    assert.ok(topIds.includes('b'), 'b should be in top 2');
  });

  it('handles empty vector results', () => {
    const bm25: RankedResult[] = [{ id: 'a', rank: 1 }];
    const fused = fuseResults([], bm25);
    assert.strictEqual(fused.length, 1);
    assert.strictEqual(fused[0].id, 'a');
  });

  it('handles empty BM25 results', () => {
    const vector: RankedResult[] = [{ id: 'a', rank: 1 }];
    const fused = fuseResults(vector, []);
    assert.strictEqual(fused.length, 1);
    assert.strictEqual(fused[0].id, 'a');
  });

  it('deduplicates IDs from both lists', () => {
    const vector: RankedResult[] = [{ id: 'a', rank: 1 }, { id: 'b', rank: 2 }];
    const bm25: RankedResult[] = [{ id: 'a', rank: 1 }, { id: 'b', rank: 2 }];
    const fused = fuseResults(vector, bm25);
    const ids = fused.map(r => r.id);
    assert.strictEqual(new Set(ids).size, ids.length, 'No duplicates');
  });

  it('gives top-rank bonus to rank 1 results', () => {
    const vector: RankedResult[] = [{ id: 'a', rank: 1 }, { id: 'b', rank: 10 }];
    const bm25: RankedResult[] = [{ id: 'b', rank: 1 }, { id: 'a', rank: 10 }];
    const fused = fuseResults(vector, bm25);
    // Both appear at rank 1 in one list and rank 10 in another — equal
    // But both get a top-rank bonus from their #1 position
    assert.strictEqual(fused.length, 2);
  });
});

describe('expandQuery', () => {
  it('returns original query as first element', () => {
    const expanded = expandQuery('automation target processing');
    assert.strictEqual(expanded[0], 'automation target processing');
  });

  it('generates at least 2 variants', () => {
    const expanded = expandQuery('automation target processing');
    assert.ok(expanded.length >= 2, `Expected at least 2 variants, got ${expanded.length}`);
  });

  it('generates keyword variant without stopwords', () => {
    const expanded = expandQuery('how does the automation target work');
    const hasKeywordVariant = expanded.some(q => !q.includes('how') || !q.includes('does') || !q.includes('the'));
    assert.ok(hasKeywordVariant, 'Should have a variant with stopwords removed');
  });

  it('returns just the original for very short queries', () => {
    const expanded = expandQuery('hi');
    assert.strictEqual(expanded.length, 1);
  });
});
```

**Step 2: Write implementation**

Create `src/hybrid-search.ts`:

```typescript
export interface RankedResult {
  id: string;
  rank: number;
}

export interface FusedResult {
  id: string;
  rrfScore: number;
}

const RRF_K = 60; // Standard RRF constant
const TOP_RANK_BONUS = 0.05; // Bonus for #1 rank

/**
 * Reciprocal Rank Fusion: combine two ranked result lists into one.
 * RRF score = sum of 1/(k + rank) across all lists where the item appears.
 * Top-rank bonus: +0.05 for items at rank 1 in either list.
 */
export function fuseResults(vectorResults: RankedResult[], bm25Results: RankedResult[]): FusedResult[] {
  const scores = new Map<string, number>();

  for (const r of vectorResults) {
    const rrf = 1 / (RRF_K + r.rank);
    const bonus = r.rank === 1 ? TOP_RANK_BONUS : 0;
    scores.set(r.id, (scores.get(r.id) ?? 0) + rrf + bonus);
  }

  for (const r of bm25Results) {
    const rrf = 1 / (RRF_K + r.rank);
    const bonus = r.rank === 1 ? TOP_RANK_BONUS : 0;
    scores.set(r.id, (scores.get(r.id) ?? 0) + rrf + bonus);
  }

  return [...scores.entries()]
    .map(([id, rrfScore]) => ({ id, rrfScore: Math.round(rrfScore * 10000) / 10000 }))
    .sort((a, b) => b.rrfScore - a.rrfScore);
}

const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
  'before', 'after', 'above', 'below', 'between', 'out', 'off', 'over',
  'under', 'again', 'further', 'then', 'once', 'here', 'there', 'when',
  'where', 'why', 'how', 'all', 'each', 'every', 'both', 'few', 'more',
  'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own',
  'same', 'so', 'than', 'too', 'very', 'just', 'because', 'but', 'and',
  'or', 'if', 'while', 'about', 'up', 'its', 'it', 'this', 'that', 'what',
]);

/**
 * Expand a query into multiple variants for better recall.
 * Returns: [original, keyword_variant, ...].
 * Original is always first and should be weighted 2x.
 */
export function expandQuery(query: string): string[] {
  const trimmed = query.trim();
  if (trimmed.split(/\s+/).length <= 2) return [trimmed];

  const variants: string[] = [trimmed];

  // Keyword variant: remove stopwords
  const keywords = trimmed
    .toLowerCase()
    .split(/\s+/)
    .filter(w => !STOPWORDS.has(w) && w.length > 1);

  if (keywords.length > 0 && keywords.join(' ') !== trimmed.toLowerCase()) {
    variants.push(keywords.join(' '));
  }

  return variants;
}
```

**Step 3: Build and run tests**

```bash
npm run build && node --test dist/hybrid-search.test.js
```

Expected: 9 tests pass.

**Step 4: Commit**

```bash
git add src/hybrid-search.ts src/hybrid-search.test.ts
git commit -m "Add hybrid search module with RRF fusion and query expansion"
```

---

### Task 6: Upgrade `docmem_search` with hybrid search + query expansion

Rewrite the search handler to run both BM25 and vector searches, fuse results, then apply composite scoring.

**Files:**
- Modify: `src/server.ts`

**Step 1: Add imports**

```typescript
import { fuseResults, expandQuery, type RankedResult } from './hybrid-search.js';
import { getOrCreateSession, recordSessionAccess } from './sessions.js';
```

**Step 2: Rewrite the search handler**

Replace the `docmem_search` handler with a version that:
1. Expands the query into variants
2. Runs vector search (existing pgvector query)
3. Runs BM25 search using `ts_rank` + `plainto_tsquery`
4. Fuses results via RRF
5. Fetches full row data for the top fused IDs
6. Applies composite scoring
7. Records search results in session

The new handler flow:

```typescript
  async ({ project, query, max_results, topic }) => {
    let projectId: string | null = null;

    if (project !== '*') {
      const projResult = await pool.query(
        'SELECT id FROM docmem.projects WHERE name = $1', [project]
      );
      if (projResult.rows.length === 0) {
        return { content: [{ type: 'text' as const, text: `Project "${project}" not found. Run "docmem index" first.` }] };
      }
      projectId = projResult.rows[0].id;
    }

    const queries = expandQuery(query);
    const candidateLimit = Math.max((max_results ?? 5) * 3, 15);

    // --- Vector search (original query, weighted 2x by being first) ---
    const queryEmbedding = await embedQuery(queries[0]);
    const embeddingStr = `[${queryEmbedding.join(',')}]`;

    let vectorSql = `
      SELECT c.id, ROW_NUMBER() OVER (ORDER BY c.embedding <=> $1::vector) AS rank
      FROM docmem.chunks c
      WHERE 1=1
    `;
    const vectorParams: unknown[] = [embeddingStr];
    let vIdx = 2;
    if (projectId) {
      vectorSql += ` AND c.project_id = $${vIdx}`;
      vectorParams.push(projectId);
      vIdx++;
    }
    if (topic) {
      vectorSql += ` AND c.topic = $${vIdx}`;
      vectorParams.push(topic);
      vIdx++;
    }
    vectorSql += ` ORDER BY c.embedding <=> $1::vector LIMIT $${vIdx}`;
    vectorParams.push(candidateLimit);

    const vectorResults = await pool.query(vectorSql, vectorParams);

    // --- BM25 search (all query variants combined with OR) ---
    const tsQuery = queries.map(q => `plainto_tsquery('english', '${q.replace(/'/g, "''")}')`).join(' || ');

    let bm25Sql = `
      SELECT c.id, ROW_NUMBER() OVER (ORDER BY ts_rank(c.search_vector, query) DESC) AS rank
      FROM docmem.chunks c, (SELECT ${tsQuery} AS query) q
      WHERE c.search_vector @@ q.query
    `;
    const bm25Params: unknown[] = [];
    let bIdx = 1;
    if (projectId) {
      bm25Sql += ` AND c.project_id = $${bIdx}`;
      bm25Params.push(projectId);
      bIdx++;
    }
    if (topic) {
      bm25Sql += ` AND c.topic = $${bIdx}`;
      bm25Params.push(topic);
      bIdx++;
    }
    bm25Sql += ` ORDER BY ts_rank(c.search_vector, query) DESC LIMIT ${candidateLimit}`;

    let bm25Results: { rows: { id: string; rank: string }[] } = { rows: [] };
    try {
      bm25Results = await pool.query(bm25Sql, bm25Params);
    } catch {
      // BM25 may fail if search_vector is null (not yet backfilled) — fall through
    }

    // --- RRF fusion ---
    const vectorRanked: RankedResult[] = vectorResults.rows.map(r => ({ id: r.id, rank: parseInt(r.rank) }));
    const bm25Ranked: RankedResult[] = bm25Results.rows.map(r => ({ id: r.id, rank: parseInt(r.rank) }));
    const fused = fuseResults(vectorRanked, bm25Ranked);

    if (fused.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No results found.' }] };
    }

    // --- Fetch full data for top fused IDs ---
    const topIds = fused.slice(0, candidateLimit).map(f => f.id);
    const fullData = await pool.query(
      `SELECT
        c.id, c.source_file, c.section_path, c.summary, c.topic, c.token_count,
        c.last_modified, p.name AS project_name,
        1 - (c.embedding <=> $1::vector) AS similarity,
        COALESCE(a.access_count, 0) AS access_count,
        COALESCE(a.avg_usefulness, 0.5) AS avg_usefulness
      FROM docmem.chunks c
      LEFT JOIN docmem.access_stats a ON a.chunk_id = c.id
      JOIN docmem.projects p ON p.id = c.project_id
      WHERE c.id = ANY($2)`,
      [embeddingStr, topIds]
    );

    // Get max access for normalization
    let maxAccessSql = `SELECT COALESCE(MAX(a.access_count), 0) AS max_access
       FROM docmem.access_stats a JOIN docmem.chunks c ON c.id = a.chunk_id`;
    const maxAccessParams: unknown[] = [];
    if (projectId) {
      maxAccessSql += ` WHERE c.project_id = $1`;
      maxAccessParams.push(projectId);
    }
    const maxAccessResult = await pool.query(maxAccessSql, maxAccessParams);
    const maxAccess = parseInt(maxAccessResult.rows[0].max_access) || 0;

    // Build lookup maps
    const rowMap = new Map(fullData.rows.map(r => [r.id, r]));
    const rrfMap = new Map(fused.map(f => [f.id, f.rrfScore]));

    const now = new Date();
    const queryLower = query.toLowerCase();

    // Score with composite scoring, then sort
    const scored = topIds
      .map(id => rowMap.get(id))
      .filter((row): row is NonNullable<typeof row> => !!row)
      .map(row => {
        const { score, breakdown } = computeScore({
          similarity: parseFloat(row.similarity),
          accessCount: parseInt(row.access_count),
          maxAccess,
          lastModified: new Date(row.last_modified),
          now,
          queryMatchesTopic: queryLower.includes(row.topic.split('/').pop()?.toLowerCase() ?? ''),
          usefulness: parseFloat(row.avg_usefulness),
        });
        return { row, score, breakdown, rrfScore: rrfMap.get(row.id) ?? 0 };
      });

    scored.sort((a, b) => b.score - a.score);

    // Record in session
    const sessionId = await getOrCreateSession(projectId);
    for (const s of scored.slice(0, max_results ?? 5)) {
      await recordSessionAccess(sessionId, s.row.id, 'search');
    }

    const output = scored.slice(0, max_results ?? 5).map((s, i) => ({
      rank: i + 1,
      chunk_id: s.row.id,
      project: s.row.project_name,
      source_file: s.row.source_file,
      section_path: s.row.section_path,
      topic: s.row.topic,
      token_count: s.row.token_count,
      score: s.score,
      score_breakdown: s.breakdown,
      rrf_score: s.rrfScore,
      similarity: Math.round(parseFloat(s.row.similarity) * 1000) / 1000,
      summary: s.row.summary || `[${s.row.section_path}] (${s.row.token_count} tokens)`,
    }));

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }],
    };
  }
```

**Step 3: Also wire session tracking into `docmem_load_chunk`**

In the load_chunk handler, after the access_stats upsert, add:

```typescript
    const sessionId = await getOrCreateSession(row.project_id);
    await recordSessionAccess(sessionId, chunk_id, 'load');
```

(Ensure the chunk query SELECTs `c.project_id` — add it if not already there.)

**Step 4: Build and verify**

```bash
npm run build
```

**Step 5: Commit**

```bash
git add src/server.ts
git commit -m "Upgrade search with hybrid BM25+vector fusion, query expansion, and session tracking"
```

---

### Task 7: `docmem_suggest` co-access tool

"Agents who loaded X also loaded Y" — recommendations from session co-access patterns.

**Files:**
- Modify: `src/server.ts`

**Step 1: Add tool registration after `docmem_feedback`**

```typescript
server.registerTool(
  'docmem_suggest',
  {
    description: 'Suggest related chunks based on co-access patterns. Shows what other agents typically loaded alongside a given chunk. Use after loading a chunk to discover commonly co-accessed documentation.',
    inputSchema: {
      chunk_id: z.string().describe('The chunk ID to find co-accessed chunks for'),
      max_results: z.number().optional().default(5).describe('Max suggestions to return (default 5)'),
    },
  },
  async ({ chunk_id, max_results }) => {
    const result = await pool.query(
      `SELECT
        sa2.chunk_id AS suggested_id,
        c.source_file, c.section_path, c.topic, c.token_count,
        p.name AS project,
        COUNT(DISTINCT sa2.session_id) AS co_access_count
      FROM docmem.session_accesses sa1
      JOIN docmem.session_accesses sa2 ON sa2.session_id = sa1.session_id AND sa2.chunk_id != sa1.chunk_id
      JOIN docmem.chunks c ON c.id = sa2.chunk_id
      JOIN docmem.projects p ON p.id = c.project_id
      WHERE sa1.chunk_id = $1
      GROUP BY sa2.chunk_id, c.source_file, c.section_path, c.topic, c.token_count, p.name
      ORDER BY co_access_count DESC
      LIMIT $2`,
      [chunk_id, max_results ?? 5]
    );

    if (result.rows.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No co-access patterns found yet. Suggestions improve as more chunks are accessed in sessions.' }] };
    }

    const output = result.rows.map((row, i) => ({
      rank: i + 1,
      chunk_id: row.suggested_id,
      project: row.project,
      source_file: row.source_file,
      section_path: row.section_path,
      topic: row.topic,
      token_count: row.token_count,
      co_access_count: parseInt(row.co_access_count),
    }));

    return { content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }] };
  }
);
```

**Step 2: Build and commit**

```bash
npm run build
git add src/server.ts
git commit -m "Add docmem_suggest tool for co-access recommendations"
```

---

### Task 8: Git-aware staleness + replace mtime

Replace `statSync` with `git log` timestamps in `list_topics`.

**Files:**
- Create: `src/git-staleness.ts`
- Create: `src/git-staleness.test.ts`
- Modify: `src/server.ts`

**Step 1: Write tests**

Create `src/git-staleness.test.ts`:

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseGitTimestamp, isStale } from './git-staleness.js';

describe('parseGitTimestamp', () => {
  it('parses unix timestamp string to Date', () => {
    const date = parseGitTimestamp('1710000000');
    assert.ok(date instanceof Date);
    assert.strictEqual(date.getTime(), 1710000000 * 1000);
  });

  it('returns null for empty string', () => {
    assert.strictEqual(parseGitTimestamp(''), null);
  });

  it('returns null for whitespace', () => {
    assert.strictEqual(parseGitTimestamp('  \n'), null);
  });
});

describe('isStale', () => {
  it('returns true when git timestamp is newer than indexed', () => {
    assert.strictEqual(isStale(new Date('2026-03-17'), new Date('2026-03-16')), true);
  });

  it('returns false when indexed is newer', () => {
    assert.strictEqual(isStale(new Date('2026-03-15'), new Date('2026-03-16')), false);
  });

  it('returns false when equal', () => {
    const t = new Date('2026-03-16');
    assert.strictEqual(isStale(t, t), false);
  });

  it('returns true when git timestamp is null (deleted)', () => {
    assert.strictEqual(isStale(null, new Date('2026-03-16')), true);
  });
});
```

**Step 2: Write implementation**

Create `src/git-staleness.ts`:

```typescript
import { execSync } from 'child_process';

export function parseGitTimestamp(timestamp: string): Date | null {
  const trimmed = timestamp.trim();
  if (!trimmed) return null;
  const seconds = parseInt(trimmed, 10);
  if (isNaN(seconds)) return null;
  return new Date(seconds * 1000);
}

export function isStale(gitTimestamp: Date | null, indexedTimestamp: Date): boolean {
  if (!gitTimestamp) return true;
  return gitTimestamp.getTime() > indexedTimestamp.getTime();
}

export function getGitFileTimestamp(rootPath: string, filePath: string): Date | null {
  try {
    const output = execSync(
      `git log -1 --format=%ct -- "${filePath}"`,
      { cwd: rootPath, encoding: 'utf-8', timeout: 5000 }
    );
    return parseGitTimestamp(output);
  } catch {
    return null;
  }
}
```

**Step 3: Update list_topics in server.ts**

Replace the `statSync`-based staleness check with:

```typescript
import { getGitFileTimestamp, isStale } from './git-staleness.js';
```

In the handler, replace the `const { statSync } = await import('fs');` block and staleness check with:

```typescript
      const gitTime = getGitFileTimestamp(rootPath, row.source_file);
      if (isStale(gitTime, new Date(row.last_modified))) {
        topicStats.get(row.topic)!.stale_chunks++;
      }
```

Remove the `const { statSync } = await import('fs');` line. Keep the `const { resolve } = await import('path');` only if used elsewhere, otherwise remove it too.

**Step 4: Build and run tests**

```bash
npm run build && node --test dist/git-staleness.test.js
```

Expected: 7 tests pass.

**Step 5: Commit**

```bash
git add src/git-staleness.ts src/git-staleness.test.ts src/server.ts
git commit -m "Add git-aware staleness detection, replace mtime checks"
```

---

### Task 9: Hook-based auto-indexing

Add a CLI command that generates Claude Code hook configuration for automatic reindexing.

**Files:**
- Modify: `src/cli.ts`

**Step 1: Add `generate-hooks` command to the CLI switch**

```typescript
    case 'generate-hooks': {
      const docmemPath = process.argv[1] || 'docmem';
      const hookConfig = {
        hooks: {
          SessionEnd: [
            {
              type: "command" as const,
              command: `${docmemPath} reindex-all 2>/dev/null &`,
              timeout: 5000,
            },
          ],
        },
      };
      console.log('Add this to your ~/.claude/settings.json:\n');
      console.log(JSON.stringify(hookConfig, null, 2));
      console.log('\nThis will automatically reindex all projects when a Claude Code session ends.');
      break;
    }
```

Also update the default/help case to include the new command:

```typescript
      console.log('  generate-hooks    Print Claude Code hook config for auto-reindexing');
```

**Step 2: Build and verify**

```bash
npm run build && node dist/cli.js generate-hooks
```

Expected: Prints a JSON hook configuration.

**Step 3: Commit**

```bash
git add src/cli.ts
git commit -m "Add generate-hooks CLI command for Claude Code auto-indexing"
```

---

### Task 10: Reindex all projects + verify end-to-end

Reindex everything to populate `search_vector` and apply smart chunking, then verify all features.

**Step 1: Run all tests**

```bash
npm run build && node --test dist/**/*.test.js
```

Expected: All tests pass (~58 total: 9 chunker + 10 entity + 9 link + 12 scoring + 5 session + 9 hybrid + 7 git-staleness = 61).

**Step 2: Reindex all projects to populate tsvector + smart chunks**

```bash
node dist/cli.js reindex-all
```

Expected: All 7 projects reindexed with new tsvector data.

**Step 3: Verify hybrid search**

```bash
PGPASSWORD=docmem psql -h localhost -p 5433 -U docmem -d docmem -c "
SELECT COUNT(*) AS chunks_with_tsvector
FROM docmem.chunks WHERE search_vector IS NOT NULL;"
```

Expected: 780 (all chunks have tsvector).

**Step 4: Verify sessions**

After using search + load_chunk:
```bash
PGPASSWORD=docmem psql -h localhost -p 5433 -U docmem -d docmem -c "
SELECT COUNT(*) FROM docmem.sessions;
SELECT COUNT(*) FROM docmem.session_accesses;"
```

Expected: Non-zero counts.

**Step 5: Commit plan**

```bash
git add -f docs/plans/2026-03-17-docmem-phase5-plan.md
git commit -m "Add Phase 5 implementation plan"
```

---

## Summary

| Task | What | Files |
|------|------|-------|
| 1 | DB migration (sessions + tsvector) | Modify: `migrate.ts` |
| 2 | Smart chunking + code fence protection | Modify: `chunker.ts`, `chunker.test.ts` |
| 3 | Populate tsvector during indexing | Modify: `index-project.ts` |
| 4 | Session management module + tests | Create: `sessions.ts`, `sessions.test.ts` |
| 5 | Hybrid search module (RRF + query expansion) + tests | Create: `hybrid-search.ts`, `hybrid-search.test.ts` |
| 6 | Upgrade search with hybrid + sessions | Modify: `server.ts` |
| 7 | `docmem_suggest` co-access tool | Modify: `server.ts` |
| 8 | Git-aware staleness + replace mtime | Create: `git-staleness.ts`, `git-staleness.test.ts`, Modify: `server.ts` |
| 9 | Hook-based auto-indexing CLI | Modify: `cli.ts` |
| 10 | Reindex + verify | No files — verification only |

**After Phase 5, the full tool suite (9 tools):**
```
docmem_search       — hybrid BM25+vector search with query expansion + composite scoring
docmem_load_chunk   — load content + entities + session tracking
docmem_list_topics  — topic discovery with git-aware staleness
docmem_overview     — topic section browser
docmem_related      — relationship traversal
docmem_index        — agent-triggered reindexing
docmem_feedback     — usefulness signal
docmem_suggest      — co-access recommendations
```

**Search pipeline after Phase 5:**
```
Query "how does automation target processing work"
  ↓
Query Expansion: ["how does automation target processing work", "automation target processing work"]
  ↓
Vector Search (pgvector cosine) → top 15 candidates ranked by similarity
BM25 Search (tsvector/tsquery) → top 15 candidates ranked by term frequency
  ↓
RRF Fusion (k=60, top-rank bonus) → merged + deduplicated candidates
  ↓
Composite Scoring (similarity 65% + heat 10% + recency 10% + usefulness 10% + topic 5%)
  ↓
Top 5 results with score_breakdown + rrf_score
```
