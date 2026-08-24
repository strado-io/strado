import { exec } from 'node:child_process';
import { defaultShell } from './platform.js';

export type ToolStatus = {
  id: string;
  label: string;
  found: boolean;
  version: string | null;
  optional: boolean;
  hint: string | null;
  // Whether onboarding can install this itself (see installSpec). git needs
  // Xcode's GUI installer and the `code` shim comes from inside VS Code, so
  // neither can be driven from here — those stay copy-the-command.
  installable: boolean;
  // The command as a human would type it: shown next to the Install button,
  // and the fallback to copy when an install fails.
  installCommand: string | null;
};

type ToolSpec = {
  id: string;
  label: string;
  commands: string[]; // first that answers wins
  optional: boolean;
  hint: string; // shown when missing
  // argv, never a shell string: the client only ever sends a tool id, and
  // nothing user-supplied reaches a shell.
  install?: { file: string; args: string[] };
};

const TOOLS: ToolSpec[] = [
  { id: 'git', label: 'git', commands: ['git --version'], optional: false, hint: 'install Xcode command line tools or brew install git' },
  {
    id: 'claude',
    label: 'Claude Code',
    commands: ['claude --version'],
    optional: false,
    hint: 'npm i -g @anthropic-ai/claude-code',
    install: { file: 'npm', args: ['install', '-g', '@anthropic-ai/claude-code'] },
  },
  {
    id: 'codex',
    label: 'Codex CLI',
    commands: ['codex --version'],
    optional: true,
    hint: 'npm i -g @openai/codex — the Codex button hides until installed',
    install: { file: 'npm', args: ['install', '-g', '@openai/codex'] },
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    commands: ['opencode --version'],
    optional: true,
    hint: 'OpenCode needs to be installed to use',
    install: { file: 'npm', args: ['install', '-g', 'opencode-ai'] },
  },
  {
    id: 'vscode',
    label: 'VS Code (embedded editor)',
    commands: ['code --version', 'code-insiders --version', 'code-server --version'],
    optional: true,
    hint: 'Cmd+Shift+P → "Shell Command: Install \'code\'" — the editor tab hides until installed',
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

// The install command as typed, for display and for the copy-me fallback.
function displayCommand(spec: ToolSpec): string | null {
  return spec.install ? [spec.install.file, ...spec.install.args].join(' ') : null;
}

/** The argv onboarding may run for a tool id, or null if it isn't installable. */
export function installSpec(id: string): { file: string; args: string[]; display: string } | null {
  const tool = TOOLS.find((t) => t.id === id);
  if (!tool?.install) return null;
  return { ...tool.install, display: displayCommand(tool)! };
}

export async function checkTool(id: string): Promise<ToolStatus | null> {
  const tool = TOOLS.find((t) => t.id === id);
  return tool ? probe(tool) : null;
}

async function probe(tool: ToolSpec): Promise<ToolStatus> {
  const installable = tool.install !== undefined;
  const installCommand = displayCommand(tool);
  for (const cmd of tool.commands) {
    const out = await tryCommand(cmd);
    if (out !== null) {
      return {
        id: tool.id,
        label: tool.label,
        found: true,
        version: out || null,
        optional: tool.optional,
        hint: null,
        installable,
        installCommand,
      };
    }
  }
  return {
    id: tool.id,
    label: tool.label,
    found: false,
    version: null,
    optional: tool.optional,
    hint: tool.hint,
    installable,
    installCommand,
  };
}

export async function checkTools(): Promise<ToolStatus[]> {
  return Promise.all(TOOLS.map(probe));
}
