import type { AgentDescriptor } from '../types.js';

const SETTINGS = '~/.claude/settings.json';
const PROJECT_SETTINGS = '<worktree>/.claude/settings.json';

export const claudeDescriptor: AgentDescriptor = {
  id: 'claude',
  label: 'Claude',
  toolCheckId: 'claude',
  surfaces: [
    {
      id: 'mcp', label: 'MCP servers', group: 'MCP', kind: 'mcp-list',
      global: { file: '~/.claude.json', path: ['mcpServers'], format: 'json' },
      project: { file: '<worktree>/.mcp.json', path: ['mcpServers'], format: 'json' },
    },
    // Read-only. `projects.<worktree>` in `~/.claude.json` is Claude's own
    // per-project telemetry blob — `mcpServers` sits alongside `allowedTools`,
    // `lastCost`, `lastSessionId` and more, which Claude rewrites constantly.
    // The path must reach all the way into `mcpServers` — stopping at
    // `<worktree>` would hand the mcp-list widget the WHOLE entry (telemetry
    // included) and render it as if every key were a server.
    {
      id: 'mcp-approved', label: 'Approved for this project', group: 'MCP',
      kind: 'mcp-list', readOnly: true,
      project: { file: '~/.claude.json', path: ['projects', '<worktree>', 'mcpServers'], format: 'json' },
    },
    {
      id: 'model', label: 'Model', group: 'Model & behavior', kind: 'enum',
      global: { file: SETTINGS, path: ['model'], format: 'json' },
      project: { file: PROJECT_SETTINGS, path: ['model'], format: 'json' },
    },
    {
      id: 'effortLevel', label: 'Effort level', group: 'Model & behavior', kind: 'enum',
      options: ['low', 'medium', 'high', 'xhigh', 'max'],
      global: { file: SETTINGS, path: ['effortLevel'], format: 'json' },
    },
    {
      id: 'alwaysThinking', label: 'Always thinking', group: 'Model & behavior', kind: 'toggle',
      global: { file: SETTINGS, path: ['alwaysThinkingEnabled'], format: 'json' },
    },
    {
      id: 'theme', label: 'Theme', group: 'Model & behavior', kind: 'enum',
      global: { file: SETTINGS, path: ['theme'], format: 'json' },
    },
    {
      id: 'permissions', label: 'Permissions', group: 'Permissions', kind: 'permissions',
      global: { file: SETTINGS, path: ['permissions'], format: 'json' },
      project: { file: PROJECT_SETTINGS, path: ['permissions'], format: 'json' },
    },
    {
      id: 'env', label: 'Environment variables', group: 'Environment', kind: 'kv',
      global: { file: SETTINGS, path: ['env'], format: 'json' },
      project: { file: PROJECT_SETTINGS, path: ['env'], format: 'json' },
    },
    {
      id: 'hooks', label: 'Hooks', group: 'Hooks', kind: 'hook-list',
      global: { file: SETTINGS, path: ['hooks'], format: 'json' },
      project: { file: PROJECT_SETTINGS, path: ['hooks'], format: 'json' },
    },
    {
      id: 'plugins', label: 'Plugins', group: 'Plugins', kind: 'plugin-list',
      global: { file: SETTINGS, path: ['enabledPlugins'], format: 'json' },
    },
    {
      id: 'marketplaces', label: 'Plugin marketplaces', group: 'Plugins', kind: 'raw',
      global: { file: SETTINGS, path: ['extraKnownMarketplaces'], format: 'json' },
    },
    {
      id: 'statusLine', label: 'Status line', group: 'Model & behavior', kind: 'raw',
      global: { file: SETTINGS, path: ['statusLine'], format: 'json' },
    },
    {
      id: 'skills', label: 'Skills', group: 'Skills', kind: 'skill-list',
      global: { file: '~/.claude/skills', path: [], format: 'dir' },
      project: { file: '<worktree>/.claude/skills', path: [], format: 'dir' },
    },
    {
      id: 'instructions', label: 'Instructions', group: 'Instructions', kind: 'markdown',
      global: { file: '~/.claude/CLAUDE.md', path: [], format: 'text' },
      project: { file: '<worktree>/CLAUDE.md', path: [], format: 'text' },
    },
  ],
};

export const descriptors: Record<string, AgentDescriptor> = {
  [claudeDescriptor.id]: claudeDescriptor,
};
