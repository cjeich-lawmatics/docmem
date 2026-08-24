#!/usr/bin/env node
// Light DB probe. Connects on the configured DATABASE_URL, runs SELECT 1, and exits with a
// classified code so callers (docmem-dbcheck.sh, the reindex preflight) can tell "container
// down" (3) from "reachable but erroring" (1). Imports only the pool, never the indexing
// stack, so it starts fast.
import { pool } from './pool.js';
import { config } from '../config.js';
import { isConnectionRefused } from './connection-error.js';

async function main(): Promise<number> {
  try {
    await pool.query('SELECT 1');
    console.log('ok');
    return 0;
  } catch (err) {
    if (isConnectionRefused(err)) {
      console.error(`docmem healthcheck: DB unreachable at ${redact(config.databaseUrl)}`);
      return 3;
    }
    console.error(
      `docmem healthcheck: DB reachable but query failed: ${err instanceof Error ? err.message : err}`,
    );
    return 1;
  } finally {
    await pool.end().catch(() => {});
  }
}

// Strip credentials from the connection string before logging it.
function redact(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || '5432'}`;
  } catch {
    return 'the configured database';
  }
}

main().then(code => {
  process.exit(code);
});
