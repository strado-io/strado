// A smoke test with the real CodeMirror in jsdom: the lazy module builds a
// read-only view with line numbers, the change gutter, and n/p navigation.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import { createCodeView } from './codeView';

afterEach(() => { document.body.replaceChildren(); });

describe('codeView (real CodeMirror)', () => {
  it('renders read-only text with line numbers and change marks; n/p and goToLine move the cursor', async () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const onSelection = vi.fn();
    const doc = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');
    const view = await createCodeView(parent, {
      doc, path: 'notes.txt', language: null, onSelection,
      marks: { path: 'notes.txt', added: [[5, 6]], modified: [[12, 12]], deletedAfter: [20] },
    });
    expect(parent.querySelector('.cm-content')).toHaveAttribute('contenteditable', 'true');
    expect(parent.querySelector('.cm-content')).toHaveAttribute('aria-readonly', 'true');
    expect(parent.querySelector('.cm-lineNumbers')).not.toBeNull();
    const marks = [...parent.querySelectorAll('[data-mark]')].map((el) => el.getAttribute('data-mark'));
    expect(marks).toContain('added');
    expect(marks).toContain('modified');
    expect(marks).toContain('deleted');
    expect(view.step(1)).toBe(5);
    expect(view.step(1)).toBe(12);
    expect(view.step(1)).toBe(21);
    expect(view.step(1)).toBe(5);
    expect(view.step(-1)).toBe(21);
    view.goToLine(3);
    expect(view.step(1)).toBe(5);
    view.setMarks(null);
    expect(view.step(1)).toBeNull();
    view.destroy();
    expect(parent.querySelector('.cm-editor')).toBeNull();
  });

  it('F12 and ⇧F12 report the cursor (1-based) for definition and references; goToLine takes a column', async () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const onNavigate = vi.fn();
    const view = await createCodeView(parent, { doc: 'const a = 1;\nopen(a);\n', path: 'x.ts', language: null, marks: null, onSelection: vi.fn(), onNavigate });
    view.goToLine(2, 6);
    expect(view.cursor()).toEqual({ line: 2, col: 6 });
    const content = parent.querySelector('.cm-content')!;
    content.dispatchEvent(new KeyboardEvent('keydown', { key: 'F12', bubbles: true, cancelable: true }));
    expect(onNavigate).toHaveBeenLastCalledWith('definition', { line: 2, col: 6 });
    content.dispatchEvent(new KeyboardEvent('keydown', { key: 'F12', shiftKey: true, bubbles: true, cancelable: true }));
    expect(onNavigate).toHaveBeenLastCalledWith('references', { line: 2, col: 6 });
    view.goToLine(99, 99);
    expect(view.cursor().line).toBe(3);
    view.destroy();
  });

  it('setHighlight marks every match of a ⌘⇧F query; the one at the cursor is the current one; null clears', async () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const view = await createCodeView(parent, { doc: 'open(a);\nreopen(b);\nOpen(c);\n', path: 'x.ts', language: null, marks: null, onSelection: vi.fn() });
    view.setHighlight({ q: 'open', case: true });
    view.goToLine(2, 3);
    expect([...parent.querySelectorAll('.cm-searchMatch')].map((e) => e.textContent)).toEqual(['open', 'open']);
    expect(parent.querySelector('.cm-searchMatch-selected')?.textContent).toBe('open');
    const cm = EditorView.findFromDOM(parent.querySelector('.cm-editor') as HTMLElement)!;
    expect(cm.state.doc.lineAt(cm.state.selection.main.head).number).toBe(2);
    view.setHighlight({ q: 'open', word: true });
    expect([...parent.querySelectorAll('.cm-searchMatch')].map((e) => e.textContent)).toEqual(['open', 'Open']);
    view.setHighlight({ q: 'o[a-z]+n', regex: true, case: true });
    expect(parent.querySelectorAll('.cm-searchMatch')).toHaveLength(2);
    view.setHighlight(null);
    expect(parent.querySelector('.cm-searchMatch')).toBeNull();
    view.destroy();
  });

  it('read-only without onChange; with it, typing reports the text, ⌘Z/Ctrl-Z undoes, and setText is not an edit', async () => {
    const ro = document.createElement('div');
    document.body.append(ro);
    const view0 = await createCodeView(ro, { doc: 'abc', path: 'x.ts', language: null, marks: null, onSelection: vi.fn() });
    expect(EditorView.findFromDOM(ro.querySelector('.cm-editor') as HTMLElement)!.state.readOnly).toBe(true);
    view0.destroy();

    const parent = document.createElement('div');
    document.body.append(parent);
    const onChange = vi.fn();
    const view = await createCodeView(parent, { doc: 'const a = 1;\nnext\n', path: 'x.ts', language: null, marks: null, onSelection: vi.fn(), onChange });
    const cm = EditorView.findFromDOM(parent.querySelector('.cm-editor') as HTMLElement)!;
    expect(cm.state.readOnly).toBe(false);
    cm.dispatch({ changes: { from: 0, insert: '// hi\n' }, userEvent: 'input.type' });
    expect(onChange).toHaveBeenLastCalledWith('// hi\nconst a = 1;\nnext\n');
    const content = parent.querySelector('.cm-content')!;
    content.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
    expect(cm.state.doc.toString()).toBe('const a = 1;\nnext\n');
    expect(onChange).toHaveBeenLastCalledWith('const a = 1;\nnext\n');
    // ⌘[ / Ctrl-[ is the Files tab's Back, not indent-less: left alone here.
    const back = new KeyboardEvent('keydown', { key: '[', ctrlKey: true, bubbles: true, cancelable: true });
    content.dispatchEvent(back);
    expect(back.defaultPrevented).toBe(false);
    // A reload (or the other pane) replaces only what differs; the cursor stays; not reported.
    onChange.mockClear();
    view.goToLine(2, 3);
    view.setText('const a = 2;\nnext\n');
    expect(cm.state.doc.toString()).toBe('const a = 2;\nnext\n');
    expect(view.cursor()).toEqual({ line: 2, col: 3 });
    expect(onChange).not.toHaveBeenCalled();
    view.destroy();
  });

  it('a CRLF file stays CRLF: an edit reports \\r\\n on every line, Enter inserts one, setText of the same text dispatches nothing', async () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const onChange = vi.fn();
    const doc = 'one\r\ntwo\r\nthree\r\n';
    const view = await createCodeView(parent, { doc, path: 'x.ts', language: null, marks: null, onSelection: vi.fn(), onChange });
    const cm = EditorView.findFromDOM(parent.querySelector('.cm-editor') as HTMLElement)!;
    expect(cm.state.lineBreak).toBe('\r\n');
    cm.dispatch({ changes: { from: 0, insert: '// ' }, userEvent: 'input.type' });
    expect(onChange).toHaveBeenLastCalledWith('// one\r\ntwo\r\nthree\r\n');
    cm.dispatch({ selection: { anchor: cm.state.doc.line(2).to } });
    parent.querySelector('.cm-content')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(onChange).toHaveBeenLastCalledWith('// one\r\ntwo\r\n\r\nthree\r\n');
    expect(onChange.mock.lastCall![0]).not.toMatch(/[^\r]\n/);
    const dispatch = vi.spyOn(cm, 'dispatch');
    view.setText('// one\r\ntwo\r\n\r\nthree\r\n');
    expect(dispatch).not.toHaveBeenCalled();
    // A reload of new CRLF text goes in as CRLF, only where it differs.
    view.setText('// one\r\nTWO\r\n\r\nthree\r\n');
    expect(cm.state.sliceDoc()).toBe('// one\r\nTWO\r\n\r\nthree\r\n');
    expect(cm.state.doc.lines).toBe(5);
    view.destroy();
  });

  it('reports cursor moves the person makes, not goToLine', async () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const onCursor = vi.fn();
    const view = await createCodeView(parent, { doc: 'a\nbb\nccc\n', path: 'x.ts', language: null, marks: null, onSelection: vi.fn(), onCursor });
    view.goToLine(3, 2);
    expect(onCursor).not.toHaveBeenCalled();
    const cm = EditorView.findFromDOM(parent.querySelector('.cm-editor') as HTMLElement)!;
    cm.dispatch({ selection: { anchor: 3 }, userEvent: 'select.pointer' });
    expect(onCursor).toHaveBeenLastCalledWith({ line: 2, col: 2 });
    view.destroy();
  });
});
