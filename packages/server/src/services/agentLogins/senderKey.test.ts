import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadSenderKey, nextIssuedAt, senderKeyPath } from './senderKey.js';

let tmp: string;
let prevHome: string | undefined;

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'sender-key-'));
  prevHome = process.env.STRADO_HOME;
  process.env.STRADO_HOME = tmp;
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.STRADO_HOME;
  else process.env.STRADO_HOME = prevHome;
  await fsp.rm(tmp, { recursive: true, force: true });
});

describe('laptop sender key', () => {
  it('is created once, 0600, under STRADO_HOME, and reused after', async () => {
    const a = await loadSenderKey();
    expect(senderKeyPath()).toBe(path.join(tmp, 'agent-login-sender.key'));
    expect((await fsp.stat(senderKeyPath())).mode & 0o777).toBe(0o600);
    expect(Buffer.from(a.publicKey, 'base64')).toHaveLength(32);
    expect(await loadSenderKey()).toEqual(a);
  });

  it('concurrent first loads agree on one key and leave no temp files', async () => {
    const keys = await Promise.all(Array.from({ length: 8 }, () => loadSenderKey()));
    expect(new Set(keys.map((k) => k.publicKey)).size).toBe(1);
    expect(await fsp.readdir(tmp)).toEqual(['agent-login-sender.key']);
  });

  it('a corrupt key file is an error, never silently replaced (the runner pinned the old one)', async () => {
    await fsp.writeFile(senderKeyPath(), 'garbage');
    await expect(loadSenderKey()).rejects.toThrow('sender key unreadable');
    expect(await fsp.readFile(senderKeyPath(), 'utf8')).toBe('garbage');
  });
});

describe('nextIssuedAt', () => {
  it('is strictly increasing even within one millisecond', () => {
    const xs = Array.from({ length: 50 }, () => nextIssuedAt());
    for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeGreaterThan(xs[i - 1]!);
    expect(Math.abs(xs[0]! - Date.now())).toBeLessThan(1000);
  });
});
