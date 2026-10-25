// A smoke test with the real CodeMirror in jsdom: the lazy module builds a
// read-only view with line numbers, the change gutter, and n/p navigation.
import { afterEach, describe, expect, it, vi } from 'vitest';
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
});
