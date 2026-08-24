import { describe, it } from 'node:test';
import assert from 'node:assert';
import { computeCoverage } from './completeness.js';

describe('computeCoverage', () => {
  const t = new Date('2026-08-24T00:00:00Z');

  it('complete when expected met and last-full set', () => {
    assert.deepStrictEqual(computeCoverage({ expected: 100, embedded: 100, lastFullIndexAt: t }),
      { coverage: 1, complete: true });
  });

  it('partial: embedded below expected', () => {
    const r = computeCoverage({ expected: 4704, embedded: 222, lastFullIndexAt: null });
    assert.strictEqual(r.complete, false);
    assert.ok(Math.abs(r.coverage - 222 / 4704) < 1e-9);
  });

  it('never indexed: expected null, nothing embedded', () => {
    assert.deepStrictEqual(computeCoverage({ expected: null, embedded: 0, lastFullIndexAt: null }),
      { coverage: 0, complete: false });
  });

  it('expected null but some embedded: coverage 1, still incomplete (no full marker)', () => {
    assert.deepStrictEqual(computeCoverage({ expected: null, embedded: 50, lastFullIndexAt: null }),
      { coverage: 1, complete: false });
  });

  it('embedded exceeds expected (docs shrank) still counts complete when full marker set', () => {
    const r = computeCoverage({ expected: 100, embedded: 130, lastFullIndexAt: t });
    assert.strictEqual(r.coverage, 1); // clamped
    assert.strictEqual(r.complete, true);
  });

  it('expected met but no last-full marker => incomplete', () => {
    assert.deepStrictEqual(computeCoverage({ expected: 100, embedded: 100, lastFullIndexAt: null }),
      { coverage: 1, complete: false });
  });

  it('expected zero: coverage 1 if anything embedded else 0', () => {
    assert.strictEqual(computeCoverage({ expected: 0, embedded: 0, lastFullIndexAt: null }).coverage, 0);
    assert.strictEqual(computeCoverage({ expected: 0, embedded: 5, lastFullIndexAt: null }).coverage, 1);
  });
});
