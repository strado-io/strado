import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkPin, peekPin, pinsPath, replacePin, resetPin } from './pins.js';

let tmp: string;
let prevHome: string | undefined;

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'runner-pins-'));
  prevHome = process.env.STRADO_HOME;
  process.env.STRADO_HOME = tmp;
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.STRADO_HOME;
  else process.env.STRADO_HOME = prevHome;
  await fsp.rm(tmp, { recursive: true, force: true });
});

describe('runner key pins', () => {
  it('first call new, same match, different changed, after reset new', async () => {
    expect(await checkPin('r1', 'aaaa-bbbb-cccc-dddd')).toBe('new');
    expect(await checkPin('r1', 'aaaa-bbbb-cccc-dddd')).toBe('match');
    expect(await checkPin('r1', 'ffff-bbbb-cccc-dddd')).toBe('changed');
    expect(await checkPin('r1', 'aaaa-bbbb-cccc-dddd')).toBe('match');
    await resetPin('r1');
    expect(await checkPin('r1', 'ffff-bbbb-cccc-dddd')).toBe('new');
    expect(await checkPin('r1', 'ffff-bbbb-cccc-dddd')).toBe('match');
  });

  it('pins are per runner; reset touches only its own', async () => {
    await checkPin('r1', 'aaaa');
    await checkPin('r2', 'bbbb');
    await resetPin('r1');
    expect(await checkPin('r2', 'bbbb')).toBe('match');
    expect(await checkPin('r1', 'cccc')).toBe('new');
  });

  it('the file is mode 600 under STRADO_HOME', async () => {
    await checkPin('r1', 'aaaa');
    expect(pinsPath()).toBe(path.join(tmp, 'runner-key-pins.json'));
    expect((await fsp.stat(pinsPath())).mode & 0o777).toBe(0o600);
  });

  it('a corrupt file starts over rather than throwing', async () => {
    await fsp.writeFile(pinsPath(), 'garbage');
    expect(await checkPin('r1', 'aaaa')).toBe('new');
  });
});

describe('pins: hardening', () => {
  it('peekPin reads without recording', async () => {
    expect(await peekPin('r1')).toBeNull();
    expect(await peekPin('r1')).toBeNull();
    await checkPin('r1', 'aaaa');
    expect(await peekPin('r1')).toBe('aaaa');
  });

  it('concurrent first syncs to different runners keep both pins', async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) => checkPin(`r${i}`, `fp${i}`)));
    for (let i = 0; i < 20; i++) expect(await peekPin(`r${i}`)).toBe(`fp${i}`);
  });

  it('concurrent first syncs to one runner: exactly one is new, the same key matches', async () => {
    const res = await Promise.all([checkPin('r1', 'aaaa'), checkPin('r1', 'aaaa'), checkPin('r1', 'bbbb')]);
    expect(res).toEqual(['new', 'match', 'changed']);
  });

  it('an existing file with loose permissions is tightened to 600 on write', async () => {
    await fsp.writeFile(pinsPath(), '{}', { mode: 0o644 });
    await fsp.chmod(pinsPath(), 0o644);
    await checkPin('r1', 'aaaa');
    expect((await fsp.stat(pinsPath())).mode & 0o777).toBe(0o600);
  });

  it('leaves no temp files behind', async () => {
    await checkPin('r1', 'aaaa');
    await resetPin('r1');
    expect(await fsp.readdir(tmp)).toEqual(['runner-key-pins.json']);
  });
});

describe('replacePin', () => {
  it('swaps the pin only while it still holds the key the person was shown', async () => {
    await checkPin('r1', 'OLD');
    expect(await replacePin('r1', 'OTHER', 'NEW')).toBe(false);
    expect(await peekPin('r1')).toBe('OLD');
    expect(await replacePin('r1', 'OLD', 'NEW')).toBe(true);
    expect(await peekPin('r1')).toBe('NEW');
  });

  it('never creates a pin', async () => {
    expect(await replacePin('r9', 'OLD', 'NEW')).toBe(false);
    expect(await peekPin('r9')).toBeNull();
  });
});
