import { useEffect, useRef, useState } from 'react';
import { api } from '../api';

type Category = 'bug' | 'idea' | 'other';
const CATEGORIES: { id: Category; label: string }[] = [
  { id: 'bug', label: 'Bug' },
  { id: 'idea', label: 'Idea' },
  { id: 'other', label: 'Other' },
];

export function FeedbackDialog({
  open,
  onClose,
  context,
}: {
  open: boolean;
  onClose: () => void;
  context?: string;
}) {
  const [category, setCategory] = useState<Category>('bug');
  const [message, setMessage] = useState('');
  const [email, setEmail] = useState('');
  const [includeDiag, setIncludeDiag] = useState(true);
  const [showDiag, setShowDiag] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    if (open) {
      setCategory('bug');
      setMessage('');
      setEmail('');
      setIncludeDiag(true);
      setShowDiag(false);
      setError(null);
      setSent(false);
    }
  }, [open]);

  useEffect(() => {
    return () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    };
  }, []);

  if (!open) return null;

  const submit = async () => {
    setSending(true);
    setError(null);
    try {
      await api.feedback.submit({
        category,
        message: message.trim(),
        email: email.trim() || undefined,
        includeDiagnostics: category === 'bug' && includeDiag,
        context,
      });
      setSent(true);
      closeTimer.current = setTimeout(onClose, 900);
    } catch {
      setError("Couldn't send — check your connection and try again.");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="flex w-full max-w-lg flex-col gap-3 rounded-lg border border-zinc-800 bg-zinc-950 p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-sm font-medium text-zinc-200">Send feedback</div>

        <div className="flex gap-1" role="group" aria-label="Category">
          {CATEGORIES.map((c) => (
            <button
              key={c.id}
              onClick={() => setCategory(c.id)}
              className={`rounded px-3 py-1 text-sm ${
                category === c.id ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>

        <textarea
          autoFocus
          aria-label="Message"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder={category === 'bug' ? 'What happened? What did you expect?' : 'Tell us what you think'}
          className="h-40 w-full resize-none rounded border border-zinc-700 bg-zinc-900 p-2 text-sm text-zinc-100 focus:border-zinc-500 focus:outline-none"
        />

        <input
          aria-label="Email (optional)"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Email (optional) — so we can follow up"
          className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100 focus:border-zinc-500 focus:outline-none"
        />

        {category === 'bug' && (
          <div className="text-xs text-zinc-400">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                aria-label="Include diagnostics"
                checked={includeDiag}
                onChange={(e) => setIncludeDiag(e.target.checked)}
              />
              Include diagnostics
            </label>
            <button
              type="button"
              onClick={() => setShowDiag((v) => !v)}
              className="mt-1 text-zinc-500 underline hover:text-zinc-300"
            >
              What's included?
            </button>
            {showDiag && (
              <ul className="mt-1 list-disc pl-5 text-zinc-500">
                <li>App version and OS</li>
                <li>The last ~200 lines of the Strado debug log</li>
              </ul>
            )}
          </div>
        )}

        {error && <div className="text-xs text-red-400">{error}</div>}
        {sent && <div className="text-xs text-emerald-400">Thanks — sent!</div>}

        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded px-3 py-1 text-sm text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!message.trim() || sending}
            className="rounded bg-sky-700 px-3 py-1 text-sm font-medium text-white hover:bg-sky-600 disabled:opacity-40"
          >
            {sending ? 'Sending…' : error ? 'Retry' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  );
}
