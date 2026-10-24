import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdPair, cmdUnpair } from '../src/index.js';
import { readIdentity, writeIdentity, type RunnerIdentity } from '../src/identity.js';

let dir: string;
const savedArgv = process.argv;
const savedHome = process.env.STRADO_HOME;
let out: string[];

const identity = (runnerId: string): RunnerIdentity => ({
  runnerId,
  runnerToken: 't'.repeat(64),
  accessKey: 'a'.repeat(32),
  apiUrl: 'https://api.strado.io',
});

function deps(stdin = '') {
  return {
    pairRunner: vi.fn(async (o: { code: string }) => identity(`box-${o.code.slice(-4)}`)),
    readStdin: vi.fn(() => stdin),
    restartService: vi.fn(() => null),
    log: (l: string) => out.push(l),
  };
}

const argv = (...rest: string[]) => {
  process.argv = ['node', 'runner.mjs', 'pair', ...rest];
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strado-pair-'));
  process.env.STRADO_HOME = dir;
  out = [];
});

afterEach(() => {
  process.argv = savedArgv;
  if (savedHome === undefined) delete process.env.STRADO_HOME;
  else process.env.STRADO_HOME = savedHome;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('strado-runner pair', () => {
  it('--code - reads the code from stdin and prints runnerId=<id> on its own line', async () => {
    argv('--code', '-');
    const d = deps('PAIR-ABCD-WXYZ\n');
    await cmdPair(d);
    expect(d.readStdin).toHaveBeenCalled();
    expect(d.pairRunner).toHaveBeenCalledWith(expect.objectContaining({ code: 'PAIR-ABCD-WXYZ' }));
    expect(out).toContain('runnerId=box-WXYZ');
    expect(readIdentity(path.join(dir, 'runner.json'))?.runnerId).toBe('box-WXYZ');
    // The code never reaches the output.
    expect(out.join('\n')).not.toContain('PAIR-ABCD');
  });

  it('a code on argv still works and stdin is not read', async () => {
    argv('--code', 'PAIR-AAAA-BBBB');
    const d = deps();
    await cmdPair(d);
    expect(d.readStdin).not.toHaveBeenCalled();
    expect(out).toContain('runnerId=box-BBBB');
  });

  it('empty stdin is refused before any network call', async () => {
    argv('--code', '-');
    const d = deps('  \n');
    await expect(cmdPair(d)).rejects.toThrow('no pairing code on stdin');
    expect(d.pairRunner).not.toHaveBeenCalled();
  });

  it('--force wipes the previous owner\'s synced logins and sender pin', async () => {
    writeIdentity(path.join(dir, 'runner.json'), identity('box-old'));
    fs.writeFileSync(path.join(dir, 'agent-logins-runner.json'), '{"claudeToken":"x"}');
    fs.writeFileSync(path.join(dir, 'runner-sender-pin.json'), '{"spk":"y"}');
    argv('--code', '-', '--force');
    await cmdPair(deps('PAIR-NEW1-NEW2'));
    expect(fs.existsSync(path.join(dir, 'agent-logins-runner.json'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'runner-sender-pin.json'))).toBe(false);
    expect(readIdentity(path.join(dir, 'runner.json'))?.runnerId).toBe('box-NEW2');
  });

  const synced = () => {
    fs.writeFileSync(path.join(dir, 'agent-logins-runner.json'), '{"claudeToken":"old-owner"}');
    fs.writeFileSync(path.join(dir, 'runner-sender-pin.json'), '{"spk":"old-laptop"}');
  };
  const wiped = () =>
    !fs.existsSync(path.join(dir, 'agent-logins-runner.json')) && !fs.existsSync(path.join(dir, 'runner-sender-pin.json'));

  it('a first-ever pair wipes leftovers (nothing on this box was synced by this owner)', async () => {
    synced();
    argv('--code', 'PAIR-AAAA-BBBB');
    await cmdPair(deps());
    expect(wiped()).toBe(true);
  });

  it('unpair, then a plain pair, leaves nothing of the old owner', async () => {
    writeIdentity(path.join(dir, 'runner.json'), identity('box-old'));
    synced();
    cmdUnpair();
    expect(wiped()).toBe(true);
    expect(readIdentity(path.join(dir, 'runner.json'))).toBeNull();
    synced(); // even if something re-appeared in between
    argv('--code', 'PAIR-AAAA-BBBB');
    await cmdPair(deps());
    expect(wiped()).toBe(true);
  });

  it('a --force re-pair to the same runner id leaves the files alone', async () => {
    writeIdentity(path.join(dir, 'runner.json'), identity('box-BBBB'));
    synced();
    argv('--code', 'PAIR-AAAA-BBBB', '--force');
    await cmdPair(deps());
    expect(readIdentity(path.join(dir, 'runner.json'))?.runnerId).toBe('box-BBBB');
    expect(wiped()).toBe(false);
  });

  it('a failed --force pair leaves the old identity and its files in place', async () => {
    writeIdentity(path.join(dir, 'runner.json'), identity('box-old'));
    fs.writeFileSync(path.join(dir, 'runner-sender-pin.json'), '{}');
    argv('--code', '-', '--force');
    const d = deps('PAIR-NEW1-NEW2');
    d.pairRunner.mockRejectedValueOnce(new Error('pairing failed (410): expired'));
    await expect(cmdPair(d)).rejects.toThrow('pairing failed');
    expect(readIdentity(path.join(dir, 'runner.json'))?.runnerId).toBe('box-old');
    expect(fs.existsSync(path.join(dir, 'runner-sender-pin.json'))).toBe(true);
  });
});
