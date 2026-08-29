import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { installOpencodePlugin, piExtensionPath } from '../../src/services/claudeHooks';

let dir: string;
beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'oc-'));
});
afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

// Pi loads its status extension by path (`pi -e <path>`) rather than from a
// copy inside the worktree, so the launch command is only correct as long as
// the file it names actually ships.
describe('piExtensionPath', () => {
  it('names a shipped extension that posts to the pi status route', async () => {
    const p = piExtensionPath();
    expect(fs.existsSync(p)).toBe(true);
    const body = await fsp.readFile(p, 'utf8');
    expect(body).toContain('/api/pi/status');
    expect(body).toContain('agent_settled');
  });

  it('writes nothing into the worktree', async () => {
    expect(fs.existsSync(path.join(dir, '.pi'))).toBe(false);
  });
});

describe('installOpencodePlugin', () => {
  it('writes the plugin into <worktree>/.opencode/plugin', async () => {
    await installOpencodePlugin(dir);
    const p = path.join(dir, '.opencode', 'plugin', 'strado-opencode-status.js');
    expect(fs.existsSync(p)).toBe(true);
    const body = await fsp.readFile(p, 'utf8');
    expect(body).toContain('/api/opencode/status');
  });
});
