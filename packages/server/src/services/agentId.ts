import path from 'node:path';
import { parseSessionKey } from './terminalManager.js';

/** Worktree slug for an agent id: the path basename with anything outside
 * the id alphabet replaced. Disambiguation (`~2`) is the registry's job — it
 * needs scope-wide knowledge this pure helper does not have. */
export function slugOf(worktreePath: string): string {
  return path.basename(worktreePath).replace(/[^A-Za-z0-9_.-]/g, '-');
}

/** `<mode>-<tab>@<slug>` — stable for the life of a tab, byte-exact. */
export function agentIdFor(key: string, slug: string): string {
  const { mode, id } = parseSessionKey(key);
  return `${mode}-${id}@${slug}`;
}

export const ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

export function isValidAlias(alias: string): boolean {
  return ALIAS_PATTERN.test(alias);
}
