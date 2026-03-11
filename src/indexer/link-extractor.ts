import { dirname, normalize } from 'path';

export interface ExtractedLink {
  targetFile: string;   // Resolved relative path (e.g., 'docs/features/automations.md')
  anchor: string | null; // Section anchor if present (e.g., 'guard-pattern')
  linkText: string;      // The display text of the link
}

// Match [text](path) but NOT ![text](path) (images)
const LINK_RE = /(?<!!)\[([^\]]+)\]\(([^)]+)\)/g;

/**
 * Extract markdown links to other documentation files.
 * Resolves relative paths against the source file's directory.
 * Ignores external URLs and image links.
 */
export function extractLinks(text: string, sourceFile: string): ExtractedLink[] {
  const links: ExtractedLink[] = [];
  const sourceDir = dirname(sourceFile);

  for (const match of text.matchAll(LINK_RE)) {
    const linkText = match[1];
    let href = match[2].trim();

    // Skip external and protocol-relative URLs
    if (/^(https?:)?\/\//.test(href)) continue;

    // Skip non-markdown links
    if (!href.replace(/#.*$/, '').endsWith('.md')) continue;

    // Split anchor
    let anchor: string | null = null;
    const hashIdx = href.indexOf('#');
    if (hashIdx !== -1) {
      anchor = href.slice(hashIdx + 1);
      href = href.slice(0, hashIdx);
    }

    // Resolve relative path
    const resolved = normalize(`${sourceDir}/${href}`);

    // Clean up: remove leading ./ or /
    const targetFile = resolved.replace(/^\.\//, '').replace(/^\//, '');

    links.push({ targetFile, anchor, linkText });
  }

  return links;
}
