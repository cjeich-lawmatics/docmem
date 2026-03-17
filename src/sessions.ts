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
