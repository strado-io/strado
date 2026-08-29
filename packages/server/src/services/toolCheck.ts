import { execFile } from 'node:child_process';
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
  // Minimum `node` major.minor the tool's CLI needs. Only set it for a tool
  // that HARD-FAILS on an older runtime: it turns a bare "not installed" into
  // a hint naming the real reason, which is otherwise unguessable — the CLI is
  // on PATH and runs fine in the user's terminal, it just crashes here.
  minNode?: string;
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
    id: 'pi',
    label: 'Pi',
    commands: ['pi --version'],
    optional: true,
    hint: 'Pi needs to be installed to use',
    // pi declares engines.node >= 22.19.0 and its bundle throws outright on an
    // older runtime rather than printing a version.
    minNode: '22.19',
    // `--ignore-scripts` is what pi's own quick start recommends: it needs no
    // dependency lifecycle scripts for a normal npm install.
    install: { file: 'npm', args: ['install', '-g', '--ignore-scripts', '@earendil-works/pi-coding-agent'] },
  },
  {
    id: 'vscode',
    label: 'VS Code (embedded editor)',
    commands: ['code --version', 'code-insiders --version', 'code-server --version'],
    optional: true,
    hint: 'Cmd+Shift+P → "Shell Command: Install \'code\'" — the editor tab hides until installed',
  },
];

// A LOGIN shell (`-l`), matching how the terminal routes actually launch an
// agent (`defaultShell() -l -c '<agent>'`). `exec`'s `shell` option would give
// a plain `<shell> -c`, which reads a different profile and so resolves a
// different PATH — that gap let a probe report "not installed" for a CLI whose
// tab starts fine, and the reverse. The probe has to measure the environment
// the agent will actually run in, or it isn't answering the question.
function tryCommand(cmd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(defaultShell(), ['-l', '-c', cmd], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(stdout.trim().split('\n')[0] ?? '');
    });
  });
}

/** The node version the agent launch shell resolves, as printed (`v20.19.4`),
 * or null when there is no node on it at all. NOT `process.versions.node`: the
 * packaged app bundles its own node for the server, and no agent ever runs on
 * it — gating on that would hide the tool from everyone. */
async function launchShellNode(): Promise<string | null> {
  const out = await tryCommand('node --version');
  return out && /^v?\d+\./.test(out) ? out : null;
}

/** Compares on major.minor only — a floor is expressed that way, and patch
 * releases never move it. Unparseable input is treated as "not below" so a
 * surprising version string can't invent a reason the tool is missing. */
function below(version: string, floor: string): boolean {
  const v = version.match(/v?(\d+)\.(\d+)/);
  const f = floor.match(/(\d+)\.(\d+)/);
  if (!v || !f) return false;
  const [vMajor, vMinor] = [Number(v[1]), Number(v[2])];
  const [fMajor, fMinor] = [Number(f[1]), Number(f[2])];
  return vMajor !== fMajor ? vMajor < fMajor : vMinor < fMinor;
}

/** Why a `minNode` tool failed to answer, when node is the reason. Falls back
 * to the tool's own hint whenever node is fine (or absent) — a wrong guess
 * here is worse than the generic message. */
async function missingReason(tool: ToolSpec): Promise<string> {
  if (!tool.minNode) return tool.hint;
  const node = await launchShellNode();
  if (!node || !below(node, tool.minNode)) return tool.hint;
  return `${tool.label} needs Node ${tool.minNode}+ (found ${node})`;
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
    hint: await missingReason(tool),
    installable,
    installCommand,
  };
}

export async function checkTools(): Promise<ToolStatus[]> {
  return Promise.all(TOOLS.map(probe));
}
