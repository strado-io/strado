import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addGitExclude } from './gitExclude.js';

const HOOK_EVENTS: Record<string, 'working' | 'waiting' | 'idle'> = {
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

function hookScriptPath(): string {
  return path.join(hooksDir(), 'claude-status-hook.mjs');
}

export function codexNotifyScriptPath(): string {
  return path.join(hooksDir(), 'codex-notify-hook.mjs');
}

export function opencodePluginSourcePath(): string {
  return path.join(hooksDir(), 'strado-opencode-status.js');
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

export async function installClaudeHooks(worktreePath: string, port: number): Promise<void> {
  const scriptPath = hookScriptPath();
  const claudeDir = path.join(worktreePath, '.claude');
  const settingsPath = path.join(claudeDir, 'settings.local.json');

  let settings: Record<string, any> = {};
  try {
    const parsed = JSON.parse(await fsp.readFile(settingsPath, 'utf8'));
    if (parsed && typeof parsed === 'object') settings = parsed;
  } catch {
    // Missing or invalid — start fresh.
  }
  if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) settings.hooks = {};

  for (const [event, status] of Object.entries(HOOK_EVENTS)) {
    const command = `node "${scriptPath}" ${status} ${port}`;
    let entries = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
    // Drop stale Strado status hooks that point at a DIFFERENT location (an
    // old/moved install). Left behind, they fire a dead script every turn
    // (MODULE_NOT_FOUND). Our own current hook (matching scriptPath) is kept.
    entries = entries.filter((g: any) => {
      if (!Array.isArray(g?.hooks)) return true;
      const stradoElsewhere = g.hooks.some(
        (h: any) =>
          typeof h?.command === 'string' &&
          h.command.includes('claude-status-hook.mjs') &&
          !h.command.includes(scriptPath),
      );
      return !stradoElsewhere;
    });
    const already = entries.some(
      (g: any) =>
        Array.isArray(g?.hooks) &&
        g.hooks.some((h: any) => typeof h?.command === 'string' && h.command.includes(scriptPath)),
    );
    if (!already) entries.push({ hooks: [{ type: 'command', command }] });
    settings.hooks[event] = entries;
  }

  await fsp.mkdir(claudeDir, { recursive: true });
  await fsp.writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n');

  // The file is created by us (before Claude runs), so Claude's own auto-ignore
  // never triggers. Add it to the worktree's git exclude so it doesn't pollute
  // `git status`. Best-effort: silently skip if this isn't a git worktree.
  await addGitExclude(worktreePath, '.claude/settings.local.json');
}
