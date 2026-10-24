// "Add over SSH": type user@host, and a server job takes a bare Linux box to an
// online, paired runner. The dialog only ever sends the destination, an
// optional name, and yes/no answers — the job builds every command. Prompts the
// job can't answer for the person (the first connect's password or host key,
// sudo) happen in the terminal below, which the job hands us when it needs it.
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { subscribeJob } from '../eventStream';
import {
  SSH_SETUP_STEPS,
  SSH_SETUP_TERMINAL_PATH,
  type SshSetupProgress,
  type SshSetupQuestion,
  type SshSetupResult,
  type SshSetupStepId,
} from '../types';
import { CommandTerminal } from './CommandTerminal';

type Phase = 'form' | 'running' | 'success' | 'failed';

/** A destination the server will accept: no option injection, no spaces. */
export function destinationProblem(d: string): string | null {
  if (!d) return 'Enter user@host, ssh://user@host:2222, or an ssh config alias';
  if (d.startsWith('-')) return 'A destination cannot start with “-”';
  if (/[\s\x00-\x1f\x7f]/.test(d)) return 'A destination has no spaces';
  return null;
}
const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

type RunState = {
  step: SshSetupStepId | null;
  detail: string | null;
  question: SshSetupQuestion | null;
  terminalKey: string | null;
  /** Bumped by every {terminal} frame: the job reuses one key and respawns it
   * for each interactive step, so each frame is a fresh attach. */
  terminalSeq: number;
  /** Everything the run printed, in order: step output and headers, then the
   * error if it stopped. Append-only; the terminal below never clears. */
  lines: string[];
  result: SshSetupResult | null;
  error: string | null;
};
const fresh: RunState = { step: null, detail: null, question: null, terminalKey: null, terminalSeq: 0, lines: [], result: null, error: null };

function useSetupJob(jobId: string | null): RunState {
  const [s, set] = useState<RunState>(fresh);
  useEffect(() => {
    set(fresh);
    if (!jobId) return;
    return subscribeJob(jobId, (evt) => {
      if (evt.type === 'progress') {
        const p = ((evt.data ?? {}) as { data?: SshSetupProgress }).data;
        if (!p) return;
        if ('question' in p) set((c) => ({ ...c, question: p.question }));
        else if ('terminal' in p) set((c) => ({ ...c, terminalKey: p.terminal.key, terminalSeq: c.terminalSeq + 1 }));
        else if ('transcript' in p) set((c) => ({ ...c, lines: [...c.lines, ...(p.transcript ? [p.transcript] : [])] }));
        else if ('step' in p) {
          set((c) => {
            const lines = p.detail ? [...c.lines, p.detail] : c.lines;
            return p.step === c.step ? { ...c, lines, detail: p.detail ?? c.detail } : { ...c, lines, step: p.step, detail: p.detail ?? null };
          });
        }
        return;
      }
      if (evt.type === 'done') {
        const result = ((evt.data ?? {}) as { result?: SshSetupResult }).result ?? null;
        set((c) => ({ ...c, question: null, result }));
        return;
      }
      const d = (evt.data ?? {}) as { message?: string; error?: string };
      const error = d.message || d.error || 'Setup stopped';
      set((c) => ({ ...c, question: null, error, lines: [...c.lines, `\x1b[31m✗ ${error}\x1b[0m`] }));
    });
  }, [jobId]);
  return s;
}

export function SetUpOverSshDialog({ onClose, onAdded, onOpenHost }: {
  onClose: () => void;
  /** "Open host": go to the new runner's Connections tab. */
  onOpenHost?: (runnerId: string) => void;
  /** A runner was added (or repaired): refresh the list. */
  onAdded?: (runnerId: string) => void;
}) {
  const [destination, setDestination] = useState('');
  const [name, setName] = useState('');
  const [more, setMore] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const run = useSetupJob(jobId);

  const phase: Phase = run.result ? 'success' : run.error || startError ? 'failed' : jobId || starting ? 'running' : 'form';
  const running = phase === 'running';
  const dest = destination.trim();
  const problem = destinationProblem(dest) ?? (name.trim() && !NAME_RE.test(name.trim()) ? 'A name is letters, digits, “.”, “_” or “-” (up to 64)' : null);

  const added = useRef<string | null>(null);
  useEffect(() => {
    if (run.result && added.current !== run.result.runnerId) {
      added.current = run.result.runnerId;
      onAdded?.(run.result.runnerId);
    }
  }, [run.result, onAdded]);

  // Not dismissible while running: Escape is swallowed, the backdrop ignored.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (running) { e.preventDefault(); return; }
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [running, onClose]);

  // A new run (Set up or Retry) gets a fresh terminal; nothing else clears it.
  const [runSeq, setRunSeq] = useState(0);
  const start = async () => {
    if (problem || running) return;
    setRunSeq((n) => n + 1);
    setStartError(null);
    setStarting(true);
    setJobId(null);
    try {
      const { jobId: id } = await api.runners.sshSetup.start({ destination: dest, ...(name.trim() ? { name: name.trim() } : {}) });
      setJobId(id);
    } catch (err) {
      setStartError((err as Error).message);
    } finally {
      setStarting(false);
    }
  };

  const cancel = async () => {
    const id = jobId;
    setJobId(null);
    if (id) await api.runners.sshSetup.cancel(id).catch(() => {});
  };

  const [answering, setAnswering] = useState(false);
  const answer = async (yes: boolean) => {
    if (!jobId || !run.question) return;
    setAnswering(true);
    try {
      await api.runners.sshSetup.answer(jobId, { questionId: run.question.id, yes });
    } catch (err) {
      setStartError((err as Error).message);
    } finally {
      setAnswering(false);
    }
  };
  // The job clears a question by moving on; hide ours as soon as it's answered.
  const [answered, setAnswered] = useState<string | null>(null);
  const question = run.question && run.question.id !== answered ? run.question : null;

  const failedStep = phase === 'failed' ? run.step : null;
  const stepIndex = run.step ? SSH_SETUP_STEPS.findIndex((s) => s.id === run.step) : -1;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget && !running) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-label="Add a host over SSH" className="flex max-h-[92vh] w-[760px] max-w-full flex-col gap-3 overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-900 p-5 text-sm">
        <div>
          <h2 className="text-base font-semibold text-zinc-100">Add a host over SSH</h2>
          <p className="mt-0.5 text-xs text-zinc-500">
            Installs the Strado runner on a Linux machine you can reach with ssh, pairs it to your account, and keeps it running as a service.
          </p>
        </div>

        <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); if (phase !== 'success') void start(); }}>
          <div className="flex items-center gap-2">
            <input
              autoFocus
              aria-label="SSH destination"
              value={destination}
              onChange={(e) => setDestination(e.target.value)}
              placeholder="user@host, ssh://user@host:2222, or an ssh config alias"
              disabled={running || phase === 'success'}
              spellCheck={false}
              className="h-8 min-w-0 flex-1 rounded-md border border-zinc-800 bg-zinc-950 px-2 font-mono text-xs text-zinc-100 outline-none focus:border-zinc-600 disabled:opacity-60"
            />
            {running ? (
              <button type="button" onClick={() => void cancel()} className="rounded-md border border-zinc-700 px-3 py-1 text-xs text-zinc-200 hover:bg-zinc-800">Cancel</button>
            ) : phase === 'success' ? (
              <button type="button" onClick={onClose} className="rounded-md bg-sky-700 px-3 py-1 text-xs font-medium text-white hover:bg-sky-600">Done</button>
            ) : (
              <button type="submit" disabled={!!problem} className="rounded-md bg-sky-700 px-3 py-1 text-xs font-medium text-white hover:bg-sky-600 disabled:opacity-40">
                {phase === 'failed' ? 'Retry' : 'Set up'}
              </button>
            )}
          </div>
          {phase === 'form' && (
            more ? (
              <input
                aria-label="Runner name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Runner name (optional — defaults to the host name)"
                className="h-8 w-72 rounded-md border border-zinc-800 bg-zinc-950 px-2 text-xs text-zinc-100 outline-none focus:border-zinc-600"
              />
            ) : (
              <button type="button" onClick={() => setMore(true)} className="self-start text-[11px] text-zinc-500 hover:text-zinc-300">More</button>
            )
          )}
          {dest && problem && phase === 'form' && <p className="text-[11px] text-amber-300">{problem}</p>}
        </form>

        {running && (
          <div className="rounded-md bg-zinc-800/50 px-3 py-2 text-xs text-zinc-300" data-testid="ssh-banner">
            Answer any questions in the terminal below, such as a password.
          </div>
        )}

        {phase !== 'form' && (
          <ol className="flex flex-wrap gap-x-3 gap-y-1" aria-label="Setup steps" data-testid="ssh-steps">
            {SSH_SETUP_STEPS.map((s, i) => {
              const state = failedStep === s.id ? 'failed'
                : phase === 'success' || (stepIndex >= 0 && i < stepIndex) ? 'done'
                : s.id === run.step ? 'active' : 'pending';
              return (
                <li key={s.id} data-step={s.id} data-state={state}
                  className={`flex items-center gap-1.5 text-xs ${state === 'failed' ? 'text-red-300' : state === 'done' ? 'text-zinc-400' : state === 'active' ? 'text-zinc-100' : 'text-zinc-600'}`}>
                  <span aria-hidden className={`inline-block h-1.5 w-1.5 rounded-full ${state === 'failed' ? 'bg-red-400' : state === 'done' ? 'bg-emerald-400' : state === 'active' ? 'animate-pulse bg-sky-400' : 'bg-zinc-700'}`} />
                  {s.label}
                  <span className="sr-only"> — {state}</span>
                </li>
              );
            })}
          </ol>
        )}
        {running && run.detail && <p className="truncate text-[11px] text-zinc-500" data-testid="ssh-detail">{run.detail}</p>}

        {phase === 'failed' && (
          <div role="alert" className="rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-200" data-testid="ssh-failed">
            Setup stopped{failedStep ? ` at ${SSH_SETUP_STEPS.find((s) => s.id === failedStep)?.label}` : ''}. {run.error ?? startError}
          </div>
        )}

        {question && (
          <div className="flex flex-col gap-2 rounded-md border border-amber-900/60 bg-amber-950/30 px-3 py-2.5" data-testid="ssh-question">
            <p className="text-xs text-amber-100">{question.message}</p>
            {question.command && (
              <code className="overflow-x-auto whitespace-pre rounded bg-black/50 px-2 py-1 font-mono text-[11px] text-zinc-200">{question.command}</code>
            )}
            {question.command && <p className="text-[11px] text-zinc-500">Yes runs this in the terminal below; type your password there.</p>}
            <div className="flex gap-2">
              <button type="button" disabled={answering} onClick={() => { setAnswered(question.id); void answer(true); }} className="rounded-md bg-amber-700 px-3 py-1 text-xs font-medium text-white hover:bg-amber-600 disabled:opacity-40">Yes</button>
              <button type="button" disabled={answering} onClick={() => { setAnswered(question.id); void answer(false); }} className="rounded-md border border-zinc-700 px-3 py-1 text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-40">No</button>
            </div>
          </div>
        )}

        {phase !== 'form' && (
          <div className="h-[300px] w-full overflow-hidden rounded-lg border border-zinc-800 bg-black p-2" data-testid="ssh-transcript">
            <CommandTerminal
              key={runSeq}
              lines={startError ? [...run.lines, `\x1b[31m✗ ${startError}\x1b[0m`] : run.lines}
              attach={run.terminalKey && running ? { url: `${SSH_SETUP_TERMINAL_PATH}?key=${encodeURIComponent(run.terminalKey)}`, seq: run.terminalSeq } : null}
            />
          </div>
        )}

        {phase === 'success' && run.result && <SetupDone result={run.result} onOpenHost={onOpenHost} />}
      </div>
    </div>
  );
}

/** The new runner. Its logins are connected on its host page, where the first
 * Connect asks to trust the runner's key. */
function SetupDone({ result, onOpenHost }: { result: SshSetupResult; onOpenHost?: (runnerId: string) => void }) {
  return (
    <div className="flex flex-col gap-2 rounded-md border border-zinc-800 bg-zinc-950/60 px-3 py-2.5" data-testid="ssh-success">
      <div className="flex items-center gap-3">
        <span aria-label="online" className="size-2 shrink-0 rounded-full bg-emerald-500" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm text-zinc-100">{result.name}</div>
          <div className="text-[11px] text-zinc-500">online · {result.sandboxes ? 'sandboxes on' : 'sandboxes off'}</div>
        </div>
        {onOpenHost && (
          <button type="button" onClick={() => onOpenHost(result.runnerId)}
            className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-200 hover:bg-zinc-800">
            Open host
          </button>
        )}
      </div>
      {result.warnings.map((w) => <p key={w} className="text-[11px] text-amber-300">{w}</p>)}
      <p className="text-[11px] text-zinc-500">Connect Claude, Codex and the rest on its Connections tab.</p>
    </div>
  );
}
