import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileContent, FileMarks } from '../../types';

type Opts = { doc: string; path: string; language: string | null; onSelection: (s: { from: number; to: number; text: string } | null) => void; onChange?: (text: string) => void };
const cm = vi.hoisted(() => ({
  opts: null as Opts | null,
  view: { goToLine: vi.fn(), focus: vi.fn(), step: vi.fn(), setMarks: vi.fn(), setHighlight: vi.fn(), setText: vi.fn(), destroy: vi.fn() },
}));
vi.mock('./codeView', () => ({
  createCodeView: vi.fn(async (_el: HTMLElement, o: Opts) => { cm.opts = o; return cm.view; }),
}));

import { FileViewer } from './FileViewer';
import { __resetBuffers, getBuffer, isDirty } from './buffers';

const TEXT: FileContent = { path: 'src/app.ts', size: 40, binary: false, tooLarge: false, text: 'const a = 1;\nconst b = 2;\n', language: 'typescript', change: 'M' };
const MARKS: FileMarks = { path: 'src/app.ts', added: [[2, 2]], modified: [[5, 6]], deletedAfter: [] };
const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });

function show(over: Partial<Parameters<typeof FileViewer>[0]> = {}, file: FileContent = TEXT, marks: FileMarks = MARKS) {
  const props = {
    worktreePath: '/wt', path: 'src/app.ts',
    read: vi.fn(async () => file), marks: vi.fn(async () => marks),
    onAskAgent: vi.fn(), ...over,
  };
  return { ...render(<FileViewer {...props} />), props };
}

beforeEach(async () => {
  __resetBuffers();
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
    expect(screen.getByTestId('file-viewer')).toHaveAccessibleName('src/app.ts');
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

  it('has no editor button of its own (the pane title bar has it)', async () => {
    show();
    await flush();
    expect(screen.queryByRole('button', { name: /Open in/ })).toBeNull();
  });

  it('too large: says the size and points at the title bar\'s editor button', async () => {
    show({}, { ...TEXT, tooLarge: true, size: 3 * 1024 * 1024, text: undefined });
    await flush();
    expect(screen.getByTestId('file-empty')).toHaveTextContent('Too large to show');
    expect(screen.getByTestId('file-empty')).toHaveTextContent('3.0 MB');
    expect(screen.getByTestId('file-empty')).toHaveTextContent('Open it in your editor from the title bar.');
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

  describe('editing (given a write)', () => {
    const V1 = { ...TEXT, version: 'v1' };
    const written = (version = 'v2') => vi.fn(async (b: { path: string; text: string }) => ({ path: b.path, version, size: b.text.length }));

    it('is editable, from the file\'s buffer; typing makes it dirty; no Read-only hint', async () => {
      show({ write: written() }, V1);
      await flush();
      expect(cm.opts!.onChange).toBeTypeOf('function');
      expect(screen.queryByTestId('read-only')).toBeNull();
      act(() => cm.opts!.onChange!('const a = 10;\n'));
      expect(isDirty(getBuffer('/wt', 'src/app.ts'))).toBe(true);
      expect(getBuffer('/wt', 'src/app.ts')).toMatchObject({ text: 'const a = 10;\n', version: 'v1' });
    });

    it('a clean file that changed on disk reloads quietly, in the same editor', async () => {
      let disk = V1;
      const read = vi.fn(async () => disk);
      const { props, rerender } = show({ write: written(), read }, V1);
      await flush();
      const { createCodeView } = await import('./codeView');
      disk = { ...V1, text: 'by an agent\n', version: 'v2' };
      rerender(<FileViewer {...props} reloadKey={1} />);
      await flush();
      expect(createCodeView).toHaveBeenCalledTimes(1);
      expect(cm.view.setText).toHaveBeenLastCalledWith('by an agent\n');
      expect(screen.queryByTestId('conflict-bar')).toBeNull();
    });

    it('a dirty file that changed on disk keeps your text and shows the bar; Reload (after a yes) takes the disk', async () => {
      let disk = V1;
      const read = vi.fn(async () => disk);
      const { props, rerender } = show({ write: written(), read }, V1);
      await flush();
      act(() => cm.opts!.onChange!('mine\n'));
      disk = { ...V1, text: 'theirs\n', version: 'v2' };
      rerender(<FileViewer {...props} reloadKey={1} />);
      await flush();
      expect(screen.getByTestId('conflict-bar')).toHaveTextContent('This file changed on disk.');
      expect(getBuffer('/wt', 'src/app.ts')!.text).toBe('mine\n');
      const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
      fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
      await flush();
      expect(getBuffer('/wt', 'src/app.ts')!.text).toBe('mine\n');
      fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
      await flush();
      expect(confirm).toHaveBeenLastCalledWith('Discard your changes to app.ts and load it from disk?');
      expect(getBuffer('/wt', 'src/app.ts')).toMatchObject({ text: 'theirs\n', base: 'theirs\n', version: 'v2', conflict: null });
      expect(cm.view.setText).toHaveBeenLastCalledWith('theirs\n');
      expect(screen.queryByTestId('conflict-bar')).toBeNull();
      confirm.mockRestore();
    });

    it('a save refused with 409 shows the bar; Overwrite writes with force; the gutter re-reads after', async () => {
      const write = vi.fn(async (b: { path: string; text: string; force?: boolean }) => {
        if (!b.force) throw Object.assign(new Error('409'), { code: 'CONFLICT', details: { version: 'disk' } });
        return { path: b.path, version: 'v3', size: 1 };
      });
      const { props } = show({ write }, V1);
      await flush();
      act(() => cm.opts!.onChange!('mine\n'));
      const { saveBuffer } = await import('./buffers');
      await act(async () => { await saveBuffer('/wt', 'src/app.ts'); });
      expect(screen.getByTestId('conflict-bar')).toBeInTheDocument();
      expect(props.marks).toHaveBeenCalledTimes(1);
      fireEvent.click(screen.getByRole('button', { name: 'Overwrite' }));
      await flush();
      expect(write).toHaveBeenLastCalledWith({ path: 'src/app.ts', text: 'mine\n', baseVersion: 'v1', force: true });
      expect(screen.queryByTestId('conflict-bar')).toBeNull();
      expect(isDirty(getBuffer('/wt', 'src/app.ts'))).toBe(false);
      expect(props.marks).toHaveBeenCalledTimes(2);
    });

    it('a failed save says so in fixed words above the code', async () => {
      show({ write: vi.fn(async () => { throw new Error('EACCES'); }) }, V1);
      await flush();
      act(() => cm.opts!.onChange!('mine\n'));
      const { saveBuffer } = await import('./buffers');
      await act(async () => { await saveBuffer('/wt', 'src/app.ts'); });
      expect(screen.getByTestId('save-error')).toHaveTextContent('Couldn’t save. Your changes are still here.');
    });

    it('a file that isn\'t UTF-8 is read-only even with a write, and the chip says why', async () => {
      const write = written();
      show({ write }, { ...V1, notUtf8: true });
      await flush();
      expect(cm.opts!.doc).toBe(TEXT.text);
      expect(cm.opts!.onChange).toBeUndefined();
      expect(screen.getByTestId('read-only')).toHaveTextContent('Read-only: not UTF-8');
      expect(getBuffer('/wt', 'src/app.ts')).toBeUndefined();
      expect(write).not.toHaveBeenCalled();
    });

    it('mixed line endings (or a lone CR) are read-only, and the chip says why; a CRLF file is editable', async () => {
      const a = show({ write: written() }, { ...V1, text: 'one\r\ntwo\nthree\r\n' });
      await flush();
      expect(cm.opts!.onChange).toBeUndefined();
      expect(screen.getByTestId('read-only')).toHaveTextContent('Read-only: mixed line endings');
      expect(getBuffer('/wt', 'src/app.ts')).toBeUndefined();
      a.unmount();
      const b = show({ write: written() }, { ...V1, text: 'old mac\rline' });
      await flush();
      expect(screen.getByTestId('read-only')).toHaveTextContent('Read-only: mixed line endings');
      b.unmount();
      show({ write: written() }, { ...V1, text: 'one\r\ntwo\r\n' });
      await flush();
      expect(cm.opts!.onChange).toBeTypeOf('function');
      expect(screen.queryByTestId('read-only')).toBeNull();
    });

    it('read-only: without a write (a runner), and for binary or too-large files even with one', async () => {
      const a = show({ readOnlyWhy: 'Files on runner-dev are read-only here' });
      await flush();
      expect(cm.opts!.onChange).toBeUndefined();
      expect(screen.getByTestId('read-only')).toHaveAttribute('title', 'Files on runner-dev are read-only here');
      a.unmount();
      const b = show({ write: written() }, { ...TEXT, binary: true, text: undefined });
      await flush();
      expect(screen.getByTestId('read-only')).toHaveAttribute('title', 'Binary files can’t be edited here');
      b.unmount();
      show({ write: written() }, { ...TEXT, tooLarge: true, size: 3 * 1024 * 1024, text: undefined });
      await flush();
      expect(screen.getByTestId('read-only')).toHaveAttribute('title', 'Files over 1 MB can’t be edited here');
    });
  });
});
