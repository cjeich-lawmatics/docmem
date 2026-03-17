# DocMem Phase 3: Smart Scoring & Polish

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Upgrade search from pure cosine distance to composite scoring (semantic + heat + recency), add explainable score traces, an agent-triggered reindex tool, and staleness detection.

**Architecture:** A pure-function scoring module computes a weighted blend of semantic similarity, access heat, document recency, and topic affinity. The `docmem_search` tool uses this scorer and returns a breakdown with each result. A new `docmem_index` tool lets agents trigger reindexing without the CLI. Staleness detection checks file mtimes against indexed timestamps.

**Tech Stack:** TypeScript, PostgreSQL (existing docmem schema), node:test for testing, existing MCP server

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

**Database:** Postgres 16 + pgvector on port 5433. Schema `docmem`.

**Current search behavior (server.ts:23-86):** Pure cosine distance ranking. The SQL query orders by `embedding <=> query_embedding` and returns similarity as `1 - distance`. No consideration of access frequency, recency, or topic affinity.

**Existing access_stats table:** Already records `access_count` and `last_accessed` for each chunk loaded via `docmem_load_chunk`. Currently only displayed in `docmem_overview` — not used for ranking.

**Existing files you'll touch:**
- `src/server.ts` — MCP server with 5 tools
- `src/cli.ts` — CLI entry point
- `src/indexer/index-project.ts` — indexing pipeline (exports `indexProject()`)

**New files you'll create:**
- `src/scoring.ts` — composite scoring module
- `src/scoring.test.ts` — tests for scoring

---

### Task 1: Composite scoring module

A pure-function module that computes a weighted final score from multiple signals. Easily testable without database access.

**Scoring formula:**
```
final_score = w_sim * similarity + w_heat * heat_norm + w_recency * recency_norm + w_topic * topic_bonus
```

**Signals:**
- `similarity` (0–1): cosine similarity from pgvector, already computed
- `heat_norm` (0–1): `min(access_count / max_access, 1.0)` — normalized against the most-accessed chunk. Chunks with 0 access get 0.
- `recency_norm` (0–1): `1 - (days_since_modified / max_age_days)` clamped to [0, 1]. max_age_days = 365. More recently modified = higher.
- `topic_bonus` (0 or 1): 1 if the query string contains the chunk's topic name (case-insensitive), 0 otherwise

**Default weights:**
```typescript
const DEFAULT_WEIGHTS = {
  similarity: 0.70,
  heat: 0.15,
  recency: 0.10,
  topic: 0.05,
};
```

**Files:**
- Create: `src/scoring.ts`
- Create: `src/scoring.test.ts`

**Step 1: Write the failing tests**

Create `src/scoring.test.ts`:

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { computeScore, normalizeHeat, normalizeRecency, type ScoringInput } from './scoring.js';

describe('normalizeHeat', () => {
  it('returns 0 when access_count is 0', () => {
    assert.strictEqual(normalizeHeat(0, 100), 0);
  });

  it('returns 1 when access_count equals max', () => {
    assert.strictEqual(normalizeHeat(50, 50), 1);
  });

  it('returns 0 when max is 0 (no accesses anywhere)', () => {
    assert.strictEqual(normalizeHeat(0, 0), 0);
  });

  it('normalizes proportionally', () => {
    assert.strictEqual(normalizeHeat(25, 100), 0.25);
  });
});

describe('normalizeRecency', () => {
  it('returns 1 for today', () => {
    const now = new Date();
    assert.strictEqual(normalizeRecency(now, now), 1);
  });

  it('returns 0.5 for halfway through max age', () => {
    const now = new Date();
    const halfYear = new Date(now.getTime() - (365 / 2) * 24 * 60 * 60 * 1000);
    const score = normalizeRecency(halfYear, now);
    assert.ok(Math.abs(score - 0.5) < 0.01, `Expected ~0.5, got ${score}`);
  });

  it('returns 0 for very old documents', () => {
    const now = new Date();
    const twoYearsAgo = new Date(now.getTime() - 730 * 24 * 60 * 60 * 1000);
    assert.strictEqual(normalizeRecency(twoYearsAgo, now), 0);
  });
});

describe('computeScore', () => {
  it('returns similarity-dominated score with default weights', () => {
    const input: ScoringInput = {
      similarity: 0.8,
      accessCount: 0,
      maxAccess: 100,
      lastModified: new Date(),
      now: new Date(),
      queryMatchesTopic: false,
    };
    const result = computeScore(input);
    // 0.7 * 0.8 + 0.15 * 0 + 0.10 * 1.0 + 0.05 * 0 = 0.56 + 0 + 0.10 + 0 = 0.66
    assert.ok(Math.abs(result.score - 0.66) < 0.01, `Expected ~0.66, got ${result.score}`);
  });

  it('boosts score for hot chunks', () => {
    const base: ScoringInput = {
      similarity: 0.5,
      accessCount: 0,
      maxAccess: 100,
      lastModified: new Date(),
      now: new Date(),
      queryMatchesTopic: false,
    };
    const hot: ScoringInput = { ...base, accessCount: 100 };

    const baseResult = computeScore(base);
    const hotResult = computeScore(hot);
    assert.ok(hotResult.score > baseResult.score, 'Hot chunk should score higher');
  });

  it('includes breakdown in result', () => {
    const input: ScoringInput = {
      similarity: 0.9,
      accessCount: 50,
      maxAccess: 100,
      lastModified: new Date(),
      now: new Date(),
      queryMatchesTopic: true,
    };
    const result = computeScore(input);
    assert.ok('breakdown' in result);
    assert.ok('similarity' in result.breakdown);
    assert.ok('heat' in result.breakdown);
    assert.ok('recency' in result.breakdown);
    assert.ok('topic' in result.breakdown);
  });

  it('topic bonus adds to score when query matches topic', () => {
    const noMatch: ScoringInput = {
      similarity: 0.5,
      accessCount: 0,
      maxAccess: 0,
      lastModified: new Date(),
      now: new Date(),
      queryMatchesTopic: false,
    };
    const match: ScoringInput = { ...noMatch, queryMatchesTopic: true };

    const noMatchResult = computeScore(noMatch);
    const matchResult = computeScore(match);
    assert.ok(matchResult.score > noMatchResult.score);
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
npm run build 2>&1 | tail -5
```

Expected: Compile error — `scoring.js` doesn't exist yet.

**Step 3: Write the implementation**

Create `src/scoring.ts`:

```typescript
export interface ScoringInput {
  similarity: number;       // 0–1 cosine similarity
  accessCount: number;      // raw access count for this chunk
  maxAccess: number;        // max access count across all project chunks
  lastModified: Date;       // when the chunk's source was last modified
  now: Date;                // current time (injected for testability)
  queryMatchesTopic: boolean; // whether query text contains the topic name
}

export interface ScoringResult {
  score: number;            // final composite score (0–1)
  breakdown: {
    similarity: number;     // weighted similarity component
    heat: number;           // weighted heat component
    recency: number;        // weighted recency component
    topic: number;          // weighted topic component
  };
}

const WEIGHTS = {
  similarity: 0.70,
  heat: 0.15,
  recency: 0.10,
  topic: 0.05,
};

const MAX_AGE_DAYS = 365;

/**
 * Normalize access count to 0–1 range relative to the most-accessed chunk.
 */
export function normalizeHeat(accessCount: number, maxAccess: number): number {
  if (maxAccess <= 0) return 0;
  return Math.min(accessCount / maxAccess, 1);
}

/**
 * Normalize document recency to 0–1 range.
 * 1 = just modified, 0 = older than MAX_AGE_DAYS.
 */
export function normalizeRecency(lastModified: Date, now: Date): number {
  const daysSince = (now.getTime() - lastModified.getTime()) / (24 * 60 * 60 * 1000);
  return Math.max(0, Math.min(1, 1 - daysSince / MAX_AGE_DAYS));
}

/**
 * Compute composite score from multiple signals.
 * Returns the final score and a breakdown of each component.
 */
export function computeScore(input: ScoringInput): ScoringResult {
  const heatNorm = normalizeHeat(input.accessCount, input.maxAccess);
  const recencyNorm = normalizeRecency(input.lastModified, input.now);
  const topicBonus = input.queryMatchesTopic ? 1 : 0;

  const breakdown = {
    similarity: WEIGHTS.similarity * input.similarity,
    heat: WEIGHTS.heat * heatNorm,
    recency: WEIGHTS.recency * recencyNorm,
    topic: WEIGHTS.topic * topicBonus,
  };

  const score = breakdown.similarity + breakdown.heat + breakdown.recency + breakdown.topic;

  return {
    score: Math.round(score * 1000) / 1000,
    breakdown: {
      similarity: Math.round(breakdown.similarity * 1000) / 1000,
      heat: Math.round(breakdown.heat * 1000) / 1000,
      recency: Math.round(breakdown.recency * 1000) / 1000,
      topic: Math.round(breakdown.topic * 1000) / 1000,
    },
  };
}
```

**Step 4: Run tests to verify they pass**

```bash
npm run build && node --test dist/scoring.test.js
```

Expected: All 10 tests pass.

**Step 5: Commit**

```bash
git add src/scoring.ts src/scoring.test.ts
git commit -m "Add composite scoring module with heat, recency, and topic signals"
```

---

### Task 2: Upgrade `docmem_search` with composite scoring + explainable traces

Replace pure cosine ranking with composite scoring. Return a `score_breakdown` in each result so agents can understand why results ranked the way they did.

**Files:**
- Modify: `src/server.ts`

**Step 1: Add import**

At the top of `src/server.ts`, add:

```typescript
import { computeScore } from './scoring.js';
```

**Step 2: Rewrite the `docmem_search` handler**

Replace the existing handler (lines 23-86) with this version that:
1. Fetches access stats in the same query (LEFT JOIN)
2. Gets max access count for the project
3. Computes composite scores for each result
4. Re-ranks by composite score
5. Returns breakdown with each result

```typescript
  async ({ project, query, max_results, topic }) => {
    const projResult = await pool.query(
      'SELECT id FROM docmem.projects WHERE name = $1',
      [project]
    );
    if (projResult.rows.length === 0) {
      return { content: [{ type: 'text' as const, text: `Project "${project}" not found. Run "docmem index" first.` }] };
    }
    const projectId = projResult.rows[0].id;

    // Generate embedding for the query
    const queryEmbedding = await embedQuery(query);
    const embeddingStr = `[${queryEmbedding.join(',')}]`;

    // Get max access count for normalization
    const maxAccessResult = await pool.query(
      `SELECT COALESCE(MAX(a.access_count), 0) AS max_access
       FROM docmem.access_stats a
       JOIN docmem.chunks c ON c.id = a.chunk_id
       WHERE c.project_id = $1`,
      [projectId]
    );
    const maxAccess = parseInt(maxAccessResult.rows[0].max_access) || 0;

    // Fetch more candidates than needed so composite re-ranking has room to work
    const candidateLimit = Math.max((max_results ?? 5) * 3, 15);

    let sql = `
      SELECT
        c.id,
        c.source_file,
        c.section_path,
        c.summary,
        c.topic,
        c.token_count,
        c.last_modified,
        1 - (c.embedding <=> $1::vector) AS similarity,
        COALESCE(a.access_count, 0) AS access_count
      FROM docmem.chunks c
      LEFT JOIN docmem.access_stats a ON a.chunk_id = c.id
      WHERE c.project_id = $2
    `;
    const params: unknown[] = [embeddingStr, projectId];
    let paramIdx = 3;

    if (topic) {
      sql += ` AND c.topic = $${paramIdx}`;
      params.push(topic);
      paramIdx++;
    }

    sql += ` ORDER BY c.embedding <=> $1::vector LIMIT $${paramIdx}`;
    params.push(candidateLimit);

    const results = await pool.query(sql, params);

    if (results.rows.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No results found.' }] };
    }

    const now = new Date();
    const queryLower = query.toLowerCase();

    // Score and re-rank
    const scored = results.rows.map(row => {
      const { score, breakdown } = computeScore({
        similarity: parseFloat(row.similarity),
        accessCount: parseInt(row.access_count),
        maxAccess,
        lastModified: new Date(row.last_modified),
        now,
        queryMatchesTopic: queryLower.includes(row.topic.split('/').pop()?.toLowerCase() ?? ''),
      });

      return { row, score, breakdown };
    });

    scored.sort((a, b) => b.score - a.score);

    const output = scored.slice(0, max_results ?? 5).map((s, i) => ({
      rank: i + 1,
      chunk_id: s.row.id,
      source_file: s.row.source_file,
      section_path: s.row.section_path,
      topic: s.row.topic,
      token_count: s.row.token_count,
      score: s.score,
      score_breakdown: s.breakdown,
      similarity: Math.round(parseFloat(s.row.similarity) * 1000) / 1000,
      summary: s.row.summary || `[${s.row.section_path}] (${s.row.token_count} tokens)`,
    }));

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(output, null, 2),
      }],
    };
  }
```

**Step 3: Build and verify**

```bash
npm run build
```

Expected: Compiles with no errors.

**Step 4: Commit**

```bash
git add src/server.ts
git commit -m "Upgrade search to composite scoring with explainable traces"
```

---

### Task 3: `docmem_index` MCP tool

Let agents trigger reindexing without the CLI. Calls the existing `indexProject()` function.

**Files:**
- Modify: `src/server.ts`

**Step 1: Add import**

At the top of `src/server.ts`, add:

```typescript
import { indexProject } from './indexer/index-project.js';
```

**Step 2: Add the tool registration**

Add after `docmem_related` in `src/server.ts`:

```typescript
server.registerTool(
  'docmem_index',
  {
    description: 'Reindex a project\'s documentation. Use when you know docs have changed or when search results seem stale. Returns indexing stats.',
    inputSchema: {
      project_path: z.string().describe('Absolute path to the project root (must contain .docmem.json)'),
    },
  },
  async ({ project_path }) => {
    try {
      const result = await indexProject(project_path);
      const output = {
        status: 'ok',
        ...result,
      };
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(output, null, 2),
        }],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ status: 'error', message }, null, 2),
        }],
      };
    }
  }
);
```

**Step 3: Build and verify**

```bash
npm run build
```

Expected: Compiles with no errors.

**Step 4: Commit**

```bash
git add src/server.ts
git commit -m "Add docmem_index MCP tool for agent-triggered reindexing"
```

---

### Task 4: Staleness detection in `docmem_list_topics`

Enhance `list_topics` to check whether source files have been modified since their chunks were last indexed. Reports a `stale_chunks` count per topic so agents know when to reindex.

**Files:**
- Modify: `src/server.ts`

**Step 1: Update the `docmem_list_topics` handler**

Replace the existing handler with a version that:
1. Fetches the project's `root_path` from the projects table
2. For each chunk, checks if the source file's mtime is newer than `last_modified`
3. Aggregates stale_chunks count per topic

```typescript
  async ({ project }) => {
    const projResult = await pool.query(
      'SELECT id, root_path FROM docmem.projects WHERE name = $1',
      [project]
    );
    if (projResult.rows.length === 0) {
      return { content: [{ type: 'text' as const, text: `Project "${project}" not found.` }] };
    }
    const projectId = projResult.rows[0].id;
    const rootPath = projResult.rows[0].root_path;

    const result = await pool.query(
      `SELECT
        c.topic,
        c.source_file,
        c.last_modified,
        COUNT(*) OVER (PARTITION BY c.topic) AS chunk_count,
        SUM(c.token_count) OVER (PARTITION BY c.topic) AS total_tokens,
        MAX(c.last_modified) OVER (PARTITION BY c.topic) AS topic_last_modified
      FROM docmem.chunks c
      WHERE c.project_id = $1
      ORDER BY c.topic, c.source_file`,
      [projectId]
    );

    // Check staleness by comparing file mtime to indexed last_modified
    const { statSync } = await import('fs');
    const { resolve } = await import('path');

    const topicStats = new Map<string, { chunk_count: number; total_tokens: number; last_modified: string; stale_chunks: number }>();

    for (const row of result.rows) {
      if (!topicStats.has(row.topic)) {
        topicStats.set(row.topic, {
          chunk_count: parseInt(row.chunk_count),
          total_tokens: parseInt(row.total_tokens),
          last_modified: row.topic_last_modified,
          stale_chunks: 0,
        });
      }

      // Check if source file is newer than indexed version
      try {
        const absPath = resolve(rootPath, row.source_file);
        const stat = statSync(absPath);
        if (stat.mtime > new Date(row.last_modified)) {
          topicStats.get(row.topic)!.stale_chunks++;
        }
      } catch {
        // File may have been deleted — counts as stale
        topicStats.get(row.topic)!.stale_chunks++;
      }
    }

    const output = [...topicStats.entries()].map(([topic, stats]) => ({
      topic,
      ...stats,
    }));

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(output, null, 2),
      }],
    };
  }
```

**Step 2: Build and verify**

```bash
npm run build
```

Expected: Compiles with no errors.

**Step 3: Commit**

```bash
git add src/server.ts
git commit -m "Add staleness detection to list_topics"
```

---

### Task 5: Verify end-to-end

Run all tests and verify the upgraded tools work correctly.

**Step 1: Run all tests**

```bash
npm run build && node --test dist/**/*.test.js
```

Expected: All tests pass (chunker: 6, entity-extractor: 10, link-extractor: 9, scoring: 10 = 35 total).

**Step 2: Test composite search**

Use the MCP connection to call:
```
docmem_search({ project: "boost-api", query: "automation targets stuck in running" })
```

Expected: Results now include `score`, `score_breakdown` (with similarity, heat, recency, topic components), and results may be re-ranked vs pure cosine order.

**Step 3: Test staleness detection**

Call `docmem_list_topics({ project: "boost-api" })` and verify the response includes `stale_chunks` for each topic.

**Step 4: Test agent-triggered reindex**

Call `docmem_index({ project_path: "/Users/ceich/Code/boost-api" })` and verify it returns indexing stats.

**Step 5: Commit plan**

```bash
git add -f docs/plans/2026-03-17-docmem-phase3-plan.md
git commit -m "Add Phase 3 implementation plan"
```

---

## Summary

| Task | What | New/Modified Files |
|------|------|--------------------|
| 1 | Composite scoring module + tests | Create: `scoring.ts`, `scoring.test.ts` |
| 2 | Upgrade search with scoring + traces | Modify: `server.ts` |
| 3 | `docmem_index` MCP tool | Modify: `server.ts` |
| 4 | Staleness detection in list_topics | Modify: `server.ts` |
| 5 | Verify all tools | No files — verification only |

**After Phase 3, search results look like:**
```json
{
  "rank": 1,
  "chunk_id": "abc-123",
  "score": 0.72,
  "score_breakdown": {
    "similarity": 0.56,
    "heat": 0.075,
    "recency": 0.08,
    "topic": 0.005
  },
  "similarity": 0.8,
  "source_file": "docs/features/automations.md",
  "section_path": "Automations > Guard Pattern"
}
```
