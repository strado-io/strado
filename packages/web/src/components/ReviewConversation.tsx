import { useState } from 'react';
import Markdown, { type Components, type Options } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeHighlight from 'rehype-highlight';
import type { ReviewComment, ReviewDiscussion } from '../types';
import { relativeTime } from '../lib/relativeTime';
import { PrStateIcon } from './sidebar/prVisuals';

export type ReviewSubmission = { body: string; event: 'comment' | 'approve' | 'request-changes' };

export type DiscussionProbe =
  | { kind: 'loading' }
  | { kind: 'needsAuth' }
  | { kind: 'error' }
  | { kind: 'ready'; discussion: ReviewDiscussion };

const REMARK_PLUGINS = [remarkGfm];

// Review bodies routinely embed literal HTML — <details> walkthroughs, <table>
// summaries, <br> — which providers render and react-markdown escapes by
// default, so it arrives as visible tag soup. rehype-raw parses it back into
// real nodes; rehype-sanitize then drops anything executable, because this is
// untrusted text from a code host running inside the desktop shell. Highlight
// runs last so its class names survive the sanitizer.
const SANITIZE_SCHEMA = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), 'details', 'summary'],
  attributes: {
    ...defaultSchema.attributes,
    details: [...(defaultSchema.attributes?.details ?? []), 'open'],
    td: [...(defaultSchema.attributes?.td ?? []), 'align'],
    th: [...(defaultSchema.attributes?.th ?? []), 'align'],
  },
};
const REHYPE_PLUGINS: Options['rehypePlugins'] = [rehypeRaw, [rehypeSanitize, SANITIZE_SCHEMA], rehypeHighlight];

// remark-gfm's table parsing goes quadratic on very large inputs (see the
// measurements in MarkdownView) — a comment this long is pathological, so it
// renders as plain text rather than freezing the pane.
const MAX_MARKDOWN_CHARS = 50_000;

const COMPONENTS: Components = {
  a({ href, children, node: _node, ...rest }) {
    // A bare click navigates the whole desktop window away in place; a new
    // browsing context routes through the shell's window-open handler
    // instead, which hands the URL to the system browser.
    if (href && /^https?:/i.test(href)) {
      return <a href={href} target="_blank" rel="noopener noreferrer" {...rest}>{children}</a>;
    }
    return <a href={href} {...rest} onClick={(event) => event.preventDefault()}>{children}</a>;
  },
};

function Body({ text }: { text: string }) {
  if (text.length > MAX_MARKDOWN_CHARS) {
    return <p className="whitespace-pre-wrap break-words text-xs text-zinc-400">{text}</p>;
  }
  return (
    <div className="kb-markdown break-words text-sm text-zinc-300">
      <Markdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={COMPONENTS}
      >{text}</Markdown>
    </div>
  );
}

const VERDICT = {
  approved: { label: 'approved', cls: 'border-emerald-800/70 bg-emerald-950/40 text-emerald-300' },
  'changes-requested': { label: 'requested changes', cls: 'border-amber-800/70 bg-amber-950/40 text-amber-300' },
} as const;

/** Initials on a hue derived from the name, so one person keeps one colour. */
function Avatar({ name }: { name: string | null }) {
  const initials = (name ?? '').trim().split(/[\s._-]+/).filter(Boolean).slice(0, 2)
    .map((word) => word[0]).join('').toUpperCase() || '?';
  const hue = [...(name ?? '?')].reduce((acc, char) => (acc * 31 + char.charCodeAt(0)) % 360, 7);
  return (
    <span
      aria-hidden
      style={{ backgroundColor: `hsl(${hue} 40% 20%)`, color: `hsl(${hue} 70% 76%)` }}
      className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold"
    >{initials}</span>
  );
}

export function CommentCard({ comment, onJumpToLine }: {
  comment: ReviewComment;
  /** Turns the file:line chip into a jump into the diff, when it is loaded. */
  onJumpToLine?: (comment: ReviewComment) => void;
}) {
  const verdict = comment.kind === 'comment' ? null : VERDICT[comment.kind];
  const anchor = comment.path
    ? `${comment.path}${comment.line ? `:${comment.line}` : ''}`
    : null;
  const body = comment.body.trim();
  return (
    <li className="px-3 py-2">
      <article className="overflow-hidden rounded-md border border-zinc-800 bg-zinc-900/20">
        <header className="flex min-w-0 flex-wrap items-center gap-2 border-b border-zinc-800/80 bg-zinc-900/40 px-3 py-1.5 text-xs">
          <Avatar name={comment.author} />
          <span className="font-medium text-zinc-200">{comment.author ?? 'Unknown'}</span>
          <span className="text-zinc-500">{relativeTime(comment.createdAt)}</span>
          {verdict && (
            <span className={`rounded-full border px-1.5 py-0.5 text-[10px] ${verdict.cls}`}>{verdict.label}</span>
          )}
          {anchor && (onJumpToLine ? (
            <button
              type="button"
              onClick={() => onJumpToLine(comment)}
              title={`Go to ${anchor} in the diff`}
              className="ml-auto min-w-0 max-w-[60%] truncate rounded border border-zinc-800 bg-zinc-950/60 px-1.5 py-0.5 font-mono text-[10px] text-sky-400 hover:bg-zinc-900 hover:text-sky-300"
            >{anchor}</button>
          ) : (
            <span
              title={anchor}
              className="ml-auto min-w-0 max-w-[60%] truncate rounded border border-zinc-800 bg-zinc-950/60 px-1.5 py-0.5 font-mono text-[10px] text-zinc-400"
            >{anchor}</span>
          ))}
        </header>
        {body && <div className="px-3 py-2"><Body text={body} /></div>}
      </article>
    </li>
  );
}

function Composer({ provider, canReview, onSubmit }: {
  provider: 'github' | 'gitlab';
  canReview: boolean;
  onSubmit: (input: ReviewSubmission) => Promise<void>;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<ReviewSubmission['event'] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const send = async (event: ReviewSubmission['event']) => {
    setBusy(event);
    setError(null);
    try {
      await onSubmit({ body: text, event });
      setText('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const label = (event: ReviewSubmission['event'], idle: string, pending: string) =>
    busy === event ? pending : idle;

  return (
    <form
      className="shrink-0 border-t border-zinc-800 px-4 py-3"
      onSubmit={(event) => { event.preventDefault(); if (text.trim()) void send('comment'); }}
    >
      <textarea
        aria-label="Leave a comment"
        placeholder="Leave a comment"
        rows={3}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && text.trim()) {
            event.preventDefault();
            void send('comment');
          }
        }}
        className="w-full resize-y rounded-md border border-zinc-800 bg-zinc-950 px-2.5 py-2 text-sm text-zinc-200 outline-none placeholder:text-zinc-700 focus:border-zinc-600"
      />
      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
      <div className="mt-2 flex flex-wrap items-center justify-end gap-2 text-xs">
        {/* GitLab has no request-changes verdict, so it is a GitHub-only action. */}
        {canReview && provider === 'github' && (
          <button
            type="button"
            onClick={() => void send('request-changes')}
            disabled={busy !== null}
            className="rounded border border-amber-700/60 px-2.5 py-1 text-amber-300 hover:bg-amber-900/30 disabled:cursor-wait disabled:opacity-60"
          >{label('request-changes', 'Request changes', 'Sending…')}</button>
        )}
        {canReview && (
          <button
            type="button"
            onClick={() => void send('approve')}
            disabled={busy !== null}
            className="rounded bg-emerald-700 px-2.5 py-1 text-white hover:bg-emerald-600 disabled:cursor-wait disabled:opacity-60"
          >{label('approve', 'Approve', 'Approving…')}</button>
        )}
        <button
          type="submit"
          disabled={busy !== null || !text.trim()}
          className="rounded border border-zinc-700 px-2.5 py-1 text-zinc-200 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
        >{label('comment', 'Comment', 'Posting…')}</button>
      </div>
    </form>
  );
}

/** The review's description and every human comment, oldest first. */
export function ReviewConversation({
  probe, provider, providerName, canReview, onConnect, onSubmit, onJumpToLine, jumpablePaths,
}: {
  probe: DiscussionProbe;
  provider: 'github' | 'gitlab';
  providerName: string;
  /** Approve / request changes only make sense while the review is open. */
  canReview: boolean;
  onConnect: () => void;
  onSubmit: (input: ReviewSubmission) => Promise<void>;
  onJumpToLine?: (comment: ReviewComment) => void;
  /** Paths present in the loaded diff — the only ones a jump can land on. */
  jumpablePaths?: string[];
}) {
  if (probe.kind === 'loading') {
    return (
      <div role="status" aria-label="Loading conversation" className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4">
        <span className="animate-pulse text-zinc-400" aria-hidden>
          <PrStateIcon state="open" className="h-9 w-9" />
        </span>
        <span className="text-sm text-zinc-500">Loading conversation…</span>
      </div>
    );
  }
  if (probe.kind === 'needsAuth') {
    return (
      <div className="min-h-0 flex-1 overflow-auto p-4 text-xs text-zinc-400">
        Reconnect {providerName} to read this conversation.
        <button
          onClick={onConnect}
          className="ml-2 rounded bg-zinc-800 px-2 py-1 text-zinc-200 hover:bg-zinc-700"
        >Connect {providerName}</button>
      </div>
    );
  }
  if (probe.kind === 'error') {
    return <div className="min-h-0 flex-1 overflow-auto p-4 text-xs text-red-300">Couldn’t load the conversation.</div>;
  }

  const { description, comments } = probe.discussion;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-auto">
        {description && (
          <section className="px-3 pt-3">
            <article className="overflow-hidden rounded-md border border-zinc-800 bg-zinc-900/20">
              <h3 className="border-b border-zinc-800/80 bg-zinc-900/40 px-3 py-1.5 text-[10px] font-medium uppercase tracking-wide text-zinc-500">
                Description
              </h3>
              <div className="px-3 py-2"><Body text={description} /></div>
            </article>
          </section>
        )}
        {comments.length === 0 ? (
          <p className="px-4 py-6 text-xs text-zinc-600">
            {description ? 'No comments yet.' : 'No description or comments yet.'}
          </p>
        ) : (
          <ul className="py-1">
            {comments.map((comment) => (
              <CommentCard
                key={comment.id}
                comment={comment}
                onJumpToLine={onJumpToLine && comment.line && comment.path && jumpablePaths?.includes(comment.path)
                  ? onJumpToLine
                  : undefined}
              />
            ))}
          </ul>
        )}
      </div>
      <Composer provider={provider} canReview={canReview} onSubmit={onSubmit} />
    </div>
  );
}
