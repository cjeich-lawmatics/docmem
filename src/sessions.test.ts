import { describe, it } from 'node:test';
import assert from 'node:assert';
import { shouldStartNewSession } from './sessions.js';

describe('shouldStartNewSession', () => {
  it('returns true when no existing session', () => {
    assert.strictEqual(shouldStartNewSession(null, new Date()), true);
  });

  it('returns true when session is older than timeout', () => {
    const now = new Date();
    const oldAccess = new Date(now.getTime() - 31 * 60 * 1000);
    assert.strictEqual(shouldStartNewSession(oldAccess, now), true);
  });

  it('returns false when session is within timeout', () => {
    const now = new Date();
    const recentAccess = new Date(now.getTime() - 5 * 60 * 1000);
    assert.strictEqual(shouldStartNewSession(recentAccess, now), false);
  });

  it('returns false when session just started', () => {
    const now = new Date();
    assert.strictEqual(shouldStartNewSession(now, now), false);
  });

  it('returns true at exactly the timeout boundary', () => {
    const now = new Date();
    const exact = new Date(now.getTime() - 30 * 60 * 1000);
    assert.strictEqual(shouldStartNewSession(exact, now), true);
  });
});
