// Runner side of a host's Connections tab: is each agent actually logged in
// here? Every check runs the agent's own CLI in a one-shot container, so the
// answer is what a sandbox would see. `connected` comes only from here.
//
// Output from the CLIs is parsed, never returned: every detail is a fixed
// sentence or a list of sanitized provider names.
import { runOneShot, stripAnsi, type OneShotDeps } from './oneShot.js';
import type { ConnectionAgent, RunnerCheckResult } from './types.js';

export type CheckDeps = OneShotDeps & { readClaudeToken(): Promise<string | null> };

const CANNOT_RUN: RunnerCheckResult = { state: 'unknown', detail: 'could not run the check on this runner' };
const NOT_CONNECTED: RunnerCheckResult = { state: 'not-connected', detail: null };

const providers = (names: string[]) =>
  `${names.length} provider${names.length === 1 ? '' : 's'}: ${names.join(', ')}`;
/** A provider name the CLI printed, cut to something safe to show. */
const safeName = (s: string) => s.replace(/[^\w .()/-]/g, '').trim().slice(0, 40);

async function checkClaude(deps: CheckDeps): Promise<RunnerCheckResult> {
  const token = await deps.readClaudeToken();
  if (!token) return NOT_CONNECTED;
  // `claude auth status` reports any non-empty token as logged in; only a real
  // call proves the token works. No volume: the call must not leave a session
  // in the shared HOME.
  const r = await runOneShot(deps, {
    volume: false,
    cmd: ['sh', '-c', 'IFS= read -r CLAUDE_CODE_OAUTH_TOKEN; export CLAUDE_CODE_OAUTH_TOKEN; exec claude -p ok --max-turns 1 </dev/null'],
    input: `${token}\n`,
    timeoutMs: 90_000,
  });
  if (r.code === 0) return { state: 'connected', detail: 'Logged in with a Claude subscription' };
  if (/\b401\b|Invalid bearer token|Failed to authenticate/i.test(r.stdout + r.stderr)) {
    return { state: 'failed', detail: 'Claude rejected the stored token' };
  }
  return CANNOT_RUN;
}

async function checkCodex(deps: CheckDeps): Promise<RunnerCheckResult> {
  const r = await runOneShot(deps, { volume: true, cmd: ['codex', 'login', 'status'], timeoutMs: 30_000 });
  const out = stripAnsi(r.stdout + r.stderr);
  if (r.code === 0 && /Logged in/i.test(out)) {
    if (/ChatGPT/i.test(out)) return { state: 'connected', detail: 'Logged in with ChatGPT' };
    if (/API key/i.test(out)) return { state: 'connected', detail: 'Logged in with an API key' };
    return { state: 'connected', detail: 'Logged in' };
  }
  if (r.code === 1 && /Not logged in/i.test(out)) return NOT_CONNECTED;
  return CANNOT_RUN;
}

async function checkOpencode(deps: CheckDeps): Promise<RunnerCheckResult> {
  const r = await runOneShot(deps, { volume: true, cmd: ['opencode', 'auth', 'list'], timeoutMs: 30_000 });
  if (r.code !== 0) return CANNOT_RUN;
  // "●  <Provider name> <type>" per credential.
  const names = stripAnsi(r.stdout)
    .split('\n')
    .map((l) => /^[│|\s]*●\s+(.+?)\s+[a-z-]+\s*$/.exec(l)?.[1])
    .filter((n): n is string => !!n)
    .map(safeName)
    .filter(Boolean);
  return names.length ? { state: 'connected', detail: providers(names) } : NOT_CONNECTED;
}

// Runs inside the container (plain node, CommonJS). Reads only the provider
// ids and whether each has a refresh token, asks `pi auth check` about each,
// and prints one JSON line. --no-refresh: a check must never write the file.
const PI_SCRIPT = String.raw`
const fs = require('fs'), path = require('path'), cp = require('child_process');
const f = path.join(process.env.HOME, '.pi', 'agent', 'auth.json');
let raw;
try { raw = fs.readFileSync(f, 'utf8'); } catch { process.stdout.write('{"providers":[]}\n'); process.exit(0); }
let auth;
try { auth = JSON.parse(raw); } catch { process.stdout.write('{"bad":true}\n'); process.exit(0); }
if (!auth || typeof auth !== 'object' || Array.isArray(auth)) { process.stdout.write('{"bad":true}\n'); process.exit(0); }
const out = [];
for (const id of Object.keys(auth).sort()) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) continue;
  const e = auth[id];
  const refresh = !!(e && typeof e.refresh === 'string' && e.refresh.length);
  let stdout = '';
  try {
    stdout = cp.execFileSync('pi', ['auth', 'check', '--provider', id, '--json', '--no-refresh'], { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (err) { stdout = String((err && err.stdout) || ''); }
  let ready = false;
  try { ready = JSON.parse(stdout.trim().split('\n').pop()).status === 'ready'; } catch {}
  out.push({ id, ready, refresh });
}
process.stdout.write(JSON.stringify({ providers: out }) + '\n');
`;

async function checkPi(deps: CheckDeps): Promise<RunnerCheckResult> {
  const r = await runOneShot(deps, { volume: true, cmd: ['node', '-e', PI_SCRIPT], timeoutMs: 120_000 });
  if (r.code !== 0) return CANNOT_RUN;
  let report: { bad?: boolean; providers?: { id: string; ready: boolean; refresh: boolean }[] };
  try {
    report = JSON.parse(r.stdout.trim().split('\n').pop() ?? '');
  } catch {
    return CANNOT_RUN;
  }
  if (report.bad || !Array.isArray(report.providers)) return CANNOT_RUN;
  const ready = report.providers.filter((p) => p.ready).map((p) => safeName(String(p.id)));
  const needsTerminal = report.providers.some((p) => p.refresh && !p.ready);
  const base: RunnerCheckResult = ready.length ? { state: 'connected', detail: providers(ready) } : NOT_CONNECTED;
  return needsTerminal ? { ...base, needsTerminal: true } : base;
}

export async function checkAgent(agent: ConnectionAgent, deps: CheckDeps): Promise<RunnerCheckResult> {
  try {
    switch (agent) {
      case 'claude': return await checkClaude(deps);
      case 'codex': return await checkCodex(deps);
      case 'opencode': return await checkOpencode(deps);
      case 'pi': return await checkPi(deps);
    }
  } catch {
    return CANNOT_RUN;
  }
}
