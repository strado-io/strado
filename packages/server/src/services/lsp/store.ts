// Which language servers the user turned off. Every server is on unless it is
// listed here, so a new server in LSP_SERVERS is on without a migration.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { LspServerId } from './types.js';

export type LspEnabledStore = {
  isEnabled(id: LspServerId): Promise<boolean>;
  setEnabled(id: LspServerId, enabled: boolean): Promise<void>;
};

export function lspStorePath(): string {
  const home = process.env.STRADO_HOME || path.join(os.homedir(), '.strado');
  return path.join(home, 'lsp-servers.json');
}

export function createLspEnabledStore(file: () => string = lspStorePath): LspEnabledStore {
  let queue: Promise<unknown> = Promise.resolve();
  const read = async (): Promise<LspServerId[]> => {
    try {
      const raw = JSON.parse(await fs.readFile(file(), 'utf8')) as { disabled?: unknown };
      return Array.isArray(raw.disabled) ? raw.disabled.filter((x): x is LspServerId => typeof x === 'string') : [];
    } catch {
      return [];
    }
  };
  return {
    async isEnabled(id) {
      return !(await read()).includes(id);
    },
    setEnabled(id, enabled) {
      const next = queue.then(async () => {
        const disabled = new Set(await read());
        if (enabled) disabled.delete(id);
        else disabled.add(id);
        const p = file();
        await fs.mkdir(path.dirname(p), { recursive: true });
        const tmp = `${p}.${process.pid}.tmp`;
        await fs.writeFile(tmp, JSON.stringify({ disabled: [...disabled].sort() }, null, 2));
        await fs.rename(tmp, p);
      });
      queue = next.catch(() => {});
      return next;
    },
  };
}
