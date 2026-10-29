import { useState } from 'react';
import type { ChatEntry } from '../../types';
import { AnswerText } from '../jarvis/AnswerText';

type ActionEntry = Extract<ChatEntry, { type: 'action' }>;

// One stroke icon per kind of step, drawn at 14px like the rest of the chrome.
const PATHS: Record<string, string[]> = {
  tab: ['M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z', 'M3 9h18'],
  shell: ['M4 17l6-6-6-6', 'M12 19h8'],
  browser: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M3 12h18', 'M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18'],
  start: ['M7 4v16l13-8z'],
  stop: ['M6 6h12v12H6z'],
  agent: ['M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z', 'M19 17l.8 2.2L22 20l-2.2.8L19 23l-.8-2.2L16 20l2.2-.8z'],
  recap: ['M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z', 'M14 3v6h6', 'M8 13h8', 'M8 17h5'],
  call: ['M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9', 'M10.3 21a1.94 1.94 0 0 0 3.4 0'],
  edit: ['M12 20h9', 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z'],
  branch: ['M6 3v12', 'M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M18 9a9 9 0 0 1-9 9'],
  step: ['M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z'],
};

function kindOf(action: string): keyof typeof PATHS {
  if (action === 'shell.run') return 'shell';
  if (action === 'browser.open') return 'browser';
  if (action === 'server.start') return 'start';
  if (action === 'server.stop' || action.endsWith('.interrupt')) return 'stop';
  if (action === 'agent.recap') return 'recap';
  if (action.startsWith('agent.')) return 'agent';
  if (action.startsWith('call.')) return 'call';
  if (action === 'focus.edit') return 'edit';
  if (action.startsWith('worktree.')) return 'branch';
  if (action.startsWith('tab.')) return 'tab';
  return 'step';
}

export function StepIcon({ action }: { action: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0">
      {PATHS[kindOf(action)]!.map((d) => <path key={d} d={d} />)}
    </svg>
  );
}

type Tone = 'running' | 'done' | 'failed' | 'muted';

/** One line of Jarvis's work, as agents show tool calls: an icon, what
 * happened (its first word stressed), a status on the right, and, when there
 * is one, a body that opens on a click. */
export function StepRow({ icon, summary, tone, status, body, testId, state }: {
  icon: React.ReactNode;
  summary: string;
  tone: Tone;
  /** On the right: a spinner while running, else a word ("Failed", "Approved"). */
  status?: string;
  body?: React.ReactNode;
  testId: string;
  state: string;
}) {
  const [open, setOpen] = useState(false);
  const [verb, ...rest] = summary.split(' ');
  const iconTone = tone === 'failed' ? 'text-red-400' : tone === 'running' ? 'text-zinc-300' : 'text-zinc-500';
  const verbTone = tone === 'running' ? 'jarvis-shimmer' : tone === 'failed' ? 'text-red-300' : 'text-zinc-300';
  return (
    <div data-testid={testId} data-state={state} className="-mx-1.5">
      <button type="button" disabled={!body} aria-expanded={body ? open : undefined} onClick={() => setOpen((o) => !o)}
        className="group flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left text-[12.5px] enabled:hover:bg-[rgb(var(--pane-edge)/0.05)]">
        <span className={iconTone}>{icon}</span>
        <span className="min-w-0 flex-1 truncate">
          <span className={`font-medium ${verbTone}`}>{verb}</span>
          {rest.length > 0 && <span className="text-zinc-500"> {rest.join(' ')}</span>}
        </span>
        {tone === 'running' && <span role="status" aria-label="running" className="braille-spinner shrink-0 font-mono text-[12px] leading-none text-zinc-400" />}
        {status && <span className={`shrink-0 text-[11px] ${tone === 'failed' ? 'text-red-400' : 'text-zinc-600'}`}>{status}</span>}
        {body && (
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden
            className={`shrink-0 text-zinc-600 transition-transform group-hover:text-zinc-400 ${open ? 'rotate-90' : ''}`}>
            <path d="M6 4l4 4-4 4" />
          </svg>
        )}
      </button>
      {open && body && (
        <div className="ml-7 mt-0.5 max-h-72 overflow-auto rounded-md bg-[rgb(var(--pane-edge)/0.04)] px-2.5 py-2">{body}</div>
      )}
    </div>
  );
}

/** Plain output (a command's, an error), as the terminal printed it. */
export function Mono({ text, failed = false }: { text: string; failed?: boolean }) {
  return <pre className={`whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed ${failed ? 'text-red-300' : 'text-zinc-400'}`}>{text}</pre>;
}

/** Words an agent wrote (a recap, an answer): rendered, small. */
function Prose({ text }: { text: string }) {
  return <div className="text-[12.5px] leading-relaxed text-zinc-300"><AnswerText text={text} /></div>;
}

/** A step Jarvis took. `live`: the turn is still going, so a step left
 * "running" really is; otherwise it was cut off. */
export function ToolLine({ entry, live }: { entry: ActionEntry; live: boolean }) {
  const running = entry.state === 'running' && live;
  const cut = entry.state === 'running' && !live;
  const failed = !entry.ok && !running;
  const text = failed ? entry.error : entry.detail;
  const body = text ? (failed || !entry.action.startsWith('agent.') ? <Mono text={text} failed={failed} /> : <Prose text={text} />) : undefined;
  return (
    <StepRow testId="jarvis-action" icon={<StepIcon action={entry.action} />} summary={entry.summary} body={body}
      tone={running ? 'running' : failed ? 'failed' : cut ? 'muted' : 'done'}
      state={running ? 'running' : failed ? 'failed' : cut ? 'stopped' : 'done'}
      status={failed ? 'Failed' : cut ? 'Stopped' : undefined} />
  );
}

// "<agent> finished: <its answer>", "<agent> exited", "<agent> answered: …"
const AGENT_EVENT = /^(\S+) (finished|exited|answered)(?:: ([\s\S]*))?$/;

/** Something that happened while Jarvis waited (an agent finished, answered):
 * one line, its answer a click away. Anything else stays a quiet note. */
export function EventLine({ text }: { text: string }) {
  const m = AGENT_EVENT.exec(text.trim());
  if (!m) return <div className="truncate text-center text-[12px] text-zinc-500" title={text}>{text}</div>;
  const [, who, verb, said] = m;
  return (
    <StepRow testId="jarvis-event" state={verb!} tone={verb === 'exited' ? 'muted' : 'done'}
      icon={<StepIcon action={verb === 'exited' ? 'server.stop' : 'agent.message'} />}
      summary={`${who} ${verb}`} body={said ? <Prose text={said} /> : undefined} />
  );
}

/** While a turn runs and no step shows its own spinner: Jarvis is thinking. */
export function ThinkingLine() {
  return (
    <div aria-live="polite" className="-mx-1.5 flex items-center gap-2 px-1.5 py-1 text-[12.5px]">
      <span role="status" aria-label="Jarvis is working" className="braille-spinner font-mono text-[12px] leading-none text-[#e8906f]" />
      <span className="jarvis-shimmer font-medium">Thinking…</span>
    </div>
  );
}
