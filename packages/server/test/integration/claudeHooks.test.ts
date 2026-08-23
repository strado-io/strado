import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installClaudeHooks } from '../../src/services/claudeHooks';

let tmp: string;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'hooks-'));
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

async function readSettings(): Promise<any> {
  return JSON.parse(await fs.readFile(path.join(tmp, '.claude', 'settings.local.json'), 'utf8'));
}

describe('installClaudeHooks', () => {
  it('creates settings.local.json with the three status hooks', async () => {
    await installClaudeHooks(tmp, 7777);
    const s = await readSettings();
    expect(Object.keys(s.hooks).sort()).toEqual(['Notification', 'Stop', 'UserPromptSubmit']);
    const stopCmd = s.hooks.Stop[0].hooks[0].command;
    expect(stopCmd).toContain('claude-status-hook.mjs');
    expect(stopCmd).toContain('idle');
    expect(stopCmd).toContain('7777');
    expect(s.hooks.UserPromptSubmit[0].hooks[0].command).toContain('working');
    expect(s.hooks.Notification[0].hooks[0].command).toContain('waiting');
  });

  it('preserves existing settings and foreign hooks', async () => {
    await fs.mkdir(path.join(tmp, '.claude'));
    await fs.writeFile(
      path.join(tmp, '.claude', 'settings.local.json'),
      JSON.stringify({
        permissions: { allow: ['Bash'] },
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo keep-me' }] }] },
      }),
    );
    await installClaudeHooks(tmp, 7777);
    const s = await readSettings();
    expect(s.permissions).toEqual({ allow: ['Bash'] });
    const stopCmds = s.hooks.Stop.flatMap((g: any) => g.hooks.map((h: any) => h.command));
    expect(stopCmds).toContain('echo keep-me');
    expect(stopCmds.some((c: string) => c.includes('claude-status-hook.mjs'))).toBe(true);
  });

  it('prunes a stale Strado hook from a moved/old location, keeps foreign hooks', async () => {
    await fs.mkdir(path.join(tmp, '.claude'));
    await fs.writeFile(
      path.join(tmp, '.claude', 'settings.local.json'),
      JSON.stringify({
        hooks: {
          Stop: [
            { hooks: [{ type: 'command', command: 'node "/old/path/packages/server/hooks/claude-status-hook.mjs" idle 7777' }] },
            { hooks: [{ type: 'command', command: 'echo keep-me' }] },
          ],
        },
      }),
    );
    await installClaudeHooks(tmp, 7777);
    const s = await readSettings();
    const stopCmds = s.hooks.Stop.flatMap((g: any) => g.hooks.map((h: any) => h.command));
    expect(stopCmds.some((c: string) => c.includes('/old/path/'))).toBe(false); // stale dropped
    expect(stopCmds).toContain('echo keep-me'); // foreign kept
    expect(stopCmds.filter((c: string) => c.includes('claude-status-hook.mjs'))).toHaveLength(1);
  });

  it('is idempotent — re-install does not duplicate entries', async () => {
    await installClaudeHooks(tmp, 7777);
    await installClaudeHooks(tmp, 7777);
    const s = await readSettings();
    expect(s.hooks.Stop).toHaveLength(1);
    expect(s.hooks.UserPromptSubmit).toHaveLength(1);
    expect(s.hooks.Notification).toHaveLength(1);
  });

  it('replaces a malformed array hooks value with an object', async () => {
    await fs.mkdir(path.join(tmp, '.claude'));
    await fs.writeFile(
      path.join(tmp, '.claude', 'settings.local.json'),
      JSON.stringify({ hooks: [] }),
    );
    await installClaudeHooks(tmp, 7777);
    const s = await readSettings();
    expect(Array.isArray(s.hooks)).toBe(false);
    expect(s.hooks.Stop[0].hooks[0].command).toContain('claude-status-hook.mjs');
  });

  it('adds settings.local.json to the worktree git exclude (idempotently)', async () => {
    const { exec } = await import('../../src/shell');
    await exec('git', ['init', '-q'], { cwd: tmp });
    await installClaudeHooks(tmp, 7777);
    await installClaudeHooks(tmp, 7777);
    const fsp = await import('node:fs/promises');
    const pathMod = await import('node:path');
    const exclude = await fsp.readFile(pathMod.join(tmp, '.git', 'info', 'exclude'), 'utf8');
    const matches = exclude.split('\n').filter((l) => l.trim() === '.claude/settings.local.json');
    expect(matches).toHaveLength(1);
  });
});
