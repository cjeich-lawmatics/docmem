import { describe, it } from 'node:test';
import assert from 'node:assert';
import { isMainBranch, normalizeBranchName } from './branch-manager.js';

describe('isMainBranch', () => {
  it('returns true for master', () => {
    assert.strictEqual(isMainBranch('master'), true);
  });

  it('returns true for main', () => {
    assert.strictEqual(isMainBranch('main'), true);
  });

  it('returns false for feature branches', () => {
    assert.strictEqual(isMainBranch('feature/billing'), false);
  });

  it('returns false for develop', () => {
    assert.strictEqual(isMainBranch('develop'), false);
  });
});

describe('normalizeBranchName', () => {
  it('trims whitespace and newlines', () => {
    assert.strictEqual(normalizeBranchName('  master\n'), 'master');
  });

  it('handles refs/heads/ prefix', () => {
    assert.strictEqual(normalizeBranchName('refs/heads/feature/foo'), 'feature/foo');
  });

  it('returns input as-is when clean', () => {
    assert.strictEqual(normalizeBranchName('feature/billing'), 'feature/billing');
  });

  it('handles detached HEAD (empty)', () => {
    assert.strictEqual(normalizeBranchName(''), 'detached');
  });
});
