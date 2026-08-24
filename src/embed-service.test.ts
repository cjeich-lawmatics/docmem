import { describe, it } from 'node:test';
import assert from 'node:assert';
import { EmbedService, type WorkerLike } from './embed-service.js';

class FakeWorker implements WorkerLike {
  posted: Array<{ id: string; query: string }> = [];
  terminated = false;
  private handlers: Record<string, Array<(...a: any[]) => void>> = {};
  postMessage(value: unknown) { this.posted.push(value as any); }
  on(event: string, listener: (...a: any[]) => void) {
    (this.handlers[event] ??= []).push(listener);
  }
  emit(event: string, ...args: any[]) {
    (this.handlers[event] ?? []).forEach(h => h(...args));
  }
  terminate() { this.terminated = true; }
}

function serviceWithFakes(recycleMs = 60000) {
  const created: FakeWorker[] = [];
  const svc = new EmbedService(() => {
    const w = new FakeWorker();
    created.push(w);
    return w;
  }, recycleMs);
  return { svc, created };
}

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

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

describe('EmbedService hung-worker watchdog', () => {
  it('recycles a worker that never replies and respawns on the next call', async () => {
    const { svc, created } = serviceWithFakes(30);
    const result = await svc.embedQueryAsync('hello', 1000); // no reply ever
    assert.strictEqual(result, null);              // recycle resolved it null
    assert.strictEqual(created[0].terminated, true);

    const p2 = svc.embedQueryAsync('again', 1000); // next call spawns a fresh worker
    assert.strictEqual(created.length, 2);
    created[1].emit('message', { id: created[1].posted[0].id, embedding: [1] });
    assert.deepStrictEqual(await p2, [1]);
  });

  it('does not recycle a worker that replies', async () => {
    const { svc, created } = serviceWithFakes(30);
    const p = svc.embedQueryAsync('hello', 1000);
    created[0].emit('message', { id: created[0].posted[0].id, embedding: [2] });
    assert.deepStrictEqual(await p, [2]);
    await delay(80); // well past recycleMs
    assert.strictEqual(created[0].terminated, false);
    assert.strictEqual(created.length, 1);
  });

  it('keeps the worker alive across a client timeout when it later replies', async () => {
    const { svc, created } = serviceWithFakes(60);
    const p = svc.embedQueryAsync('hello', 10); // short client timeout
    assert.strictEqual(await p, null);           // client gave up at 10ms
    await delay(20);
    created[0].emit('message', { id: created[0].posted[0].id, embedding: [3] }); // late reply
    await delay(80); // past the original recycle window
    assert.strictEqual(created[0].terminated, false);
  });
});
