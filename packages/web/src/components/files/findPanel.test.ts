// The ⌘F find bar with the real CodeMirror: ours, not the default panel.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createCodeView } from './codeView';

// jsdom has no layout; CodeMirror measures ranges when it scrolls to a match.
const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) };
Range.prototype.getClientRects ??= (() => Object.assign([], { item: () => null })) as unknown as Range['getClientRects'];
Range.prototype.getBoundingClientRect ??= (() => rect) as unknown as Range['getBoundingClientRect'];

afterEach(() => { document.body.replaceChildren(); });

const DOC = 'const fetchGroups = 1;\nfetchGroups();\nFetchGroups;\nfetchGroupsAll;\n';

async function setUp() {
  const parent = document.createElement('div');
  document.body.append(parent);
  const view = await createCodeView(parent, { doc: DOC, path: 'x.ts', language: null, marks: null, onSelection: vi.fn() });
  const content = parent.querySelector<HTMLElement>('.cm-content')!;
  content.focus();
  content.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true }));
  const bar = parent.querySelector<HTMLElement>('.cm-find');
  return { parent, view, content, bar };
}
const key = (el: Element, k: string, over: KeyboardEventInit = {}) =>
  el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...over }));
const type = (input: HTMLInputElement, text: string) => { input.value = text; input.dispatchEvent(new Event('input', { bubbles: true })); };
const btn = (bar: HTMLElement, name: string) => bar.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!;

describe('find bar', () => {
  it('⌘F opens our bar, focused, with no replace and no "all"', async () => {
    const { parent, bar } = await setUp();
    expect(bar).not.toBeNull();
    expect(parent.querySelector('.cm-search')).toBeNull();
    const input = bar!.querySelector('input')!;
    expect(input).toHaveAttribute('placeholder', 'Find in file');
    expect(document.activeElement).toBe(input);
    expect(bar!.querySelectorAll('input')).toHaveLength(1);
    expect(bar!.textContent).not.toMatch(/replace|all/i);
    for (const name of ['Match case', 'Regular expression', 'Whole word']) expect(btn(bar!, name)).toHaveAttribute('aria-pressed', 'false');
  });

  it('typing updates the count; Enter / Shift+Enter walk the matches', async () => {
    const { bar } = await setUp();
    const input = bar!.querySelector('input')!;
    const count = bar!.querySelector('.cm-find-count')!;
    type(input, 'nothing-here');
    expect(count.textContent).toBe('No results');
    type(input, 'fetchGroups');
    expect(count.textContent).toBe('4');
    key(input, 'Enter');
    expect(count.textContent).toBe('1 of 4');
    key(input, 'Enter');
    expect(count.textContent).toBe('2 of 4');
    key(input, 'Enter', { shiftKey: true });
    expect(count.textContent).toBe('1 of 4');
    btn(bar!, 'Next match').click();
    expect(count.textContent).toBe('2 of 4');
    btn(bar!, 'Previous match').click();
    expect(count.textContent).toBe('1 of 4');
  });

  it('toggles: match case, whole word, regex', async () => {
    const { bar } = await setUp();
    const input = bar!.querySelector('input')!;
    const count = bar!.querySelector('.cm-find-count')!;
    type(input, 'fetchGroups');
    btn(bar!, 'Match case').click();
    expect(btn(bar!, 'Match case')).toHaveAttribute('aria-pressed', 'true');
    expect(btn(bar!, 'Match case').classList.contains('glass-pill')).toBe(true);
    expect(count.textContent).toBe('3');
    btn(bar!, 'Whole word').click();
    expect(count.textContent).toBe('2');
    btn(bar!, 'Match case').click();
    btn(bar!, 'Whole word').click();
    type(input, 'fetch\\w+\\(');
    expect(count.textContent).toBe('No results');
    btn(bar!, 'Regular expression').click();
    expect(btn(bar!, 'Regular expression')).toHaveAttribute('aria-pressed', 'true');
    expect(count.textContent).toBe('1');
  });

  it('Esc (and ×) closes it and gives focus back to the code', async () => {
    const { parent, content, bar } = await setUp();
    key(bar!.querySelector('input')!, 'Escape');
    expect(parent.querySelector('.cm-find')).toBeNull();
    expect(document.activeElement).toBe(content);
    content.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true }));
    btn(parent.querySelector('.cm-find')!, 'Close find').click();
    expect(parent.querySelector('.cm-find')).toBeNull();
  });

  it('theme vars only — no raw hex, only 13px/11px type', () => {
    const src = ['./findPanel.ts', './codeView.ts'].map((f) => readFileSync(fileURLToPath(new URL(f, import.meta.url)), 'utf8')).join('\n');
    expect(src).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    for (const m of src.matchAll(/fontSize: '(\d+)px'/g)) expect(['11', '13']).toContain(m[1]);
  });
});
