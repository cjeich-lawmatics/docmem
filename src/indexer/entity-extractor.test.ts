import { describe, it } from 'node:test';
import assert from 'node:assert';
import { extractEntities, type ExtractedEntity } from './entity-extractor.js';

describe('extractEntities', () => {
  it('extracts backtick-wrapped PascalCase as model', () => {
    const entities = extractEntities('The `AutomationTarget` model handles execution.');
    const found = entities.find(e => e.name === 'AutomationTarget');
    assert.ok(found, 'Should find AutomationTarget');
    assert.strictEqual(found.type, 'model');
  });

  it('extracts backtick-wrapped snake_case as identifier', () => {
    const entities = extractEntities('Call `reindex_contact` to refresh.');
    const found = entities.find(e => e.name === 'reindex_contact');
    assert.ok(found, 'Should find reindex_contact');
    assert.strictEqual(found.type, 'identifier');
  });

  it('extracts backtick-wrapped camelCase as identifier', () => {
    const entities = extractEntities('Use `findById` to look up records.');
    const found = entities.find(e => e.name === 'findById');
    assert.ok(found, 'Should find findById');
    assert.strictEqual(found.type, 'identifier');
  });

  it('extracts SCREAMING_SNAKE as constant', () => {
    const entities = extractEntities('Set `BATCH_SIZE` to 32.');
    const found = entities.find(e => e.name === 'BATCH_SIZE');
    assert.ok(found, 'Should find BATCH_SIZE');
    assert.strictEqual(found.type, 'constant');
  });

  it('extracts other backtick terms as term', () => {
    const entities = extractEntities('Install `pgvector` extension.');
    const found = entities.find(e => e.name === 'pgvector');
    assert.ok(found, 'Should find pgvector');
    assert.strictEqual(found.type, 'term');
  });

  it('deduplicates entities within a single text', () => {
    const entities = extractEntities('The `Foo` model. Also see `Foo` again.');
    const foos = entities.filter(e => e.name === 'Foo');
    assert.strictEqual(foos.length, 1, 'Should deduplicate');
  });

  it('ignores short backtick terms (1-2 chars)', () => {
    const entities = extractEntities('Use `x` or `id` for lookups.');
    assert.strictEqual(entities.length, 0, 'Should ignore short terms');
  });

  it('ignores backtick terms that look like code snippets', () => {
    const entities = extractEntities('Run `npm install` and `git commit -m "foo"`.');
    // Multi-word backtick content with spaces = code snippet, not entity
    assert.strictEqual(entities.length, 0, 'Should ignore code snippets');
  });

  it('extracts multiple entities from one text', () => {
    const entities = extractEntities(
      'The `AutomationTarget` uses `ContactableReindexWorker` with `BATCH_SIZE` set.'
    );
    assert.strictEqual(entities.length, 3);
  });

  it('returns empty array for text with no backtick terms', () => {
    const entities = extractEntities('Plain text with no code references.');
    assert.strictEqual(entities.length, 0);
  });
});
