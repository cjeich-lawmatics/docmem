import { execSync } from 'child_process';

export function parseGitTimestamp(timestamp: string): Date | null {
  const trimmed = timestamp.trim();
  if (!trimmed) return null;
  const seconds = parseInt(trimmed, 10);
  if (isNaN(seconds)) return null;
  return new Date(seconds * 1000);
}

export function isStale(gitTimestamp: Date | null, indexedTimestamp: Date): boolean {
  if (!gitTimestamp) return true;
  return gitTimestamp.getTime() > indexedTimestamp.getTime();
}

export function getGitFileTimestamp(rootPath: string, filePath: string): Date | null {
  try {
    const output = execSync(
      `git log -1 --format=%ct -- "${filePath}"`,
      { cwd: rootPath, encoding: 'utf-8', timeout: 5000 }
    );
    return parseGitTimestamp(output);
  } catch {
    return null;
  }
}
