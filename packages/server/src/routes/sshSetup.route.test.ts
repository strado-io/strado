// The "Add over SSH" routes: start validates and starts the job, answer and
// cancel reach the live run. The job body is faked: it asks one question and
// returns, so the wiring is tested without spawning ssh.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp, buildDeps } from '../app.js';
import { VIA_RELAY_HEADER } from './appControl.js';
import type { SshSetupQuestion } from '../services/sshSetup/types.js';

const seen: { dest?: unknown; name?: unknown; jobId?: string } = {};

vi.mock('../services/sshSetup/job.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../services/sshSetup/job.js')>();
  return {
    ...orig,
    runSshSetup: async (
      ctx: { progress(m: string, d?: unknown): void },
      input: { jobId: string; dest: unknown; name: unknown },
      _deps: unknown,
      run: { ask(ctx: unknown, q: Omit<SshSetupQuestion, 'id'>): Promise<boolean>; transcript: string[] },
    ) => {
      Object.assign(seen, input);
      run.transcript.push('▸ Connect', 'Connected');
      const yes = await run.ask(ctx, { kind: 'linger', message: 'Linger?', command: 'loginctl enable-linger' });
      return { runnerId: 'r1', name: 'box', sandboxes: yes, warnings: [] };
    },
  };
});

let tmp: string;
let prevHome: string | undefined;
let app: Awaited<ReturnType<typeof buildApp>>;

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ssh-setup-route-')));
  prevHome = process.env.STRADO_HOME;
  process.env.STRADO_HOME = path.join(tmp, 'home');
  const deps = await buildDeps({ configDir: path.join(tmp, 'config'), homeStateDir: path.join(tmp, 'state') });
  app = await buildApp(deps);
  for (const k of Object.keys(seen)) delete (seen as Record<string, unknown>)[k];
});

afterEach(async () => {
  await app.close();
  if (prevHome === undefined) delete process.env.STRADO_HOME;
  else process.env.STRADO_HOME = prevHome;
  await fs.rm(tmp, { recursive: true, force: true });
});

const start = (payload: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url: '/api/runners/ssh-setup', payload: payload as object, headers });

/** Start a run and wait for its question frame. */
async function startAndAsk() {
  const res = await start({ destination: 'ssh://u@h:2222', name: 'box' });
  expect(res.statusCode).toBe(200);
  const { jobId } = res.json() as { jobId: string };
  await vi.waitFor(() => expect((app.deps.jobs.get(jobId)?.progress?.data as { question?: unknown })?.question).toBeTruthy());
  const q = (app.deps.jobs.get(jobId)!.progress!.data as { question: SshSetupQuestion }).question;
  return { jobId, q };
}

describe('POST /api/runners/ssh-setup', () => {
  it('starts a job with the parsed destination, the name, and its own job id', async () => {
    const { jobId } = await startAndAsk();
    expect(seen).toEqual({ jobId, dest: { target: 'u@h', port: 2222 }, name: 'box' });
  });

  it('a relayed or foreign-origin request → 403, no job', async () => {
    expect((await start({ destination: 'u@h' }, { [VIA_RELAY_HEADER]: '1' })).statusCode).toBe(403);
    expect((await start({ destination: 'u@h' }, { origin: 'https://evil.example' })).statusCode).toBe(403);
    expect(seen.jobId).toBeUndefined();
  });

  it.each([
    [{ destination: '-oProxyCommand=touch /tmp/pwn' }],
    [{ destination: 'u@h x' }],
    [{ destination: 'u@h', name: 'bad name' }],
    [{ destination: 'u@h', name: '-x' }],
    [{ destination: 'u@h', command: 'rm -rf ~' }],
    [{}],
  ])('refuses %j with 400 before any job', async (payload) => {
    const res = await start(payload);
    expect(res.statusCode).toBe(400);
    expect(seen.jobId).toBeUndefined();
  });

  it('no name → null', async () => {
    const res = await start({ destination: 'u@h' });
    expect(res.statusCode).toBe(200);
    await vi.waitFor(() => expect(seen.name).toBeNull());
  });
});

describe('answer + cancel', () => {
  it('an answer reaches the waiting question and the job finishes', async () => {
    const { jobId, q } = await startAndAsk();
    const res = await app.inject({ method: 'POST', url: `/api/runners/ssh-setup/${jobId}/answer`, payload: { questionId: q.id, yes: true } });
    expect(res.statusCode).toBe(204);
    const job = await app.deps.jobs.wait<{ sandboxes: boolean }>(jobId);
    expect(job.status).toBe('done');
    expect(job.result!.sandboxes).toBe(true);
  });

  it('unknown job or question → 404; relayed → 403', async () => {
    const { jobId, q } = await startAndAsk();
    expect((await app.inject({ method: 'POST', url: `/api/runners/ssh-setup/${jobId}/answer`, payload: { questionId: 'nope', yes: true } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/runners/ssh-setup/missing/answer', payload: { questionId: q.id, yes: true } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/api/runners/ssh-setup/${jobId}/answer`, payload: { questionId: q.id, yes: true }, headers: { [VIA_RELAY_HEADER]: '1' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/api/runners/ssh-setup/${jobId}/cancel`, headers: { [VIA_RELAY_HEADER]: '1' } })).statusCode).toBe(403);
  });

  it('cancel ends the run with the fixed message; a second cancel is 404', async () => {
    const { jobId } = await startAndAsk();
    const kill = vi.spyOn(app.deps.terminal, 'kill');
    expect((await app.inject({ method: 'POST', url: `/api/runners/ssh-setup/${jobId}/cancel` })).statusCode).toBe(204);
    expect(kill).toHaveBeenCalledWith(`\0ssh-setup:${jobId}`);
    const job = await app.deps.jobs.wait(jobId);
    expect(job.status).toBe('error');
    expect((job.error as Error).message).toBe('setup cancelled');
    expect((await app.inject({ method: 'POST', url: `/api/runners/ssh-setup/${jobId}/cancel` })).statusCode).toBe(404);
  });
});

describe('GET transcript', () => {
  const transcript = (jobId: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url: `/api/runners/ssh-setup/${jobId}/transcript`, headers });

  it('replays every line so far to a page that attaches late, during the run and after it ends', async () => {
    const { jobId, q } = await startAndAsk();
    expect((await transcript(jobId)).json()).toEqual({ lines: ['▸ Connect', 'Connected'] });
    await app.inject({ method: 'POST', url: `/api/runners/ssh-setup/${jobId}/answer`, payload: { questionId: q.id, yes: true } });
    await app.deps.jobs.wait(jobId);
    expect((await transcript(jobId)).json()).toEqual({ lines: ['▸ Connect', 'Connected'] });
  });

  it('kept after a cancel too (that is when the reason matters)', async () => {
    const { jobId } = await startAndAsk();
    await app.inject({ method: 'POST', url: `/api/runners/ssh-setup/${jobId}/cancel` });
    await app.deps.jobs.wait(jobId);
    expect((await transcript(jobId)).statusCode).toBe(200);
  });

  it('unknown job → 404; relayed → 403', async () => {
    expect((await transcript('missing')).statusCode).toBe(404);
    const { jobId } = await startAndAsk();
    expect((await transcript(jobId, { [VIA_RELAY_HEADER]: '1' })).statusCode).toBe(403);
  });
});
