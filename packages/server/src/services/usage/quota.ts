import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { isRecord } from './claudeLogs.js';
import type { RateLimitSnapshot } from './codexLogs.js';

const run = promisify(execFile);

export type QuotaWindow = { label: string; usedPercent: number; resetsAt: number | null };

export type AccountCard = {
  agent: 'claude' | 'codex';
  /**
   * When these numbers were measured. Live for Claude (an API call per refresh);
   * for Codex it is the last snapshot its CLI wrote, which only happens while a
   * session runs — so the UI says how old it is.
   */
  measuredAt: number | null;
  /** Account email when known, else a generic name. Never a credential. */
  accountLabel: string;
  /** Plan badge as the vendor names it: TEAM, MAX, PRO, PLUS. */
  plan: string | null;
  /** Where the credential lives, shown so users know what they are looking at. */
  credentialSource: string;
  windows: QuotaWindow[];
  /**
   * 'official' means the numbers came from the vendor (an API call for Claude, a
   * rate-limit snapshot the CLI wrote for Codex). 'unavailable' means we have
   * none — the UI says so rather than showing a guess as if it were a limit.
   */
  quotaStatus: 'official' | 'unavailable';
};

/** Claude Code's `/usage` endpoint; see the design doc for how it is reached. */
const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CLAUDE_OAUTH_BETA = 'oauth-2025-04-20';
const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const CACHE_MS = 5 * 60_000;

/**
 * Legacy shape: fixed top-level keys. Only read when the payload carries no
 * `limits` array, which is self-describing and covers model-scoped windows the
 * fixed keys cannot name.
 */
const CLAUDE_LEGACY_WINDOWS: { key: string; label: string }[] = [
  { key: 'five_hour', label: 'Session (5h)' },
  { key: 'seven_day', label: 'Weekly' },
];

export type QuotaServiceOptions = {
  /** Home dir holding `.claude.json` and `.codex`; `app.deps.agentHomeDir`. */
  agentHomeDir: string;
  /** Newest Codex rate-limit snapshot, from the usage store. */
  codexRateLimits: () => Promise<RateLimitSnapshot | null>;
  /** Overridden in tests; by default the Keychain or the credentials file. */
  readClaudeToken?: () => Promise<string>;
  fetchImpl?: typeof fetch;
};

export type QuotaService = { accounts(): Promise<AccountCard[]> };

const asPercent = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  // Payloads have used both a 0-100 percentage and a 0-1 share; a value at or
  // below 1 is ambiguous only when usage is under 1%, where both read the same.
  return value > 1 ? value : value * 100;
};

const asTimestamp = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Seconds or milliseconds — anything below this bound is clearly seconds.
    return value < 10_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

/**
 * A window whose reset has passed has rolled over: the percentage Codex wrote
 * before the reset describes a window that no longer exists. Codex itself
 * reports a fresh window after re-reading, so a stale row is zeroed rather than
 * left claiming usage the account no longer has against it.
 *
 * The next reset is unknowable from a rolled-over snapshot — it depends on when
 * the next turn runs — so it is dropped rather than guessed.
 */
export function dropRolledOverWindows(windows: QuotaWindow[], now = Date.now()): QuotaWindow[] {
  return windows.map((window) => (
    window.resetsAt !== null && window.resetsAt <= now
      ? { ...window, usedPercent: 0, resetsAt: null }
      : window
  ));
}

/** `weekly_scoped` → `Weekly · Fable`: the scope names what the window covers. */
function scopedSuffix(scope: unknown): string | null {
  if (!isRecord(scope)) return null;
  const model = isRecord(scope.model) ? scope.model : null;
  const name = model && typeof model.display_name === 'string' ? model.display_name : null;
  if (name) return name;
  return typeof scope.surface === 'string' && scope.surface ? scope.surface : null;
}

function limitLabel(kind: string, scope: unknown): string {
  const suffix = scopedSuffix(scope);
  if (kind === 'session') return 'Session (5h)';
  if (kind === 'weekly_all') return 'Weekly';
  if (kind === 'weekly_scoped') return suffix ? `Weekly · ${suffix}` : 'Weekly · scoped';
  // An unfamiliar window still gets a readable row rather than being dropped.
  const readable = kind.replace(/_/g, ' ').replace(/^\w/, (first) => first.toUpperCase());
  return suffix ? `${readable} · ${suffix}` : readable;
}

/**
 * The usage payload's `limits` array: one entry per rate-limit window, each
 * naming its own kind and scope. Preferred over the fixed top-level keys
 * because model-scoped windows (a weekly cap that applies to one model only)
 * arrive here with the model's display name, and their key names are internal
 * codenames that change.
 */
export function parseClaudeLimits(value: unknown): QuotaWindow[] {
  if (!Array.isArray(value)) return [];
  const windows: QuotaWindow[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const kind = typeof entry.kind === 'string' ? entry.kind : '';
    const percent = entry.percent ?? entry.utilization;
    if (!kind || typeof percent !== 'number' || !Number.isFinite(percent)) continue;
    windows.push({
      label: limitLabel(kind, entry.scope),
      usedPercent: asPercent(percent),
      resetsAt: asTimestamp(entry.resets_at),
    });
  }
  return windows;
}

function claudePlan(account: Record<string, unknown>): string | null {
  const orgType = typeof account.organizationType === 'string' ? account.organizationType : '';
  if (orgType.includes('team')) return 'TEAM';
  if (orgType.includes('enterprise')) return 'ENTERPRISE';
  const tier = typeof account.userRateLimitTier === 'string' ? account.userRateLimitTier : '';
  if (tier.includes('max')) return 'MAX';
  if (tier.includes('pro')) return 'PRO';
  return null;
}

async function keychainToken(): Promise<string> {
  const { stdout } = await run('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w']);
  const raw = stdout.trim();
  // The Keychain item holds the credentials JSON, not a bare token.
  try {
    const parsed = JSON.parse(raw);
    const oauth = isRecord(parsed) && isRecord(parsed.claudeAiOauth) ? parsed.claudeAiOauth : null;
    const token = oauth && typeof oauth.accessToken === 'string' ? oauth.accessToken : null;
    if (!token) throw new Error('no accessToken in keychain item');
    return token;
  } catch (err) {
    if (raw.startsWith('{')) throw err as Error;
    return raw;
  }
}

async function fileToken(agentHomeDir: string): Promise<string> {
  const raw = await fsp.readFile(path.join(agentHomeDir, '.claude', '.credentials.json'), 'utf8');
  const parsed = JSON.parse(raw);
  const oauth = isRecord(parsed) && isRecord(parsed.claudeAiOauth) ? parsed.claudeAiOauth : null;
  const token = oauth && typeof oauth.accessToken === 'string' ? oauth.accessToken : null;
  if (!token) throw new Error('no accessToken in credentials file');
  return token;
}

/**
 * OpenAI namespaces its claims under an object keyed by a URL. Some tokens
 * flatten that into a dotted key instead, so both spellings are checked.
 */
function codexPlan(claims: Record<string, unknown> | null): string | null {
  if (!claims) return null;
  const namespaced = claims['https://api.openai.com/auth'];
  const nested = isRecord(namespaced) ? namespaced.chatgpt_plan_type : undefined;
  const flat = claims['https://api.openai.com/auth.chatgpt_plan_type'];
  const plan = [nested, flat].find((value) => typeof value === 'string' && value);
  return typeof plan === 'string' ? plan.toUpperCase() : null;
}

function decodeJwtClaims(token: string): Record<string, unknown> | null {
  const body = token.split('.')[1];
  if (!body) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Account identity and quota for every agent signed in on this machine.
 *
 * Identity is always local: Claude Code keeps it in `~/.claude.json` and Codex
 * in its id token. Quota is not — Codex writes rate-limit snapshots into its
 * rollout logs, but Claude Code has to be asked, so that one call is cached and
 * every failure degrades to `quotaStatus: 'unavailable'` instead of throwing.
 */
export function createQuotaService({
  agentHomeDir,
  codexRateLimits,
  readClaudeToken,
  fetchImpl = fetch,
}: QuotaServiceOptions): QuotaService {
  const readToken = readClaudeToken
    ?? (async () => (process.platform === 'darwin' ? keychainToken() : fileToken(agentHomeDir)));

  let cached: { at: number; cards: AccountCard[] } | null = null;

  async function claudeQuota(): Promise<QuotaWindow[]> {
    let token: string;
    try {
      token = await readToken();
    } catch {
      return [];
    }
    if (!token) return [];
    let payload: unknown;
    try {
      const res = await fetchImpl(CLAUDE_USAGE_URL, {
        headers: {
          authorization: `Bearer ${token}`,
          'anthropic-beta': CLAUDE_OAUTH_BETA,
          accept: 'application/json',
        },
      });
      if (!res.ok) return [];
      payload = await res.json();
    } catch {
      return [];
    }
    if (!isRecord(payload)) return [];
    const source = isRecord(payload.usage) ? payload.usage : payload;
    const fromLimits = parseClaudeLimits(source.limits);
    if (fromLimits.length) return fromLimits;

    const windows: QuotaWindow[] = [];
    for (const { key, label } of CLAUDE_LEGACY_WINDOWS) {
      const entry = source[key];
      if (!isRecord(entry)) continue;
      windows.push({
        label,
        usedPercent: asPercent(entry.utilization ?? entry.used_percent ?? entry.percent_used),
        resetsAt: asTimestamp(entry.resets_at ?? entry.reset_at ?? entry.resetsAt),
      });
    }
    return windows;
  }

  async function claudeCard(): Promise<AccountCard | null> {
    let account: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(await fsp.readFile(path.join(agentHomeDir, '.claude.json'), 'utf8'));
      account = isRecord(parsed) && isRecord(parsed.oauthAccount) ? parsed.oauthAccount : null;
    } catch {
      account = null;
    }
    if (!account) return null;
    const windows = await claudeQuota();
    return {
      agent: 'claude',
      // Fetched just now, so the numbers are as live as the vendor has them.
      measuredAt: windows.length ? Date.now() : null,
      accountLabel: typeof account.emailAddress === 'string' ? account.emailAddress : 'Claude account',
      plan: claudePlan(account),
      credentialSource: process.platform === 'darwin' ? 'Keychain' : '~/.claude',
      windows,
      quotaStatus: windows.length ? 'official' : 'unavailable',
    };
  }

  async function codexCard(): Promise<AccountCard | null> {
    let tokens: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(await fsp.readFile(path.join(agentHomeDir, '.codex', 'auth.json'), 'utf8'));
      tokens = isRecord(parsed) && isRecord(parsed.tokens) ? parsed.tokens : null;
    } catch {
      return null;
    }
    if (!tokens) return null;
    const claims = typeof tokens.id_token === 'string' ? decodeJwtClaims(tokens.id_token) : null;
    const snapshot = await codexRateLimits();
    const windows = dropRolledOverWindows(snapshot?.windows ?? []);
    return {
      agent: 'codex',
      measuredAt: snapshot?.capturedAt ?? null,
      accountLabel: typeof claims?.email === 'string' ? claims.email : 'Codex account',
      plan: codexPlan(claims),
      credentialSource: '~/.codex',
      windows,
      quotaStatus: windows.length ? 'official' : 'unavailable',
    };
  }

  return {
    async accounts() {
      if (cached && Date.now() - cached.at < CACHE_MS) return cached.cards;
      const [claude, codex] = await Promise.all([claudeCard(), codexCard()]);
      const cards = [claude, codex].filter((card): card is AccountCard => card !== null);
      cached = { at: Date.now(), cards };
      return cards;
    },
  };
}
