import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addGitExclude } from './gitExclude.js';
import { exec } from '../shell.js';

const HOOK_EVENTS: Record<string, 'working' | 'waiting' | 'idle'> = {
  SessionStart: 'idle',
  UserPromptSubmit: 'working',
  Notification: 'waiting',
  Stop: 'idle',
};

/** Where the hook scripts live on THIS host. Exported because a sandbox
 * bind-mounts it into the container at the same absolute path: the settings
 * file below writes `node "<hooksDir>/claude-status-hook.mjs"`, and that
 * command has to resolve on both sides of the container wall. */
export function hooksDir(): string {
  // Packaged desktop builds ship hooks/ next to the server bundle and point
  // STRADO_HOOKS_DIR at it; dev resolves from src/services (or dist/services)
  // up to the package root.
  if (process.env.STRADO_HOOKS_DIR) return path.resolve(process.env.STRADO_HOOKS_DIR);
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '../../hooks');
}

export function codexNotifyScriptPath(): string {
  return path.join(hooksDir(), 'codex-notify-hook.mjs');
}

export function opencodePluginSourcePath(): string {
  return path.join(hooksDir(), 'strado-opencode-status.js');
}

/** Pi loads extensions from an explicit path (`pi -e <path>`), so unlike Claude
 * and OpenCode there is nothing to install into the worktree — the launch
 * command just points at this file. */
export function piExtensionPath(): string {
  return path.join(hooksDir(), 'strado-pi-status.ts');
}

// OpenCode auto-loads plugins from `.opencode/plugin/` in the project dir.
// Copy our status plugin there so opencode picks it up; git-exclude `.opencode`
// so it never shows up in the user's `git status`. Best-effort.
export async function installOpencodePlugin(worktreePath: string): Promise<void> {
  const src = opencodePluginSourcePath();
  const pluginDir = path.join(worktreePath, '.opencode', 'plugin');
  await fsp.mkdir(pluginDir, { recursive: true });
  const contents = await fsp.readFile(src, 'utf8');
  await fsp.writeFile(path.join(pluginDir, 'strado-opencode-status.js'), contents);
  await addGitExclude(worktreePath, '.opencode/');
}

const HOOK_SCRIPT_NAME = 'claude-status-hook.mjs';

/** The command written into a worktree's Claude settings. Deliberately a
 * machine-independent constant: the script path and port come from the PTY
 * env (`sessionEnv`), so the entry never goes stale when the worktree or
 * install that wrote it disappears, two Strado instances never overwrite
 * each other's path, and a session that is not under Strado no-ops. */
export function claudeHookCommand(status: 'working' | 'waiting' | 'idle'): string {
  // sessionEnv sets STRADO_STATUS_PORT whenever it sets STRADO_CLAUDE_HOOK, and
  // the script itself falls back to 7777 on an empty port argument.
  return `[ -n "$STRADO_CLAUDE_HOOK" ] && [ -f "$STRADO_CLAUDE_HOOK" ] && node "$STRADO_CLAUDE_HOOK" ${status} "$STRADO_STATUS_PORT" || true`;
}

type HookEntry = { hooks?: unknown };

function isStradoStatusHook(h: unknown): boolean {
  return typeof (h as { command?: unknown })?.command === 'string'
    && ((h as { command: string }).command.includes(HOOK_SCRIPT_NAME)
      || (h as { command: string }).command.includes('STRADO_CLAUDE_HOOK'));
}

/** Drops every Strado status hook group whose command is not byte-equal to
 * `current` — legacy path-baked entries from any install or worktree. Foreign
 * hooks are kept. Returns whether anything was removed. */
function pruneStradoHooks(entries: unknown[], current: string | null): { kept: unknown[]; removed: boolean } {
  let removed = false;
  const kept = entries.filter((g) => {
    const hooks = (g as HookEntry)?.hooks;
    if (!Array.isArray(hooks)) return true;
    const stale = hooks.some((h) => isStradoStatusHook(h) && (h as { command: string }).command !== current);
    if (stale) removed = true;
    return !stale;
  });
  return { kept, removed };
}

async function readSettings(settingsPath: string): Promise<Record<string, any> | null> {
  try {
    const parsed = JSON.parse(await fsp.readFile(settingsPath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return null;
  }
}

/** A hook whose command still bakes in a filesystem path — the pre-constant
 * form. The current constant form (using `$STRADO_CLAUDE_HOOK`) is NOT stale
 * here: unlike a per-worktree settings file, the main checkout is not being
 * rewritten with a fresh command by this install, so its own valid constant
 * hook (e.g. because the main checkout is itself a Strado worktree) must
 * survive. */
function isLegacyPathBakedHook(h: unknown): boolean {
  const command = (h as { command?: unknown })?.command;
  return typeof command === 'string' && command.includes(HOOK_SCRIPT_NAME) && !command.includes('STRADO_CLAUDE_HOOK');
}

function pruneLegacyPathBakedHooks(entries: unknown[]): { kept: unknown[]; removed: boolean } {
  let removed = false;
  const kept = entries.filter((g) => {
    const hooks = (g as HookEntry)?.hooks;
    if (!Array.isArray(hooks)) return true;
    const stale = hooks.some((h) => isLegacyPathBakedHook(h));
    if (stale) removed = true;
    return !stale;
  });
  return { kept, removed };
}

/** Claude Code merges the MAIN checkout's `.claude/settings.local.json` into
 * sessions started in any of its linked worktrees, so a legacy entry there
 * fires in every worktree while the per-worktree installer never sees it.
 * Purge only legacy path-baked Strado hooks from that file — never the current
 * constant-hook form, which may be legitimately present if the main checkout
 * is itself a Strado worktree. Add nothing; touch nothing else. Best-effort:
 * not a git repo, not a linked worktree, no file → return. */
async function pruneMainCheckoutHooks(worktreePath: string): Promise<void> {
  let commonDir: string;
  try {
    const r = await exec('git', ['-C', worktreePath, 'rev-parse', '--path-format=absolute', '--git-common-dir']);
    commonDir = r.stdout.trim();
  } catch {
    return;
  }
  if (!commonDir) return;
  const mainCheckout = path.dirname(commonDir);
  if (path.resolve(mainCheckout) === path.resolve(worktreePath)) return;
  const settingsPath = path.join(mainCheckout, '.claude', 'settings.local.json');
  const settings = await readSettings(settingsPath);
  if (!settings || !settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) return;

  let changed = false;
  for (const event of Object.keys(settings.hooks)) {
    const entries = settings.hooks[event];
    if (!Array.isArray(entries)) continue;
    const { kept, removed } = pruneLegacyPathBakedHooks(entries);
    if (removed) {
      settings.hooks[event] = kept;
      changed = true;
    }
  }
  if (!changed) return;
  await fsp.writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n');
}

export async function installClaudeHooks(worktreePath: string): Promise<void> {
  const claudeDir = path.join(worktreePath, '.claude');
  const settingsPath = path.join(claudeDir, 'settings.local.json');

  // Missing or invalid — start fresh.
  const settings: Record<string, any> = (await readSettings(settingsPath)) ?? {};
  if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) settings.hooks = {};

  for (const [event, status] of Object.entries(HOOK_EVENTS)) {
    const command = claudeHookCommand(status);
    const existing = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
    const { kept } = pruneStradoHooks(existing, command);
    const already = kept.some(
      (g) => Array.isArray((g as HookEntry)?.hooks)
        && ((g as HookEntry).hooks as unknown[]).some((h) => (h as { command?: unknown })?.command === command),
    );
    if (!already) kept.push({ hooks: [{ type: 'command', command }] });
    settings.hooks[event] = kept;
  }

  await fsp.mkdir(claudeDir, { recursive: true });
  await fsp.writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n');

  // The file is created by us (before Claude runs), so Claude's own auto-ignore
  // never triggers. Add it to the worktree's git exclude so it doesn't pollute
  // `git status`. Best-effort: silently skip if this isn't a git worktree.
  await addGitExclude(worktreePath, '.claude/settings.local.json');

  await pruneMainCheckoutHooks(worktreePath).catch(() => undefined);
}
