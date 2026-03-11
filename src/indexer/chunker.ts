import { createHash } from 'crypto';

export interface Chunk {
  sourceFile: string;
  sectionPath: string;
  content: string;
  topic: string;
  checksum: string;
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

/**
 * Split a markdown document into chunks at h2 (##) boundaries.
 * Each chunk includes any h3+ subsections under the h2.
 * Content before the first h2 becomes its own chunk if non-trivial.
 */
export function chunkMarkdown(markdown: string, filePath: string): Chunk[] {
  const lines = markdown.split('\n');
  const topic = deriveTopic(filePath);
  const chunks: Chunk[] = [];

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
        const content = currentLines.join('\n').trim();
        if (content.length > 0) {
          const sectionPath = currentHeading
            ? [mainTitle, currentHeading].filter(Boolean).join(' > ')
            : mainTitle || filePath;
          chunks.push({
            sourceFile: filePath,
            sectionPath,
            content,
            topic,
            checksum: computeChecksum(content),
          });
        }
      }
      currentHeading = line.replace(/^## /, '').trim();
      currentLines = [line];
      continue;
    }

    currentLines.push(line);
  }

  if (currentLines.length > 0) {
    const content = currentLines.join('\n').trim();
    if (content.length > 0) {
      const sectionPath = currentHeading
        ? [mainTitle, currentHeading].filter(Boolean).join(' > ')
        : mainTitle || filePath;
      chunks.push({
        sourceFile: filePath,
        sectionPath,
        content,
        topic,
        checksum: computeChecksum(content),
      });
    }
  }

  return chunks;
}
