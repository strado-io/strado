// ⌘F inside a file: our own compact find bar in place of CodeMirror's default
// panel (white input, grey buttons, raw checkboxes). It drives the search
// extension's own query and commands, so highlights, F3/⌘G and the rest keep
// working. Read-only, so no replace and no "all".
import { SearchQuery, closeSearchPanel, findNext, findPrevious, getSearchQuery, setSearchQuery } from '@codemirror/search';
import type { EditorState } from '@codemirror/state';
import { runScopeHandlers, type EditorView, type Panel, type ViewUpdate } from '@codemirror/view';

/** Counting stops here; a bigger file says "1000+". */
export const COUNT_CAP = 1000;

/** "3 of 12", "12" (cursor not on one), "No results", or "" for an empty box. */
export function matchCount(state: EditorState, q: SearchQuery): string {
  if (!q.search) return '';
  if (!q.valid) return 'No results';
  const sel = state.selection.main;
  let total = 0;
  let at = 0;
  const cursor = q.getCursor(state);
  for (let m = cursor.next(); !m.done; m = cursor.next()) {
    total++;
    if (m.value.from === sel.from && m.value.to === sel.to) at = total;
    if (total >= COUNT_CAP) return at ? `${at} of ${COUNT_CAP}+` : `${COUNT_CAP}+`;
  }
  if (!total) return 'No results';
  return at ? `${at} of ${total}` : String(total);
}

const ICON = {
  up: '<svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 15l6-6 6 6"/></svg>',
  down: '<svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>',
};

export function createFindPanel(view: EditorView): Panel {
  const dom = document.createElement('div');
  dom.className = 'cm-find';
  dom.setAttribute('role', 'search');
  dom.setAttribute('aria-label', 'Find in file');

  const input = document.createElement('input');
  input.className = 'cm-find-input';
  input.placeholder = 'Find in file';
  input.setAttribute('aria-label', 'Find in file');
  // The search extension focuses (and selects) this field when ⌘F is pressed.
  input.setAttribute('main-field', 'true');
  input.spellcheck = false;

  const count = document.createElement('span');
  count.className = 'cm-find-count';
  count.setAttribute('aria-live', 'polite');

  const button = (label: string, title: string, html: string, run: () => void) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cm-find-btn';
    b.setAttribute('aria-label', label);
    b.title = title;
    b.innerHTML = html;
    // Keep focus in the box while clicking.
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', run);
    return b;
  };
  const toggles = {
    caseSensitive: button('Match case', 'Match case', 'Aa', () => flip('caseSensitive')),
    regexp: button('Regular expression', 'Regular expression', '.*', () => flip('regexp')),
    wholeWord: button('Whole word', 'Whole word', 'W', () => flip('wholeWord')),
  };
  for (const t of Object.values(toggles)) t.classList.add('cm-find-toggle');
  const prev = button('Previous match', 'Previous match (Shift+Enter)', ICON.up, () => { findPrevious(view); });
  const next = button('Next match', 'Next match (Enter)', ICON.down, () => { findNext(view); });
  const close = button('Close find', 'Close (Esc)', '×', () => { closeSearchPanel(view); });

  const sep = document.createElement('span');
  sep.className = 'cm-find-sep';
  dom.append(input, count, toggles.caseSensitive, toggles.regexp, toggles.wholeWord, sep, prev, next, close);

  let query = getSearchQuery(view.state);
  const commit = (over: Partial<{ search: string; caseSensitive: boolean; regexp: boolean; wholeWord: boolean }>) => {
    const q = new SearchQuery({
      search: over.search ?? query.search,
      caseSensitive: over.caseSensitive ?? query.caseSensitive,
      regexp: over.regexp ?? query.regexp,
      wholeWord: over.wholeWord ?? query.wholeWord,
      literal: query.literal,
    });
    if (!q.eq(query)) view.dispatch({ effects: setSearchQuery.of(q) });
  };
  const flip = (k: 'caseSensitive' | 'regexp' | 'wholeWord') => commit({ [k]: !query[k] });

  const show = (state: EditorState) => {
    if (input.value !== query.search) input.value = query.search;
    for (const [k, b] of Object.entries(toggles)) {
      const on = query[k as keyof typeof toggles];
      b.setAttribute('aria-pressed', String(on));
      b.classList.toggle('glass-pill', on);
      b.classList.toggle('cm-find-on', on);
    }
    const c = matchCount(state, query);
    count.textContent = c;
    count.classList.toggle('cm-find-none', c === 'No results');
  };

  input.addEventListener('input', () => commit({ search: input.value }));
  dom.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeSearchPanel(view); return; }
    if (e.key === 'Enter' && e.target === input) {
      e.preventDefault();
      if (e.shiftKey) findPrevious(view); else findNext(view);
      return;
    }
    // F3, ⌘G and the rest of the search keymap.
    if (runScopeHandlers(view, e, 'search-panel')) e.preventDefault();
  });

  show(view.state);
  return {
    dom,
    top: true,
    mount: () => { input.focus(); input.select(); },
    update: (u: ViewUpdate) => {
      for (const tr of u.transactions) for (const ef of tr.effects) if (ef.is(setSearchQuery)) query = ef.value;
      if (u.docChanged || u.selectionSet || u.transactions.some((tr) => tr.effects.some((ef) => ef.is(setSearchQuery)))) show(u.state);
    },
  };
}
