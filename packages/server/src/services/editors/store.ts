// The person's choice of editor (Settings › Files › Open files in).
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EDITORS, type EditorId } from './types.js';

export type EditorStore = {
  get(): Promise<EditorId | null>;
  set(id: EditorId | null): Promise<void>;
};

export function editorStorePath(): string {
  const home = process.env.STRADO_HOME || path.join(os.homedir(), '.strado');
  return path.join(home, 'editors.json');
}

const isEditorId = (v: unknown): v is EditorId => EDITORS.some((e) => e.id === v);

export function createEditorStore(file: () => string = editorStorePath): EditorStore {
  return {
    async get() {
      try {
        const raw = JSON.parse(await fs.readFile(file(), 'utf8')) as { preferred?: unknown };
        return isEditorId(raw.preferred) ? raw.preferred : null;
      } catch {
        return null;
      }
    },
    async set(id) {
      const p = file();
      await fs.mkdir(path.dirname(p), { recursive: true });
      const tmp = `${p}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify({ preferred: id }, null, 2));
      await fs.rename(tmp, p);
    },
  };
}
