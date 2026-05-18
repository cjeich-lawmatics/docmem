import { execSync } from 'child_process';
import { pool } from './db/pool.js';

const MAIN_BRANCHES = new Set(['master', 'main']);

// Strips ANSI SGR escape sequences (e.g. `\x1b[31m`). git emits these when
// `color.ui=always` is set in a user's config, even when stdout is not a TTY.
const ANSI_ESCAPE_PATTERN = /\x1b\[[0-9;]*m/g;

export function isMainBranch(branch: string): boolean {
  return MAIN_BRANCHES.has(branch);
}

export function normalizeBranchName(raw: string): string {
  const trimmed = raw.trim().replace(/^refs\/heads\//, '');
  return trimmed || 'detached';
}

export function parseBranchLines(output: string, prefixToTrim?: string): string[] {
  return output
    .split('\n')
    .map(line => line.replace(ANSI_ESCAPE_PATTERN, ''))
    .map(line => line.replace(/^\*?\s+/, '').trim())
    .filter(Boolean)
    .filter(line => !line.includes(' -> '))
    .map(line => {
      if (!prefixToTrim) return line;
      return line.startsWith(prefixToTrim) ? line.slice(prefixToTrim.length) : line;
    })
    .map(normalizeBranchName)
    .filter(name => name !== 'detached' && name !== 'unknown');
}

export function collectKnownBranches(localBranches: string[], remoteBranches: string[]): Set<string> {
  return new Set([
    'main',
    'master',
    ...localBranches.map(normalizeBranchName),
    ...remoteBranches.map(normalizeBranchName),
  ]);
}

export function findStaleBranches(indexedBranches: string[], knownBranches: Set<string>): string[] {
  return indexedBranches.filter(branch => !knownBranches.has(branch));
}

export function detectBranch(rootPath: string): string {
  try {
    const output = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: rootPath, encoding: 'utf-8', timeout: 5000,
    });
    return normalizeBranchName(output);
  } catch {
    return 'unknown';
  }
}

export function getMergedBranches(rootPath: string): string[] {
  try {
    let mainBranch = 'master';
    try {
      execSync('git rev-parse --verify master', { cwd: rootPath, encoding: 'utf-8', timeout: 5000 });
    } catch {
      mainBranch = 'main';
    }

    const output = execSync(`git branch --merged ${mainBranch}`, {
      cwd: rootPath, encoding: 'utf-8', timeout: 5000,
    });

    return parseBranchLines(output).filter(name => !isMainBranch(name));
  } catch {
    return [];
  }
}

export async function promoteMergedBranches(projectId: string, rootPath: string): Promise<number> {
  const mergedBranches = getMergedBranches(rootPath);
  if (mergedBranches.length === 0) return 0;

  const result = await pool.query(
    `UPDATE docmem.chunks SET merged = true
     WHERE project_id = $1 AND branch = ANY($2) AND merged = false
     RETURNING id`,
    [projectId, mergedBranches]
  );
  return result.rowCount ?? 0;
}

export async function cleanupDeletedBranches(projectId: string, rootPath: string): Promise<number> {
  try {
    const localOutput = execSync('git branch', {
      cwd: rootPath, encoding: 'utf-8', timeout: 5000,
    });
    const remoteOutput = execSync('git branch -r', {
      cwd: rootPath, encoding: 'utf-8', timeout: 5000,
    });
    const knownBranches = collectKnownBranches(
      parseBranchLines(localOutput),
      parseBranchLines(remoteOutput, 'origin/')
    );

    const indexed = await pool.query(
      `SELECT DISTINCT branch FROM docmem.chunks WHERE project_id = $1 AND merged = false`,
      [projectId]
    );

    const stale = findStaleBranches(
      indexed.rows.map(r => r.branch),
      knownBranches
    );
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
