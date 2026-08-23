import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pruneDeadIdeLocks } from '../../src/services/ideLockfiles.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ide-locks-'));
}

describe('pruneDeadIdeLocks', () => {
  let dir: string;
  beforeEach(() => { dir = tmpDir(); });

  it('deletes a lock for a dead pid we own', () => {
    fs.writeFileSync(path.join(dir, '4242.lock'), JSON.stringify({ pid: 4242 }));
    pruneDeadIdeLocks([4242], { dir, isAlive: () => false });
    expect(fs.existsSync(path.join(dir, '4242.lock'))).toBe(false);
  });

  it('keeps a lock whose pid is still alive', () => {
    fs.writeFileSync(path.join(dir, '4242.lock'), JSON.stringify({ pid: 4242 }));
    pruneDeadIdeLocks([4242], { dir, isAlive: () => true });
    expect(fs.existsSync(path.join(dir, '4242.lock'))).toBe(true);
  });

  it('ignores locks for pids we did not spawn', () => {
    fs.writeFileSync(path.join(dir, '9999.lock'), JSON.stringify({ pid: 9999 }));
    pruneDeadIdeLocks([4242], { dir, isAlive: () => false });
    expect(fs.existsSync(path.join(dir, '9999.lock'))).toBe(true);
  });

  it('parses pid from filename when body has no pid', () => {
    fs.writeFileSync(path.join(dir, '4242.lock'), 'not json');
    pruneDeadIdeLocks([4242], { dir, isAlive: () => false });
    expect(fs.existsSync(path.join(dir, '4242.lock'))).toBe(false);
  });

  it('never throws when the dir is missing', () => {
    expect(() => pruneDeadIdeLocks([1], { dir: path.join(dir, 'nope'), isAlive: () => false })).not.toThrow();
  });
});
