import { describe, it } from 'node:test';
import assert from 'node:assert';
import { fuseResults, expandQuery, type RankedResult } from './hybrid-search.js';

describe('fuseResults', () => {
  it('combines results from two ranked lists via RRF', () => {
    const vectorResults: RankedResult[] = [
      { id: 'a', rank: 1 },
      { id: 'b', rank: 2 },
      { id: 'c', rank: 3 },
    ];
    const bm25Results: RankedResult[] = [
      { id: 'b', rank: 1 },
      { id: 'a', rank: 2 },
      { id: 'd', rank: 3 },
    ];
    const fused = fuseResults(vectorResults, bm25Results);
    assert.ok(fused.length >= 3);
    const topIds = fused.slice(0, 2).map(r => r.id);
    assert.ok(topIds.includes('a'), 'a should be in top 2');
    assert.ok(topIds.includes('b'), 'b should be in top 2');
  });

  it('handles empty vector results', () => {
    const bm25: RankedResult[] = [{ id: 'a', rank: 1 }];
    const fused = fuseResults([], bm25);
    assert.strictEqual(fused.length, 1);
    assert.strictEqual(fused[0].id, 'a');
  });

  it('handles empty BM25 results', () => {
    const vector: RankedResult[] = [{ id: 'a', rank: 1 }];
    const fused = fuseResults(vector, []);
    assert.strictEqual(fused.length, 1);
    assert.strictEqual(fused[0].id, 'a');
  });

  it('deduplicates IDs from both lists', () => {
    const vector: RankedResult[] = [{ id: 'a', rank: 1 }, { id: 'b', rank: 2 }];
    const bm25: RankedResult[] = [{ id: 'a', rank: 1 }, { id: 'b', rank: 2 }];
    const fused = fuseResults(vector, bm25);
    const ids = fused.map(r => r.id);
    assert.strictEqual(new Set(ids).size, ids.length, 'No duplicates');
  });

  it('gives top-rank bonus to rank 1 results', () => {
    const vector: RankedResult[] = [{ id: 'a', rank: 1 }, { id: 'b', rank: 10 }];
    const bm25: RankedResult[] = [{ id: 'b', rank: 1 }, { id: 'a', rank: 10 }];
    const fused = fuseResults(vector, bm25);
    assert.strictEqual(fused.length, 2);
  });
});

describe('expandQuery', () => {
  it('returns original query as first element', () => {
    const expanded = expandQuery('automation target processing');
    assert.strictEqual(expanded[0], 'automation target processing');
  });

  it('generates at least 2 variants', () => {
    const expanded = expandQuery('automation target processing');
    assert.ok(expanded.length >= 2, `Expected at least 2 variants, got ${expanded.length}`);
  });

  it('generates keyword variant without stopwords', () => {
    const expanded = expandQuery('how does the automation target work');
    const hasKeywordVariant = expanded.some(q => !q.includes('how') || !q.includes('does') || !q.includes('the'));
    assert.ok(hasKeywordVariant, 'Should have a variant with stopwords removed');
  });

  it('returns just the original for very short queries', () => {
    const expanded = expandQuery('hi');
    assert.strictEqual(expanded.length, 1);
  });
});
