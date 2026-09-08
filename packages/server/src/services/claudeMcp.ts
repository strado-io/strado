import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { hooksDir } from './claudeHooks.js';

/** The one MCP server Strado registers for Claude: `strado`, spawned from the
 * hooks directory (present in the dev checkout and in the packaged app). The
 * tab's environment is inherited, so no `env` is written here. */
export function claudeMcpEntry(): { type: 'stdio'; command: 'node'; args: [string] } {
  return { type: 'stdio', command: 'node', args: [path.join(hooksDir(), 'strado-mcp.mjs')] };
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const scriptBase = (entry: unknown): string | null => {
  if (!isObject(entry) || !Array.isArray(entry.args)) return null;
  const last = [...entry.args].reverse().find((a) => typeof a === 'string' && /\.(mjs|cjs|js)$/.test(a));
  return typeof last === 'string' ? path.basename(last) : null;
};

function defaultFile(): string {
  return process.env.STRADO_CLAUDE_JSON || path.join(os.homedir(), '.claude.json');
}

// ~/.claude.json is one shared file: two tabs opening at once must not
// interleave their read-modify-write. A module-level chain serialises them.
let chain: Promise<unknown> = Promise.resolve();

/** Register the `strado` MCP server for `worktreePath` in Claude Code's
 * project-local scope, and drop Strado's old global `strado-preview` entry
 * (recognised by its script name). Never touches anything else. Returns what
 * happened; never throws for a malformed file — that is the user's file. */
export function installClaudeMcp(worktreePath: string, opts: { file?: string } = {}): Promise<'written' | 'unchanged' | 'skipped'> {
  const run = async (): Promise<'written' | 'unchanged' | 'skipped'> => {
    const file = opts.file ?? defaultFile();
    let raw: string | null = null;
    try { raw = await fsp.readFile(file, 'utf8'); } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
    let root: Json;
    if (raw === null) root = {};
    else {
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch { return 'skipped'; }
      if (!isObject(parsed)) return 'skipped';
      root = parsed;
    }
    const before = JSON.stringify(root);

    const projects = isObject(root.projects) ? root.projects : (root.projects = {});
    const project = isObject(projects[worktreePath]) ? (projects[worktreePath] as Json) : (projects[worktreePath] = {});
    const servers = isObject(project.mcpServers) ? (project.mcpServers as Json) : (project.mcpServers = {});
    const existing = servers.strado;
    const ours = existing === undefined || scriptBase(existing) === 'strado-mcp.mjs' || scriptBase(existing) === 'strado-mcp.cjs';
    if (ours) servers.strado = claudeMcpEntry();

    if (isObject(root.mcpServers) && scriptBase(root.mcpServers['strado-preview']) === 'preview-mcp.cjs') {
      delete root.mcpServers['strado-preview'];
    }

    if (JSON.stringify(root) === before) return 'unchanged';
    const indent = raw !== null && /^\{\n(\s+)"/.test(raw) ? (/^\{\n(\s+)"/.exec(raw)?.[1]?.length ?? 2) : 2;

    // If `file` is a symlink (e.g. dotfiles-managed), write through it: stat,
    // temp path and rename all target the link's destination, so the symlink
    // itself survives instead of being replaced by a regular file.
    const target = await fsp.realpath(file).catch(() => file);

    // ~/.claude.json holds OAuth account data and is 0600; preserve whatever
    // mode it already has (0600 for a brand-new file), never widen it via the
    // rename-over-a-fresh-temp-file dance.
    const mode = await fsp.stat(target).then(
      (s) => s.mode & 0o777,
      (err) => { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0o600; throw err; },
    );

    const tmp = path.join(path.dirname(target), `.claude.json.${process.pid}.${Date.now()}.tmp`);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    try {
      const contents = JSON.stringify(root, null, indent) + '\n';
      // writeFile's `mode` option is filtered by the process umask; chmod is not.
      await fsp.writeFile(tmp, contents, { mode });
      await fsp.chmod(tmp, mode);
      const fh = await fsp.open(tmp, 'r+');
      try { await fh.sync(); } finally { await fh.close(); }
      await fsp.rename(tmp, target);
    } catch (err) {
      await fsp.unlink(tmp).catch(() => undefined);
      throw err;
    }
    return 'written';
  };
  const next = chain.then(run, run);
  chain = next.catch(() => undefined);
  return next;
}
