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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
