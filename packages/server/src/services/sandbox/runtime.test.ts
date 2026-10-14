import { describe, it, expect } from 'vitest';
import { detectRuntime, sandboxEnabled } from './runtime.js';

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
