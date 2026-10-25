import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileContent, FileMarks } from '../../types';

type Opts = { doc: string; path: string; language: string | null; onSelection: (s: { from: number; to: number; text: string } | null) => void };
const cm = vi.hoisted(() => ({
  opts: null as Opts | null,
  view: { goToLine: vi.fn(), focus: vi.fn(), step: vi.fn(), setMarks: vi.fn(), destroy: vi.fn() },
}));
vi.mock('./codeView', () => ({
  createCodeView: vi.fn(async (_el: HTMLElement, o: Opts) => { cm.opts = o; return cm.view; }),
}));

import { FileViewer } from './FileViewer';

const TEXT: FileContent = { path: 'src/app.ts', size: 40, binary: false, tooLarge: false, text: 'const a = 1;\nconst b = 2;\n', language: 'typescript', change: 'M' };
const MARKS: FileMarks = { path: 'src/app.ts', added: [[2, 2]], modified: [[5, 6]], deletedAfter: [] };
const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });

function show(over: Partial<Parameters<typeof FileViewer>[0]> = {}, file: FileContent = TEXT, marks: FileMarks = MARKS) {
  const props = {
    worktreePath: '/wt', path: 'src/app.ts',
    read: vi.fn(async () => file), marks: vi.fn(async () => marks),
    onAskAgent: vi.fn(), onOpenInEditor: vi.fn(), ...over,
  };
  return { ...render(<FileViewer {...props} />), props };
}

beforeEach(async () => {
  vi.mocked((await import('./codeView')).createCodeView).mockClear();
  cm.opts = null;
  for (const f of Object.values(cm.view)) f.mockReset();
  cm.view.step.mockReturnValue(5);
});

describe('FileViewer', () => {
  it('loads the editor lazily with the file\'s text and language, then its change marks', async () => {
    const { props } = show();
    await flush();
    expect(props.read).toHaveBeenCalledWith('src/app.ts');
    expect(props.marks).toHaveBeenCalledWith('src/app.ts');
    expect(cm.opts).toMatchObject({ doc: TEXT.text, path: 'src/app.ts', language: 'typescript' });
    expect(cm.view.setMarks).toHaveBeenLastCalledWith(MARKS);
    expect(screen.getByTestId('file-viewer')).toHaveTextContent('src/app.ts');
  });

  it('n/p buttons walk the changes; the count is said', async () => {
    show();
    await flush();
    expect(screen.getByTestId('change-nav')).toHaveTextContent('2 changes');
    fireEvent.click(screen.getByRole('button', { name: 'Next change' }));
    expect(cm.view.step).toHaveBeenCalledWith(1);
    fireEvent.click(screen.getByRole('button', { name: 'Previous change' }));
    expect(cm.view.step).toHaveBeenCalledWith(-1);
  });

  it('no changes, no change navigation', async () => {
    show({}, TEXT, { path: 'src/app.ts', added: [], modified: [], deletedAfter: [] });
    await flush();
    expect(screen.queryByTestId('change-nav')).toBeNull();
  });

  it('selecting lines offers "Ask agent" with the worktree, path, lines and snippet', async () => {
    const { props } = show();
    await flush();
    expect(screen.queryByRole('button', { name: /Ask agent/ })).toBeNull();
    act(() => cm.opts!.onSelection({ from: 3, to: 7, text: 'some code' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ask agent about lines 3–7' }));
    expect(props.onAskAgent).toHaveBeenCalledWith({ worktreePath: '/wt', path: 'src/app.ts', from: 3, to: 7, snippet: 'some code' });
    act(() => cm.opts!.onSelection({ from: 4, to: 4, text: 'x'.repeat(20_000) }));
    fireEvent.click(screen.getByRole('button', { name: 'Ask agent about line 4' }));
    expect((vi.mocked(props.onAskAgent).mock.calls[1]![0] as { snippet: string }).snippet).toHaveLength(8192);
    act(() => cm.opts!.onSelection(null));
    expect(screen.queryByRole('button', { name: /Ask agent/ })).toBeNull();
  });

  it('"Open in editor" opens at the current line', async () => {
    const { props } = show();
    await flush();
    act(() => cm.opts!.onSelection({ from: 9, to: 9, text: 'a' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open in editor' }));
    expect(props.onOpenInEditor).toHaveBeenCalledWith('src/app.ts', 9);
    fireEvent.click(screen.getByRole('button', { name: 'Next change' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open in editor' }));
    expect(props.onOpenInEditor).toHaveBeenLastCalledWith('src/app.ts', 5);
  });

  it('goes to the asked line once loaded, and again for a new nonce', async () => {
    const { props, rerender } = show({ line: 12, nonce: 1 });
    await flush();
    expect(cm.view.goToLine).toHaveBeenCalledWith(12, undefined);
    rerender(<FileViewer {...props} line={30} nonce={2} />);
    expect(cm.view.goToLine).toHaveBeenLastCalledWith(30, undefined);
  });

  it('a jump brings focus to the code only when focus was lost (not stolen from a box)', async () => {
    const { props, rerender } = show({ line: 12, nonce: 1 });
    await flush();
    expect(cm.view.focus).toHaveBeenCalledTimes(1);
    const box = document.createElement('input');
    document.body.append(box);
    box.focus();
    rerender(<FileViewer {...props} line={30} nonce={2} />);
    expect(cm.view.focus).toHaveBeenCalledTimes(1);
    box.remove();
  });

  it('a reload that rebuilds the editor goes back to where the person was, not the old asked line', async () => {
    let text = TEXT.text!;
    const read = vi.fn(async () => ({ ...TEXT, text }));
    const { props, rerender } = show({ read, line: 12, nonce: 1 });
    await flush();
    expect(cm.view.goToLine).toHaveBeenLastCalledWith(12, undefined);
    act(() => cm.opts!.onSelection({ from: 40, to: 40, text: 'x' }));
    cm.view.goToLine.mockClear();
    text = 'edited\n';
    rerender(<FileViewer {...props} read={read} line={12} nonce={1} reloadKey={1} />);
    await flush();
    expect(cm.opts!.doc).toBe('edited\n');
    expect(cm.view.goToLine).toHaveBeenCalledWith(40);
    expect(cm.view.goToLine).not.toHaveBeenCalledWith(12, undefined);
    // A new ask (new nonce) still jumps.
    rerender(<FileViewer {...props} read={read} line={12} nonce={2} reloadKey={1} />);
    await flush();
    expect(cm.view.goToLine).toHaveBeenLastCalledWith(12, undefined);
  });

  it('a binary file and a too-large one get a note, never the editor', async () => {
    show({}, { ...TEXT, binary: true, text: undefined });
    await flush();
    expect(screen.getByTestId('file-empty')).toHaveTextContent('Binary file');
    expect(cm.opts).toBeNull();
  });

  it('too large: says the size and offers the editor', async () => {
    const { props } = show({}, { ...TEXT, tooLarge: true, size: 3 * 1024 * 1024, text: undefined });
    await flush();
    expect(screen.getByTestId('file-empty')).toHaveTextContent('Too large to show');
    expect(screen.getByTestId('file-empty')).toHaveTextContent('3.0 MB');
    fireEvent.click(screen.getAllByRole('button', { name: 'Open in editor' }).at(-1)!);
    expect(props.onOpenInEditor).toHaveBeenCalledWith('src/app.ts', 1);
  });

  it('a failed read says so in fixed words by its code, never the relayed message', async () => {
    const fail = (code: string) => vi.fn(async () => { throw Object.assign(new Error('runner said: /etc/passwd'), { code }); });
    show({ read: fail('NOT_FOUND') });
    await flush();
    expect(screen.getByRole('alert')).toHaveTextContent(/^This file no longer exists\.$/);
  });

  it('other read failures: outside the worktree, or a plain "couldn\'t read"', async () => {
    const fail = (code: string) => vi.fn(async () => { throw Object.assign(new Error('raw'), { code }); });
    const a = show({ read: fail('PATH_FORBIDDEN') });
    await flush();
    expect(screen.getByRole('alert')).toHaveTextContent('Outside this worktree.');
    a.unmount();
    show({ read: fail('TIMEOUT') });
    await flush();
    expect(screen.getByRole('alert')).toHaveTextContent('Couldn’t read this file.');
    expect(screen.getByRole('alert')).not.toHaveTextContent('raw');
  });

  it('opening the same file again (new nonce) or Refresh re-reads it; the same text keeps the editor', async () => {
    let text = TEXT.text!;
    const read = vi.fn(async () => ({ ...TEXT, text }));
    const { props, rerender } = show({ read, nonce: 1 });
    await flush();
    expect(read).toHaveBeenCalledTimes(1);
    const { createCodeView } = await import('./codeView');
    expect(createCodeView).toHaveBeenCalledTimes(1);
    rerender(<FileViewer {...props} read={read} nonce={2} />);
    await flush();
    expect(read).toHaveBeenCalledTimes(2);
    expect(props.marks).toHaveBeenCalledTimes(2);
    expect(createCodeView).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Loading…')).toBeNull();
    text = 'changed by an agent\n';
    rerender(<FileViewer {...props} read={read} nonce={2} reloadKey={1} />);
    await flush();
    expect(read).toHaveBeenCalledTimes(3);
    expect(createCodeView).toHaveBeenCalledTimes(2);
    expect(cm.opts!.doc).toBe('changed by an agent\n');
  });

  it('marks failing still shows the file', async () => {
    show({ marks: vi.fn(async () => { throw new Error('no git'); }) });
    await flush();
    expect(cm.opts?.doc).toBe(TEXT.text);
    expect(screen.queryByTestId('change-nav')).toBeNull();
  });

  it('only 13px and 11px type, no raw hex', async () => {
    const { container } = show();
    await flush();
    expect(container.innerHTML).not.toMatch(/text-\[(9|10|12)px\]/);
    expect(container.innerHTML).not.toMatch(/#[0-9a-f]{6}\b/i);
  });
});
