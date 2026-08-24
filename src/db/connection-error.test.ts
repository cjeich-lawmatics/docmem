import { describe, it } from 'node:test';
import assert from 'node:assert';
import { isConnectionRefused } from './connection-error.js';

describe('isConnectionRefused', () => {
  it('is true for ECONNREFUSED (container down)', () => {
    const err = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5433'), {
      code: 'ECONNREFUSED',
    });
    assert.strictEqual(isConnectionRefused(err), true);
  });

  it('is true for ENOTFOUND (bad host)', () => {
    const err = Object.assign(new Error('getaddrinfo ENOTFOUND db'), { code: 'ENOTFOUND' });
    assert.strictEqual(isConnectionRefused(err), true);
  });

  it('is true for EAI_AGAIN (DNS temp failure)', () => {
    const err = Object.assign(new Error('getaddrinfo EAI_AGAIN db'), { code: 'EAI_AGAIN' });
    assert.strictEqual(isConnectionRefused(err), true);
  });

  it('is true for a connect ETIMEDOUT', () => {
    const err = Object.assign(new Error('connect ETIMEDOUT 127.0.0.1:5433'), {
      code: 'ETIMEDOUT',
    });
    assert.strictEqual(isConnectionRefused(err), true);
  });

  it('is true for the pg startup "Connection terminated" failure', () => {
    assert.strictEqual(isConnectionRefused(new Error('Connection terminated unexpectedly')), true);
  });

  it('is false for a SQL syntax error (server was reached)', () => {
    assert.strictEqual(isConnectionRefused(new Error('syntax error at or near "SELCT"')), false);
  });

  it('is false for undefined_table 42P01 (server was reached)', () => {
    const err = Object.assign(new Error('relation "docmem.projects" does not exist'), {
      code: '42P01',
    });
    assert.strictEqual(isConnectionRefused(err), false);
  });

  it('is false for a non-error value', () => {
    assert.strictEqual(isConnectionRefused(null), false);
    assert.strictEqual(isConnectionRefused('nope'), false);
  });
});
