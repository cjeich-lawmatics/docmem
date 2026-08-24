import { Worker } from 'node:worker_threads';

export interface WorkerLike {
  postMessage(value: unknown): void;
  on(event: string, listener: (...args: any[]) => void): void;
  terminate(): void;
}

export type WorkerFactory = () => WorkerLike;

const defaultFactory: WorkerFactory = () =>
  new Worker(new URL('./embed-worker.js', import.meta.url));

interface Pending {
  resolve: (value: number[] | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class EmbedService {
  private worker: WorkerLike | null = null;
  private pending = new Map<string, Pending>();
  private seq = 0;
  private unacked = 0;
  private lastActivityAt = 0;
  private watchdog: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private factory: WorkerFactory = defaultFactory,
    private recycleMs = 60000,
  ) {}

  start(): void {
    this.ensureWorker();
  }

  embedQueryAsync(query: string, timeoutMs = 1500): Promise<number[] | null> {
    let worker: WorkerLike;
    try {
      worker = this.ensureWorker();
    } catch {
      return Promise.resolve(null);
    }

    const id = String(++this.seq);
    return new Promise<number[] | null>(resolve => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(null);
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      try {
        worker.postMessage({ id, query });
        this.unacked++;
        this.armWatchdog();
      } catch {
        this.pending.delete(id);
        clearTimeout(timer);
        resolve(null);
      }
    });
  }

  private ensureWorker(): WorkerLike {
    if (this.worker) return this.worker;
    const w = this.factory();
    w.on('message', (msg: { id: string; embedding?: number[]; error?: string }) => {
      this.lastActivityAt = Date.now();
      this.unacked = 0;
      const p = this.pending.get(msg.id);
      if (!p) return; // late reply after timeout — discard (still counted as liveness above)
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      if (msg.error) console.error('[embed-worker] embed failed:', msg.error);
      p.resolve(msg.embedding ?? null);
    });
    w.on('error', (err: Error) => {
      console.error('[embed-worker] worker error:', err);
      this.recycleWorker();
    });
    w.on('exit', (code: number) => {
      if (code !== 0) console.error(`[embed-worker] worker exited with code ${code}`);
      this.failAll();
    });
    this.worker = w;
    this.lastActivityAt = Date.now();
    this.unacked = 0;
    return w;
  }

  private armWatchdog(): void {
    if (this.watchdog) return;
    this.watchdog = setTimeout(() => this.checkWatchdog(), this.recycleMs);
    this.watchdog.unref?.();
  }

  private checkWatchdog(): void {
    this.watchdog = null;
    if (!this.worker) return;
    if (this.unacked === 0) return; // worker acked everything; disarm
    const silence = Date.now() - this.lastActivityAt;
    if (silence >= this.recycleMs) {
      console.error(`[embed-worker] recycling unresponsive worker after ${silence}ms of silence`);
      this.recycleWorker();
    } else {
      this.watchdog = setTimeout(() => this.checkWatchdog(), this.recycleMs - silence);
      this.watchdog.unref?.();
    }
  }

  private recycleWorker(): void {
    const w = this.worker;
    this.failAll();
    if (w) {
      try {
        w.terminate();
      } catch {
        // ignore terminate failures on an already-dead worker
      }
    }
  }

  private failAll(): void {
    if (this.watchdog) {
      clearTimeout(this.watchdog);
      this.watchdog = null;
    }
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.resolve(null);
    }
    this.pending.clear();
    this.worker = null; // force respawn on next call
  }
}

const singleton = new EmbedService();

export function startEmbedWorker(): void {
  singleton.start();
}

export function embedQueryAsync(query: string, timeoutMs?: number): Promise<number[] | null> {
  return singleton.embedQueryAsync(query, timeoutMs);
}
