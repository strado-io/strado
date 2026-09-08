import { describe, it, expect } from 'vitest';
import { claudeDescriptor } from './claude.js';

describe('claudeDescriptor', () => {
  it('declares MCP servers at both scopes with different files', () => {
    const mcp = claudeDescriptor.surfaces.find((s) => s.id === 'mcp')!;
    expect(mcp.global!.file).toBe('~/.claude.json');
    expect(mcp.global!.path).toEqual(['mcpServers']);
    expect(mcp.project!.file).toBe('<worktree>/.mcp.json');
    expect(mcp.project!.path).toEqual(['mcpServers']);
  });

  it('never targets settings.local.json', () => {
    for (const s of claudeDescriptor.surfaces) {
      for (const t of [s.global, s.project]) {
        expect(t?.file ?? '').not.toContain('settings.local.json');
      }
    }
  });

  it('marks the project-approved MCP surface read-only', () => {
    const approved = claudeDescriptor.surfaces.find((s) => s.id === 'mcp-approved')!;
    expect(approved.readOnly).toBe(true);
  });

  it('gives every surface at least one scope target', () => {
    for (const s of claudeDescriptor.surfaces) {
      expect(s.global ?? s.project).toBeDefined();
    }
  });

  it('uses a toolCheck id that matches the env-check probe', () => {
    expect(claudeDescriptor.toolCheckId).toBe('claude');
  });

  it('contains exactly 14 surfaces with expected ids', () => {
    const expectedIds = [
      'mcp', 'mcp-approved', 'model', 'effortLevel', 'alwaysThinking', 'theme',
      'permissions', 'env', 'hooks', 'plugins', 'marketplaces', 'statusLine',
      'skills', 'instructions',
    ];
    const actualIds = claudeDescriptor.surfaces.map((s) => s.id);
    expect(actualIds).toEqual(expectedIds);
  });

  it('validates all surface file and path configurations', () => {
    const expected: Record<string, Record<'global' | 'project', { file: string; path: string[] } | null>> = {
      mcp: {
        global: { file: '~/.claude.json', path: ['mcpServers'] },
        project: { file: '<worktree>/.mcp.json', path: ['mcpServers'] },
      },
      'mcp-approved': {
        global: null,
        project: { file: '~/.claude.json', path: ['projects', '<worktree>', 'mcpServers'] },
      },
      model: {
        global: { file: '~/.claude/settings.json', path: ['model'] },
        project: { file: '<worktree>/.claude/settings.json', path: ['model'] },
      },
      effortLevel: {
        global: { file: '~/.claude/settings.json', path: ['effortLevel'] },
        project: null,
      },
      alwaysThinking: {
        global: { file: '~/.claude/settings.json', path: ['alwaysThinkingEnabled'] },
        project: null,
      },
      theme: {
        global: { file: '~/.claude/settings.json', path: ['theme'] },
        project: null,
      },
      permissions: {
        global: { file: '~/.claude/settings.json', path: ['permissions'] },
        project: { file: '<worktree>/.claude/settings.json', path: ['permissions'] },
      },
      env: {
        global: { file: '~/.claude/settings.json', path: ['env'] },
        project: { file: '<worktree>/.claude/settings.json', path: ['env'] },
      },
      hooks: {
        global: { file: '~/.claude/settings.json', path: ['hooks'] },
        project: { file: '<worktree>/.claude/settings.json', path: ['hooks'] },
      },
      plugins: {
        global: { file: '~/.claude/settings.json', path: ['enabledPlugins'] },
        project: null,
      },
      marketplaces: {
        global: { file: '~/.claude/settings.json', path: ['extraKnownMarketplaces'] },
        project: null,
      },
      statusLine: {
        global: { file: '~/.claude/settings.json', path: ['statusLine'] },
        project: null,
      },
      skills: {
        global: { file: '~/.claude/skills', path: [] },
        project: { file: '<worktree>/.claude/skills', path: [] },
      },
      instructions: {
        global: { file: '~/.claude/CLAUDE.md', path: [] },
        project: { file: '<worktree>/CLAUDE.md', path: [] },
      },
    };

    for (const surface of claudeDescriptor.surfaces) {
      const expectedConfig = expected[surface.id];
      if (!expectedConfig) {
        throw new Error(`Expected config not found for surface: ${surface.id}`);
      }

      for (const scope of ['global', 'project'] as const) {
        const expectedScope = expectedConfig[scope];
        const actualScope = surface[scope];

        if (expectedScope === null) {
          expect(actualScope).toBeUndefined();
        } else {
          expect(actualScope).toBeDefined();
          expect(actualScope!.file).toBe(expectedScope.file);
          expect(actualScope!.path).toEqual(expectedScope.path);
        }
      }
    }
  });
});
