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
    default:
      console.log('Usage: docmem <command>');
      console.log('');
      console.log('Commands:');
      console.log('  index [path]     Index a project (defaults to current directory)');
      console.log('  reindex-all      Reindex all known projects');
      console.log('  generate-hooks    Print Claude Code hook config for auto-reindexing');
      break;
  }
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
