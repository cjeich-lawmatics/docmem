export interface ExtractedEntity {
  name: string;
  type: 'model' | 'identifier' | 'constant' | 'term';
}

const BACKTICK_RE = /`([^`]+)`/g;
const MIN_LENGTH = 3;

function classifyEntity(name: string): ExtractedEntity['type'] | null {
  // Skip multi-word (likely code snippets)
  if (/\s/.test(name)) return null;

  // SCREAMING_SNAKE_CASE → constant
  if (/^[A-Z][A-Z0-9_]+$/.test(name)) return 'constant';

  // PascalCase (starts uppercase, has lowercase) → model
  if (/^[A-Z][a-zA-Z0-9]+$/.test(name) && /[a-z]/.test(name)) return 'model';

  // snake_case → identifier
  if (/^[a-z][a-z0-9_]+$/.test(name) && name.includes('_')) return 'identifier';

  // camelCase → identifier
  if (/^[a-z][a-zA-Z0-9]+$/.test(name) && /[A-Z]/.test(name)) return 'identifier';

  // Anything else → term
  return 'term';
}

/**
 * Extract named entities from markdown text using backtick-wrapped terms.
 * Returns deduplicated entities classified by naming convention.
 */
export function extractEntities(text: string): ExtractedEntity[] {
  const seen = new Set<string>();
  const entities: ExtractedEntity[] = [];

  let match: RegExpExecArray | null;
  while ((match = BACKTICK_RE.exec(text)) !== null) {
    const name = match[1].trim();

    if (name.length < MIN_LENGTH) continue;
    if (seen.has(name)) continue;

    const type = classifyEntity(name);
    if (!type) continue;

    seen.add(name);
    entities.push({ name, type });
  }

  return entities;
}
