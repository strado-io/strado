import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readClaudeToken } from './store.js';
import type { AgentLoginBundle, StaticEntry } from './types.js';

/** The bundle before sync stamps it with issuedAt. */
export type CollectedBundle = Omit<AgentLoginBundle, 'issuedAt'>;

// What this laptop can hand a runner: only credentials that do not rotate, so
// two machines holding them never log each other out. Claude = the stored
// setup-token (never the Keychain OAuth blob); Codex = an API key (never its
// ChatGPT oauth tokens); OpenCode and Pi = their static entries: api keys, and
// oauth entries with no refresh token (a refreshing one is never copied).
// From ~/.claude.json only the two non-secret onboarding keys are picked.
// Anything absent or unreadable omits that agent.

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** An auth.json entry that never rotates, reduced to the fields that travel. */
function staticEntry(p: unknown): StaticEntry | null {
  if (!isRecord(p)) return null;
  if (p.type === 'api') return typeof p.key === 'string' && p.key ? { type: 'api', key: p.key } : null;
  if (p.type !== 'oauth' || (p.refresh !== undefined && p.refresh !== '')) return null;
  if (typeof p.access !== 'string' || !p.access || typeof p.expires !== 'number') return null;
  return { type: 'oauth', access: p.access, refresh: '', expires: p.expires };
}

/** The runner refuses a whole bundle over one bad id, so such ids stay here. */
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

async function staticProviders(file: string): Promise<{ providers: Record<string, StaticEntry> } | undefined> {
  const raw = await readJson(file);
  if (!isRecord(raw)) return undefined;
  const providers: Record<string, StaticEntry> = {};
  for (const [name, p] of Object.entries(raw)) {
    const e = PROVIDER_ID.test(name) ? staticEntry(p) : null;
    if (e) providers[name] = e;
  }
  return Object.keys(providers).length ? { providers } : undefined;
}

export async function collectBundle(deps: { home?: string; readToken?: () => Promise<string | null> } = {}): Promise<CollectedBundle> {
  const home = deps.home ?? os.homedir();
  const readToken = deps.readToken ?? readClaudeToken;
  const bundle: CollectedBundle = {};

  const token = await readToken();
  if (token) {
    const cfg = await readJson(path.join(home, '.claude.json'));
    bundle.claude = { token };
    if (isRecord(cfg)) {
      if (isRecord(cfg.oauthAccount)) bundle.claude.oauthAccount = cfg.oauthAccount;
      if (typeof cfg.lastOnboardingVersion === 'string') bundle.claude.lastOnboardingVersion = cfg.lastOnboardingVersion;
    }
  }

  const codex = await readJson(path.join(home, '.codex', 'auth.json'));
  if (isRecord(codex) && typeof codex.OPENAI_API_KEY === 'string' && codex.OPENAI_API_KEY) {
    bundle.codex = { apiKey: codex.OPENAI_API_KEY };
  }

  const opencode = await staticProviders(path.join(home, '.local', 'share', 'opencode', 'auth.json'));
  if (opencode) bundle.opencode = opencode;
  const pi = await staticProviders(path.join(home, '.pi', 'agent', 'auth.json'));
  if (pi) bundle.pi = pi;

  return bundle;
}
