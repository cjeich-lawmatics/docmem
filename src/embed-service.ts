import { Worker } from 'node:worker_threads';

export interface WorkerLike {
  postMessage(value: unknown): void;
  on(event: string, listener: (...args: any[]) => void): void;
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

  constructor(private factory: WorkerFactory = defaultFactory) {}

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
    w.on('message', (msg: { id: string; embedding?: number[] }) => {
      const p = this.pending.get(msg.id);
      if (!p) return; // late reply after timeout — discard
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      p.resolve(msg.embedding ?? null);
    });
    w.on('error', () => this.failAll());
    w.on('exit', () => this.failAll());
    this.worker = w;
    return w;
  }

  private failAll(): void {
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
