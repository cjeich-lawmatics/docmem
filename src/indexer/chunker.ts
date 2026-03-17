import { createHash } from 'crypto';

export interface Chunk {
  sourceFile: string;
  sectionPath: string;
  content: string;
  topic: string;
  checksum: string;
}

export interface ChunkOptions {
  maxChunkTokens?: number;
}

/**
 * Derive topic from file path.
 * e.g., 'docs/features/automations.md' -> 'features/automations'
 * e.g., 'CLAUDE.md' -> 'root'
 */
function deriveTopic(filePath: string): string {
  let path = filePath.replace(/^docs\//, '');
  path = path.replace(/\.md$/, '');
  if (!path.includes('/')) return 'root';
  return path;
}

function computeChecksum(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

function isInsideCodeFence(lines: string[], lineIndex: number): boolean {
  let fenceCount = 0;
  for (let i = 0; i < lineIndex; i++) {
    if (/^```/.test(lines[i])) fenceCount++;
  }
  return fenceCount % 2 === 1;
}

function splitOversizedSection(content: string, maxTokens: number): string[] {
  const estimatedTokens = Math.ceil(content.length / 4);
  if (estimatedTokens <= maxTokens) return [content];

  const lines = content.split('\n');
  const parts: string[] = [];
  let currentLines: string[] = [];
  let currentTokens = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineTokens = Math.ceil(line.length / 4) + 1;

    currentLines.push(line);
    currentTokens += lineTokens;

    if (currentTokens >= maxTokens && line.trim() === '' && !isInsideCodeFence(lines, i)) {
      const part = currentLines.join('\n').trim();
      if (part) parts.push(part);
      currentLines = [];
      currentTokens = 0;
    }
  }

  const remaining = currentLines.join('\n').trim();
  if (remaining) parts.push(remaining);

  return parts.length > 0 ? parts : [content];
}

/**
 * Split a markdown document into chunks at h2 (##) boundaries.
 * Each chunk includes any h3+ subsections under the h2.
 * Content before the first h2 becomes its own chunk if non-trivial.
 * Oversized sections are split at paragraph boundaries, never inside code fences.
 */
export function chunkMarkdown(markdown: string, filePath: string, options?: ChunkOptions): Chunk[] {
  const maxChunkTokens = options?.maxChunkTokens ?? 1500;
  const lines = markdown.split('\n');
  const topic = deriveTopic(filePath);
  const rawChunks: { heading: string; lines: string[] }[] = [];

  let currentHeading = '';
  let currentLines: string[] = [];
  let mainTitle = '';

  for (const line of lines) {
    if (/^# /.test(line) && !mainTitle) {
      mainTitle = line.replace(/^# /, '').trim();
      currentLines.push(line);
      continue;
    }

    if (/^## /.test(line)) {
      if (currentLines.length > 0) {
        rawChunks.push({ heading: currentHeading, lines: [...currentLines] });
      }
      currentHeading = line.replace(/^## /, '').trim();
      currentLines = [line];
      continue;
    }

    currentLines.push(line);
  }

  if (currentLines.length > 0) {
    rawChunks.push({ heading: currentHeading, lines: [...currentLines] });
  }

  const chunks: Chunk[] = [];

  for (const raw of rawChunks) {
    const content = raw.lines.join('\n').trim();
    if (!content) continue;

    const sectionPath = raw.heading
      ? [mainTitle, raw.heading].filter(Boolean).join(' > ')
      : mainTitle || filePath;

    const parts = splitOversizedSection(content, maxChunkTokens);

    for (let i = 0; i < parts.length; i++) {
      const partPath = parts.length > 1 ? `${sectionPath} (part ${i + 1})` : sectionPath;
      chunks.push({
        sourceFile: filePath,
        sectionPath: partPath,
        content: parts[i],
        topic,
        checksum: computeChecksum(parts[i]),
      });
    }
  }

  return chunks;
}
