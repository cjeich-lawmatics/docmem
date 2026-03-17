import { execSync } from 'child_process';
import { pool } from './db/pool.js';

const MAIN_BRANCHES = new Set(['master', 'main']);

export function isMainBranch(branch: string): boolean {
  return MAIN_BRANCHES.has(branch);
}

export function normalizeBranchName(raw: string): string {
  const trimmed = raw.trim().replace(/^refs\/heads\//, '');
  return trimmed || 'detached';
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

    return output.split('\n')
      .map(line => line.replace(/^\*?\s+/, '').trim())
      .filter(name => name && !isMainBranch(name));
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
    const output = execSync('git branch -r', {
      cwd: rootPath, encoding: 'utf-8', timeout: 5000,
    });
    const remoteBranches = new Set(
      output.split('\n')
        .map(line => line.trim().replace(/^origin\//, ''))
        .filter(Boolean)
    );
    remoteBranches.add('master');
    remoteBranches.add('main');

    const indexed = await pool.query(
      `SELECT DISTINCT branch FROM docmem.chunks WHERE project_id = $1 AND merged = false`,
      [projectId]
    );

    const stale = indexed.rows.map(r => r.branch).filter(b => !remoteBranches.has(b));
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
