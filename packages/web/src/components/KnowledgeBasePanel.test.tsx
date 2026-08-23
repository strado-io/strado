import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const kbFiles = vi.fn();
const kbFile = vi.fn();
vi.mock('../api', () => ({
  // Mirrors the real ApiClientError's constructor (code, message, details) —
  // a bare `class extends Error {}` would silently drop code/details, and
  // any test asserting on them would be testing the mock's shape, not the
  // component's narrowing logic against it. Declared inside the factory:
  // vi.mock is hoisted above other top-level statements in this file, so a
  // class declared outside it isn't initialized yet when this runs.
  ApiClientError: class extends Error {
    code: string;
    details?: unknown;
    constructor(code: string, message: string, details?: unknown) {
      super(message);
      this.code = code;
      this.details = details;
    }
  },
  api: { kb: { files: (...a: unknown[]) => kbFiles(...a), file: (...a: unknown[]) => kbFile(...a) } },
}));

import { ApiClientError } from '../api';
import { KnowledgeBasePanel } from './KnowledgeBasePanel';

const LISTING = {
  truncated: false,
  cap: 2000,
  files: [
    { path: 'README.md', size: 10, mtimeMs: 1 },
    { path: 'docs/architecture.md', size: 20, mtimeMs: 2 },
    { path: 'docs/specs/plan.md', size: 30, mtimeMs: 3 },
  ],
};

// Every mock below resolves via mockImplementation rather than
// mockResolvedValue, and constructs its payload (files array included)
// fresh inside the callback — mockResolvedValue hands back the exact same
// object/array reference on every call, which a real fetch never does, and
// masks bugs that only show up when a listing's array is a genuinely new
// reference each time (React bails out of re-rendering on an unchanged
// reference; a real API response never gives it that option).
beforeEach(() => {
  localStorage.clear();
  kbFiles.mockReset().mockImplementation(() => Promise.resolve({ ...LISTING, files: [...LISTING.files] }));
  kbFile.mockReset().mockImplementation(() => Promise.resolve({ content: '# Readme body', size: 10, mtimeMs: 1 }));
});
afterEach(() => { vi.clearAllMocks(); vi.useRealTimers(); });

const panel = (over: Partial<Parameters<typeof KnowledgeBasePanel>[0]> = {}) => (
  <KnowledgeBasePanel wsId="default" worktreePath="/wt" active onOpenInVsCode={() => {}} {...over} />
);

describe('KnowledgeBasePanel', () => {
  it('lists files grouped by folder', async () => {
    render(panel());
    expect(await screen.findByRole('button', { name: 'README.md' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'architecture.md' })).toBeInTheDocument();
    expect(screen.getByText('docs')).toBeInTheDocument();
    expect(screen.getByText('docs/specs')).toBeInTheDocument();
  });

  it('lists root-level files before directory groups regardless of name', async () => {
    kbFiles.mockImplementation(() => Promise.resolve({
      truncated: false,
      cap: 2000,
      files: [
        { path: 'aaa/nested.md', size: 1, mtimeMs: 1 },
        { path: 'zzz-root.md', size: 2, mtimeMs: 2 },
      ],
    }));
    render(panel());
    const items = await screen.findAllByRole('button', { name: /\.md$/ });
    expect(items.map((el) => el.textContent)).toEqual(['zzz-root.md', 'nested.md']);
  });

  it('filters by path substring', async () => {
    render(panel());
    await screen.findByRole('button', { name: 'README.md' });

    fireEvent.change(screen.getByPlaceholderText('Filter files…'), { target: { value: 'spec' } });

    expect(screen.getByRole('button', { name: 'plan.md' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'README.md' })).not.toBeInTheDocument();
  });

  it('selects the first file on load and renders its content', async () => {
    render(panel());
    await waitFor(() => expect(kbFile).toHaveBeenCalledWith('default', '/wt', 'README.md'));
    expect(await screen.findByRole('heading', { name: 'Readme body' })).toBeInTheDocument();
  });

  it('fetches a different file when one is clicked', async () => {
    render(panel());
    await screen.findByRole('button', { name: 'architecture.md' });
    kbFile.mockImplementation(() => Promise.resolve({ content: '# Arch', size: 20, mtimeMs: 2 }));

    fireEvent.click(screen.getByRole('button', { name: 'architecture.md' }));

    await waitFor(() => expect(kbFile).toHaveBeenCalledWith('default', '/wt', 'docs/architecture.md'));
  });

  it('reloads content when switching to a file that shares the previous mtime', async () => {
    // Regression guard for a single shared mtimeRef: two files with the same
    // mtimeMs (1s-granularity filesystems, cp -p, tar -x) must not make the
    // second selection appear to already be "up to date" with the first's
    // stale content.
    kbFiles.mockImplementation(() => Promise.resolve({
      truncated: false,
      cap: 2000,
      files: [
        { path: 'a.md', size: 1, mtimeMs: 5 },
        { path: 'b.md', size: 2, mtimeMs: 5 },
      ],
    }));
    kbFile.mockImplementation((_ws: unknown, _wt: unknown, rel: unknown) =>
      Promise.resolve(
        rel === 'a.md'
          ? { content: '# A', size: 1, mtimeMs: 5 }
          : { content: '# B', size: 2, mtimeMs: 5 },
      ),
    );
    render(panel());
    await screen.findByRole('heading', { name: 'A' });

    fireEvent.click(screen.getByRole('button', { name: 'b.md' }));

    expect(await screen.findByRole('heading', { name: 'B' })).toBeInTheDocument();
  });

  it('renders the correct content when revisiting a previously-viewed file (I4)', async () => {
    // content is single-valued but mtimeRef records a visit per path: A, then
    // B (content now holds B's text), then A again — A's mtime on disk is
    // unchanged, so a mtime-only short-circuit would skip the reload and
    // leave B's text on screen under A's header. Distinct mtimes here so
    // this can't pass for I2's reason (two files sharing one mtime).
    kbFiles.mockImplementation(() => Promise.resolve({
      truncated: false,
      cap: 2000,
      files: [
        { path: 'a.md', size: 1, mtimeMs: 5 },
        { path: 'b.md', size: 2, mtimeMs: 9 },
      ],
    }));
    kbFile.mockImplementation((_ws: unknown, _wt: unknown, rel: unknown) =>
      Promise.resolve(
        rel === 'a.md'
          ? { content: '# A', size: 1, mtimeMs: 5 }
          : { content: '# B', size: 2, mtimeMs: 9 },
      ),
    );
    render(panel());
    await screen.findByRole('heading', { name: 'A' });

    fireEvent.click(screen.getByRole('button', { name: 'b.md' }));
    await screen.findByRole('heading', { name: 'B' });

    fireEvent.click(screen.getByRole('button', { name: 'a.md' }));
    expect(await screen.findByRole('heading', { name: 'A' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'B' })).not.toBeInTheDocument();
  });

  it('does not re-fetch a file whose selection and on-disk mtime are both unchanged', async () => {
    // The optimization I4's fix must not destroy: a poll bringing back a
    // structurally-identical but freshly-constructed listing (a real fetch
    // never returns the same object reference twice) changes `files`'
    // reference while `selected` stays put — the effect re-runs, and the
    // mtime+path check must still skip reloading content that's already
    // current, not just when nothing at all changed.
    vi.useFakeTimers();
    render(panel());
    await vi.advanceTimersByTimeAsync(0);
    expect(kbFile).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(kbFiles).toHaveBeenCalledTimes(2);
    expect(kbFile).toHaveBeenCalledTimes(1);
  });

  it('follows a relative markdown link inside the pane', async () => {
    kbFile.mockImplementation(() => Promise.resolve({ content: '[go](./specs/plan.md)', size: 10, mtimeMs: 1 }));
    render(panel());
    const link = await screen.findByRole('link', { name: 'go' });

    // README.md is selected first, so currentDir is '' — but the link target
    // still resolves relative to the selected file's directory.
    fireEvent.click(link);
    await waitFor(() => expect(kbFile).toHaveBeenCalledWith('default', '/wt', 'specs/plan.md'));
  });

  it('shows a notice when the listing was truncated, using the server-reported cap', async () => {
    // cap deliberately isn't 2000 (the old hardcoded constant) so this test
    // can't pass by accident against a component that ignores the response.
    kbFiles.mockImplementation(() => Promise.resolve({ ...LISTING, files: [...LISTING.files], truncated: true, cap: 7 }));
    render(panel());
    expect(await screen.findByText(/only the first 7/i)).toBeInTheDocument();
  });

  it('shows an empty state when there is no markdown', async () => {
    kbFiles.mockImplementation(() => Promise.resolve({ files: [], truncated: false, cap: 2000 }));
    render(panel());
    expect(await screen.findByText('No markdown files in this worktree.')).toBeInTheDocument();
  });

  it('surfaces a listing failure distinctly from a genuinely empty worktree', async () => {
    kbFiles.mockReset().mockRejectedValue(new Error('network down'));
    render(panel());
    expect(await screen.findByText('network down')).toBeInTheDocument();
    expect(screen.queryByText('No markdown files in this worktree.')).not.toBeInTheDocument();
  });

  it('fills in a selection after a manual listing retry succeeds', async () => {
    // A raw loadList() call from Retry (bypassing the poll tick's
    // selection-fill step) left the rail populated but the pane stuck on
    // "Select a document to read." until the next scheduled poll.
    kbFiles.mockReset().mockRejectedValueOnce(new Error('down'))
      .mockImplementation(() => Promise.resolve({ ...LISTING, files: [...LISTING.files] }));
    render(panel());
    await screen.findByText('down');

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByRole('button', { name: 'README.md' })).toBeInTheDocument();
    await waitFor(() => expect(kbFile).toHaveBeenCalledWith('default', '/wt', 'README.md'));
  });

  it('discards a stale listing response after worktreePath changes mid-flight', async () => {
    // Regression guard for a boolean live-request flag: React runs an
    // effect's cleanup and the next run's setup synchronously in the same
    // flush when deps change, so a plain live=false/live=true pair is back
    // to true again long before a slower, superseded request resolves.
    let resolveA!: (v: typeof LISTING) => void;
    const pendingA = new Promise<typeof LISTING>((res) => { resolveA = res; });
    kbFiles.mockReset();
    kbFiles.mockImplementationOnce(() => pendingA);
    kbFiles.mockImplementation(() => Promise.resolve({
      truncated: false,
      cap: 2000,
      files: [{ path: 'b-only.md', size: 1, mtimeMs: 1 }],
    }));

    let rerender!: (ui: Parameters<typeof render>[0]) => void;
    await act(async () => {
      const result = render(
        <KnowledgeBasePanel wsId="default" worktreePath="/wtA" active onOpenInVsCode={() => {}} />,
      );
      rerender = result.rerender;
    });

    // /wtB's own fetch resolves on the next microtask — flush it fully
    // inside this act() scope rather than relying on incidental timing
    // outside of React's tracked updates.
    await act(async () => {
      rerender(
        <KnowledgeBasePanel wsId="default" worktreePath="/wtB" active onOpenInVsCode={() => {}} />,
      );
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(screen.getByRole('button', { name: 'b-only.md' })).toBeInTheDocument();

    // The slow /wtA response finally lands — it must not clobber /wtB's listing.
    await act(async () => {
      resolveA({ truncated: false, cap: 2000, files: [{ path: 'a-only.md', size: 1, mtimeMs: 1 }] });
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(screen.getByRole('button', { name: 'b-only.md' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'a-only.md' })).not.toBeInTheDocument();
  });

  it('does not overwrite either worktree\'s persisted keys when worktreePath changes mid-instance', async () => {
    // `selected`/`collapsed` are lazy useState reads that don't re-derive
    // when worktreePath changes under an already-mounted instance — they
    // keep holding worktree A's values. Persistence lives at the call sites
    // that actually change these values (selectFile, toggle, refreshList's
    // fill, loadFile's catch fallback), none of which fire here (no clicks,
    // and `selected` is already non-null so refreshList's fill is a no-op) —
    // so neither worktree's keys should move at all across the switch.
    localStorage.setItem('strado:kb-selected:/wtA', 'a-selected.md');
    localStorage.setItem('strado:kb-collapsed:/wtA', JSON.stringify(['a-folder']));
    localStorage.setItem('strado:kb-selected:/wtB', 'b-selected.md');
    localStorage.setItem('strado:kb-collapsed:/wtB', JSON.stringify(['b-folder']));
    kbFiles.mockImplementation(() => Promise.resolve({ truncated: false, cap: 2000, files: [] }));

    let rerender!: (ui: Parameters<typeof render>[0]) => void;
    await act(async () => {
      const result = render(
        <KnowledgeBasePanel wsId="default" worktreePath="/wtA" active onOpenInVsCode={() => {}} />,
      );
      rerender = result.rerender;
    });

    await act(async () => {
      rerender(
        <KnowledgeBasePanel wsId="default" worktreePath="/wtB" active onOpenInVsCode={() => {}} />,
      );
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(localStorage.getItem('strado:kb-selected:/wtA')).toBe('a-selected.md');
    expect(localStorage.getItem('strado:kb-collapsed:/wtA')).toBe(JSON.stringify(['a-folder']));
    expect(localStorage.getItem('strado:kb-selected:/wtB')).toBe('b-selected.md');
    expect(localStorage.getItem('strado:kb-collapsed:/wtB')).toBe(JSON.stringify(['b-folder']));
  });

  it('surfaces a read failure with a retry button', async () => {
    kbFile.mockRejectedValue(new Error('boom'));
    render(panel());
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('clears the persisted selection key when a selected file is gone and no fallback exists', async () => {
    // A null fallback (the listing is now empty, so there's nothing to fall
    // back to) must clear the key rather than leave it naming a dead file —
    // otherwise every future mount wastes a load on it and flashes Retry.
    localStorage.setItem('strado:kb-selected:/wt', 'ghost.md');
    kbFiles.mockImplementation(() => Promise.resolve({ truncated: false, cap: 2000, files: [] }));
    kbFile.mockRejectedValue(new Error('gone'));

    render(panel());

    await screen.findByRole('button', { name: 'Retry' });
    expect(localStorage.getItem('strado:kb-selected:/wt')).toBeNull();
  });

  it('renders a read failure as plain text, never through the markdown renderer', async () => {
    // Error text interpolates the caller's own input server-side (e.g.
    // "not a markdown file: <path>"). It must render as an ordinary escaped
    // text child, never through MarkdownView/dangerouslySetInnerHTML.
    kbFile.mockRejectedValue(new Error('<img src=x onerror=alert(1)>'));
    render(panel());
    await screen.findByRole('button', { name: 'Retry' });

    expect(document.querySelectorAll('img')).toHaveLength(0);
    expect(document.querySelector('.kb-markdown')).toBeNull();
  });

  it('shows the oversized-document notice instead of parsing when a file above the render threshold loads', async () => {
    // Integration coverage for the size gate: MarkdownView's own tests pass
    // `size` directly, and nothing else in this file resolves kb.file with a
    // size above the 200KB threshold — so a regression that stops wiring
    // contentSize through to MarkdownView (e.g. dropping the `size` prop at
    // the call site) would leave every other test here green while quietly
    // restoring the multi-second freeze this gate exists to prevent.
    kbFile.mockImplementation(() => Promise.resolve({ content: '# H', size: 300_000, mtimeMs: 1 }));
    render(panel());

    await screen.findByText(/too large to render/i);
    expect(document.querySelector('.kb-markdown')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'H' })).not.toBeInTheDocument();
  });

  it('shows a human-readable notice with no Retry for a file over the server size cap', async () => {
    // readMarkdownFile's own VALIDATION error ships { size, max } in details;
    // the raw "file is larger than 2097152 bytes" string must never reach
    // the user, and Retry (which can never succeed against a file that's
    // simply too large) must not be offered.
    kbFile.mockRejectedValue(
      new ApiClientError('VALIDATION', 'file is larger than 2097152 bytes', {
        size: 3_145_728,
        max: 2_097_152,
      }),
    );
    render(panel());

    expect(await screen.findByText(/3\.0 MB, over the 2\.0 MB limit/i)).toBeInTheDocument();
    expect(screen.queryByText(/file is larger than 2097152 bytes/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('reports the selected path to Open in VS Code', async () => {
    const onOpenInVsCode = vi.fn();
    render(panel({ onOpenInVsCode }));
    await screen.findByRole('button', { name: 'README.md' });

    fireEvent.click(screen.getByRole('button', { name: 'Open in VS Code' }));
    expect(onOpenInVsCode).toHaveBeenCalledWith('README.md');
  });

  it('keeps a selection absent from the listing but still readable (e.g. a gitignored doc)', async () => {
    // listMarkdownFiles filters gitignored paths but readMarkdownFile does
    // not — a gitignored doc is a real, readable file that simply isn't in
    // the browse list. Its absence from a later poll must not be treated as
    // evidence it's gone.
    vi.useFakeTimers();
    render(panel());
    await vi.advanceTimersByTimeAsync(0);
    expect(kbFile).toHaveBeenCalledWith('default', '/wt', 'README.md');

    kbFiles.mockImplementation(() => Promise.resolve({ truncated: false, cap: 2000, files: LISTING.files.slice(1) }));
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.waitFor(() => expect(kbFiles).toHaveBeenCalledTimes(2));

    expect(kbFile).not.toHaveBeenCalledWith('default', '/wt', 'docs/architecture.md');
    expect(kbFile).toHaveBeenCalledWith('default', '/wt', 'README.md');
  });

  it('recovers the selection when the current file both fails to load and is no longer listed', async () => {
    vi.useFakeTimers();
    render(panel());
    await vi.advanceTimersByTimeAsync(0);
    expect(kbFile).toHaveBeenCalledWith('default', '/wt', 'README.md');

    // Now the selected file is both dropped from the listing AND fails to
    // read — genuinely gone, not just excluded from the browse list.
    kbFiles.mockImplementation(() => Promise.resolve({ truncated: false, cap: 2000, files: LISTING.files.slice(1) }));
    kbFile.mockRejectedValue(new Error('gone'));
    await vi.advanceTimersByTimeAsync(10_000);

    await vi.waitFor(() =>
      expect(kbFile).toHaveBeenCalledWith('default', '/wt', 'docs/architecture.md'),
    );
  });

  it('does not poll while the tab is inactive', async () => {
    vi.useFakeTimers();
    render(panel({ active: false }));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(kbFiles).not.toHaveBeenCalled();
  });

  it('does not fetch file content for a hidden panel even with a persisted selection', async () => {
    // Task 7 keeps hidden panes mounted (multiple worktrees' KB tabs).
    // Without gating the content-load effect on `active`, a hidden pane with
    // a remembered selection fetched its file content on every app start —
    // invisible, wasted, and on a many-worktree machine multiplied by every
    // remembered tab at once.
    localStorage.setItem('strado:kb-selected:/wt', 'README.md');
    vi.useFakeTimers();
    render(panel({ active: false }));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(kbFile).not.toHaveBeenCalled();
  });

  it('does not evict the persisted selection when a read fails before the first listing lands', async () => {
    // filesRef starts as [] before any listing response arrives, so
    // "selected path isn't in filesRef" is otherwise always true — a
    // transient read failure at startup would evict a perfectly good
    // selection with nothing left to ever restore it.
    localStorage.setItem('strado:kb-selected:/wt', 'ghost.md');
    let resolveFiles!: (v: typeof LISTING) => void;
    kbFiles.mockImplementation(() => new Promise((res) => { resolveFiles = res; }));
    kbFile.mockRejectedValue(new Error('transient'));

    render(panel());

    await screen.findByRole('button', { name: 'Retry' });
    expect(localStorage.getItem('strado:kb-selected:/wt')).toBe('ghost.md');

    // Clean up the still-pending listing request so it doesn't dangle past the test.
    resolveFiles({ ...LISTING, files: [...LISTING.files] });
  });

  it('loads the listing once even while the document is hidden, but does not repeatedly poll', async () => {
    // An active-but-hidden panel (window occluded, not backgrounded-tab
    // inactive) still needs its listing ready for the moment the user looks
    // at it — the visibility gate exists to stop the RECURRING poll, not
    // the first load. Previously the initial fetch shared the same
    // visibility check as the poll, so a hidden window's active tab never
    // loaded a listing at all: rail stuck on "Loading…" forever beside a
    // fully-rendered content pane (loadFile has no such gate).
    vi.useFakeTimers();
    const spy = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    try {
      render(panel());
      await vi.advanceTimersByTimeAsync(0);
      expect(kbFiles).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(kbFiles).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('polls the listing while active', async () => {
    vi.useFakeTimers();
    render(panel());
    await vi.advanceTimersByTimeAsync(0);
    expect(kbFiles).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(kbFiles).toHaveBeenCalledTimes(2);
  });

  it('marks folder headers with aria-expanded and a distinguishable accessible name', async () => {
    render(panel());
    await screen.findByRole('button', { name: 'README.md' });

    const docsHeader = screen.getByRole('button', { name: 'docs folder' });
    expect(docsHeader).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(docsHeader);
    expect(docsHeader).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: 'architecture.md' })).not.toBeInTheDocument();
  });

  it('persists collapsed groups per worktree across remounts', async () => {
    const { unmount } = render(panel());
    await screen.findByRole('button', { name: 'architecture.md' });
    fireEvent.click(screen.getByRole('button', { name: 'docs folder' }));
    expect(screen.queryByRole('button', { name: 'architecture.md' })).not.toBeInTheDocument();
    unmount();

    render(panel());
    await screen.findByRole('button', { name: 'README.md' });
    expect(screen.queryByRole('button', { name: 'architecture.md' })).not.toBeInTheDocument();
  });
});
