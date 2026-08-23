import { useEffect, useMemo } from 'react';
import type { RepoConfig, Worktree } from '../types';

const DISMISS_KEY = 'strado:onboarding-dismissed';
const FLAGS_KEY = 'strado:onboarding-flags';

type Flags = { sessionOpened?: boolean };

export function readOnboardingFlags(): Flags {
  try {
    return JSON.parse(localStorage.getItem(FLAGS_KEY) ?? '{}') as Flags;
  } catch {
    return {};
  }
}

// Session/terminal state is ephemeral (ptys die, pages reload); once a step
// has been true it stays checked via a persisted flag.
export function rememberOnboardingFlag(flag: keyof Flags): void {
  const flags = readOnboardingFlags();
  if (flags[flag]) return;
  localStorage.setItem(FLAGS_KEY, JSON.stringify({ ...flags, [flag]: true }));
}

export function onboardingDismissed(): boolean {
  return localStorage.getItem(DISMISS_KEY) === '1';
}

type Step = { id: string; label: string; detail: string; done: boolean; optional?: boolean; action?: () => void };

// Linear-style setup checklist: steps check off from REAL state, never from
// clicking "next". Renders nothing once the core loop is complete.
export function OnboardingChecklist({
  repos,
  worktrees,
  jiraOn,
  onNewWorktree,
  onOpenJiraSettings,
  onDismiss,
}: {
  repos: RepoConfig[];
  worktrees: Worktree[];
  jiraOn: boolean;
  onNewWorktree: () => void;
  onOpenJiraSettings: () => void;
  onDismiss: () => void;
}) {
  const tracked = worktrees.filter((w) => w.tracked);
  const sessionLive = worktrees.some(
    (w) => w.hasClaudeSession || w.hasCodexSession || w.hasShellSession || (w.activitySeconds ?? 0) > 0,
  );
  useEffect(() => {
    if (sessionLive) rememberOnboardingFlag('sessionOpened');
  }, [sessionLive]);
  const sessionOpened = sessionLive || !!readOnboardingFlags().sessionOpened;

  const steps = useMemo<Step[]>(
    () => [
      {
        id: 'repo',
        label: 'Add a repo',
        detail: 'Point Strado at a git checkout — settings are auto-detected.',
        done: repos.length > 0,
      },
      {
        id: 'worktree',
        label: 'Create a worktree',
        detail: 'One branch per ticket, isolated, instantly.',
        done: tracked.length > 0,
        action: onNewWorktree,
      },
      {
        id: 'session',
        label: 'Open a session',
        detail: 'Click a row for a shell — the Claude button starts an agent that keeps working when you close the window.',
        done: sessionOpened,
      },
      {
        id: 'jira',
        label: 'Connect Jira',
        detail: 'Ticket badges go live, statuses flow both ways, and tracked time gets estimates to compare against.',
        done: jiraOn,
        optional: true,
        action: onOpenJiraSettings,
      },
    ],
    [repos.length, tracked.length, sessionOpened, jiraOn, onNewWorktree, onOpenJiraSettings],
  );

  const required = steps.filter((s) => !s.optional);
  const allDone = required.every((s) => s.done) && steps.find((s) => s.id === 'jira')!.done;
  const doneCount = steps.filter((s) => s.done).length;
  if (allDone) return null;

  return (
    <div className="mx-4 mt-3 rounded-lg border border-zinc-800 bg-zinc-900/50 p-3" role="region" aria-label="Setup checklist">
      <div className="flex items-center justify-between">
        <div className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
          Get set up · {doneCount}/{steps.length}
        </div>
        <button
          onClick={onDismiss}
          aria-label="Dismiss setup checklist"
          className="rounded px-1.5 py-0.5 text-xs text-zinc-600 hover:bg-zinc-800 hover:text-zinc-300"
        >
          dismiss
        </button>
      </div>
      <ol className="mt-2 grid gap-1.5 md:grid-cols-2">
        {steps.map((s) => (
          <li key={s.id} className="flex items-start gap-2">
            <span
              className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border text-[10px] ${
                s.done ? 'border-emerald-500 bg-emerald-500/20 text-emerald-300' : 'border-zinc-700 text-transparent'
              }`}
            >
              ✓
            </span>
            <div className="min-w-0">
              <div className="flex items-baseline gap-1.5">
                {s.action && !s.done ? (
                  <button onClick={s.action} className="text-sm text-sky-400 hover:underline">
                    {s.label}
                  </button>
                ) : (
                  <span className={`text-sm ${s.done ? 'text-zinc-500 line-through' : 'text-zinc-200'}`}>{s.label}</span>
                )}
                {s.optional && !s.done && <span className="text-[10px] uppercase text-zinc-600">optional</span>}
              </div>
              {!s.done && <div className="text-xs text-zinc-500">{s.detail}</div>}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
