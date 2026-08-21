import { describe, it } from 'node:test';
import assert from 'node:assert';
import { EmbedService, type WorkerLike } from './embed-service.js';

class FakeWorker implements WorkerLike {
  posted: Array<{ id: string; query: string }> = [];
  private handlers: Record<string, Array<(...a: any[]) => void>> = {};
  postMessage(value: unknown) { this.posted.push(value as any); }
  on(event: string, listener: (...a: any[]) => void) {
    (this.handlers[event] ??= []).push(listener);
  }
  emit(event: string, ...args: any[]) {
    (this.handlers[event] ?? []).forEach(h => h(...args));
  }
}

function serviceWithFakes() {
  const created: FakeWorker[] = [];
  const svc = new EmbedService(() => {
    const w = new FakeWorker();
    created.push(w);
    return w;
  });
  return { svc, created };
}

describe('EmbedService', () => {
  it('resolves with the embedding when the worker replies in time', async () => {
    const { svc, created } = serviceWithFakes();
    const p = svc.embedQueryAsync('hello', 1000);
    const { id } = created[0].posted[0];
    created[0].emit('message', { id, embedding: [1, 2, 3] });
    assert.deepStrictEqual(await p, [1, 2, 3]);
  });

  it('resolves null when the worker does not reply within the timeout', async () => {
    const { svc } = serviceWithFakes();
    const result = await svc.embedQueryAsync('hello', 10);
    assert.strictEqual(result, null);
  });

  it('ignores a late reply that arrives after the timeout', async () => {
    const { svc, created } = serviceWithFakes();
    const p = svc.embedQueryAsync('hello', 10);
    const { id } = created[0].posted[0];
    assert.strictEqual(await p, null);
    // Late reply must not throw and must not affect anything.
    assert.doesNotThrow(() => created[0].emit('message', { id, embedding: [9] }));
    // Service still usable afterward.
    const p2 = svc.embedQueryAsync('again', 1000);
    const second = created[0].posted[1];
    created[0].emit('message', { id: second.id, embedding: [4] });
    assert.deepStrictEqual(await p2, [4]);
  });

  it('resolves null on a worker error and respawns on the next call', async () => {
    const { svc, created } = serviceWithFakes();
    const p = svc.embedQueryAsync('hello', 1000);
    created[0].emit('error', new Error('boom'));
    assert.strictEqual(await p, null);

    const p2 = svc.embedQueryAsync('after', 1000);
    assert.strictEqual(created.length, 2); // new worker spawned
    const { id } = created[1].posted[0];
    created[1].emit('message', { id, embedding: [7] });
    assert.deepStrictEqual(await p2, [7]);
  });

  it('resolves null on worker exit', async () => {
    const { svc, created } = serviceWithFakes();
    const p = svc.embedQueryAsync('hello', 1000);
    created[0].emit('exit', 1);
    assert.strictEqual(await p, null);
  });
});
