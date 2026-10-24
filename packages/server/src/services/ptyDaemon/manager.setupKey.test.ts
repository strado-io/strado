import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDaemonTerminalManager } from './manager.js';
import { releasePtyDaemon } from './supervisor.js';
import { SSH_SETUP_KEY_PREFIX } from '../sshSetup/types.js';
import { shellKey, type TerminalManager } from '../terminalManager.js';

// A setup pty outlives nothing: after a server restart no job owns it, so a
// left-over ssh or sudo prompt would sit in the daemon with nobody to end it.
const here = path.dirname(fileURLToPath(import.meta.url));
const daemonScript = path.resolve(here, '../../../../ptyd/dist/ptyd.cjs');
const KEY = `${SSH_SETUP_KEY_PREFIX}job-1`;
const SHELL = shellKey('/tmp', '1');
const spec = { file: '/bin/sh', args: ['-c', 'printf ready; cat'] };

let stateDir: string;
let manager: TerminalManager & { destroy(): void };
let manager2: (TerminalManager & { destroy(): void }) | null = null;

beforeEach(async () => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptyd-mgr-'));
  manager = await createDaemonTerminalManager({ stateDir, daemonScript });
});
afterEach(() => {
  manager2?.destroy();
  manager2 = null;
  manager.destroy();
  releasePtyDaemon(stateDir);
  const manifest = path.join(stateDir, 'ptyd', 'manifest.json');
  if (fs.existsSync(manifest)) {
    const { pid } = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ }
  }
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe('ptyd manager: ssh setup ptys across a server restart', () => {
  it('a restarted server kills left-over setup ptys and adopts everything else', async () => {
    await manager.ensure(KEY, '/tmp', spec);
    await manager.ensure(SHELL, '/tmp', spec);
    manager.destroy();
    manager2 = await createDaemonTerminalManager({ stateDir, daemonScript });
    expect(manager2.status(SHELL).status).toBe('running');
    expect(manager2.status(KEY).status).not.toBe('running');
    // And the daemon really let it go: a third attach doesn't see it either.
    manager2.destroy();
    manager2 = await createDaemonTerminalManager({ stateDir, daemonScript });
    expect(manager2.status(KEY).status).not.toBe('running');
    expect(manager2.status(SHELL).status).toBe('running');
  });
});
