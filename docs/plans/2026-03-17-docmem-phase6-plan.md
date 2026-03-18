# DocMem Phase 6: Branch-Scoped Indexing, Docker Packaging & Team Mode

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make DocMem team-ready with branch-aware indexing (feature branch docs layer over master), automatic merge detection, Docker packaging for shared deployment, and multi-user shared database mode.

**Architecture:** Every chunk is tagged with its branch origin and a `merged` flag. Feature branch docs overlay master — search returns merged (stable) docs by default, with opt-in to include unmerged branch docs. When a branch merges to master, its chunks are auto-promoted via `git branch --merged`. The entire stack (Postgres + MCP server) is packaged as a Docker Compose service. A shared DB mode lets the team point their local MCP servers at a central Postgres instance.

**Tech Stack:** TypeScript, PostgreSQL (pgvector), Docker, docker-compose, child_process for git

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

**Database:** Postgres 16 + pgvector on port 5433 (local Docker). Schema `docmem`.

**Current indexing (index-project.ts):** No branch awareness. Chunks are keyed by `source_file::section_path`. Re-indexing from a different branch silently overwrites the previous branch's content.

**Current docker-compose.yml:** Only has Postgres. No Dockerfile for the DocMem app itself.

**Existing files you'll touch:**
- `src/db/migrate.ts` — schema
- `src/indexer/index-project.ts` — indexing pipeline
- `src/server.ts` — MCP server (search handler, list_topics)
- `src/cli.ts` — CLI commands
- `docker-compose.yml` — Docker services
- `package.json` — scripts

**New files you'll create:**
- `src/branch-manager.ts` — branch detection and merge tracking
- `src/branch-manager.test.ts` — tests
- `Dockerfile` — app container image
- `.dockerignore` — build exclusions

---

### Task 1: Database migration — branch columns

Add `branch` and `merged` columns to the chunks table. Chunks from master are always `merged = true`. Feature branch chunks start as `merged = false` and get promoted on merge.

**Files:**
- Modify: `src/db/migrate.ts`

**Step 1: Add branch columns to the migration**

Append to the MIGRATION string (before the closing backtick):

```sql
-- Branch-scoped indexing
ALTER TABLE docmem.chunks ADD COLUMN IF NOT EXISTS branch TEXT DEFAULT 'master';
ALTER TABLE docmem.chunks ADD COLUMN IF NOT EXISTS merged BOOLEAN DEFAULT true;
CREATE INDEX IF NOT EXISTS idx_chunks_branch ON docmem.chunks (branch);
CREATE INDEX IF NOT EXISTS idx_chunks_merged ON docmem.chunks (merged);

-- Update unique constraint: same file+section can exist on different branches
-- Drop the implicit uniqueness from the existing data model and add branch to the key
-- (This is handled by the indexer's checksum-based diffing, not a DB constraint)
```

**Step 2: Build and run migration**

```bash
npm run build && npm run db:migrate
```

**Step 3: Commit**

```bash
git add src/db/migrate.ts
git commit -m "Add branch and merged columns to chunks table"
```

---

### Task 2: Branch manager module + tests

Detects the current git branch, determines if a branch has been merged to master, and promotes chunks on merge.

**Files:**
- Create: `src/branch-manager.ts`
- Create: `src/branch-manager.test.ts`

**Step 1: Write tests**

Create `src/branch-manager.test.ts`:

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { isMainBranch, normalizeBranchName } from './branch-manager.js';

describe('isMainBranch', () => {
  it('returns true for master', () => {
    assert.strictEqual(isMainBranch('master'), true);
  });

  it('returns true for main', () => {
    assert.strictEqual(isMainBranch('main'), true);
  });

  it('returns false for feature branches', () => {
    assert.strictEqual(isMainBranch('feature/billing'), false);
  });

  it('returns false for develop', () => {
    assert.strictEqual(isMainBranch('develop'), false);
  });
});

describe('normalizeBranchName', () => {
  it('trims whitespace and newlines', () => {
    assert.strictEqual(normalizeBranchName('  master\n'), 'master');
  });

  it('handles refs/heads/ prefix', () => {
    assert.strictEqual(normalizeBranchName('refs/heads/feature/foo'), 'feature/foo');
  });

  it('returns input as-is when clean', () => {
    assert.strictEqual(normalizeBranchName('feature/billing'), 'feature/billing');
  });

  it('handles detached HEAD (empty)', () => {
    assert.strictEqual(normalizeBranchName(''), 'detached');
  });
});
```

**Step 2: Write implementation**

Create `src/branch-manager.ts`:

```typescript
import { execSync } from 'child_process';
import { pool } from './db/pool.js';

const MAIN_BRANCHES = new Set(['master', 'main']);

/**
 * Check if a branch name is a main/trunk branch.
 */
export function isMainBranch(branch: string): boolean {
  return MAIN_BRANCHES.has(branch);
}

/**
 * Normalize a branch name: trim, strip refs/heads/ prefix.
 */
export function normalizeBranchName(raw: string): string {
  const trimmed = raw.trim().replace(/^refs\/heads\//, '');
  return trimmed || 'detached';
}

/**
 * Detect the current git branch for a repository.
 */
export function detectBranch(rootPath: string): string {
  try {
    const output = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: rootPath,
      encoding: 'utf-8',
      timeout: 5000,
    });
    return normalizeBranchName(output);
  } catch {
    return 'unknown';
  }
}

/**
 * Get list of branches that have been merged into the main branch.
 */
export function getMergedBranches(rootPath: string): string[] {
  try {
    // Try master first, then main
    let mainBranch = 'master';
    try {
      execSync('git rev-parse --verify master', { cwd: rootPath, encoding: 'utf-8', timeout: 5000 });
    } catch {
      mainBranch = 'main';
    }

    const output = execSync(`git branch --merged ${mainBranch}`, {
      cwd: rootPath,
      encoding: 'utf-8',
      timeout: 5000,
    });

    return output
      .split('\n')
      .map(line => line.replace(/^\*?\s+/, '').trim())
      .filter(name => name && !isMainBranch(name));
  } catch {
    return [];
  }
}

/**
 * Promote chunks from a merged branch: set merged = true.
 * Returns the number of chunks promoted.
 */
export async function promoteMergedBranches(projectId: string, rootPath: string): Promise<number> {
  const mergedBranches = getMergedBranches(rootPath);
  if (mergedBranches.length === 0) return 0;

  const result = await pool.query(
    `UPDATE docmem.chunks
     SET merged = true
     WHERE project_id = $1
       AND branch = ANY($2)
       AND merged = false
     RETURNING id`,
    [projectId, mergedBranches]
  );

  return result.rowCount ?? 0;
}

/**
 * Clean up chunks from branches that no longer exist in the remote.
 * Returns the number of chunks removed.
 */
export async function cleanupDeletedBranches(projectId: string, rootPath: string): Promise<number> {
  try {
    // Get all remote branches
    const output = execSync('git branch -r', {
      cwd: rootPath,
      encoding: 'utf-8',
      timeout: 5000,
    });
    const remoteBranches = new Set(
      output.split('\n')
        .map(line => line.trim().replace(/^origin\//, ''))
        .filter(Boolean)
    );

    // Add main branches (always valid)
    remoteBranches.add('master');
    remoteBranches.add('main');

    // Find indexed branches that no longer exist
    const indexed = await pool.query(
      `SELECT DISTINCT branch FROM docmem.chunks WHERE project_id = $1 AND merged = false`,
      [projectId]
    );

    const stale = indexed.rows
      .map(r => r.branch)
      .filter(b => !remoteBranches.has(b));

    if (stale.length === 0) return 0;

    const result = await pool.query(
      `DELETE FROM docmem.chunks WHERE project_id = $1 AND branch = ANY($2) AND merged = false RETURNING id`,
      [projectId, stale]
    );

    return result.rowCount ?? 0;
  } catch {
    return 0;
  }
}
```

**Step 3: Build and run tests**

```bash
npm run build && node --test dist/branch-manager.test.js
```

Expected: 8 tests pass.

**Step 4: Commit**

```bash
git add src/branch-manager.ts src/branch-manager.test.ts
git commit -m "Add branch manager with merge detection and cleanup"
```

---

### Task 3: Branch-aware indexing pipeline

Update the indexer to detect the current branch, tag chunks with it, and handle the overlay model (branch chunks keyed separately from master).

**Files:**
- Modify: `src/indexer/index-project.ts`

**Step 1: Add imports**

```typescript
import { detectBranch, isMainBranch, promoteMergedBranches, cleanupDeletedBranches } from '../branch-manager.js';
```

**Step 2: Detect branch after config load**

After `const projectId = await ensureProject(...)`, add:

```typescript
  const branch = detectBranch(absRoot);
  const merged = isMainBranch(branch);
  console.log(`Branch: ${branch} (${merged ? 'main' : 'feature'})`);
```

**Step 3: Update chunk keying to include branch**

The existing chunk dedup key is `source_file::section_path`. Change it to include branch so the same file on different branches doesn't collide:

```typescript
// Change all key constructions from:
const key = `${chunk.sourceFile}::${chunk.sectionPath}`;
// To:
const key = `${branch}::${chunk.sourceFile}::${chunk.sectionPath}`;
```

And update the existing chunks query to filter by branch:

```typescript
  const existing = await pool.query(
    'SELECT id, source_file, section_path, checksum FROM docmem.chunks WHERE project_id = $1 AND branch = $2',
    [projectId, branch]
  );
  const existingMap = new Map<string, { id: string; checksum: string }>();
  for (const row of existing.rows) {
    existingMap.set(`${branch}::${row.source_file}::${row.section_path}`, { id: row.id, checksum: row.checksum });
  }
```

**Step 4: Set branch and merged on insert/update**

In the INSERT statement, add `branch` and `merged` columns:

```sql
INSERT INTO docmem.chunks (project_id, source_file, section_path, content, summary, embedding, token_count, topic, checksum, last_modified, search_vector, branch, merged)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, to_tsvector('english', $4), $11, $12)
```

With params: `[..., branch, merged]`

In the UPDATE statement, also update branch and merged:

```sql
branch = $9, merged = $10
```

**Step 5: Add merge promotion and cleanup at the end**

After entity/relationship extraction and before the return, add:

```typescript
  // Promote chunks from branches that have been merged to master
  const promoted = await promoteMergedBranches(projectId, absRoot);
  if (promoted > 0) console.log(`Promoted ${promoted} chunks from merged branches`);

  // Clean up chunks from deleted branches
  const cleaned = await cleanupDeletedBranches(projectId, absRoot);
  if (cleaned > 0) console.log(`Cleaned up ${cleaned} chunks from deleted branches`);
```

**Step 6: Update orphan cleanup to be branch-scoped**

The orphan cleanup should only remove chunks from the CURRENT branch:

```typescript
  const currentKeys = new Set(allChunks.map(c => `${branch}::${c.sourceFile}::${c.sectionPath}`));
  const toRemove = [...existingMap.entries()]
    .filter(([key]) => !currentKeys.has(key))
    .map(([, val]) => val.id);
```

**Step 7: Build and verify**

```bash
npm run build
```

**Step 8: Commit**

```bash
git add src/indexer/index-project.ts
git commit -m "Add branch-aware indexing with overlay model"
```

---

### Task 4: Branch-scoped search

Update `docmem_search` to support branch filtering. Default: merged docs only. Opt-in to include feature branch docs.

**Files:**
- Modify: `src/server.ts`

**Step 1: Update search inputSchema**

Add two optional parameters:

```typescript
include_branches: z.boolean().optional().default(false).describe('Include unmerged feature branch docs (default: false, only searches merged/stable docs)'),
branch: z.string().optional().describe('Filter to a specific branch name (e.g., "feature/billing")'),
```

**Step 2: Update the search handler**

In the search handler, after the project lookup, add branch filtering to both the vector and BM25 SQL queries.

For the vector search SQL, add after the existing WHERE clauses:

```typescript
    if (!include_branches && !branch) {
      // Default: only merged docs
      vectorSql += ` AND c.merged = true`;
    } else if (branch) {
      // Specific branch: that branch's docs + merged master docs
      vectorSql += ` AND (c.branch = $${vIdx} OR c.merged = true)`;
      vectorParams.push(branch);
      vIdx++;
    }
    // include_branches = true: no filter, search everything
```

Apply the same logic to the BM25 SQL query.

And for the full data fetch query, add the same filter:

```typescript
    let mergeFilter = '';
    const mergeParams: unknown[] = [];
    if (!include_branches && !branch) {
      mergeFilter = ' AND c.merged = true';
    } else if (branch) {
      mergeFilter = ` AND (c.branch = $3 OR c.merged = true)`;
      mergeParams.push(branch);
    }
```

**Step 3: Add branch info to search output**

In the output mapping, add:

```typescript
branch: s.row.branch,
merged: s.row.merged,
```

(Ensure the full data fetch query also selects `c.branch` and `c.merged`.)

**Step 4: Build and verify**

```bash
npm run build
```

**Step 5: Commit**

```bash
git add src/server.ts
git commit -m "Add branch-scoped search with merged-only default"
```

---

### Task 5: Branch info in list_topics and overview

Show branch distribution in `list_topics` and mark branch origin in `overview`.

**Files:**
- Modify: `src/server.ts`

**Step 1: Update list_topics output**

In the `docmem_list_topics` handler, add branch stats to the topic aggregation. After the existing topicStats loop, add:

```typescript
      // Track branches per topic
      if (!topicStats.get(row.topic)!.branches) {
        topicStats.get(row.topic)!.branches = new Set();
      }
      topicStats.get(row.topic)!.branches.add(row.branch);
```

Update the query to also select `c.branch`:

```sql
c.branch
```

And in the output, convert the Set to an array:

```typescript
branches: [...stats.branches],
```

Update the topicStats type to include `branches: Set<string>`.

**Step 2: Update overview output**

In the `docmem_overview` handler, add `c.branch` and `c.merged` to the query SELECT, and include them in the sections output:

```typescript
branch: row.branch,
merged: row.merged,
```

**Step 3: Build and commit**

```bash
npm run build
git add src/server.ts
git commit -m "Add branch info to list_topics and overview"
```

---

### Task 6: `docmem promote` CLI command

Manual merge promotion command for when auto-detection isn't enough.

**Files:**
- Modify: `src/cli.ts`

**Step 1: Add promote command**

```typescript
    case 'promote': {
      const branchName = args[1];
      if (!branchName) {
        console.log('Usage: docmem promote <branch-name>');
        console.log('  Promotes all chunks from <branch-name> to merged status.');
        break;
      }
      const result = await pool.query(
        `UPDATE docmem.chunks SET merged = true WHERE branch = $1 AND merged = false RETURNING id`,
        [branchName]
      );
      console.log(`Promoted ${result.rowCount} chunks from branch "${branchName}".`);
      break;
    }
    case 'branches': {
      const branches = await pool.query(
        `SELECT branch, merged, COUNT(*) AS chunks, array_agg(DISTINCT p.name) AS projects
         FROM docmem.chunks c
         JOIN docmem.projects p ON p.id = c.project_id
         GROUP BY branch, merged
         ORDER BY branch`
      );
      if (branches.rows.length === 0) {
        console.log('No indexed branches.');
        break;
      }
      console.log('Branch                        Merged  Chunks  Projects');
      console.log('---                           ---     ---     ---');
      for (const row of branches.rows) {
        const branch = row.branch.padEnd(30);
        const merged = (row.merged ? 'yes' : 'no').padEnd(8);
        const chunks = String(row.chunks).padEnd(8);
        const projects = row.projects.join(', ');
        console.log(`${branch}${merged}${chunks}${projects}`);
      }
      break;
    }
```

Update the help text:

```typescript
      console.log('  promote <branch>  Promote a branch\'s chunks to merged status');
      console.log('  branches          List all indexed branches with chunk counts');
```

**Step 2: Build and verify**

```bash
npm run build && node dist/cli.js branches
```

**Step 3: Commit**

```bash
git add src/cli.ts
git commit -m "Add promote and branches CLI commands"
```

---

### Task 7: Dockerfile for DocMem app

Package the MCP server and CLI into a Docker image. The image runs the MCP server by default, or can run CLI commands.

**Files:**
- Create: `Dockerfile`
- Create: `.dockerignore`

**Step 1: Create .dockerignore**

```
node_modules
dist
.env
*.tgz
.git
docs
```

**Step 2: Create Dockerfile**

```dockerfile
FROM node:20-slim

WORKDIR /app

# Install git for branch detection and staleness checks
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

# Copy package files and install dependencies
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev

# Copy source and build
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Default: run MCP server on stdio
CMD ["node", "dist/server.js"]
```

**Step 3: Build and test the image**

```bash
docker build -t docmem:latest .
# Verify it starts (will fail to connect to DB but should load)
docker run --rm docmem:latest node dist/cli.js 2>&1 | head -5
```

**Step 4: Commit**

```bash
git add Dockerfile .dockerignore
git commit -m "Add Dockerfile for DocMem app"
```

---

### Task 8: Team docker-compose with shared DB

Update docker-compose.yml to include both Postgres and a utility service for running CLI commands. The Postgres instance becomes the shared team DB.

**Files:**
- Modify: `docker-compose.yml`

**Step 1: Rewrite docker-compose.yml**

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg16
    restart: unless-stopped
    environment:
      POSTGRES_USER: docmem
      POSTGRES_PASSWORD: ${DOCMEM_DB_PASSWORD:-docmem}
      POSTGRES_DB: docmem
    ports:
      - '${DOCMEM_DB_PORT:-5433}:5432'
    volumes:
      - docmem-pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U docmem']
      interval: 2s
      timeout: 5s
      retries: 10

  # Utility service for running CLI commands (index, reindex-all, migrate, etc.)
  cli:
    build: .
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      DATABASE_URL: postgresql://docmem:${DOCMEM_DB_PASSWORD:-docmem}@postgres:5432/docmem
    volumes:
      # Mount project directories for indexing
      - ${HOME}/Code:/repos:ro
    entrypoint: ["node", "dist/cli.js"]
    profiles:
      - tools

  # Run database migrations
  migrate:
    build: .
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      DATABASE_URL: postgresql://docmem:${DOCMEM_DB_PASSWORD:-docmem}@postgres:5432/docmem
    entrypoint: ["node", "dist/db/migrate.js"]
    profiles:
      - tools

volumes:
  docmem-pgdata:
```

**Step 2: Add team setup docs as a CLI command**

In `src/cli.ts`, add a `setup-team` command:

```typescript
    case 'setup-team': {
      console.log(`DocMem Team Setup
================

1. Start the shared database:
   docker compose up -d postgres

2. Run migrations:
   docker compose run --rm migrate

3. Index projects:
   docker compose run --rm cli index /repos/boost-api
   docker compose run --rm cli index /repos/boost-client
   # ... or index all at once:
   docker compose run --rm cli reindex-all

4. Configure each team member's Claude Code MCP settings:
   Add to ~/.claude/settings.json:
   {
     "mcpServers": {
       "docmem": {
         "command": "node",
         "args": ["/path/to/docmem/dist/server.js"],
         "env": {
           "DATABASE_URL": "postgresql://docmem:<password>@<team-db-host>:5433/docmem"
         }
       }
     }
   }

5. Team members can now search all indexed docs.
   Feature branch docs are scoped — only merged docs appear by default.
`);
      break;
    }
```

Update help text:

```typescript
      console.log('  setup-team        Print team setup instructions');
```

**Step 3: Build and verify**

```bash
npm run build && node dist/cli.js setup-team
```

**Step 4: Commit**

```bash
git add docker-compose.yml src/cli.ts
git commit -m "Add team Docker setup with shared DB and CLI service"
```

---

### Task 9: Shared DB configuration

Update the config module to support team database URLs via environment variable, with sensible defaults for local vs team mode.

**Files:**
- Modify: `src/config.ts`

**Step 1: Update config to support team DB URL**

```typescript
import { readFileSync } from 'fs';

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  try {
    const envFile = readFileSync(new URL('../.env', import.meta.url), 'utf-8');
    for (const line of envFile.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex === -1) continue;
      const key = trimmed.slice(0, eqIndex);
      const value = trimmed.slice(eqIndex + 1);
      if (!env[key]) env[key] = value;
    }
  } catch {
    // .env file is optional
  }
  return env;
}

const env = loadEnv();

export const config = {
  databaseUrl: env.DATABASE_URL ?? 'postgresql://docmem:docmem@localhost:5433/docmem',
  isTeamMode: !!env.DOCMEM_TEAM_DB,
};
```

**Step 2: Update .env.example**

Create/update `.env.example`:

```
# Local development (default)
DATABASE_URL=postgresql://docmem:docmem@localhost:5433/docmem

# Team mode — point to shared Postgres
# DATABASE_URL=postgresql://docmem:secretpassword@team-db.example.com:5433/docmem
# DOCMEM_TEAM_DB=true
```

**Step 3: Build and commit**

```bash
npm run build
git add src/config.ts .env.example
git commit -m "Support team database configuration via environment variable"
```

---

### Task 10: Version bump + verify end-to-end

**Step 1: Bump version to 0.3.0**

In `package.json`, change version to `"0.3.0"`.

**Step 2: Run all tests**

```bash
npm run build && node --test dist/**/*.test.js
```

Expected: All tests pass (existing + 8 branch-manager tests).

**Step 3: Test branch-aware indexing**

```bash
# Index from current branch (should detect master)
node dist/cli.js index ~/Code/boost-api

# Check branches
node dist/cli.js branches
```

Expected: All chunks tagged as `master`, `merged = true`.

**Step 4: Test Docker build**

```bash
docker build -t docmem:0.3.0 .
docker compose up -d postgres
docker compose run --rm migrate
docker compose run --rm cli index /repos/boost-api
```

**Step 5: Commit plan + version bump**

```bash
git add package.json
git add -f docs/plans/2026-03-17-docmem-phase6-plan.md
git commit -m "Phase 6: branch-scoped indexing, Docker packaging, team mode (v0.3.0)"
```

---

## Summary

| Task | What | Files |
|------|------|-------|
| 1 | DB migration (branch + merged columns) | Modify: `migrate.ts` |
| 2 | Branch manager module + tests | Create: `branch-manager.ts`, `branch-manager.test.ts` |
| 3 | Branch-aware indexing pipeline | Modify: `index-project.ts` |
| 4 | Branch-scoped search | Modify: `server.ts` |
| 5 | Branch info in list_topics + overview | Modify: `server.ts` |
| 6 | `promote` + `branches` CLI commands | Modify: `cli.ts` |
| 7 | Dockerfile | Create: `Dockerfile`, `.dockerignore` |
| 8 | Team docker-compose + setup command | Modify: `docker-compose.yml`, `cli.ts` |
| 9 | Shared DB configuration | Modify: `config.ts`, `.env.example` |
| 10 | Version bump + verify | Modify: `package.json` |

## Branch Overlay Model

```
Master index (merged = true):
  ┌─────────────────────────────┐
  │ automations.md  (654 chunks)│
  │ billing.md      (89 chunks) │
  │ ...                         │
  └─────────────────────────────┘

Feature branch overlay (merged = false):
  ┌─────────────────────────────┐
  │ automations.md  (12 chunks) │  ← overrides master's automations sections
  │ new-feature.md  (8 chunks)  │  ← new doc, only on this branch
  └─────────────────────────────┘

Search (default, merged only):
  → Returns master's automations.md + billing.md

Search (include_branches or branch="feature/x"):
  → Returns feature branch's automations.md (overlay) + master's billing.md + new-feature.md
```

## CLI after Phase 6

```
docmem index [path]         Index a project (auto-detects branch)
docmem reindex-all          Reindex all known projects
docmem branches             List all indexed branches
docmem promote <branch>     Promote a branch's chunks to merged
docmem generate-hooks       Print Claude Code hook config
docmem setup-team           Print team setup instructions
```

## Docker deployment

```bash
# Start shared DB
docker compose up -d postgres

# Run migrations
docker compose run --rm migrate

# Index a project
docker compose run --rm cli index /repos/boost-api

# Each team member configures their MCP to point at the shared DB
DATABASE_URL=postgresql://docmem:pass@team-db:5433/docmem npm start
```
