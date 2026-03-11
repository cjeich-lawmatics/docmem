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
    default:
      console.log('Usage: docmem <command>');
      console.log('');
      console.log('Commands:');
      console.log('  index [path]   Index a project (defaults to current directory)');
      break;
  }
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
