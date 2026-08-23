import { exec } from 'node:child_process';
import { defaultShell } from './platform.js';

export type ToolStatus = {
  id: string;
  label: string;
  found: boolean;
  version: string | null;
  optional: boolean;
  hint: string | null;
};

type ToolSpec = {
  id: string;
  label: string;
  commands: string[]; // first that answers wins
  optional: boolean;
  hint: string; // shown when missing
};

const TOOLS: ToolSpec[] = [
  { id: 'git', label: 'git', commands: ['git --version'], optional: false, hint: 'install Xcode command line tools or brew install git' },
  { id: 'claude', label: 'Claude Code', commands: ['claude --version'], optional: false, hint: 'npm i -g @anthropic-ai/claude-code' },
  { id: 'codex', label: 'Codex CLI', commands: ['codex --version'], optional: true, hint: 'npm i -g @openai/codex — the Codex button hides until installed' },
  { id: 'opencode', label: 'OpenCode', commands: ['opencode --version'], optional: true, hint: 'OpenCode needs to be installed to use' },
  {
    id: 'vscode',
    label: 'VS Code (embedded editor)',
    commands: ['code --version', 'code-insiders --version', 'code-server --version'],
    optional: true,
    hint: 'VS Code → Cmd+Shift+P → "Shell Command: Install \'code\'" — the editor tab hides until installed',
  },
];

function tryCommand(cmd: string): Promise<string | null> {
  return new Promise((resolve) => {
    // Login shell so GUI launches (Electron via Finder) still see the user's PATH.
    exec(cmd, { timeout: 5000, shell: defaultShell() }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(stdout.trim().split('\n')[0] ?? '');
    });
  });
}

export async function checkTools(): Promise<ToolStatus[]> {
  return Promise.all(
    TOOLS.map(async (tool) => {
      for (const cmd of tool.commands) {
        const out = await tryCommand(cmd);
        if (out !== null) {
          return { id: tool.id, label: tool.label, found: true, version: out || null, optional: tool.optional, hint: null };
        }
      }
      return { id: tool.id, label: tool.label, found: false, version: null, optional: tool.optional, hint: tool.hint };
    }),
  );
}
