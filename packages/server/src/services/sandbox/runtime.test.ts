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
