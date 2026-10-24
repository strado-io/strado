// Writes agent-login files into the shared sandbox HOME volume through a
// one-shot container, so ownership comes out right on both runtimes: the
// container runs with the same user mapping as a real sandbox, which is the
// one thing that knows who `node` is on this host. Writing the volume's
// mountpoint directly does not work for docker (root-owned /var/lib/docker)
// and depends on storage config for podman.
//
// The payload travels on stdin only — argv and `-e` show up in `ps` and in the
// runtime's inspect output.
import { randomBytes } from 'node:crypto';
import type { ExecFn, SandboxRuntime } from '../sandbox/runtime.js';
import { HOME_VOLUME } from '../sandbox/sandboxes.js';
import type { AgentName, AgentOutcome, StaticEntry } from './types.js';

/** prev: what this runner was last sent for the agent (the store's record of
 *  synced ids). An id is written only where the file lacks it or still holds
 *  exactly what was sent before; a previously sent id no longer in providers
 *  is removed on the same terms. Defaults to providers itself (a re-apply). */
export type SyncedProviders = { providers: Record<string, StaticEntry>; prev?: Record<string, StaticEntry> };

export type VolumePayload = {
  claude?: { oauthAccount?: Record<string, unknown>; lastOnboardingVersion?: string; trustPaths?: string[] };
  codex?: { apiKey: string };
  opencode?: SyncedProviders;
  pi?: SyncedProviders;
};

const AGENTS: AgentName[] = ['claude', 'codex', 'opencode', 'pi'];

// Runs inside the container (plain node, CommonJS). Every write merges into
// what is there and never replaces a login the host made itself; an existing
// file that will not parse fails that agent rather than being overwritten.
// Prints one JSON line of outcomes for the agents present in the payload.
const SCRIPT = String.raw`
const fs = require('fs'), path = require('path');
process.umask(0o077);
const H = process.env.HOME;
const BAD = Symbol('bad');
const read = (f) => {
  let raw;
  try { raw = fs.readFileSync(f, 'utf8'); } catch { return null; }
  try { return JSON.parse(raw); } catch { return BAD; }
};
const save = (f, before, next) => {
  if (before && JSON.stringify(before) === JSON.stringify(next)) return 'unchanged';
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  const tmp = f + '.strado-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, f);
  return 'written';
};
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
// Only ids this runner was sent are ever touched, and only while the file
// still holds what was sent: an entry made or changed on this host is kept.
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const mergeProviders = (f, p) => {
  const providers = p.providers || {};
  const prev = p.prev || providers;
  const cur = read(f);
  if (cur === BAD || (cur !== null && !isObj(cur))) return 'failed';
  const next = { ...(cur || {}) };
  for (const [name, entry] of Object.entries(prev)) {
    if (!(name in providers) && same(next[name], entry)) delete next[name];
  }
  for (const [name, entry] of Object.entries(providers)) {
    if (next[name] === undefined || same(next[name], prev[name])) next[name] = entry;
  }
  if (cur === null && !Object.keys(next).length) return 'unchanged';
  return save(f, cur, next);
};
const writers = {
  claude(p) {
    const f = path.join(H, '.claude.json');
    const cur = read(f);
    if (cur === BAD || (cur !== null && !isObj(cur))) return 'failed';
    const next = { ...(cur || {}), hasCompletedOnboarding: true };
    if (p.lastOnboardingVersion) next.lastOnboardingVersion = p.lastOnboardingVersion;
    if (p.oauthAccount) next.oauthAccount = p.oauthAccount;
    if (p.trustPaths && p.trustPaths.length) {
      const projects = isObj(next.projects) ? { ...next.projects } : {};
      for (const t of p.trustPaths) projects[t] = { ...(isObj(projects[t]) ? projects[t] : {}), hasTrustDialogAccepted: true };
      next.projects = projects;
    }
    return save(f, cur, next);
  },
  codex(p) {
    const f = path.join(H, '.codex', 'auth.json');
    const cur = read(f);
    if (cur === BAD || (cur !== null && !isObj(cur))) return 'failed';
    // A login the host made itself (ChatGPT tokens) wins over a pushed key.
    if (cur && (cur.auth_mode ? cur.auth_mode !== 'apikey' : cur.tokens)) return 'unchanged';
    return save(f, cur, { auth_mode: 'apikey', OPENAI_API_KEY: p.apiKey });
  },
  opencode(p) {
    return mergeProviders(path.join(H, '.local', 'share', 'opencode', 'auth.json'), p);
  },
  pi(p) {
    return mergeProviders(path.join(H, '.pi', 'agent', 'auth.json'), p);
  },
};
let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  const payload = JSON.parse(raw);
  const out = {};
  for (const name of Object.keys(writers)) {
    if (!payload[name]) continue;
    try { out[name] = writers[name](payload[name]); } catch { out[name] = 'failed'; }
  }
  process.stdout.write(JSON.stringify(out) + '\n');
});
`;

export async function writeHomeVolume(
  deps: { rt: SandboxRuntime; exec: ExecFn; image: string; userArgs: string[] },
  payload: VolumePayload,
): Promise<Record<AgentName, AgentOutcome>> {
  const present = AGENTS.filter((a) => payload[a]);
  const result = Object.fromEntries(AGENTS.map((a) => [a, 'skipped'])) as Record<AgentName, AgentOutcome>;
  if (present.length === 0) return result;
  const failAll = () => {
    for (const a of present) result[a] = 'failed';
    return result;
  };

  // Named, so a run whose client is killed at the budget can still be
  // removed: killing `podman run` does not stop the container.
  const name = `strado-vol-${randomBytes(6).toString('hex')}`;
  const removeIt = async () => {
    try {
      await deps.exec(deps.rt.bin, ['rm', '-f', name], 15_000);
    } catch {
      /* best effort */
    }
  };
  const args = [
    'run', '--rm', '-i',
    '--name', name,
    ...deps.userArgs,
    '-e', 'HOME=/home/node',
    '-v', `${HOME_VOLUME}:/home/node`,
    deps.image,
    'node', '-e', SCRIPT,
  ];
  let r: { code: number; stdout: string };
  try {
    // 5 min: a first keep-id run of a fresh image does the same one-time
    // layer copy-up as a sandbox create.
    r = await deps.exec(deps.rt.bin, args, 5 * 60_000, undefined, JSON.stringify(payload));
  } catch {
    await removeIt();
    return failAll();
  }
  if (r.code !== 0) {
    await removeIt();
    return failAll();
  }
  let reported: Partial<Record<AgentName, AgentOutcome>>;
  try {
    reported = JSON.parse(r.stdout.trim().split('\n').pop() ?? '');
  } catch {
    return failAll();
  }
  for (const a of present) {
    const o = reported[a];
    result[a] = o === 'written' || o === 'unchanged' ? o : 'failed';
  }
  return result;
}
