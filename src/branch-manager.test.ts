import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  collectKnownBranches,
  findStaleBranches,
  isMainBranch,
  normalizeBranchName,
  parseBranchLines,
} from './branch-manager.js';

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

describe('parseBranchLines', () => {
  it('normalizes local branch output', () => {
    assert.deepStrictEqual(
      parseBranchLines('  main\n* codex/sc-123\n  feature/docs\n'),
      ['main', 'codex/sc-123', 'feature/docs']
    );
  });

  it('normalizes remote branch output and drops symbolic refs', () => {
    assert.deepStrictEqual(
      parseBranchLines('  origin/main\n  origin/feature/docs\n  origin/HEAD -> origin/main\n', 'origin/'),
      ['main', 'feature/docs']
    );
  });

  it('strips ANSI color codes emitted when color.ui=always', () => {
    // git renders `*` on the current branch in green and other branches uncolored,
    // but with `color.ui=always` each line is wrapped in ANSI SGR sequences.
    const colored =
      '  [31marnie-hk/sc-47198[m\n' +
      '* [32mchriseich/sc-46487/custom-form-share-sent-activity[m\n' +
      '  [31mmaster[m\n';
    assert.deepStrictEqual(
      parseBranchLines(colored),
      ['arnie-hk/sc-47198', 'chriseich/sc-46487/custom-form-share-sent-activity', 'master']
    );
  });
});

describe('collectKnownBranches', () => {
  it('keeps local-only branches', () => {
    const known = collectKnownBranches(
      ['main', 'codex/sc-123', 'feature/docs'],
      ['main']
    );

    assert.deepStrictEqual(
      [...known].sort(),
      ['main', 'master', 'codex/sc-123', 'feature/docs'].sort()
    );
  });
});

describe('findStaleBranches', () => {
  it('does not mark local-only branches as stale', () => {
    const stale = findStaleBranches(
      ['codex/sc-123', 'feature/docs'],
      new Set(['main', 'master', 'codex/sc-123', 'feature/docs'])
    );

    assert.deepStrictEqual(stale, []);
  });

  it('keeps remote-only branches', () => {
    const stale = findStaleBranches(
      ['feature/server'],
      new Set(['main', 'master', 'feature/server'])
    );

    assert.deepStrictEqual(stale, []);
  });

  it('marks branches missing locally and remotely as stale', () => {
    const stale = findStaleBranches(
      ['feature/removed', 'codex/sc-123'],
      new Set(['main', 'master', 'codex/sc-123'])
    );

    assert.deepStrictEqual(stale, ['feature/removed']);
  });
});
