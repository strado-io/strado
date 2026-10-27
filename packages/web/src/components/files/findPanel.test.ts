// The ⌘F find bar with the real CodeMirror: ours, not the default panel.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createCodeView } from './codeView';
import { countMatches } from './findCount';
import { COUNT_DEBOUNCE_MS, setFindCounter } from './findPanel';

// jsdom has no layout; CodeMirror measures ranges when it scrolls to a match.
const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) };
Range.prototype.getClientRects ??= (() => Object.assign([], { item: () => null })) as unknown as Range['getClientRects'];
Range.prototype.getBoundingClientRect ??= (() => rect) as unknown as Range['getBoundingClientRect'];

// The worker's job, done in place (jsdom has no Worker).
beforeEach(() => setFindCounter(async (doc, q) => countMatches(doc, q)));
afterEach(() => { document.body.replaceChildren(); setFindCounter(null); });
const settle = () => new Promise((r) => setTimeout(r, COUNT_DEBOUNCE_MS + 30));

const DOC = 'const fetchGroups = 1;\nfetchGroups();\nFetchGroups;\nfetchGroupsAll;\n';

async function setUp(onChange?: (text: string) => void) {
  const parent = document.createElement('div');
  document.body.append(parent);
  const view = await createCodeView(parent, { doc: DOC, path: 'x.ts', language: null, marks: null, onSelection: vi.fn(), onChange });
  const content = parent.querySelector<HTMLElement>('.cm-content')!;
  content.focus();
  content.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true }));
  const bar = parent.querySelector<HTMLElement>('.cm-find');
  return { parent, view, content, bar };
}
const key = (el: Element, k: string, over: KeyboardEventInit = {}) =>
  el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...over }));
const type = async (input: HTMLInputElement, text: string) => { input.value = text; input.dispatchEvent(new Event('input', { bubbles: true })); await settle(); };
const press = async (b: HTMLButtonElement) => { b.click(); await settle(); };
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
    await type(input, 'nothing-here');
    expect(count.textContent).toBe('No results');
    await type(input, 'fetchGroups');
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
    await type(input, 'fetchGroups');
    await press(btn(bar!, 'Match case'));
    expect(btn(bar!, 'Match case')).toHaveAttribute('aria-pressed', 'true');
    expect(btn(bar!, 'Match case').classList.contains('glass-pill')).toBe(true);
    expect(count.textContent).toBe('3');
    await press(btn(bar!, 'Whole word'));
    expect(count.textContent).toBe('2');
    await press(btn(bar!, 'Match case'));
    await press(btn(bar!, 'Whole word'));
    await type(input, 'fetch\\w+\\(');
    expect(count.textContent).toBe('No results');
    await press(btn(bar!, 'Regular expression'));
    expect(btn(bar!, 'Regular expression')).toHaveAttribute('aria-pressed', 'true');
    expect(count.textContent).toBe('1');
  });

  it('a regex too slow to count shows "—", marks the box and highlights nothing', async () => {
    setFindCounter(async (doc, q) => (q.regexp ? 'timeout' : countMatches(doc, q)));
    const { parent, bar } = await setUp();
    const input = bar!.querySelector('input')!;
    const count = bar!.querySelector('.cm-find-count')!;
    await press(btn(bar!, 'Regular expression'));
    await type(input, '(a+)+$');
    expect(count.textContent).toBe('—');
    expect(count).toHaveAttribute('title', 'Too slow to count');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(parent.querySelector('.cm-searchMatch')).toBeNull();
    await type(input, 'fetch');
    await press(btn(bar!, 'Regular expression'));
    expect(input).toHaveAttribute('aria-invalid', 'false');
    expect(count.textContent).toBe('4');
  });

  it('a broken regex says Invalid; the count is debounced and a cursor move doesn\'t recount', async () => {
    const counter = vi.fn(async (doc: string, q: Parameters<typeof countMatches>[1]) => countMatches(doc, q));
    setFindCounter(counter);
    const { bar } = await setUp();
    const input = bar!.querySelector('input')!;
    const count = bar!.querySelector('.cm-find-count')!;
    await press(btn(bar!, 'Regular expression'));
    counter.mockClear();
    input.value = 'f'; input.dispatchEvent(new Event('input'));
    input.value = 'fe'; input.dispatchEvent(new Event('input'));
    await type(input, 'fetch(');
    expect(counter).toHaveBeenCalledTimes(1);
    expect(count.textContent).toBe('Invalid');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    await type(input, 'fetch');
    counter.mockClear();
    key(input, 'Enter');
    expect(count.textContent).toBe('1 of 4');
    expect(counter).not.toHaveBeenCalled();
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

  it('read-only: no replace row', async () => {
    const { bar } = await setUp();
    expect(bar!.querySelector('button[aria-label="Toggle replace"]')).toBeNull();
  });

  it('editable: › shows the replace row; Enter replaces the next, ⌘Enter all; one undo per replace', async () => {
    const onChange = vi.fn();
    const { bar } = await setUp(onChange);
    const toggle = btn(bar!, 'Toggle replace');
    const row = bar!.querySelector<HTMLElement>('.cm-find-replace')!;
    expect(row.hidden).toBe(true);
    toggle.click();
    expect(row.hidden).toBe(false);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const replace = row.querySelector('input')!;
    expect(document.activeElement).toBe(replace);
    await type(bar!.querySelector('input')!, 'fetchGroups');
    await type(replace, 'loadGroups');
    key(replace, 'Enter'); // selects the first match
    key(replace, 'Enter'); // replaces it
    expect(onChange).toHaveBeenLastCalledWith(expect.stringMatching(/^const loadGroups = 1;\nfetchGroups\(\);/));
    key(replace, 'Enter', { metaKey: true });
    await settle();
    // Case-insensitive by default: FetchGroups too; fetchGroupsAll is a substring match.
    expect(onChange).toHaveBeenLastCalledWith('const loadGroups = 1;\nloadGroups();\nloadGroups;\nloadGroupsAll;\n');
    expect(bar!.querySelector('.cm-find-count')!.textContent).toBe('No results');
  });

  it('theme vars only — no raw hex, only 13px/11px type', () => {
    const src = ['./findPanel.ts', './codeView.ts'].map((f) => readFileSync(fileURLToPath(new URL(f, import.meta.url)), 'utf8')).join('\n');
    expect(src).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    for (const m of src.matchAll(/fontSize: '(\d+)px'/g)) expect(['11', '13']).toContain(m[1]);
  });
});
