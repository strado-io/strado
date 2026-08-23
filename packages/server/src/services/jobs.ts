import { randomUUID } from 'node:crypto';
import type { EventBus } from '../events/bus.js';
import { toResponse } from '../errors.js';

export type JobStatus = 'pending' | 'running' | 'done' | 'error';

export type JobContext = {
  progress(message: string, data?: unknown): void;
};

export type Job<T> = {
  id: string;
  kind: string;
  status: JobStatus;
  result?: T;
  error?: unknown;
};

export type JobQueue = {
  start<T>(kind: string, fn: (ctx: JobContext) => Promise<T>): Job<T>;
  get<T>(id: string): Job<T> | undefined;
  wait<T>(id: string): Promise<Job<T>>;
};

export function createJobQueue(bus: EventBus): JobQueue {
  const jobs = new Map<string, Job<unknown>>();
  const waiters = new Map<string, ((job: Job<unknown>) => void)[]>();

  function emitChange(job: Job<unknown>, type: 'progress' | 'done' | 'error', data: unknown) {
    bus.emit(`job:${job.id}`, { type, data });
    if (type === 'done' || type === 'error') {
      const list = waiters.get(job.id) ?? [];
      waiters.delete(job.id);
      for (const fn of list) fn(job);
    }
  }

  return {
    start(kind, fn) {
      const id = randomUUID();
      const job: Job<unknown> = { id, kind, status: 'running' };
      jobs.set(id, job);

      const ctx: JobContext = {
        progress(message, data) {
          emitChange(job, 'progress', { message, data });
        },
      };

      void Promise.resolve()
        .then(() => fn(ctx))
        .then((result) => {
          job.status = 'done';
          job.result = result;
          emitChange(job, 'done', { result });
        })
        .catch((err) => {
          job.status = 'error';
          job.error = err;
          emitChange(job, 'error', toResponse(err).error);
        });

      return job as Job<never>;
    },
    get(id) {
      return jobs.get(id) as Job<never> | undefined;
    },
    wait(id) {
      const existing = jobs.get(id);
      if (!existing) return Promise.reject(new Error(`job ${id} not found`));
      if (existing.status === 'done' || existing.status === 'error') {
        return Promise.resolve(existing as Job<never>);
      }
      return new Promise((resolve) => {
        const list = waiters.get(id) ?? [];
        list.push((j) => resolve(j as Job<never>));
        waiters.set(id, list);
      });
    },
  };
}
