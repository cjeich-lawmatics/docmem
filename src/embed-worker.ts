// No runtime-env import here: worker_threads inherit a snapshot of the
// parent process.env, and both entry points (server.ts, cli.ts) set the
// OMP_* thread caps at module load before this worker is spawned. Importing
// runtime-env here would couple this commit to a file that is not yet tracked.
import { parentPort } from 'node:worker_threads';
import { embedQuery } from './indexer/embedder.js';

if (!parentPort) {
  throw new Error('embed-worker must be run as a worker thread');
}

const port = parentPort;

port.on('message', async (msg: { id: string; query: string }) => {
  try {
    const embedding = await embedQuery(msg.query);
    port.postMessage({ id: msg.id, embedding });
  } catch (err) {
    port.postMessage({ id: msg.id, error: err instanceof Error ? err.message : String(err) });
  }
});
