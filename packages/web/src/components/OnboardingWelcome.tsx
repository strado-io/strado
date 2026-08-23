import { useEffect, useState } from 'react';
import { api } from '../api';

type Tool = { id: string; label: string; found: boolean; version: string | null; optional: boolean; hint: string | null };

// OpenCode is intentionally excluded from the onboarding environment gate: it's
// an optional agent that many machines (and every fresh Linux box) won't have,
// and the "every tool must be present" gate below would otherwise trap the user
// on the welcome screen. The server still probes it (see toolCheck) so the
// OpenCode terminal tab lights up whenever it IS installed.
const dropOpencode = (tools: Tool[]) => tools.filter((t) => t.id !== 'opencode');

// Stage 0 of onboarding: a standalone full-screen page (no sidebar, no
// sessions) — the mental model in three sentences plus a live environment
// probe. Hard gate: every tool must be present before continuing.
export function OnboardingWelcome({ onContinue }: { onContinue: () => void }) {
  const [tools, setTools] = useState<Tool[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [firstName, setFirstName] = useState<string | null>(null);

  useEffect(() => {
    api.envCheck().then((list) => setTools(dropOpencode(list))).catch(() => setTools([]));
    // greet by the profile name if set, falling back to the name on their invite
    Promise.all([api.profile.get().catch(() => null), api.license.get().catch(() => null)]).then(
      ([profile, lic]) => {
        const fromProfile = profile?.callMe?.trim() || profile?.fullName?.trim().split(' ')[0];
        setFirstName(fromProfile || lic?.license?.name?.split(' ')[0] || null);
      },
    );
  }, []);

  const recheck = () => {
    setChecking(true);
    api.envCheck(true)
      .then((list) => setTools(dropOpencode(list)))
      .catch(() => undefined)
      .finally(() => setChecking(false));
  };

  const allFound = tools !== null && tools.length > 0 && tools.every((t) => t.found);

  return (
    <div className="h-screen overflow-y-auto bg-zinc-950">
      <div className="mx-auto mt-12 w-full max-w-2xl px-6 pb-16">
      <h1 className="text-2xl font-semibold text-zinc-100">
        Welcome to <span className="text-sky-400">Strado</span>
        {firstName ? <span className="text-zinc-400">, {firstName}</span> : null}
      </h1>
      <div className="mt-4 space-y-2 text-sm leading-relaxed text-zinc-400">
        <p>
          <span className="text-zinc-200">Every ticket gets its own worktree.</span> One branch, one
          directory, isolated from everything else you have in flight.
        </p>
        <p>
          <span className="text-zinc-200">Every worktree gets its own agents and terminals.</span> Claude
          Code, Codex, and shells keep running on the local server even when you close the window.
        </p>
        <p>
          <span className="text-zinc-200">Your time tracks itself.</span> Keystrokes, agent turns, and file
          saves — no timers, no worklogs. Connect Jira and the board shows live ticket status too.
        </p>
      </div>

      <div className="mt-6 rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
        <div className="flex items-center justify-between">
          <div className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">Environment</div>
          {/* installs happen mid-onboarding — let the probe re-run without a restart */}
          <button
            onClick={recheck}
            disabled={checking}
            className="rounded px-1.5 py-0.5 text-[11px] text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-50"
          >
            {checking ? 'Checking…' : 'Re-check'}
          </button>
        </div>
        {tools === null ? (
          <div className="mt-2 text-xs text-zinc-600">Checking…</div>
        ) : (
          <ul className="mt-2 space-y-1.5">
            {tools.map((t) => (
              <li key={t.id} className="flex items-baseline gap-2 text-sm">
                <span className={t.found ? 'text-emerald-400' : 'text-amber-400'}>
                  {t.found ? '✓' : '✗'}
                </span>
                <span className={t.found ? 'text-zinc-200' : 'text-zinc-400'}>{t.label}</span>
                {t.found && t.version && (
                  <span className="truncate font-mono text-[11px] text-zinc-600">{t.version}</span>
                )}
                {!t.found && (
                  <span className="text-xs text-zinc-500">
                    <span className="font-mono text-[11px]">{t.hint}</span>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <button
        onClick={onContinue}
        disabled={!allFound}
        className="mt-6 rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
      >
        Set up my first repo →
      </button>
      {tools !== null && !allFound && (
        <p className="mt-2 text-xs text-amber-400/80">
          Install the missing tools above, then hit Re-check — all of them are required to get in.
        </p>
      )}
      </div>
    </div>
  );
}
