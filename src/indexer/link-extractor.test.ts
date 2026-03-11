import { describe, it } from 'node:test';
import assert from 'node:assert';
import { extractLinks, type ExtractedLink } from './link-extractor.js';

describe('extractLinks', () => {
  it('extracts relative markdown links', () => {
    const links = extractLinks(
      'See [automations](../features/automations.md) for details.',
      'docs/guides/overview.md'
    );
    assert.strictEqual(links.length, 1);
    assert.strictEqual(links[0].targetFile, 'docs/features/automations.md');
  });

  it('extracts same-directory links', () => {
    const links = extractLinks(
      'See [billing](./billing.md).',
      'docs/features/payments.md'
    );
    assert.strictEqual(links.length, 1);
    assert.strictEqual(links[0].targetFile, 'docs/features/billing.md');
  });

  it('extracts links without ./ prefix', () => {
    const links = extractLinks(
      'See [billing](billing.md).',
      'docs/features/payments.md'
    );
    assert.strictEqual(links.length, 1);
    assert.strictEqual(links[0].targetFile, 'docs/features/billing.md');
  });

  it('strips section anchors from target path', () => {
    const links = extractLinks(
      'See [section](automations.md#guard-pattern).',
      'docs/features/overview.md'
    );
    assert.strictEqual(links[0].targetFile, 'docs/features/automations.md');
    assert.strictEqual(links[0].anchor, 'guard-pattern');
  });

  it('ignores external URLs', () => {
    const links = extractLinks(
      'Visit [docs](https://example.com/docs) and [api](http://api.example.com).',
      'docs/readme.md'
    );
    assert.strictEqual(links.length, 0);
  });

  it('ignores image links', () => {
    const links = extractLinks(
      '![diagram](./architecture.png)',
      'docs/overview.md'
    );
    assert.strictEqual(links.length, 0);
  });

  it('extracts multiple links from one text', () => {
    const links = extractLinks(
      'See [a](./a.md) and [b](../b.md) for more.',
      'docs/features/c.md'
    );
    assert.strictEqual(links.length, 2);
  });

  it('returns empty array for text with no links', () => {
    const links = extractLinks('No links here.', 'docs/test.md');
    assert.strictEqual(links.length, 0);
  });

  it('normalizes paths (removes double slashes, dots)', () => {
    const links = extractLinks(
      'See [x](../../../CLAUDE.md).',
      'docs/features/deep/nested.md'
    );
    assert.strictEqual(links[0].targetFile, 'CLAUDE.md');
  });
});
