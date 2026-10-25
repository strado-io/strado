// Which editors are on this machine: a CLI found the way language servers are
// (PATH, the common bin dirs, node version managers), or on macOS an app
// bundle in /Applications or ~/Applications (opened with `open -a`).
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Detect } from '../lsp/detect.js';
import { EDITORS, type EditorSpec, type EditorStatus } from './types.js';

export type EditorDetectDeps = {
  detect: Detect;
  platform?: NodeJS.Platform;
  /** Where macOS app bundles are looked for. */
  appDirs?: string[];
};

export type FoundEditor = {
  spec: EditorSpec;
  /** The CLI's resolved path, or null. */
  cli: string | null;
  /** The macOS app name to `open -a`, or null. */
  app: string | null;
  available: boolean;
};

const defaultAppDirs = () => ['/Applications', path.join(os.homedir(), 'Applications')];

const isDir = (p: string) => fs.stat(p).then((s) => s.isDirectory(), () => false);

export async function findEditor(spec: EditorSpec, deps: EditorDetectDeps): Promise<FoundEditor> {
  if (spec.id === 'system') return { spec, cli: null, app: null, available: true };
  const cli = spec.cli ? await deps.detect.which(spec.cli) : null;
  let app: string | null = null;
  if (spec.macApp && (deps.platform ?? process.platform) === 'darwin') {
    for (const dir of deps.appDirs ?? defaultAppDirs()) {
      if (await isDir(path.join(dir, `${spec.macApp}.app`))) {
        app = spec.macApp;
        break;
      }
    }
  }
  return { spec, cli, app, available: cli !== null || app !== null };
}

export async function listEditors(deps: EditorDetectDeps): Promise<EditorStatus[]> {
  const found = await Promise.all(EDITORS.map((spec) => findEditor(spec, deps)));
  return found.map(({ spec, cli, available }) => ({
    id: spec.id,
    label: spec.label,
    available,
    lines: cli !== null && spec.goto !== 'none',
  }));
}
