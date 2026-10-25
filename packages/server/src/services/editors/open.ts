// Open in editor: hand a worktree, or one file at a line, to the person's own
// editor. The argv is built here from EDITORS, never from a request; the path
// must resolve inside the worktree (same checks as Files). The editor is
// started detached with the env language servers get: no Strado identity and
// nothing shaped like a credential.
import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { AppError } from '../../errors.js';
import { resolveInside, safeRel } from '../files/files.js';
import type { Detect } from '../lsp/detect.js';
import { envAllowed } from '../lsp/manager.js';
import { findEditor, listEditors, type FoundEditor } from './detect.js';
import type { EditorStore } from './store.js';
import { EDITORS, type EditorId, type EditorsAnswer, type OpenInEditorBody } from './types.js';

export type SpawnFn = (
  file: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; detached: true; stdio: 'ignore' },
) => Promise<void>;

/** Resolves once the process started, rejects if it could not (ENOENT, EACCES). */
const realSpawn: SpawnFn = (file, args, opts) =>
  new Promise((resolve, reject) => {
    const child = nodeSpawn(file, args, opts);
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });

export type EditorsDeps = {
  detect: Detect;
  store: EditorStore;
  platform?: NodeJS.Platform;
  appDirs?: string[];
  spawn?: SpawnFn;
};

export type Editors = {
  list(): Promise<EditorsAnswer>;
  setPreferred(id: EditorId | null): Promise<void>;
  /** `worktreePath` is already known to belong to this server (the route checks). */
  open(o: OpenInEditorBody): Promise<void>;
};

/** The argv for `target` (a file, or the worktree folder when `file` is null). */
export function editorArgv(
  found: FoundEditor,
  root: string,
  file: string | null,
  line: number | undefined,
  col: number | undefined,
  o: { platform: NodeJS.Platform; xdgOpen: string | null },
): string[] {
  const target = file ?? root;
  const at = file !== null && line !== undefined;
  if (found.cli) {
    const cli = found.cli;
    switch (found.spec.goto) {
      case 'vscode':
        // The folder too, so the file opens in its worktree's window.
        if (at) return [cli, root, '-g', `${file}:${line}:${col ?? 1}`];
        return file ? [cli, root, file] : [cli, root];
      case 'zed':
      case 'sublime':
        return at ? [cli, `${file}:${line}:${col ?? 1}`] : [cli, target];
      case 'jetbrains':
        return at ? [cli, '--line', String(line), ...(col ? ['--column', String(col)] : []), file!] : [cli, target];
      case 'xcode':
        return at ? [cli, '-l', String(line), file!] : [cli, target];
      default:
        return [cli, target];
    }
  }
  // macOS app bundle without its CLI: no way to pass a line.
  if (found.app) return ['/usr/bin/open', '-a', found.app, target];
  if (o.platform === 'darwin') return ['/usr/bin/open', target];
  if (!o.xdgOpen) throw new AppError('VALIDATION', 'No default app opener (xdg-open) on this machine');
  return [o.xdgOpen, target];
}

export function createEditors(deps: EditorsDeps): Editors {
  const platform = deps.platform ?? process.platform;
  const spawn = deps.spawn ?? realSpawn;
  const detectDeps = { detect: deps.detect, platform, appDirs: deps.appDirs };

  async function env(): Promise<NodeJS.ProcessEnv> {
    const out: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && envAllowed(k, v)) out[k] = v;
    out.PATH = (await deps.detect.dirs()).join(':');
    return out;
  }

  /** The asked-for editor, else the preferred one, else the first installed, else the default app. */
  async function choose(id: EditorId | undefined): Promise<FoundEditor> {
    const wanted = id ?? (await deps.store.get());
    if (wanted) {
      const found = await findEditor(EDITORS.find((e) => e.id === wanted)!, detectDeps);
      if (!found.available) throw new AppError('VALIDATION', `${found.spec.label} is not installed`);
      return found;
    }
    for (const spec of EDITORS) {
      if (spec.id === 'system') continue;
      const found = await findEditor(spec, detectDeps);
      if (found.available) return found;
    }
    return findEditor(EDITORS.find((e) => e.id === 'system')!, detectDeps);
  }

  return {
    async list() {
      return { editors: await listEditors(detectDeps), preferred: await deps.store.get() };
    },

    setPreferred: (id) => deps.store.set(id),

    async open(o) {
      const { realRoot } = await resolveInside(o.worktreePath, '');
      // What opens: the worktree, a folder in it (as a folder), or a file in it.
      let folder = realRoot;
      let file: string | null = null;
      if (o.path !== undefined) {
        const rel = safeRel(o.path);
        if (!rel) throw new AppError('VALIDATION', 'path is required');
        const { real } = await resolveInside(realRoot, rel);
        if ((await fs.stat(real)).isDirectory()) folder = real;
        else file = real;
      }
      const found = await choose(o.editor);
      const xdgOpen = platform === 'darwin' ? null : await deps.detect.which('xdg-open');
      const [bin, ...args] = editorArgv(found, folder, file, o.line, o.col, { platform, xdgOpen });
      try {
        await spawn(bin!, args, { cwd: realRoot, env: await env(), detached: true, stdio: 'ignore' });
      } catch {
        throw new AppError('UNAVAILABLE', `Could not start ${found.spec.label}`);
      }
    },
  };
}
