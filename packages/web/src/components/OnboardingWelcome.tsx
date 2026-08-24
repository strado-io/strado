import { useEffect, useRef, useState } from 'react';
import { api, type ToolStatus } from '../api';
import { subscribeEnvInstall } from '../eventStream';
import { FirstRunCard, ghostButtonClass, primaryButtonClass } from './FirstRunCard';

// OpenCode is intentionally excluded from the onboarding environment gate: it's
// an optional agent that many machines (and every fresh Linux box) won't have,
// and the "every tool must be present" gate below would otherwise trap the user
// on the welcome screen. The server still probes it (see toolCheck) so the
// OpenCode terminal tab lights up whenever it IS installed.
const dropOpencode = (tools: ToolStatus[]) => tools.filter((t) => t.id !== 'opencode');

// Only the last few lines are kept per row: this is a progress signal inside a
// card, not a terminal, and npm emits thousands of lines on a cold cache.
const LOG_TAIL = 40;

type Install = { lines: string[]; running: boolean; error: string | null; expanded: boolean };

// Stage 0 of onboarding: the sign-in card's chrome, carrying a live environment
// probe that can also *fix* what it finds. A missing prerequisite used to send
// the user out to a terminal and back; the Install button runs the same command
// here and flips the row green when the re-probe confirms it.
export function OnboardingWelcome({ onContinue }: { onContinue: () => void }) {
  const [tools, setTools] = useState<ToolStatus[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [firstName, setFirstName] = useState<string | null>(null);
  const [installs, setInstalls] = useState<Record<string, Install>>({});

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

  // One stream for every row. Opened on mount rather than on the first click so
  // an install started here survives a remount of this screen — the server owns
  // the process, and its output keeps arriving.
  useEffect(() => {
    return subscribeEnvInstall((evt) => {
      const { id } = evt.data;
      if (evt.type === 'output') {
        setInstalls((prev) => {
          const cur = prev[id] ?? { lines: [], running: true, error: null, expanded: false };
          return { ...prev, [id]: { ...cur, running: true, lines: [...cur.lines, evt.data.line].slice(-LOG_TAIL) } };
        });
        return;
      }
      const { ok, message, tool } = evt.data;
      setInstalls((prev) => {
        const cur = prev[id] ?? { lines: [], running: false, error: null, expanded: false };
        // A failed install keeps its log open: the reason is in those lines,
        // and collapsing them would leave the user with a bare ✗.
        return { ...prev, [id]: { ...cur, running: false, error: ok ? null : message, expanded: !ok } };
      });
      if (tool) setTools((prev) => (prev ? prev.map((t) => (t.id === tool.id ? tool : t)) : prev));
    });
  }, []);

  const recheck = () => {
    setChecking(true);
    api.envCheck(true)
      .then((list) => setTools(dropOpencode(list)))
      .catch(() => undefined)
      .finally(() => setChecking(false));
  };

  const install = (id: string) => {
    setInstalls((prev) => ({ ...prev, [id]: { lines: [], running: true, error: null, expanded: true } }));
    api.envInstall.start(id).catch((err: Error) => {
      setInstalls((prev) => ({
        ...prev,
        [id]: { lines: prev[id]?.lines ?? [], running: false, error: err.message, expanded: true },
      }));
    });
  };

  // Only the tools marked required in toolCheck's table gate entry. Blocking on
  // an optional one trapped anybody without VS Code or Codex on this screen —
  // and the amber line below told them, wrongly, that all of them were needed.
  const required = tools?.filter((t) => !t.optional) ?? [];
  const allFound = tools !== null && required.length > 0 && required.every((t) => t.found);
  const missingRequired = required.filter((t) => !t.found);

  return (
    <FirstRunCard
      title={
        <>
          Welcome to Strado
          {firstName ? <span className="text-zinc-400">, {firstName}</span> : null}
        </>
      }
      lede="One worktree per ticket, each with its own agents and terminals."
      width="wide"
    >
      <div className="rounded-xl border border-zinc-700 bg-zinc-950 px-5 py-4 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.4)]">
        <div className="flex items-center justify-between">
          <span className="text-[0.62rem] uppercase tracking-[0.28em] text-zinc-500">environment</span>
          {/* Installs happen mid-onboarding, so this has to look pressable —
              as bare hover-only text it read as a label and the user had no
              way to know the probe could be re-run without a restart. */}
          <button
            onClick={recheck}
            disabled={checking}
            className={`${ghostButtonClass} flex items-center gap-1.5 px-2 py-1 text-[11px] font-medium`}
          >
            <span aria-hidden="true" className={checking ? 'animate-spin' : undefined}>
              ↻
            </span>
            {checking ? 'Checking…' : 'Re-check'}
          </button>
        </div>
        {tools === null ? (
          <div className="mt-4 text-xs text-zinc-600">Checking…</div>
        ) : (
          <ul className="mt-4 space-y-3">
            {tools.map((t) => (
              <ToolRow
                key={t.id}
                tool={t}
                install={installs[t.id]}
                onInstall={() => install(t.id)}
                onCancel={() => void api.envInstall.cancel(t.id).catch(() => undefined)}
                onToggleLog={() =>
                  setInstalls((prev) =>
                    prev[t.id] ? { ...prev, [t.id]: { ...prev[t.id]!, expanded: !prev[t.id]!.expanded } } : prev,
                  )
                }
              />
            ))}
          </ul>
        )}
      </div>

      <button onClick={onContinue} disabled={!allFound} className={`${primaryButtonClass} mt-5`}>
        Set up my first repo →
      </button>
      {tools !== null && missingRequired.length > 0 && (
        <p className="mt-2 text-center text-xs text-amber-400/80">
          {missingRequired.every((t) => t.installable)
            ? 'Install the missing tools above to continue.'
            : 'Install the missing tools above, then hit Re-check.'}
        </p>
      )}
    </FirstRunCard>
  );
}

function ToolRow({
  tool,
  install,
  onInstall,
  onCancel,
  onToggleLog,
}: {
  tool: ToolStatus;
  install: Install | undefined;
  onInstall: () => void;
  onCancel: () => void;
  onToggleLog: () => void;
}) {
  const running = install?.running === true;
  const lines = install?.lines ?? [];
  return (
    <li className="text-sm">
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <span
          className={tool.found ? 'text-emerald-400' : tool.optional ? 'text-zinc-600' : 'text-amber-400'}
          aria-hidden="true"
        >
          {tool.found ? '✓' : running ? '·' : tool.optional ? '–' : '✗'}
        </span>
        <span className={tool.found ? 'text-zinc-200' : 'text-zinc-400'}>{tool.label}</span>
        {!tool.found && tool.optional && (
          <span className="flex-none text-[10px] uppercase tracking-[0.18em] text-zinc-600">optional</span>
        )}
        {/* For a tool we can't install from here, the hint IS the instruction —
            so it sits on the label's line exactly where a version would, not
            stranded on a line of its own below it. */}
        {!tool.found && !tool.installable && tool.hint && (
          <span className="min-w-[15rem] flex-1 basis-0 text-[11px] leading-relaxed text-zinc-500">{tool.hint}</span>
        )}
        {tool.found && tool.version && <span className="truncate text-[11px] text-zinc-600">{tool.version}</span>}
        {!tool.found && (
          <span className="ml-auto flex-none">
            {running ? (
              <button onClick={onCancel} className={`${ghostButtonClass} px-2 py-0.5 text-[11px] font-medium`}>
                Stop
              </button>
            ) : tool.installable ? (
              <button onClick={onInstall} className={`${ghostButtonClass} px-2 py-0.5 text-[11px] font-medium`}>
                {install?.error ? 'Retry' : 'Install'}
              </button>
            ) : null}
          </span>
        )}
      </div>


      {running && (
        <div className="mt-1.5 flex items-baseline gap-2 pl-7 text-[11px] text-zinc-500">
          <span className="braille-spinner flex-none text-sky-400" aria-hidden="true" />
          {/* With the log open the newest line is already the last row of it —
              repeating it here just says the same thing twice. */}
          <span className="truncate">
            {install?.expanded ? 'installing…' : lines[lines.length - 1] ?? 'starting…'}
          </span>
        </div>
      )}

      {install?.error && (
        <div className="mt-1.5 pl-7 text-[11px] leading-relaxed text-amber-400/90">
          {install.error}
          {tool.installCommand && (
            <span className="text-zinc-500"> Run <span className="text-zinc-300">{tool.installCommand}</span> yourself, then hit Re-check.</span>
          )}
        </div>
      )}

      {lines.length > 0 && (
        <div className="pl-7">
          <button onClick={onToggleLog} className="mt-1 text-[11px] text-zinc-500 hover:text-zinc-300">
            {install?.expanded ? '⌃ hide output' : '⌄ show output'}
          </button>
          {install?.expanded && <InstallLog lines={lines} />}
        </div>
      )}
    </li>
  );
}

function InstallLog({ lines }: { lines: string[] }) {
  const box = useRef<HTMLPreElement>(null);
  // Pin to the newest line: an npm install that scrolls out of view reads as
  // hung, which is the exact anxiety this panel exists to remove.
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [lines]);
  return (
    <pre
      ref={box}
      className="mt-1 max-h-28 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-zinc-800 bg-black/40 p-2 text-[10px] leading-relaxed text-zinc-500"
    >
      {lines.join('\n')}
    </pre>
  );
}
