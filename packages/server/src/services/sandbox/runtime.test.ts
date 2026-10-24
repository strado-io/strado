import { describe, it, expect } from 'vitest';
import { detectRuntime, realExec, sandboxEnabled } from './runtime.js';

const ok = { code: 0, stdout: 'version 5', stderr: '' };
const missing = { code: 127, stdout: '', stderr: 'not found' };

describe('detectRuntime', () => {
  it('prefers podman over docker', async () => {
    const rt = await detectRuntime(async (file) => (file === 'podman' || file === 'docker' ? ok : missing));
    expect(rt).toEqual({ bin: 'podman' });
  });
  it('falls back to docker', async () => {
    const rt = await detectRuntime(async (file) => (file === 'docker' ? ok : missing));
    expect(rt).toEqual({ bin: 'docker' });
  });
  it('null when neither present (exec throws)', async () => {
    expect(await detectRuntime(async () => { throw new Error('ENOENT'); })).toBeNull();
  });
});

describe('sandboxEnabled', () => {
  it('requires BOTH runner mode and a runtime', () => {
    const prev = process.env.STRADO_RUNNER;
    try {
      delete process.env.STRADO_RUNNER;
      expect(sandboxEnabled({ bin: 'podman' })).toBe(false);
      process.env.STRADO_RUNNER = '1';
      expect(sandboxEnabled(null)).toBe(false);
      expect(sandboxEnabled({ bin: 'podman' })).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.STRADO_RUNNER; else process.env.STRADO_RUNNER = prev;
    }
  });
});

describe('realExec', () => {
  it('streams output while running and still returns the captured streams', async () => {
    const { realExec } = await import('./runtime.js');
    const chunks: string[] = [];
    const r = await realExec('sh', ['-c', 'echo out; echo err >&2'], 5000, (c) => chunks.push(c));
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('out');
    expect(r.stderr.trim()).toBe('err');
    expect(chunks.join('')).toContain('out');
    expect(chunks.join('')).toContain('err');
  });
  it('kills at the budget and says so in stderr', async () => {
    const { realExec } = await import('./runtime.js');
    const r = await realExec('sh', ['-c', 'sleep 5'], 100);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/timed out after 0s/);
  });
  it('reports a missing binary as 127', async () => {
    const { realExec } = await import('./runtime.js');
    const r = await realExec('definitely-not-a-binary-xyz', ['--version']);
    expect(r.code).toBe(127);
  });
});

describe('detectRuntime probes that the runtime actually works', () => {
  const version = { code: 0, stdout: 'podman version 5', stderr: '' };
  it('skips a runtime whose `info` fails (docker without group membership, podman without subuid)', async () => {
    const logs: string[] = [];
    const rt = await detectRuntime(async (file, args) => {
      if (args[0] === '--version') return version;
      if (file === 'podman') return { code: 125, stdout: '', stderr: 'Error: cannot setup namespace: no subuid ranges' };
      return { code: 0, stdout: 'ok', stderr: '' };
    }, (l) => logs.push(l));
    expect(rt).toEqual({ bin: 'docker' });
    expect(logs[0]).toMatch(/podman is installed but cannot run containers.*no subuid ranges/);
  });
  it('null when every runtime fails info', async () => {
    const rt = await detectRuntime(async (_f, args) =>
      args[0] === '--version' ? version : { code: 1, stdout: '', stderr: 'permission denied while trying to connect to the Docker daemon socket' });
    expect(rt).toBeNull();
  });
});

describe('sandboxEnabled opt-out', () => {
  it('STRADO_SANDBOX=0 disables sandboxing on a runner with a runtime', () => {
    expect(sandboxEnabled({ bin: 'podman' }, { STRADO_RUNNER: '1', STRADO_SANDBOX: '0' })).toBe(false);
    expect(sandboxEnabled({ bin: 'podman' }, { STRADO_RUNNER: '1' })).toBe(true);
  });
});

describe('realExec', () => {
  it('pipes input to stdin', async () => {
    const r = await realExec('cat', [], 5_000, undefined, 'hello stdin');
    expect(r).toMatchObject({ code: 0, stdout: 'hello stdin' });
  });
});
