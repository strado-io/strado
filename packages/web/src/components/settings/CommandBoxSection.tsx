import { useEffect, useState, type ReactNode } from 'react';
import { api, type ModelCredentialSummary } from '../../api';
import { voiceEngineChanged } from '../../hooks/voice';

type CredentialApi = { get: () => Promise<ModelCredentialSummary>; save: (key: string | null) => Promise<ModelCredentialSummary> };

/** One API key: a password field until saved, then only its last four and Remove. */
export function KeyField({ label, name, noun = 'key', placeholder, help, cred: credApi, onSaved, extra }: {
  label: string;
  /** For the buttons: "Save <name> <noun>" / "Remove <name> <noun>". */
  name: string;
  noun?: string;
  placeholder: string;
  help: string;
  cred: CredentialApi;
  /** After a save or removal lands. */
  onSaved?: () => void;
  /** Beside the save button, e.g. how to get the secret. */
  extra?: ReactNode;
}) {
  const [cred, setCred] = useState<ModelCredentialSummary | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.resolve().then(() => credApi.get()).then(setCred).catch(() => setCred({ present: false, last4: null }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async (key: string | null) => {
    setBusy(true);
    setError(null);
    try {
      setCred(await credApi.save(key));
      setDraft('');
      onSaved?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mb-6">
      <div className="mb-1.5 text-sm text-zinc-200">{label}</div>
      {cred === null ? (
        <div className="text-xs text-zinc-600">Loading…</div>
      ) : cred.present ? (
        <div className="flex items-center gap-3">
          <code className="rounded bg-zinc-900 px-2 py-1 text-xs text-zinc-300">{`••••${cred.last4 ?? ''}`}</code>
          <button type="button" aria-label={`Remove ${name} ${noun}`} disabled={busy} onClick={() => void save(null)} className="rounded-md border border-zinc-800 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-900 disabled:opacity-40">
            Remove {noun}
          </button>
        </div>
      ) : (
        <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); if (draft.trim()) void save(draft.trim()); }}>
          <input
            type="password"
            aria-label={label}
            autoComplete="off"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={placeholder}
            className="h-8 w-72 rounded-md border border-zinc-800 bg-zinc-900 px-2 text-xs text-zinc-100 outline-none focus:border-zinc-600"
          />
          <button type="submit" aria-label={`Save ${name} ${noun}`} disabled={busy || !draft.trim()} className="rounded-md bg-sky-700 px-2.5 py-1 text-xs font-medium text-white hover:bg-sky-600 disabled:opacity-40">
            Save {noun}
          </button>
          {extra}
        </form>
      )}
      <p className="mt-1.5 text-[11px] text-zinc-500">{help}</p>
      {error && <p role="alert" className="mt-1.5 text-xs text-red-400">{error}</p>}
    </div>
  );
}

/** `claude setup-token` prints a long-lived token after a browser login. This
 * copies the command to run anywhere, for pasting the token by hand. */
export const SETUP_TOKEN_COMMAND = 'claude setup-token';
export function SetupTokenButton() {
  const [copied, setCopied] = useState(false);
  return (
    <button type="button" title={`Copies “${SETUP_TOKEN_COMMAND}” — run it in any terminal, then paste the token here`}
      onClick={() => { void navigator.clipboard?.writeText(SETUP_TOKEN_COMMAND); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
      className="rounded-md border border-zinc-800 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-900">
      {copied ? 'Copied — run it in a terminal' : 'Get a token'}
    </button>
  );
}

export function SenderKeyLine({ fingerprint, className = '' }: { fingerprint: string; className?: string }) {
  return <p className={`text-[11px] text-zinc-500 ${className}`} data-testid="sender-key">This laptop’s key: <code className="font-mono text-zinc-400">{fingerprint}</code></p>;
}

/** Settings for the ⌘K command box's natural language: the Anthropic key it
 * uses, the optional OpenRouter key for Jev's instant navigation (both
 * server-side only; the window only ever sees the last four), and the
 * "Local only" switch that keeps every keystroke on this machine. */
export function CommandBoxSection() {
  const [localOnly, setLocal] = useState<boolean | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [wakes, setWakes] = useState<boolean | null>(null);
  const [wakesError, setWakesError] = useState<string | null>(null);

  useEffect(() => {
    api.profile.get().then((p) => {
      setLocal(!!p.jarvisLocalOnly);
      setWakes(p.jarvisWakes !== false);
    }).catch(() => {
      setLocal(false);
      setWakes(true);
    });
  }, []);

  const toggleWakes = async () => {
    const next = !wakes;
    setWakes(next);
    setWakesError(null);
    try {
      await api.profile.save({ jarvisWakes: next });
    } catch (e) {
      setWakes(!next);
      setWakesError((e as Error).message);
    }
  };

  const toggleLocal = async () => {
    const next = !localOnly;
    setLocal(next);
    setLocalError(null);
    try {
      await api.profile.save({ jarvisLocalOnly: next });
      voiceEngineChanged(); // Local only keeps voice on this Mac too
    } catch (e) {
      setLocal(!next);
      setLocalError((e as Error).message);
    }
  };

  return (
    <div className="max-w-lg">
      <h2 className="mb-1 text-base font-semibold text-zinc-100">Command box</h2>
      <p className="mb-5 text-xs text-zinc-500">
        ⌘K understands plain English (“put the dev server under claude”) using Claude Haiku with your own Anthropic key.
        Commands it can’t parse locally are sent with your tab and worktree names — never terminal output, file contents, or <code>$</code> lines.
      </p>

      <KeyField label="Anthropic API key" name="Anthropic" placeholder="sk-ant-…"
        help="Stored on this machine only. It is also used by your runners for their model calls." cred={api.modelCredential} />
      <KeyField label="OpenRouter key (fast decisions, Jev)" name="OpenRouter" placeholder="sk-or-…"
        help="Optional. Instant navigation commands; everything else still uses Haiku." cred={api.routerCredential} />
      <KeyField label="ElevenLabs API key (voice)" name="ElevenLabs" placeholder="sk_…  or  xi-…"
        help="Optional. Voice in the command box uses ElevenLabs Scribe v2 Realtime (audio goes to ElevenLabs). Without a key, Strado uses on-device Apple speech. Local only keeps voice on this Mac."
        cred={api.voiceCredential} onSaved={voiceEngineChanged} />

      <label className="flex items-start gap-3">
        <input
          type="checkbox"
          aria-label="Local only (never send to a model)"
          checked={!!localOnly}
          disabled={localOnly === null}
          onChange={() => void toggleLocal()}
          className="mt-0.5 h-4 w-4 accent-sky-600"
        />
        <span>
          <span className="text-sm text-zinc-200">Local only (never send to a model)</span>
          <span className="block text-xs text-zinc-500">⌘K uses its built-in rules only; the server refuses model calls.</span>
        </span>
      </label>
      {localError && <p role="alert" className="mt-1.5 text-xs text-red-400">{localError}</p>}

      <label className="mt-4 flex items-start gap-3">
        <input
          type="checkbox"
          aria-label="Jarvis speaks up when agents finish"
          checked={!!wakes}
          disabled={wakes === null}
          onChange={() => void toggleWakes()}
          className="mt-0.5 h-4 w-4 accent-sky-600"
        />
        <span>
          <span className="text-sm text-zinc-200">Jarvis speaks up when agents finish</span>
          <span className="block text-xs text-zinc-500">When an agent a Focus’s Jarvis started finishes, Jarvis posts a short note in that Focus’s chat. Off: the chat only records it.</span>
        </span>
      </label>
      {wakesError && <p role="alert" className="mt-1.5 text-xs text-red-400">{wakesError}</p>}
    </div>
  );
}
