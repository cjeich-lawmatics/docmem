import { describe, it } from 'node:test';
import assert from 'node:assert';
import { rankResults, type RankRow } from './search-ranking.js';

const now = new Date('2026-08-21T00:00:00Z');

function row(over: Partial<RankRow>): RankRow {
  return {
    id: 'x', source_file: 'f.md', section_path: 'S', summary: 'sum',
    topic: 'features/x', token_count: 10, last_modified: now.toISOString(),
    branch: 'master', merged: true, project_name: 'boost-api',
    similarity: 0, access_count: 0, avg_usefulness: 0.5, ...over,
  };
}

describe('rankResults normal mode', () => {
  it('orders by composite score (similarity dominates)', () => {
    const rows = [
      row({ id: 'lo', similarity: 0.1 }),
      row({ id: 'hi', similarity: 0.9 }),
    ];
    const { results } = rankResults(rows, {
      maxAccess: 0, now, query: 'q', degraded: false,
      rrfScoreMap: new Map([['lo', 1], ['hi', 0]]), maxResults: 5,
    });
    assert.strictEqual(results[0].chunk_id, 'hi');
    assert.strictEqual(results[1].chunk_id, 'lo');
  });
});

describe('rankResults degraded mode', () => {
  it('orders by rrf score, not composite score', () => {
    // Both have similarity 0; without rrf ordering they would tie/keep input order.
    const rows = [
      row({ id: 'a', similarity: 0 }),
      row({ id: 'b', similarity: 0 }),
    ];
    const { results } = rankResults(rows, {
      maxAccess: 0, now, query: 'q', degraded: true,
      rrfScoreMap: new Map([['a', 0.1], ['b', 0.9]]), maxResults: 5,
    });
    assert.strictEqual(results[0].chunk_id, 'b');
    assert.strictEqual(results[1].chunk_id, 'a');
  });

  it('falls back to composite score when rrf ties', () => {
    const rows = [
      row({ id: 'cold', access_count: 0, maxAccess: 10 } as Partial<RankRow>),
      row({ id: 'hot', access_count: 10 } as Partial<RankRow>),
    ];
    const { results } = rankResults(rows, {
      maxAccess: 10, now, query: 'q', degraded: true,
      rrfScoreMap: new Map([['cold', 0.5], ['hot', 0.5]]), maxResults: 5,
    });
    assert.strictEqual(results[0].chunk_id, 'hot');
  });
});

describe('rankResults output shape', () => {
  it('assigns 1-based ranks, rounds similarity, and falls back summary', () => {
    const rows = [row({ id: 'a', similarity: 0.123456, summary: null, section_path: 'Sec' })];
    const { results, top } = rankResults(rows, {
      maxAccess: 0, now, query: 'q', degraded: false,
      rrfScoreMap: new Map([['a', 1]]), maxResults: 5,
    });
    assert.strictEqual(results[0].rank, 1);
    assert.strictEqual(results[0].similarity, 0.123);
    assert.strictEqual(results[0].summary, '[Sec] (10 tokens)');
    assert.strictEqual(top[0].row.id, 'a');
  });

  it('respects maxResults', () => {
    const rows = [row({ id: 'a' }), row({ id: 'b' }), row({ id: 'c' })];
    const { results } = rankResults(rows, {
      maxAccess: 0, now, query: 'q', degraded: false,
      rrfScoreMap: new Map(), maxResults: 2,
    });
    assert.strictEqual(results.length, 2);
  });
});
