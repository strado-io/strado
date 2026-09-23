import fs from 'node:fs/promises';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claudeMcpEntry, installClaudeMcp } from '../../src/services/claudeMcp';

let tmp: string; let file: string;
const read = async () => JSON.parse(await fs.readFile(file, 'utf8'));
beforeEach(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-mcp-')); file = path.join(tmp, '.claude.json'); });
afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

describe('installClaudeMcp', () => {
  it('creates the file with only the project entry when it does not exist', async () => {
    expect(await installClaudeMcp('/w/one', { file })).toBe('written');
    expect(await read()).toEqual({ projects: { '/w/one': { mcpServers: { strado: claudeMcpEntry() } } } });
    expect(claudeMcpEntry().args[0]).toMatch(/\/hooks\/strado-mcp\.mjs$/);
  });

  it('adds the entry, prunes Strado\'s old global strado-preview, keeps everything else byte-for-byte', async () => {
    const before = {
      numStartups: 3,
      mcpServers: {
        figma: { type: 'stdio', command: 'npx', args: ['figma-mcp'] },
        'strado-preview': { type: 'stdio', command: 'node', args: ['/Applications/Strado.app/Contents/Resources/bin/preview-mcp.cjs'], env: {} },
      },
      projects: {
        '/w/other': { allowedTools: ['Bash'], mcpServers: { x: { type: 'stdio', command: 'x', args: [] } } },
        '/w/one': { allowedTools: [], mcpServers: { y: { type: 'stdio', command: 'y', args: [] } } },
      },
    };
    await fs.writeFile(file, JSON.stringify(before, null, 2) + '\n');
    expect(await installClaudeMcp('/w/one', { file })).toBe('written');
    const after = await read();
    expect(after.mcpServers).toEqual({ figma: before.mcpServers.figma });
    expect(after.projects['/w/other']).toEqual(before.projects['/w/other']);
    expect(after.projects['/w/one']).toEqual({ allowedTools: [], mcpServers: { y: before.projects['/w/one'].mcpServers.y, strado: claudeMcpEntry() } });
    expect(after.numStartups).toBe(3);
    expect((await fs.readFile(file, 'utf8')).endsWith('\n')).toBe(true);
  });

  it('keeps a strado-preview that is not ours and a strado entry that is not ours; replaces a stale strado path', async () => {
    await fs.writeFile(file, JSON.stringify({
      mcpServers: { 'strado-preview': { type: 'stdio', command: 'node', args: ['/home/me/my-own-preview.js'] } },
      projects: {
        '/w/one': { mcpServers: { strado: { type: 'stdio', command: 'node', args: ['/old/checkout/packages/server/hooks/strado-mcp.mjs'] } } },
        '/w/two': { mcpServers: { strado: { type: 'http', url: 'http://elsewhere' } } },
      },
    }));
    await installClaudeMcp('/w/one', { file });
    await installClaudeMcp('/w/two', { file });
    const after = await read();
    expect(after.mcpServers['strado-preview'].args).toEqual(['/home/me/my-own-preview.js']);
    expect(after.projects['/w/one'].mcpServers.strado).toEqual(claudeMcpEntry());
    expect(after.projects['/w/two'].mcpServers.strado).toEqual({ type: 'http', url: 'http://elsewhere' });
  });

  it('skips without writing when the file is not a JSON object', async () => {
    await fs.writeFile(file, '[1,2,3]');
    expect(await installClaudeMcp('/w/one', { file })).toBe('skipped');
    expect(await fs.readFile(file, 'utf8')).toBe('[1,2,3]');
    await fs.writeFile(file, '{ not json');
    expect(await installClaudeMcp('/w/one', { file })).toBe('skipped');
    expect(await fs.readFile(file, 'utf8')).toBe('{ not json');
  });

  it('is idempotent and serialises concurrent installs', async () => {
    await installClaudeMcp('/w/one', { file });
    const bytes = await fs.readFile(file, 'utf8');
    expect(await installClaudeMcp('/w/one', { file })).toBe('unchanged');
    expect(await fs.readFile(file, 'utf8')).toBe(bytes);
    await Promise.all([installClaudeMcp('/w/a', { file }), installClaudeMcp('/w/b', { file }), installClaudeMcp('/w/c', { file })]);
    const after = await read();
    expect(Object.keys(after.projects).sort()).toEqual(['/w/a', '/w/b', '/w/c', '/w/one']);
  });

  it('honours STRADO_CLAUDE_JSON when no file option is given', async () => {
    const previous = process.env.STRADO_CLAUDE_JSON;          // vitest.config.ts sets a tmp default; restore it, never delete it
    process.env.STRADO_CLAUDE_JSON = path.join(tmp, 'env.json');
    try {
      await installClaudeMcp('/w/one');
      expect(JSON.parse(await fs.readFile(process.env.STRADO_CLAUDE_JSON, 'utf8')).projects['/w/one'].mcpServers.strado).toEqual(claudeMcpEntry());
    } finally { if (previous === undefined) delete process.env.STRADO_CLAUDE_JSON; else process.env.STRADO_CLAUDE_JSON = previous; }
  });

  it('creates a brand-new file mode 0600 (it holds OAuth account data)', async () => {
    await installClaudeMcp('/w/one', { file });
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  });

  it('preserves an existing 0600 file\'s mode across the rewrite', async () => {
    await fs.writeFile(file, '{}');
    await fs.chmod(file, 0o600);
    await installClaudeMcp('/w/one', { file });
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  });

  it('preserves an existing 0644 file\'s mode across the rewrite (does not force it to 0600)', async () => {
    await fs.writeFile(file, '{}');
    await fs.chmod(file, 0o644);
    await installClaudeMcp('/w/one', { file });
    expect((await fs.stat(file)).mode & 0o777).toBe(0o644);
  });

  it('leaves no temp file behind when rename fails after the temp file was written', async () => {
    await fs.writeFile(file, '{}');
    const original = await fs.readFile(file, 'utf8');
    const spy = vi.spyOn(fsp, 'rename').mockRejectedValueOnce(Object.assign(new Error('boom'), { code: 'EIO' }));
    try {
      await expect(installClaudeMcp('/w/one', { file })).rejects.toThrow('boom');
      const entries = await fs.readdir(tmp);
      expect(entries.filter((n) => n.includes('.tmp'))).toEqual([]);
      expect(await fs.readFile(file, 'utf8')).toBe(original);
    } finally {
      spy.mockRestore();
    }
  });

  it('writes through a symlinked file instead of replacing the link with a regular file', async () => {
    const real = path.join(tmp, 'real.json');
    const symlinkPath = path.join(tmp, 'claude.json');
    await fs.writeFile(real, '{}');
    await fs.symlink(real, symlinkPath);
    expect(await installClaudeMcp('/w/one', { file: symlinkPath })).toBe('written');
    expect((await fs.lstat(symlinkPath)).isSymbolicLink()).toBe(true);
    expect(JSON.parse(await fs.readFile(real, 'utf8')).projects['/w/one'].mcpServers.strado).toEqual(claudeMcpEntry());
  });

  it('a bad parent path fails before any write is attempted (mkdir rejects with ENOTDIR)', async () => {
    // `not-a-dir` is a plain file, so mkdir(dirname(file), { recursive: true })
    // rejects with ENOTDIR before any temp file is ever created — this proves
    // the function surfaces that failure and touches nothing, NOT that the
    // write-then-cleanup path runs (see the rename-failure test above for that).
    const blocker = path.join(tmp, 'not-a-dir');
    await fs.writeFile(blocker, 'x');
    const badFile = path.join(blocker, 'claude.json');
    await expect(installClaudeMcp('/w/one', { file: badFile })).rejects.toThrow();
    const entries = await fs.readdir(tmp);
    expect(entries.filter((e) => e.includes('.tmp'))).toEqual([]);
  });
});
