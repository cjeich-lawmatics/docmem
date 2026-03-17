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

  it('keeps code blocks intact within a section', () => {
    const doc = `# Title

## Section

Before code.

\`\`\`typescript
function foo() {
  return "bar";
}
\`\`\`

After code.
`;
    const chunks = chunkMarkdown(doc, 'test.md');
    const section = chunks.find(c => c.sectionPath.includes('Section'));
    assert.ok(section, 'Should have a Section chunk');
    assert.ok(section.content.includes('function foo()'), 'Code block should be in the section');
    assert.ok(section.content.includes('After code'), 'Content after code block should be in same section');
  });

  it('does not split inside a code fence when breaking large sections', () => {
    const bigCode = Array(50).fill('  console.log("line");').join('\n');
    const doc = `# Title

## Big Section

Intro paragraph.

\`\`\`javascript
${bigCode}
\`\`\`

Conclusion paragraph.
`;
    const chunks = chunkMarkdown(doc, 'test.md');
    for (const chunk of chunks) {
      const fenceCount = (chunk.content.match(/^```/gm) || []).length;
      assert.strictEqual(fenceCount % 2, 0, `Chunk "${chunk.sectionPath}" has unbalanced code fences (${fenceCount})`);
    }
  });

  it('splits oversized sections at paragraph boundaries', () => {
    const paragraphs = Array(20).fill('This is a paragraph with enough text to contribute to a large section. It contains meaningful content that should be kept together as a unit.').join('\n\n');
    const doc = `# Title

## Huge Section

${paragraphs}
`;
    const chunks = chunkMarkdown(doc, 'test.md', { maxChunkTokens: 200 });
    assert.ok(chunks.length >= 2, `Expected multiple chunks for oversized section, got ${chunks.length}`);
  });
});
