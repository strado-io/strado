// A host's Connections tab: is each agent logged in on this runner, and the one
// button that gets it there. "Connected" only ever comes from a check the runner
// ran; a connect is a server job whose frames carry a phase, a device code to
// type in the browser, or the first-pin question. The page never sees a token.
import { useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import { subscribeJob } from '../../eventStream';
import {
  CONNECTION_AGENTS,
  type AgentConnection,
  type ConnectionAgent,
  type ConnectPhase,
  type ConnectProgress,
  type ConnectQuestion,
  type DeviceLoginPrompt,
} from '../../types';
import { KeyField, SetupTokenButton } from '../settings/CommandBoxSection';

const LABEL: Record<ConnectionAgent, string> = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode', pi: 'Pi' };
const PHASE: Record<ConnectPhase, string> = {
  'opening-browser': 'Opening your browser…',
  'waiting-approval': 'Waiting for you to approve in the browser…',
  saving: 'Saving…',
  syncing: 'Sending to the runner…',
  checking: 'Checking on the runner…',
};

export function ago(ms: number): string {
  const mins = Math.round((Date.now() - ms) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 60 / 24)}d ago`;
}

/** Runner-level trust problems a connect can hit; they block every agent. A
 * changed key is normally asked inside the job (the pin question with the old
 * key); this banner is only the fallback if the job refuses it outright. */
export type TrustProblem =
  | { kind: 'key-changed'; keys?: { expected: string; actual: string } }
  | { kind: 'sender-refused' }
  | { kind: 'inconsistent-key' };

/** The laptop's fixed trust errors (sync.ts), or null for any other failure. */
export function trustProblem(message: string, details: unknown): TrustProblem | null {
  if (/runner key changed/i.test(message)) {
    const d = details as { expected?: unknown; actual?: unknown } | undefined;
    const keys = typeof d?.expected === 'string' && typeof d?.actual === 'string' ? { expected: d.expected, actual: d.actual } : undefined;
    return { kind: 'key-changed', keys };
  }
  if (/inconsistent key/i.test(message)) return { kind: 'inconsistent-key' };
  if (/sender not trusted/i.test(message)) return { kind: 'sender-refused' };
  return null;
}

export function TrustBanner({ problem }: { problem: TrustProblem }) {
  if (problem.kind === 'inconsistent-key') {
    // No trust button: a key that doesn't match its own fingerprint is never one to pin.
    return (
      <div role="alert" className="rounded-md border border-red-900/60 bg-red-950/30 px-3 py-2 text-[11px] text-red-300" data-testid="sync-inconsistent-key">
        The runner sent an inconsistent key — nothing was sent. Check the runner before connecting again.
      </div>
    );
  }
  if (problem.kind === 'sender-refused') {
    // No trust button: only the runner's owner can reset which laptop it trusts.
    return (
      <div role="alert" className="rounded-md border border-amber-900/60 bg-amber-950/30 px-3 py-2 text-[11px] text-amber-300" data-testid="sync-sender-refused">
        This runner trusts a different laptop. To reset, delete <code className="font-mono">~/.strado/runner-sender-pin.json</code> on the runner.
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1 rounded-md border border-amber-900/60 bg-amber-950/30 px-3 py-2 text-[11px] text-amber-300" data-testid="sync-key-changed">
      <span>Runner key changed — nothing was sent.</span>
      {problem.keys && (
        <span className="font-mono text-[10px] text-zinc-400" data-testid="sync-key-compare">
          Expected {problem.keys.expected} · Runner now {problem.keys.actual}
        </span>
      )}
      <span className="text-zinc-500">Connect again to compare the new key with the runner’s before trusting it.</span>
    </div>
  );
}

/** One agent's connect job, in memory only. */
type Run = {
  jobId: string | null;
  phase: ConnectPhase | null;
  device: DeviceLoginPrompt | null;
  question: ConnectQuestion | null;
};
const idle: Run = { jobId: null, phase: null, device: null, question: null };

/** Codex and OpenCode's ChatGPT login both use OpenAI's device page; nothing
 * else a runner sends is opened. */
const safeUrl = (url: string) => { try { const u = new URL(url); return u.protocol === 'https:' && u.hostname === 'auth.openai.com'; } catch { return false; } };
function openPage(url: string) {
  // The desktop shell sends window.open on to the system browser.
  if (safeUrl(url)) window.open(url, '_blank', 'noopener');
}

export function ConnectionsTab({ runnerId, online, pinnedRunnerFingerprint }: {
  runnerId: string;
  online: boolean;
  /** From the host info: null means this laptop never trusted the runner yet. */
  pinnedRunnerFingerprint: string | null;
}) {
  const [rows, setRows] = useState<AgentConnection[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [runs, setRuns] = useState<Partial<Record<ConnectionAgent, Run>>>({});
  const [errors, setErrors] = useState<Partial<Record<ConnectionAgent, string>>>({});
  const [busy, setBusy] = useState<Partial<Record<ConnectionAgent, boolean>>>({});
  const [trust, setTrust] = useState<TrustProblem | null>(null);
  const opened = useRef(new Set<string>());
  const subs = useRef(new Map<ConnectionAgent, () => void>());

  useEffect(() => {
    let live = true;
    Promise.resolve().then(() => api.runners.connections.list(runnerId))
      .then(({ connections, stale: old }) => { if (live) { setRows(connections); setStale(!!old); setLoadError(null); } })
      .catch((err: Error) => { if (live) setLoadError(err.message); });
    return () => { live = false; };
  }, [runnerId]);
  useEffect(() => () => { for (const off of subs.current.values()) off(); }, []);

  const put = (connection: AgentConnection) =>
    setRows((rs) => (rs ?? []).some((r) => r.agent === connection.agent)
      ? (rs ?? []).map((r) => (r.agent === connection.agent ? connection : r))
      : [...(rs ?? []), connection]);
  const setRun = (agent: ConnectionAgent, f: (r: Run) => Run | null) =>
    setRuns((m) => {
      const next = f(m[agent] ?? idle);
      const out = { ...m };
      if (next) out[agent] = next; else delete out[agent];
      return out;
    });
  const stop = (agent: ConnectionAgent) => {
    subs.current.get(agent)?.();
    subs.current.delete(agent);
    setRun(agent, () => null);
  };
  const fail = (agent: ConnectionAgent, message: string, details?: unknown) => {
    const problem = trustProblem(message, details);
    if (problem) setTrust(problem);
    // A declined first pin or a cancel changed nothing: the row keeps its state, as the server's cache does.
    else if (/not trusted yet|connect cancelled|trust changed meanwhile/i.test(message)) setErrors((e) => ({ ...e, [agent]: message }));
    else {
      setRows((rs) => (rs ?? []).map((r) => (r.agent === agent ? { ...r, state: 'failed', detail: message } : r)));
    }
  };

  const connect = async (agent: ConnectionAgent) => {
    setErrors((e) => ({ ...e, [agent]: undefined }));
    setTrust(null);
    setRun(agent, () => ({ ...idle }));
    try {
      const { jobId } = await api.runners.connections.connect(runnerId, agent);
      setRun(agent, (r) => ({ ...r, jobId }));
      subs.current.set(agent, subscribeJob(jobId, (evt) => {
        if (evt.type === 'progress') {
          const p = ((evt.data ?? {}) as { data?: ConnectProgress }).data;
          if (!p) return;
          if ('device' in p) {
            if (!opened.current.has(jobId)) { opened.current.add(jobId); openPage(p.device.url); }
            setRun(agent, (r) => ({ ...r, device: p.device }));
          } else if ('question' in p) setRun(agent, (r) => ({ ...r, question: p.question }));
          else if ('phase' in p) setRun(agent, (r) => ({ ...r, phase: p.phase, device: p.phase === 'waiting-approval' ? r.device : null }));
          return;
        }
        stop(agent);
        if (evt.type === 'done') {
          const result = ((evt.data ?? {}) as { result?: { connection?: AgentConnection } }).result;
          if (result?.connection) put(result.connection);
          return;
        }
        const d = (evt.data ?? {}) as { message?: string; error?: string; details?: unknown };
        fail(agent, d.message || d.error || 'Connect stopped', d.details);
      }));
    } catch (err) {
      // Refused before a job started ('already connecting', 'runner is offline'):
      // the row keeps its state and says why.
      stop(agent);
      setErrors((e) => ({ ...e, [agent]: (err as Error).message }));
    }
  };

  const cancel = (agent: ConnectionAgent) => {
    const id = runs[agent]?.jobId;
    stop(agent);
    if (id) void api.runners.connections.cancel(id).catch(() => {});
  };

  const answer = async (agent: ConnectionAgent, yes: boolean) => {
    const run = runs[agent];
    if (!run?.jobId || !run.question) return;
    const questionId = run.question.id;
    setRun(agent, (r) => ({ ...r, question: null }));
    await api.runners.connections.answer(run.jobId, { questionId, yes }).catch((err: Error) => fail(agent, err.message));
  };

  const act = async (agent: ConnectionAgent, call: () => Promise<{ connection: AgentConnection }>) => {
    setBusy((b) => ({ ...b, [agent]: true }));
    setErrors((e) => ({ ...e, [agent]: undefined }));
    try {
      put((await call()).connection);
    } catch (err) {
      setErrors((e) => ({ ...e, [agent]: (err as Error).message }));
    } finally {
      setBusy((b) => ({ ...b, [agent]: false }));
    }
  };
  const check = (agent: ConnectionAgent) => act(agent, () => api.runners.connections.check(runnerId, agent));
  const disconnect = (agent: ConnectionAgent) => {
    const ask = agent === 'claude'
      ? 'Removes Claude from this runner. Your other runners keep it.'
      : `Disconnect ${LABEL[agent]} on this runner? New sandboxes here stop getting its login.`;
    if (!confirm(ask)) return;
    void act(agent, () => api.runners.connections.disconnect(runnerId, agent));
  };

  // The server's word wins: a runner the list calls online may still be unreachable.
  const live = online && !stale;
  const pending = CONNECTION_AGENTS.map((a) => [a, runs[a]] as const).find(([, r]) => r?.question);

  return (
    <section className="flex flex-col gap-3" data-testid="connections-tab">
      {!live && (
        <p className="rounded-md border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-xs text-zinc-400" data-testid="conn-offline">
          Runner offline — showing the last check.
        </p>
      )}
      {live && pinnedRunnerFingerprint === null && !pending && (
        <p className="text-[11px] text-zinc-500" data-testid="first-trust-hint">The first Connect asks you to compare this laptop’s key with the runner’s.</p>
      )}
      {trust && <TrustBanner problem={trust} />}
      {pending && <PinQuestion q={pending[1]!.question!} onAnswer={(yes) => void answer(pending[0], yes)} />}
      {loadError ? (
        <p role="alert" className="text-xs text-red-300">Couldn’t load connections: {loadError}</p>
      ) : rows === null ? (
        <p className="text-xs text-zinc-500">Loading…</p>
      ) : (
        <ul className="flex flex-col divide-y divide-zinc-800 rounded border border-zinc-800">
          {CONNECTION_AGENTS.map((agent) => {
            const c = rows.find((r) => r.agent === agent) ?? { agent, state: 'unknown' as const, detail: null, checkedAt: null };
            return (
              <ConnectionRow key={agent} c={c} run={runs[agent]} online={live} busy={!!busy[agent]} error={errors[agent]}
                onConnect={() => void connect(agent)} onCancel={() => cancel(agent)}
                onCheck={() => void check(agent)} onDisconnect={() => disconnect(agent)} />
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** The job's trust question: a first contact, or a key that changed since this
 * laptop trusted it (then the old key is shown too). */
function PinQuestion({ q, onAnswer }: { q: ConnectQuestion; onAnswer: (yes: boolean) => void }) {
  const changed = !!q.previousFingerprint;
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-amber-900/60 bg-amber-950/30 px-3 py-2.5 text-xs text-amber-100" data-testid="pin-question" data-changed={changed || undefined}>
      <span className="font-medium">{changed ? 'This runner’s key changed. Trust the new one?' : 'Trust this runner?'}</span>
      {changed && <span className="font-mono text-[11px] text-zinc-400">Trusted before {q.previousFingerprint}</span>}
      <span className="font-mono text-[11px] text-zinc-300">{changed ? 'Runner’s new key' : 'Runner’s key'} {q.runnerFingerprint}</span>
      <span className="font-mono text-[11px] text-zinc-300">This laptop’s key {q.laptopFingerprint}</span>
      <span className="text-[11px] text-zinc-500">
        {changed ? 'A reinstall or a new machine changes it; anything else, don’t trust it. ' : ''}
        The runner’s key should match <code className="font-mono">strado-runner key</code> on the box. Once trusted, your logins are sent only to this key.
      </span>
      <div className="flex gap-2">
        <button type="button" onClick={() => onAnswer(true)} className="rounded-md bg-amber-700 px-3 py-1 text-xs font-medium text-white hover:bg-amber-600">{changed ? 'Trust new key & connect' : 'Trust & connect'}</button>
        <button type="button" onClick={() => onAnswer(false)} className="rounded-md border border-zinc-700 px-3 py-1 text-xs text-zinc-200 hover:bg-zinc-800">Don’t trust</button>
      </div>
    </div>
  );
}

const btn = 'rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-40';
const primary = 'rounded bg-sky-700 px-2.5 py-1 text-xs font-medium text-white hover:bg-sky-600 disabled:opacity-40';

function ConnectionRow({ c, run, online, busy, error, onConnect, onCancel, onCheck, onDisconnect }: {
  c: AgentConnection;
  run: Run | undefined;
  online: boolean;
  busy: boolean;
  error: string | undefined;
  onConnect: () => void;
  onCancel: () => void;
  onCheck: () => void;
  onDisconnect: () => void;
}) {
  const [paste, setPaste] = useState(false);
  const off = !online || busy;
  const checked = c.checkedAt == null ? '' : ` · ${online ? 'checked' : 'last checked'} ${ago(c.checkedAt)}`;
  const status = run
    ? (run.device && run.phase !== 'checking' ? 'Enter this code on the page that opened' : PHASE[run.phase ?? 'opening-browser'])
    : c.state === 'connected' ? `✓ Connected${checked}`
    : c.state === 'failed' ? `Failed${c.detail ? ` · ${c.detail}` : ''}`
    : c.state === 'not-connected' ? 'Not connected'
    : 'Not checked yet';
  const tone = run ? 'text-sky-300' : c.state === 'connected' ? 'text-emerald-300' : c.state === 'failed' ? 'text-red-300' : 'text-zinc-500';

  return (
    <li className="flex flex-col gap-1.5 px-3 py-2.5" data-testid={`conn-${c.agent}`} data-state={run ? 'connecting' : c.state}>
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm text-zinc-100">{LABEL[c.agent]}</div>
          <div className={`text-[11px] ${tone}`}>
            {status}
            {!run && c.state === 'connected' && c.agent === 'claude' && <span className="text-zinc-500"> · on every runner</span>}
          </div>
          {!run && c.state !== 'failed' && c.detail && <div className="text-[11px] text-zinc-500">{c.detail}</div>}
          {!run && c.needsTerminal && <div className="text-[11px] text-amber-300">Some providers need a login in a terminal on this runner.</div>}
        </div>
        {run ? (
          <button type="button" onClick={onCancel} className={btn}>Cancel</button>
        ) : c.state === 'connected' ? (
          <>
            <button type="button" onClick={onCheck} disabled={off} className={btn}>{busy ? 'Checking…' : 'Check now'}</button>
            <button type="button" onClick={onDisconnect} disabled={off} className={btn}>Disconnect</button>
          </>
        ) : c.state === 'unknown' ? (
          <>
            <button type="button" onClick={onCheck} disabled={off} className={btn}>{busy ? 'Checking…' : 'Check now'}</button>
            <button type="button" onClick={onConnect} disabled={off} className={primary}>Connect</button>
          </>
        ) : (
          <button type="button" onClick={onConnect} disabled={off} className={primary}>{c.state === 'failed' ? 'Retry' : 'Connect'}</button>
        )}
      </div>
      {run?.device && run.phase !== 'checking' && <DeviceCode device={run.device} />}
      {error && !run && <p role="alert" className="text-[11px] text-red-300">{error}</p>}
      {c.agent === 'claude' && !run && (
        paste ? (
          <div className="-mb-6 pt-1">
            <KeyField label="Claude token" name="Claude" noun="token" placeholder="sk-ant-oat01-…"
              help="From `claude setup-token`. Then Connect sends it to your runners." cred={api.agentLogins.claudeToken} extra={<SetupTokenButton />} />
          </div>
        ) : (
          <button type="button" onClick={() => setPaste(true)} className="self-start text-[11px] text-zinc-500 underline-offset-2 hover:text-zinc-300 hover:underline">
            Paste a token instead
          </button>
        )
      )}
    </li>
  );
}

function DeviceCode({ device }: { device: DeviceLoginPrompt }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-3 rounded-md border border-zinc-800 bg-zinc-950/60 px-3 py-2">
      <code className="font-mono text-xl tracking-widest text-zinc-100" data-testid="device-code">{device.code}</code>
      <button type="button" className={btn}
        onClick={() => { void navigator.clipboard?.writeText(device.code); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
        {copied ? 'Copied' : 'Copy code'}
      </button>
      {safeUrl(device.url) && <button type="button" className={btn} onClick={() => openPage(device.url)}>Open page again</button>}
    </div>
  );
}
