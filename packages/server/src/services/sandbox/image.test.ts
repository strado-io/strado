import { describe, it, expect } from 'vitest';
import { imageTag, ensureBaseImage, dockerfilePath } from './image.js';
import fsp from 'node:fs/promises';

describe('imageTag', () => {
  it('encodes the node major', () => {
    expect(imageTag('22')).toBe('strado-sandbox:node22-v4');
    expect(imageTag(null)).toBe('strado-sandbox:base-v4');
  });
});

describe('Dockerfile', () => {
  it('installs all four agents and takes NODE_MAJOR', async () => {
    const df = await fsp.readFile(dockerfilePath(), 'utf8');
    for (const pkg of [
      '@anthropic-ai/claude-code',
      '@openai/codex',
      'opencode-ai',
      '@earendil-works/pi-coding-agent',
    ]) expect(df).toContain(pkg);
    expect(df).toContain('ARG NODE_MAJOR');
  });

  it('runs as the uid-1000 node user, not a colliding new user, and trusts bind mounts', async () => {
    const df = await fsp.readFile(dockerfilePath(), 'utf8');
    // node:bookworm already owns uid 1000; creating a user here bumps to 1001
    // and the container can no longer write the host-1000-owned worktree.
    expect(df).toContain('USER node');
    expect(df).not.toMatch(/^\s*RUN\b.*useradd/m); // no user-creating instruction
    expect(df).toContain("safe.directory '*'");
  });
});

describe('ensureBaseImage', () => {
  it('skips the build when the image exists', async () => {
    const calls: string[][] = [];
    await ensureBaseImage({ bin: 'podman' }, { node: '22' }, async (_f, args) => {
      calls.push(args);
      return { code: 0, stdout: 'abc123', stderr: '' }; // inspect succeeds
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe('image');
  });

  it('builds with the right tag and NODE_MAJOR when absent', async () => {
    const calls: string[][] = [];
    await ensureBaseImage({ bin: 'podman' }, { node: '20' }, async (_f, args) => {
      calls.push(args);
      return args[0] === 'image' ? { code: 1, stdout: '', stderr: 'no such image' } : { code: 0, stdout: '', stderr: '' };
    });
    const build = calls.find((a) => a[0] === 'build')!;
    expect(build).toContain('strado-sandbox:node20-v4');
    expect(build.join(' ')).toContain('NODE_MAJOR=20');
  });

  it('gives the build a long timeout but not the inspect (a build takes minutes)', async () => {
    const seen: { cmd: string; timeoutMs: number | undefined }[] = [];
    await ensureBaseImage({ bin: 'podman' }, { node: '20' }, async (_f, args, timeoutMs) => {
      seen.push({ cmd: args[0]!, timeoutMs });
      return args[0] === 'image' ? { code: 1, stdout: '', stderr: '' } : { code: 0, stdout: '', stderr: '' };
    });
    const inspect = seen.find((s) => s.cmd === 'image')!;
    const build = seen.find((s) => s.cmd === 'build')!;
    // inspect keeps the default (no explicit budget); build must exceed 10 min,
    // or a real `podman build` is killed before it finishes (the 10s default).
    expect(inspect.timeoutMs).toBeUndefined();
    expect(build.timeoutMs).toBeGreaterThanOrEqual(10 * 60_000);
  });

  it('throws with stderr when the build fails', async () => {
    await expect(
      ensureBaseImage({ bin: 'podman' }, { node: null }, async (_f, args) =>
        args[0] === 'image' ? { code: 1, stdout: '', stderr: '' } : { code: 1, stdout: '', stderr: 'network unreachable' },
      ),
    ).rejects.toThrow(/network unreachable/);
  });
});
