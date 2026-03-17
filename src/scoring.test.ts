import { describe, it } from 'node:test';
import assert from 'node:assert';
import { computeScore, normalizeHeat, normalizeRecency, type ScoringInput } from './scoring.js';

describe('normalizeHeat', () => {
  it('returns 0 when access_count is 0', () => {
    assert.strictEqual(normalizeHeat(0, 100), 0);
  });

  it('returns 1 when access_count equals max', () => {
    assert.strictEqual(normalizeHeat(50, 50), 1);
  });

  it('returns 0 when max is 0 (no accesses anywhere)', () => {
    assert.strictEqual(normalizeHeat(0, 0), 0);
  });

  it('normalizes proportionally', () => {
    assert.strictEqual(normalizeHeat(25, 100), 0.25);
  });
});

describe('normalizeRecency', () => {
  it('returns 1 for today', () => {
    const now = new Date();
    assert.strictEqual(normalizeRecency(now, now), 1);
  });

  it('returns 0.5 for halfway through max age', () => {
    const now = new Date();
    const halfYear = new Date(now.getTime() - (365 / 2) * 24 * 60 * 60 * 1000);
    const score = normalizeRecency(halfYear, now);
    assert.ok(Math.abs(score - 0.5) < 0.01, `Expected ~0.5, got ${score}`);
  });

  it('returns 0 for very old documents', () => {
    const now = new Date();
    const twoYearsAgo = new Date(now.getTime() - 730 * 24 * 60 * 60 * 1000);
    assert.strictEqual(normalizeRecency(twoYearsAgo, now), 0);
  });
});

describe('computeScore', () => {
  it('returns similarity-dominated score with default weights', () => {
    const input: ScoringInput = {
      similarity: 0.8,
      accessCount: 0,
      maxAccess: 100,
      lastModified: new Date(),
      now: new Date(),
      queryMatchesTopic: false,
    };
    const result = computeScore(input);
    // 0.7 * 0.8 + 0.15 * 0 + 0.10 * 1.0 + 0.05 * 0 = 0.56 + 0 + 0.10 + 0 = 0.66
    assert.ok(Math.abs(result.score - 0.66) < 0.01, `Expected ~0.66, got ${result.score}`);
  });

  it('boosts score for hot chunks', () => {
    const base: ScoringInput = {
      similarity: 0.5,
      accessCount: 0,
      maxAccess: 100,
      lastModified: new Date(),
      now: new Date(),
      queryMatchesTopic: false,
    };
    const hot: ScoringInput = { ...base, accessCount: 100 };

    const baseResult = computeScore(base);
    const hotResult = computeScore(hot);
    assert.ok(hotResult.score > baseResult.score, 'Hot chunk should score higher');
  });

  it('includes breakdown in result', () => {
    const input: ScoringInput = {
      similarity: 0.9,
      accessCount: 50,
      maxAccess: 100,
      lastModified: new Date(),
      now: new Date(),
      queryMatchesTopic: true,
    };
    const result = computeScore(input);
    assert.ok('breakdown' in result);
    assert.ok('similarity' in result.breakdown);
    assert.ok('heat' in result.breakdown);
    assert.ok('recency' in result.breakdown);
    assert.ok('topic' in result.breakdown);
  });

  it('topic bonus adds to score when query matches topic', () => {
    const noMatch: ScoringInput = {
      similarity: 0.5,
      accessCount: 0,
      maxAccess: 0,
      lastModified: new Date(),
      now: new Date(),
      queryMatchesTopic: false,
    };
    const match: ScoringInput = { ...noMatch, queryMatchesTopic: true };

    const noMatchResult = computeScore(noMatch);
    const matchResult = computeScore(match);
    assert.ok(matchResult.score > noMatchResult.score);
  });
});
