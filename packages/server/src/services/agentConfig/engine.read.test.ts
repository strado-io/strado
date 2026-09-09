import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readSurfaces } from './engine.js';
import { claudeDescriptor } from './descriptors/claude.js';

async function home(): Promise<string> {
  const h = await mkdtemp(path.join(tmpdir(), 'home-'));
  await mkdir(path.join(h, '.claude'), { recursive: true });
  return h;
}

const find = (list: Awaited<ReturnType<typeof readSurfaces>>, id: string) =>
  list.find((s) => s.id === id)!;

describe('readSurfaces', () => {
  it('reports unset surfaces when no config file exists', async () => {
    const h = await home();
    const out = await readSurfaces(claudeDescriptor, 'global', { home: h });
    const model = find(out, 'model');
    expect(model.source).toBe('unset');
    expect(model.exists).toBe(false);
    expect(model.file).toBe(path.join(h, '.claude/settings.json'));
  });

  it('reads a set value and reports the resolved file', async () => {
    const h = await home();
    await writeFile(path.join(h, '.claude/settings.json'), '{"effortLevel":"high"}');
    const out = await readSurfaces(claudeDescriptor, 'global', { home: h });
    expect(find(out, 'effortLevel')).toMatchObject({ value: 'high', source: 'set', exists: true });
  });

  it('marks a project surface inherited when only global sets it', async () => {
    const h = await home();
    const wt = await mkdtemp(path.join(tmpdir(), 'wt-'));
    await writeFile(path.join(h, '.claude/settings.json'), '{"model":"opus-5"}');
    const out = await readSurfaces(claudeDescriptor, 'project', { home: h, worktree: wt });
    expect(find(out, 'model')).toMatchObject({ source: 'inherited', inheritedValue: 'opus-5' });
  });

  it('prefers the project value over the global one', async () => {
    const h = await home();
    const wt = await mkdtemp(path.join(tmpdir(), 'wt-'));
    await writeFile(path.join(h, '.claude/settings.json'), '{"model":"opus-5"}');
    await mkdir(path.join(wt, '.claude'), { recursive: true });
    await writeFile(path.join(wt, '.claude/settings.json'), '{"model":"haiku-4-5"}');
    const out = await readSurfaces(claudeDescriptor, 'project', { home: h, worktree: wt });
    expect(find(out, 'model')).toMatchObject({
      value: 'haiku-4-5', source: 'set', inheritedValue: 'opus-5',
    });
  });

  it('lists skills through the directory driver', async () => {
    const h = await home();
    await mkdir(path.join(h, '.claude/skills/superset'), { recursive: true });
    await writeFile(path.join(h, '.claude/skills/superset/SKILL.md'), '# s\n');
    const out = await readSurfaces(claudeDescriptor, 'global', { home: h });
    expect(find(out, 'skills').value).toEqual([{ name: 'superset', hasSkillMd: true }]);
  });

  it('reports a parse error on the surface instead of throwing', async () => {
    const h = await home();
    await writeFile(path.join(h, '.claude/settings.json'), '{ broken');
    const out = await readSurfaces(claudeDescriptor, 'global', { home: h });
    const model = find(out, 'model');
    expect(model.error).toMatch(/not valid JSON/);
    expect(model.value).toBeUndefined();
  });

  it('omits surfaces that have no target for the requested scope', async () => {
    const h = await home();
    const wt = await mkdtemp(path.join(tmpdir(), 'wt-'));
    const out = await readSurfaces(claudeDescriptor, 'project', { home: h, worktree: wt });
    expect(out.find((s) => s.id === 'plugins')).toBeUndefined();
  });

  // mcp-approved reads `~/.claude.json` → projects[<worktree>]. That map is
  // keyed by every absolute project path Claude has ever seen on this
  // machine, so this surface exists specifically to show *this* project's
  // approved servers — never the whole map. If engine.ts read
  // `target.path` directly (the literal '<worktree>' string) instead of
  // resolving it against ctx, jsonDriver.get would look up the nonexistent
  // key 'projects.<worktree>' and this surface would come back unset,
  // silently losing the data rather than leaking it — so this test also
  // guards against a regression to that literal-path bug.
  it('reads only the current worktree entry from the projects map, not the whole map', async () => {
    const h = await home();
    const wt = await mkdtemp(path.join(tmpdir(), 'wt-'));
    const otherProject = '/some/other/absolute/project/path';
    await writeFile(
      path.join(h, '.claude.json'),
      JSON.stringify({
        projects: {
          [wt]: { mcpServers: { mine: { command: 'mcp__mine' } } },
          [otherProject]: { mcpServers: { secret: { command: 'mcp__someone-elses-secret' } } },
        },
      }),
    );
    const out = await readSurfaces(claudeDescriptor, 'project', { home: h, worktree: wt });
    const approved = find(out, 'mcp-approved');
    expect(approved.value).toEqual({ mine: { command: 'mcp__mine' } });
    expect(approved.source).toBe('set');
    // The whole point of this surface: no other project's absolute path or
    // data should be reachable through it.
    expect(JSON.stringify(out)).not.toContain(otherProject);
    expect(JSON.stringify(out)).not.toContain('someone-elses-secret');
  });

  // Final review fix #1: the path used to stop at `<worktree>`, resolving to
  // the WHOLE project entry — `mcpServers` sitting alongside `allowedTools`,
  // `lastCost`, `lastSessionId` and whatever else Claude stores there — so
  // this surface rendered a telemetry blob as if it were a list of MCP
  // servers. This fixture deliberately includes those sibling keys so a
  // regression back to the whole-entry path would fail this assertion.
  it('surfaces only mcpServers from the project entry, never sibling telemetry keys', async () => {
    const h = await home();
    const wt = await mkdtemp(path.join(tmpdir(), 'wt-'));
    await writeFile(
      path.join(h, '.claude.json'),
      JSON.stringify({
        projects: {
          [wt]: {
            mcpServers: { mine: { command: 'mcp__mine' } },
            allowedTools: ['Bash'],
            lastCost: 1.23,
            lastSessionId: 'sess-abc',
          },
        },
      }),
    );
    const out = await readSurfaces(claudeDescriptor, 'project', { home: h, worktree: wt });
    const approved = find(out, 'mcp-approved');
    expect(approved.value).toEqual({ mine: { command: 'mcp__mine' } });
    expect(JSON.stringify(approved.value)).not.toContain('lastCost');
    expect(JSON.stringify(approved.value)).not.toContain('lastSessionId');
    expect(JSON.stringify(approved.value)).not.toContain('allowedTools');
  });

  it('surfaces a parse error on the global file as inheritedError, not silently unset', async () => {
    const h = await home();
    const wt = await mkdtemp(path.join(tmpdir(), 'wt-'));
    await writeFile(path.join(h, '.claude/settings.json'), '{ broken');
    // No project settings file at all — the primary read is a plain
    // "file missing" unset, so any error here can only have come from the
    // global (inherited) read.
    const out = await readSurfaces(claudeDescriptor, 'project', { home: h, worktree: wt });
    const model = find(out, 'model');
    expect(model.exists).toBe(false);
    expect(model.error).toBeUndefined();
    expect(model.inheritedValue).toBeUndefined();
    expect(model.inheritedError).toMatch(/not valid JSON/);
  });

  it('reports every field for an enum surface with options (effortLevel)', async () => {
    const h = await home();
    await writeFile(path.join(h, '.claude/settings.json'), '{"effortLevel":"high"}');
    const out = await readSurfaces(claudeDescriptor, 'global', { home: h });
    expect(find(out, 'effortLevel')).toEqual({
      id: 'effortLevel',
      label: 'Effort level',
      group: 'Model & behavior',
      kind: 'enum',
      readOnly: false,
      options: ['low', 'medium', 'high', 'xhigh', 'max'],
      value: 'high',
      inheritedValue: undefined,
      inheritedError: undefined,
      source: 'set',
      file: path.join(h, '.claude/settings.json'),
      exists: true,
      error: undefined,
    });
  });

  it('reports every field for a readOnly surface with no options (mcp-approved)', async () => {
    const h = await home();
    const wt = await mkdtemp(path.join(tmpdir(), 'wt-'));
    await writeFile(
      path.join(h, '.claude.json'),
      JSON.stringify({ projects: { [wt]: { mcpServers: { mine: { command: 'mcp__mine' } }, allowedTools: ['Bash'] } } }),
    );
    const out = await readSurfaces(claudeDescriptor, 'project', { home: h, worktree: wt });
    expect(find(out, 'mcp-approved')).toEqual({
      id: 'mcp-approved',
      label: 'Approved for this project',
      group: 'MCP',
      kind: 'mcp-list',
      readOnly: true,
      options: undefined,
      value: { mine: { command: 'mcp__mine' } },
      inheritedValue: undefined,
      inheritedError: undefined,
      source: 'set',
      file: path.join(h, '.claude.json'),
      exists: true,
      error: undefined,
    });
  });

  it('reports an error when a dir surface path exists but is a plain file', async () => {
    const h = await home();
    // Replace the skills directory with a regular file.
    await writeFile(path.join(h, '.claude/skills'), 'not a directory');
    const out = await readSurfaces(claudeDescriptor, 'global', { home: h });
    const skills = find(out, 'skills');
    expect(skills.exists).toBe(true);
    expect(skills.value).toBeUndefined();
    expect(skills.error).toMatch(/not a directory/);
  });

  // Root bypasses directory permission bits entirely, so this test cannot
  // discriminate anything when run as root (some CI containers do). Skip
  // rather than leave a test that silently passes for the wrong reason.
  it.skipIf(typeof process.getuid === 'function' && process.getuid() === 0)(
    'reports an error when a dir surface exists but cannot be read',
    async () => {
      const h = await home();
      const skillsDir = path.join(h, '.claude/skills');
      await mkdir(skillsDir, { recursive: true });
      await chmod(skillsDir, 0o000);
      try {
        const out = await readSurfaces(claudeDescriptor, 'global', { home: h });
        const skills = find(out, 'skills');
        expect(skills.exists).toBe(true);
        expect(skills.value).toBeUndefined();
        expect(skills.error).toMatch(/could not read/);
      } finally {
        await chmod(skillsDir, 0o755);
      }
    },
  );
});
