import { useMemo, useRef } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import rehypeSlug from 'rehype-slug';
import { formatBytes } from '../lib/formatBytes';

const MARKDOWN_EXT = /\.(md|mdx|markdown)$/i;

// Above this, remark-gfm's table parsing goes quadratic enough to freeze
// the whole renderer with no spinner and no cancel — measured (Node 20,
// this exact plugin pipeline): a 1000-row GFM table (24KB) parses in
// ~124ms; a 2000-row table (48KB, 2x the rows) in ~463ms (~4x, confirming
// O(n^2)); 2000 small tables (62KB) take ~2.3s; 1MB prose-only takes
// ~3.1s but 1MB mixed table/code takes ~20.5s; 2MB (the server's own
// MAX_FILE_BYTES read cap) takes ~81s. The largest real doc in this repo
// (163KB) parses in ~183ms, so typical docs are unaffected.
const MAX_RENDER_BYTES = 200_000;

// Plugin arrays must be stable references. react-markdown does its own
// parse/transform work on every render regardless of prop identity, so
// giving it a fresh array literal here would still be fine correctness-wise,
// but keeping these at module scope costs nothing and pairs with the
// content-keyed memoization below.
const REMARK_PLUGINS = [remarkGfm];
const REHYPE_PLUGINS = [rehypeSlug, rehypeHighlight];

// Resolve a relative markdown href against the directory of the file being
// viewed, POSIX-style. Kept local (no node:path in the browser bundle).
// A leading `/` is root-absolute (GFM convention) and resets to the
// worktree root instead of being treated as just another empty segment.
export function resolveRelative(currentDir: string, href: string): string {
  const parts = href.startsWith('/') ? [] : currentDir.split('/').filter((seg) => seg !== '');
  for (const seg of href.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

export function MarkdownView({
  content,
  currentDir,
  onNavigate,
  size = 0,
}: {
  content: string;
  currentDir: string;
  onNavigate: (relPath: string) => void;
  // Byte size of `content`, if known — the caller already has it from the
  // read response or listing, so this never triggers a new request.
  size?: number;
}) {
  // A future caller that forgets to pass `size` (it defaults to 0, i.e.
  // "unknown") falls back to content.length — UTF-16 code units, which are
  // always <= the real UTF-8 byte count (ASCII: equal; BMP: 1 unit -> 2-3
  // bytes; astral: 2 units -> 4 bytes) — so this can only ever UNDER-trigger
  // the gate, never spuriously trip it. Free backstop against the one
  // failure mode that matters: failing open into the freeze this gates.
  const effectiveSize = size || content.length;
  const oversized = effectiveSize > MAX_RENDER_BYTES;
  // Scopes in-document anchor lookups to this pane. Task 7 keeps panes for
  // multiple worktrees of the same repo mounted while hidden, and identical
  // heading text produces identical rehype-slug ids across them —
  // document.getElementById would happily scroll a different pane's heading.
  const rootRef = useRef<HTMLDivElement>(null);

  // Rebuilt only when currentDir/onNavigate change, not on every render, so
  // the content-keyed memo below can actually bail out of re-parsing.
  const components = useMemo<Components>(
    () => ({
      a({ href, children, node: _node, ...rest }) {
        const target = href ?? '';

        if (target.startsWith('#')) {
          // In-document anchor: rehype-slug put matching ids on the headings.
          return (
            <a
              href={target}
              {...rest}
              onClick={(e) => {
                e.preventDefault();
                const id = CSS.escape(target.slice(1));
                rootRef.current?.querySelector(`#${id}`)?.scrollIntoView({ block: 'start' });
              }}
            >
              {children}
            </a>
          );
        }

        // A query string or fragment can trail an internal doc link
        // (`./notes.md?x=1`); strip both before testing the extension or
        // resolving the path.
        const path = target.split(/[#?]/)[0] ?? '';
        const hasProtocol = /^[a-z]+:/i.test(target);
        const internal = !hasProtocol && MARKDOWN_EXT.test(path);

        if (internal) {
          return (
            <a
              href={target}
              {...rest}
              onClick={(e) => {
                e.preventDefault();
                onNavigate(resolveRelative(currentDir, path));
              }}
            >
              {children}
            </a>
          );
        }

        if (/^https?:/i.test(target)) {
          // A bare click has nothing intercepting it — there's no
          // `will-navigate` handler in the desktop shell (packages/desktop/
          // main.cjs), so it would navigate the whole window away in place.
          // Forcing a new browsing context routes it through the existing
          // setWindowOpenHandler (main.cjs:1080), which opens the system
          // browser and denies the window, so the renderer never navigates.
          return (
            <a href={target} target="_blank" rel="noopener noreferrer" {...rest}>
              {children}
            </a>
          );
        }

        if (!hasProtocol) {
          // Any other relative link that isn't a markdown doc, and the
          // empty href react-markdown's urlTransform leaves behind after
          // sanitizing a javascript:/data: URL. An empty href resolves to
          // the current URL — an in-place reload that would drop app
          // state — so this must not be allowed to navigate either.
          return (
            <a href={target} {...rest} onClick={(e) => e.preventDefault()}>
              {children}
            </a>
          );
        }

        // A recognized non-http(s) protocol (mailto:, xmpp:, ircs: — the
        // rest of react-markdown's defaultUrlTransform allowlist). These
        // aren't renderer navigations; the OS handles them.
        return (
          <a href={target} {...rest}>
            {children}
          </a>
        );
      },
      table({ children, node: _node, ...rest }) {
        return (
          <div className="overflow-x-auto">
            <table {...rest}>{children}</table>
          </div>
        );
      },
    }),
    [currentDir, onNavigate],
  );

  // A filter input living in the parent panel re-renders MarkdownView on
  // every keystroke. As long as content/currentDir/onNavigate haven't
  // actually changed, returning the same element reference here lets React
  // bail out of re-parsing and re-rendering the whole document. Skipped
  // entirely when oversized — react-markdown's expensive work happens when
  // this element is actually rendered, not when it's merely constructed, but
  // there's no reason to build it at all if it's never going to be returned.
  const rendered = useMemo(() => {
    if (oversized) return null;
    return (
      <Markdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={components}>
        {content}
      </Markdown>
    );
  }, [content, components, oversized]);

  if (oversized) {
    return (
      <div ref={rootRef}>
        <p className="mb-3 text-xs text-amber-500/80">
          This document is {formatBytes(effectiveSize)} — too large to render
          as formatted markdown without risking a long freeze. Shown as plain
          text; use "Open in VS Code" to view it formatted.
        </p>
        <pre className="whitespace-pre-wrap break-words text-xs text-zinc-300">{content}</pre>
      </div>
    );
  }

  return (
    <div ref={rootRef} className="kb-markdown">
      {rendered}
    </div>
  );
}
