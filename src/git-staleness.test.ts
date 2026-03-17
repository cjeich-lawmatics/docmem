import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseGitTimestamp, isStale } from './git-staleness.js';

describe('parseGitTimestamp', () => {
  it('parses unix timestamp string to Date', () => {
    const date = parseGitTimestamp('1710000000');
    assert.ok(date instanceof Date);
    assert.strictEqual(date.getTime(), 1710000000 * 1000);
  });

  it('returns null for empty string', () => {
    assert.strictEqual(parseGitTimestamp(''), null);
  });

  it('returns null for whitespace', () => {
    assert.strictEqual(parseGitTimestamp('  \n'), null);
  });
});

describe('isStale', () => {
  it('returns true when git timestamp is newer than indexed', () => {
    assert.strictEqual(isStale(new Date('2026-03-17'), new Date('2026-03-16')), true);
  });

  it('returns false when indexed is newer', () => {
    assert.strictEqual(isStale(new Date('2026-03-15'), new Date('2026-03-16')), false);
  });

  it('returns false when equal', () => {
    const t = new Date('2026-03-16');
    assert.strictEqual(isStale(t, t), false);
  });

  it('returns true when git timestamp is null (deleted)', () => {
    assert.strictEqual(isStale(null, new Date('2026-03-16')), true);
  });
});
