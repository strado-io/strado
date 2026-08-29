import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { AgentMode } from './handoffStore.js';

export type AgentSessionReference = {
  mode: AgentMode;
  worktreePath: string;
  sessionId: string;
  providerSessionId: string;
  transcriptPath?: string;
  updatedAt: string;
};

type AgentSessionFile = { sessions: AgentSessionReference[] };

export type AgentSessionRegistry = {
  get(mode: AgentMode, worktreePath: string, sessionId: string): Promise<AgentSessionReference | null>;
  set(input: Omit<AgentSessionReference, 'updatedAt'>): Promise<AgentSessionReference>;
};

const keyOf = (mode: AgentMode, worktreePath: string, sessionId: string) =>
  `${mode}\0${path.resolve(worktreePath)}\0${sessionId}`;

/**
 * Maps a Strado tab id (for example OpenCode 2) to the provider's real
 * conversation id. Agent hooks learn that id at turn boundaries. Persisting
 * the mapping prevents two tabs in one worktree from handing off the wrong
 * conversation and keeps it usable after a server restart.
 */
export function createAgentSessionRegistry(filePath: string): AgentSessionRegistry {
  let queue: Promise<void> = Promise.resolve();

  async function read(): Promise<AgentSessionFile> {
    if (!fs.existsSync(filePath)) return { sessions: [] };
    try {
      const parsed = JSON.parse(await fsp.readFile(filePath, 'utf8')) as Partial<AgentSessionFile>;
      return { sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [] };
    } catch {
      // This is an opportunistic index, not source-of-truth user data. A
      // malformed entry must not prevent agents or handoffs from starting.
      return { sessions: [] };
    }
  }

  async function write(state: AgentSessionFile): Promise<void> {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(state, null, 2));
    await fsp.rename(tmp, filePath);
  }

  return {
    get(mode, worktreePath, sessionId) {
      const next = queue.then(async () => {
        const key = keyOf(mode, worktreePath, sessionId);
        return (await read()).sessions.find(
          (entry) => keyOf(entry.mode, entry.worktreePath, entry.sessionId) === key,
        ) ?? null;
      });
      queue = next.then(() => undefined, () => undefined);
      return next;
    },
    set(input) {
      const next = queue.then(async () => {
        const state = await read();
        const key = keyOf(input.mode, input.worktreePath, input.sessionId);
        const entry: AgentSessionReference = {
          ...input,
          worktreePath: path.resolve(input.worktreePath),
          updatedAt: new Date().toISOString(),
        };
        const index = state.sessions.findIndex(
          (candidate) => keyOf(candidate.mode, candidate.worktreePath, candidate.sessionId) === key,
        );
        if (index === -1) state.sessions.push(entry);
        else state.sessions[index] = entry;
        if (state.sessions.length > 500) {
          state.sessions.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
          state.sessions.splice(0, state.sessions.length - 500);
        }
        await write(state);
        return entry;
      });
      queue = next.then(() => undefined, () => undefined);
      return next;
    },
  };
}
