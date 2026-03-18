#!/usr/bin/env node
import { indexProject } from './indexer/index-project.js';
import { pool } from './db/pool.js';

const args = process.argv.slice(2);
const command = args[0];

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
    default:
      console.log('Usage: docmem <command>');
      console.log('');
      console.log('Commands:');
      console.log('  index [path]      Index a project (defaults to current directory)');
      console.log('  reindex-all       Reindex all known projects');
      console.log('  promote <branch>  Promote a branch\'s chunks to merged status');
      console.log('  branches          List all indexed branches with chunk counts');
      console.log('  generate-hooks    Print Claude Code hook config for auto-reindexing');
      console.log('  setup-team        Print team setup instructions');
      break;
  }
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
