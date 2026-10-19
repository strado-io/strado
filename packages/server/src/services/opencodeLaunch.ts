import path from 'node:path';
import { exec } from '../shell.js';
import { hooksDir } from './claudeHooks.js';
import { defaultShell } from './platform.js';

// OpenCode 2.x runs every TUI against one shared background service
// (`opencode serve --service`), and that service — not the tab — spawns MCP
// servers and plugins. They inherit the service's environment, so the
// `strado` MCP never sees the tab's STRADO_AGENT_TOKEN and every intercom tool
// answers UNAUTHENTICATED (and whichever tab started the service would leak
// its identity to all the others). `--standalone` gives each tab a private
// server that inherits the tab's environment. OpenCode 1.x has no service
// and no such flag, so the flag is added only when `opencode --help` lists it.

/** Registers this server's `strado` MCP for OpenCode through the tab's
 * environment, never through the user's global config. A value the user
 * already exported is kept; only `mcp.strado` is set (it also replaces a
 * stale global `strado` entry pointing at another install or worktree). */
export function opencodeConfigContent(existing: string | undefined): string {
  let base: Record<string, unknown> = {};
  if (existing) {
    try {
      const parsed = JSON.parse(existing);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) base = parsed;
    } catch { /* not JSON: OpenCode would reject it anyway; ours replaces it */ }
  }
  const mcp = base.mcp && typeof base.mcp === 'object' && !Array.isArray(base.mcp) ? base.mcp as Record<string, unknown> : {};
  return JSON.stringify({
    ...base,
    mcp: { ...mcp, strado: { type: 'local', command: ['node', path.join(hooksDir(), 'strado-mcp.mjs')], enabled: true } },
  });
}

let standalone: Promise<boolean> | undefined;
let known = false;
let checkedAt = 0;
/** A "no" is asked again after this long: OpenCode may be installed or
 * upgraded (1.x → 2.x) while the server runs. A "yes" is kept. */
export const OPENCODE_RECHECK_MS = 10 * 60_000;

/** Whether the installed OpenCode has `--standalone`, probed through a login
 * shell (the user's PATH). A failed probe (not installed yet, a slow shell)
 * means "no" for this launch but is not remembered, so a launch never breaks
 * on a flag the binary does not know and a later one still gets it. Callers
 * await it before building an OpenCode spawn spec. */
export function probeOpencodeStandalone(run: () => Promise<string> = defaultProbe, now: () => number = Date.now): Promise<boolean> {
  if (standalone && !known && now() - checkedAt >= OPENCODE_RECHECK_MS) standalone = undefined;
  if (!standalone) {
    checkedAt = now();
    const probe: Promise<boolean> = run().then(
      (help) => /--standalone\b/.test(help),
      () => { if (standalone === probe) standalone = undefined; return false; },
    ).then((ok) => (known = ok));
    standalone = probe;
  }
  return standalone;
}

/** The probe's settled answer (false until it has run). */
export const opencodeStandaloneKnown = (): boolean => known;

/** Tests only. */
export function resetOpencodeProbe(): void { standalone = undefined; known = false; checkedAt = 0; }

const defaultProbe = async (): Promise<string> => {
  const r = await exec(defaultShell(), ['-l', '-c', 'opencode --help 2>&1'], { timeoutMs: 10_000 });
  return `${r.stdout ?? ''}${r.stderr ?? ''}`;
};
