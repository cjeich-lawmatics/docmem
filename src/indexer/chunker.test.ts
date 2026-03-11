import { describe, it } from 'node:test';
import assert from 'node:assert';
import { chunkMarkdown } from './chunker.js';

const SAMPLE_DOC = `# Main Title

Some intro text.

## Section One

Content for section one.
More content here.

### Subsection A

Details about subsection A.

## Section Two

Content for section two.

### Subsection B

Details about subsection B.
Even more details.

### Subsection C

Short section.
`;

describe('chunkMarkdown', () => {
  it('splits on h2 boundaries by default', () => {
    const chunks = chunkMarkdown(SAMPLE_DOC, 'test.md');
    // Should produce: intro chunk, Section One (with Subsection A), Section Two (with Subsections B & C)
    assert.ok(chunks.length >= 2, `Expected at least 2 chunks, got ${chunks.length}`);
    assert.ok(chunks.some(c => c.sectionPath.includes('Section One')));
    assert.ok(chunks.some(c => c.sectionPath.includes('Section Two')));
  });

  it('includes source file in each chunk', () => {
    const chunks = chunkMarkdown(SAMPLE_DOC, 'docs/features/automations.md');
    for (const chunk of chunks) {
      assert.strictEqual(chunk.sourceFile, 'docs/features/automations.md');
    }
  });

  it('computes a checksum for each chunk', () => {
    const chunks = chunkMarkdown(SAMPLE_DOC, 'test.md');
    for (const chunk of chunks) {
      assert.ok(chunk.checksum.length > 0, 'Checksum should not be empty');
    }
  });

  it('produces stable checksums for identical content', () => {
    const chunks1 = chunkMarkdown(SAMPLE_DOC, 'test.md');
    const chunks2 = chunkMarkdown(SAMPLE_DOC, 'test.md');
    assert.strictEqual(chunks1[0].checksum, chunks2[0].checksum);
  });

  it('derives topic from file path', () => {
    const chunks = chunkMarkdown(SAMPLE_DOC, 'docs/features/automations.md');
    for (const chunk of chunks) {
      assert.strictEqual(chunk.topic, 'features/automations');
    }
  });

  it('handles files with no h2 headings as a single chunk', () => {
    const simpleDoc = '# Just a Title\n\nSome content without h2 headings.\n';
    const chunks = chunkMarkdown(simpleDoc, 'simple.md');
    assert.strictEqual(chunks.length, 1);
  });
});
