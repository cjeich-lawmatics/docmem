# DocMem Phase 4: Cross-Project Search, Feedback Loop & Distribution

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable cross-project search so agents can find related documentation across all indexed repos, add a usefulness feedback signal to improve scoring over time, add a `reindex-all` CLI command, and package for npm distribution.

**Architecture:** Cross-project search uses `project: "*"` as a wildcard convention. The feedback loop adds a `docmem_feedback` tool that records usefulness scores on chunks, which the composite scorer already supports via `avg_usefulness` in `access_stats`. The CLI gains a `reindex-all` command that iterates all known projects. npm packaging adds a `postinstall` migration hook and a proper bin entry.

**Tech Stack:** TypeScript, PostgreSQL (existing docmem schema), node:test, npm packaging

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

**Database:** Postgres 16 + pgvector on port 5433. Schema `docmem`. 7 projects indexed, 780 chunks.

**Current search (server.ts):** Scoped to a single project via `WHERE c.project_id = $2`. Uses composite scoring (similarity + heat + recency + topic).

**Existing access_stats table:** Has `avg_usefulness FLOAT DEFAULT 0.5` column — already in the schema but never written to.

**Existing files you'll touch:**
- `src/server.ts` — MCP server with 7 tools
- `src/scoring.ts` — composite scoring module
- `src/scoring.test.ts` — scoring tests
- `src/cli.ts` — CLI entry point
- `package.json` — npm packaging

---

### Task 1: Cross-project search (`project: "*"`)

When an agent passes `project: "*"`, search across ALL indexed projects. This is the correlation feature — finding related docs across boost-api, boost-client, lm-pdf-service, etc.

**Files:**
- Modify: `src/server.ts`

**Step 1: Update the `docmem_search` inputSchema description**

Change the `project` field description to indicate the wildcard:

```typescript
project: z.string().describe('Project name (e.g., "boost-api") or "*" to search all projects'),
```

**Step 2: Update the handler to support wildcard**

In the `docmem_search` handler, replace the project lookup and query construction to handle `"*"`:

The key changes are:
1. When `project === "*"`, skip the project lookup and don't filter by `project_id`
2. The maxAccess query should span all projects
3. The main query should omit the `project_id` filter
4. Include project name in results so the agent knows which project each result comes from

Replace the handler's project lookup and SQL construction (approximately the first 80 lines of the handler) with:

```typescript
  async ({ project, query, max_results, topic }) => {
    let projectId: string | null = null;

    if (project !== '*') {
      const projResult = await pool.query(
        'SELECT id FROM docmem.projects WHERE name = $1',
        [project]
      );
      if (projResult.rows.length === 0) {
        return { content: [{ type: 'text' as const, text: `Project "${project}" not found. Run "docmem index" first.` }] };
      }
      projectId = projResult.rows[0].id;
    }

    // Generate embedding for the query
    const queryEmbedding = await embedQuery(query);
    const embeddingStr = `[${queryEmbedding.join(',')}]`;

    // Get max access count for normalization
    let maxAccessSql = `SELECT COALESCE(MAX(a.access_count), 0) AS max_access
       FROM docmem.access_stats a
       JOIN docmem.chunks c ON c.id = a.chunk_id`;
    const maxAccessParams: unknown[] = [];
    if (projectId) {
      maxAccessSql += ` WHERE c.project_id = $1`;
      maxAccessParams.push(projectId);
    }
    const maxAccessResult = await pool.query(maxAccessSql, maxAccessParams);
    const maxAccess = parseInt(maxAccessResult.rows[0].max_access) || 0;

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
        p.name AS project_name,
        1 - (c.embedding <=> $1::vector) AS similarity,
        COALESCE(a.access_count, 0) AS access_count
      FROM docmem.chunks c
      LEFT JOIN docmem.access_stats a ON a.chunk_id = c.id
      JOIN docmem.projects p ON p.id = c.project_id
    `;
    const params: unknown[] = [embeddingStr];
    let paramIdx = 2;

    if (projectId) {
      sql += ` WHERE c.project_id = $${paramIdx}`;
      params.push(projectId);
      paramIdx++;
    } else {
      sql += ` WHERE 1=1`;
    }

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
      project: s.row.project_name,
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

Note: The output now always includes a `project` field (the project name). This is useful for both single-project and cross-project searches.

**Step 3: Build and verify**

```bash
npm run build
```

Expected: Compiles with no errors.

**Step 4: Commit**

```bash
git add src/server.ts
git commit -m "Add cross-project search with project wildcard"
```

---

### Task 2: Usefulness feedback tool

Add a `docmem_feedback` MCP tool that lets agents record whether a loaded chunk was actually useful. Updates the `avg_usefulness` column in `access_stats` using a running average.

**Files:**
- Modify: `src/server.ts`

**Step 1: Add the tool registration**

Add after `docmem_index` in `src/server.ts`:

```typescript
server.registerTool(
  'docmem_feedback',
  {
    description: 'Record whether a loaded chunk was useful. Helps improve future search ranking. Call after using a chunk\'s content.',
    inputSchema: {
      chunk_id: z.string().describe('The chunk ID to give feedback on'),
      useful: z.boolean().describe('Whether the chunk content was useful for your task'),
    },
  },
  async ({ chunk_id, useful }) => {
    const score = useful ? 1.0 : 0.0;

    // Update running average: new_avg = old_avg + (score - old_avg) / count
    const result = await pool.query(
      `INSERT INTO docmem.access_stats (chunk_id, access_count, last_accessed, avg_usefulness)
       VALUES ($1, 0, NOW(), $2)
       ON CONFLICT (chunk_id) DO UPDATE SET
         avg_usefulness = docmem.access_stats.avg_usefulness +
           ($2 - docmem.access_stats.avg_usefulness) / (docmem.access_stats.access_count + 1),
         last_accessed = NOW()
       RETURNING avg_usefulness, access_count`,
      [chunk_id, score]
    );

    if (result.rows.length === 0) {
      return { content: [{ type: 'text' as const, text: `Chunk "${chunk_id}" not found.` }] };
    }

    const row = result.rows[0];
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          status: 'recorded',
          chunk_id,
          useful,
          avg_usefulness: Math.round(parseFloat(row.avg_usefulness) * 100) / 100,
        }, null, 2),
      }],
    };
  }
);
```

**Step 2: Build and verify**

```bash
npm run build
```

**Step 3: Commit**

```bash
git add src/server.ts
git commit -m "Add docmem_feedback tool for usefulness signal"
```

---

### Task 3: Integrate usefulness into composite scoring

Now that we have a feedback signal, incorporate `avg_usefulness` into the search scoring. The `access_stats` table already has this column — we just need to fetch it and use it.

**Files:**
- Modify: `src/scoring.ts`
- Modify: `src/scoring.test.ts`
- Modify: `src/server.ts`

**Step 1: Update the ScoringInput interface and weights**

In `src/scoring.ts`, add `usefulness` to the input and adjust weights:

```typescript
export interface ScoringInput {
  similarity: number;
  accessCount: number;
  maxAccess: number;
  lastModified: Date;
  now: Date;
  queryMatchesTopic: boolean;
  usefulness: number;          // 0–1 avg usefulness from feedback (default 0.5)
}

const WEIGHTS = {
  similarity: 0.65,
  heat: 0.10,
  recency: 0.10,
  topic: 0.05,
  usefulness: 0.10,
};
```

**Step 2: Update computeScore**

Add the usefulness component to the breakdown and score:

```typescript
export function computeScore(input: ScoringInput): ScoringResult {
  const heatNorm = normalizeHeat(input.accessCount, input.maxAccess);
  const recencyNorm = normalizeRecency(input.lastModified, input.now);
  const topicBonus = input.queryMatchesTopic ? 1 : 0;

  const breakdown = {
    similarity: WEIGHTS.similarity * input.similarity,
    heat: WEIGHTS.heat * heatNorm,
    recency: WEIGHTS.recency * recencyNorm,
    topic: WEIGHTS.topic * topicBonus,
    usefulness: WEIGHTS.usefulness * input.usefulness,
  };

  const score = breakdown.similarity + breakdown.heat + breakdown.recency + breakdown.topic + breakdown.usefulness;

  return {
    score: Math.round(score * 1000) / 1000,
    breakdown: {
      similarity: Math.round(breakdown.similarity * 1000) / 1000,
      heat: Math.round(breakdown.heat * 1000) / 1000,
      recency: Math.round(breakdown.recency * 1000) / 1000,
      topic: Math.round(breakdown.topic * 1000) / 1000,
      usefulness: Math.round(breakdown.usefulness * 1000) / 1000,
    },
  };
}
```

**Step 3: Update the ScoringResult interface**

Add `usefulness` to the breakdown type:

```typescript
export interface ScoringResult {
  score: number;
  breakdown: {
    similarity: number;
    heat: number;
    recency: number;
    topic: number;
    usefulness: number;
  };
}
```

**Step 4: Update existing tests**

All existing `computeScore` tests need `usefulness: 0.5` added to their input (the default). Update the expected values:

- "similarity-dominated score" test: `0.65 * 0.8 + 0.10 * 0 + 0.10 * 1.0 + 0.05 * 0 + 0.10 * 0.5 = 0.52 + 0 + 0.10 + 0 + 0.05 = 0.67`
- Update the assertion accordingly

Add a new test:

```typescript
  it('usefulness signal boosts well-rated chunks', () => {
    const lowUse: ScoringInput = {
      similarity: 0.5,
      accessCount: 0,
      maxAccess: 0,
      lastModified: new Date(),
      now: new Date(),
      queryMatchesTopic: false,
      usefulness: 0.2,
    };
    const highUse: ScoringInput = { ...lowUse, usefulness: 0.9 };

    const lowResult = computeScore(lowUse);
    const highResult = computeScore(highUse);
    assert.ok(highResult.score > lowResult.score, 'High usefulness should score higher');
    assert.ok('usefulness' in highResult.breakdown);
  });
```

**Step 5: Update search handler in server.ts**

In the `docmem_search` handler, the SQL query already LEFT JOINs `access_stats`. Add `avg_usefulness` to the SELECT:

```sql
COALESCE(a.avg_usefulness, 0.5) AS avg_usefulness
```

And pass it to `computeScore`:

```typescript
usefulness: parseFloat(row.avg_usefulness),
```

**Step 6: Build and run tests**

```bash
npm run build && node --test dist/**/*.test.js
```

Expected: All tests pass (updated existing + 1 new).

**Step 7: Commit**

```bash
git add src/scoring.ts src/scoring.test.ts src/server.ts
git commit -m "Integrate usefulness feedback into composite scoring"
```

---

### Task 4: `reindex-all` CLI command

Add a CLI command that reindexes all known projects. Useful for keeping everything fresh after a doc update.

**Files:**
- Modify: `src/cli.ts`

**Step 1: Update the CLI switch**

Replace the CLI's `main()` function:

```typescript
async function main() {
  switch (command) {
    case 'index': {
      const projectRoot = args[1] || process.cwd();
      await indexProject(projectRoot);
      break;
    }
    case 'reindex-all': {
      const projects = await pool.query('SELECT name, root_path FROM docmem.projects ORDER BY name');
      if (projects.rows.length === 0) {
        console.log('No projects indexed yet. Use "docmem index <path>" first.');
        break;
      }
      console.log(`Reindexing ${projects.rows.length} projects...\n`);
      for (const row of projects.rows) {
        console.log(`--- ${row.name} (${row.root_path}) ---`);
        try {
          await indexProject(row.root_path);
        } catch (err) {
          console.error(`  Failed: ${err instanceof Error ? err.message : err}`);
        }
        console.log('');
      }
      console.log('All projects reindexed.');
      break;
    }
    default:
      console.log('Usage: docmem <command>');
      console.log('');
      console.log('Commands:');
      console.log('  index [path]     Index a project (defaults to current directory)');
      console.log('  reindex-all      Reindex all known projects');
      break;
  }
  await pool.end();
}
```

**Step 2: Build and verify**

```bash
npm run build && node dist/cli.js --help
```

Expected: Shows both commands.

**Step 3: Commit**

```bash
git add src/cli.ts
git commit -m "Add reindex-all CLI command"
```

---

### Task 5: npm packaging

Make docmem installable via `npm install -g docmem` (from local path for now). Add proper bin entries, a postinstall migration script, and bump version.

**Files:**
- Modify: `package.json`
- Create: `src/postinstall.ts`

**Step 1: Update package.json**

```json
{
  "name": "docmem",
  "version": "0.2.0",
  "description": "Token-efficient documentation retrieval MCP server",
  "type": "module",
  "main": "dist/index.js",
  "bin": {
    "docmem": "dist/cli.js"
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "start": "node dist/server.js",
    "cli": "node dist/cli.js",
    "db:migrate": "node dist/db/migrate.js",
    "postinstall": "node dist/db/migrate.js 2>/dev/null || true"
  },
  "files": [
    "dist/**/*.js",
    "dist/**/*.d.ts"
  ],
  "engines": {
    "node": ">=20"
  },
  "dependencies": {
    "@huggingface/transformers": "^3.8.1",
    "@modelcontextprotocol/sdk": "^1.27.1",
    "pg": "^8.20.0",
    "zod": "^4.3.6"
  },
  "devDependencies": {
    "@types/node": "^25.4.0",
    "@types/pg": "^8.18.0",
    "typescript": "^5.9.3"
  }
}
```

Key changes:
- Version bumped to `0.2.0`
- Added `files` array so only dist is published
- Added `postinstall` script that runs migration silently (fails gracefully if no DB)

**Step 2: Build and test local install**

```bash
npm run build
npm pack  # Creates docmem-0.2.0.tgz
```

Verify the tarball contains only dist files:
```bash
tar -tzf docmem-0.2.0.tgz | head -20
```

**Step 3: Test global install from local tarball**

```bash
npm install -g ./docmem-0.2.0.tgz
docmem --help
```

Expected: Shows usage with both commands. Clean up:
```bash
npm uninstall -g docmem
rm docmem-0.2.0.tgz
```

**Step 4: Commit**

```bash
git add package.json
git commit -m "Package for npm distribution (v0.2.0)"
```

---

### Task 6: Verify end-to-end

**Step 1: Run all tests**

```bash
npm run build && node --test dist/**/*.test.js
```

Expected: All tests pass.

**Step 2: Test cross-project search**

```bash
echo "Search across all projects for 'PDF generation'" | docmem
# Or via MCP: docmem_search({ project: "*", query: "PDF generation" })
```

Verify via database query:
```bash
PGPASSWORD=docmem psql -h localhost -p 5433 -U docmem -d docmem -c "
SELECT p.name, c.section_path, c.topic
FROM docmem.chunks c
JOIN docmem.projects p ON p.id = c.project_id
ORDER BY c.embedding <=> (SELECT embedding FROM docmem.chunks LIMIT 1)
LIMIT 5;"
```

Expected: Results from multiple projects.

**Step 3: Test reindex-all**

```bash
node dist/cli.js reindex-all
```

Expected: Iterates all 7 projects, reindexes each.

**Step 4: Commit plan**

```bash
git add -f docs/plans/2026-03-17-docmem-phase4-plan.md
git commit -m "Add Phase 4 implementation plan"
```

---

## Summary

| Task | What | New/Modified Files |
|------|------|--------------------|
| 1 | Cross-project search (`project: "*"`) | Modify: `server.ts` |
| 2 | `docmem_feedback` tool | Modify: `server.ts` |
| 3 | Usefulness signal in scoring | Modify: `scoring.ts`, `scoring.test.ts`, `server.ts` |
| 4 | `reindex-all` CLI command | Modify: `cli.ts` |
| 5 | npm packaging (v0.2.0) | Modify: `package.json` |
| 6 | Verify end-to-end | No files — verification only |

**After Phase 4, the full tool suite:**
```
docmem_search       — semantic search (single or cross-project) with composite scoring
docmem_load_chunk   — load content + entities + related_count
docmem_list_topics  — topic discovery with staleness detection
docmem_overview     — topic section browser with access stats
docmem_related      — relationship traversal
docmem_index        — agent-triggered reindexing
docmem_feedback     — usefulness signal for scoring improvement
```
