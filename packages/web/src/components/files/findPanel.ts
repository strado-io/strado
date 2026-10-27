// ⌘F inside a file: our own compact find bar in place of CodeMirror's default
// panel (white input, grey buttons, raw checkboxes). It drives the search
// extension's own query and commands, so highlights, F3/⌘G and the rest keep
// working. An editable file gets a replace row too (› or ⌘⌥F), driving
// CodeMirror's replaceNext/replaceAll, so one undo takes a replace back.
// The person's regex never runs over the whole file on the page's thread: the
// count happens in a worker with a timeout, and a regex is handed to
// CodeMirror (which highlights only what's on screen) only once it counted in
// time. A too-slow or broken one marks the box and highlights nothing.
import { SearchQuery, closeSearchPanel, findNext, findPrevious, getSearchQuery, openSearchPanel, replaceAll, replaceNext, searchPanelOpen, setSearchQuery } from '@codemirror/search';
import { countLabel, countMatches, FIND_TIMEOUT_MS, type FindCount, type FindSpec } from './findCount';
import { runScopeHandlers, type EditorView, type Panel, type ViewUpdate } from '@codemirror/view';

/** The count waits this long after the last keystroke. */
export const COUNT_DEBOUNCE_MS = 150;

/** Counts matches without blocking the page; 'timeout' when it took too long. */
export type FindCounter = (doc: string, q: FindSpec) => Promise<FindCount | 'invalid' | 'timeout'>;

// One worker, ended and replaced when a count runs past the timeout (a
// runaway regex can't be interrupted any other way).
function workerCounter(): FindCounter {
  let worker: Worker | null = null;
  let seq = 0;
  return (doc, q) => new Promise((resolve) => {
    worker ??= new Worker(new URL('./findCount.worker.ts', import.meta.url), { type: 'module' });
    const w = worker;
    const id = ++seq;
    const done = (r: FindCount | 'invalid' | 'timeout') => { clearTimeout(timer); w.removeEventListener('message', onMessage); resolve(r); };
    const onMessage = (e: MessageEvent<{ id: number; result: FindCount | 'invalid' }>) => { if (e.data.id === id) done(e.data.result); };
    const timer = setTimeout(() => { w.terminate(); if (worker === w) worker = null; done('timeout'); }, FIND_TIMEOUT_MS);
    w.addEventListener('message', onMessage);
    w.postMessage({ id, doc, q });
  });
}
// Without Worker (tests, very old runtimes) a literal search is cheap enough
// here; a regex is not, so it is refused rather than risked.
const inlineCounter: FindCounter = async (doc, q) => (q.regexp ? 'timeout' : countMatches(doc, q));

let counter: FindCounter | null = null;
/** Tests swap the counter; null goes back to the default. */
export function setFindCounter(c: FindCounter | null) { counter = c; }
const countIt: FindCounter = (doc, q) => {
  counter ??= typeof Worker === 'undefined' ? inlineCounter : workerCounter();
  return counter(doc, q);
};

const ICON = {
  up: '<svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 15l6-6 6 6"/></svg>',
  down: '<svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>',
};

// ⌘⌥F: the bar with its replace row showing. Open bars register how to show it.
const showReplace = new WeakMap<EditorView, () => void>();
const replaceWanted = new WeakSet<EditorView>();
export function openReplace(view: EditorView): boolean {
  if (view.state.readOnly) return false;
  if (searchPanelOpen(view.state)) showReplace.get(view)?.();
  else { replaceWanted.add(view); openSearchPanel(view); }
  return true;
}

const pick = (q: SearchQuery): FindSpec => ({ search: q.search, caseSensitive: q.caseSensitive, regexp: q.regexp, wholeWord: q.wholeWord });

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

  // The replace row, for a file that can be edited.
  const editable = !view.state.readOnly;
  const replaceInput = document.createElement('input');
  replaceInput.className = 'cm-find-input';
  replaceInput.placeholder = 'Replace';
  replaceInput.setAttribute('aria-label', 'Replace');
  replaceInput.spellcheck = false;
  const replaceRow = document.createElement('div');
  replaceRow.className = 'cm-find-replace';
  const replaceOne = button('Replace', 'Replace (Enter)', 'Replace', () => { replaceNext(view); });
  const replaceEvery = button('Replace all', 'Replace all (⌘Enter)', 'All', () => { replaceAll(view); });
  for (const b of [replaceOne, replaceEvery]) b.classList.add('cm-find-word');
  replaceRow.append(replaceInput, replaceOne, replaceEvery);
  const expand = button('Toggle replace', 'Toggle replace (⌘⌥F)', '›', () => setReplacing(!replacing));
  expand.classList.add('cm-find-expand');
  let replacing = false;
  const setReplacing = (on: boolean) => {
    replacing = on;
    replaceRow.hidden = !on;
    expand.setAttribute('aria-expanded', String(on));
    expand.classList.toggle('cm-find-open', on);
    if (on) { replaceInput.focus(); replaceInput.select(); } else input.focus();
  };
  if (editable) {
    dom.prepend(expand);
    dom.append(replaceRow);
    replaceRow.hidden = true;
    expand.setAttribute('aria-expanded', 'false');
    showReplace.set(view, () => setReplacing(true));
  }

  // What the box and toggles say; CodeMirror's query follows once it's safe.
  let draft: FindSpec = { ...pick(getSearchQuery(view.state)) };
  let result: FindCount | 'invalid' | 'timeout' | null = null;
  let ours = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let asked = 0;
  const apply = (q: FindSpec | null) => {
    const next = new SearchQuery({ ...(q ?? { ...draft, search: '' }), replace: replaceInput.value, literal: false });
    if (next.eq(getSearchQuery(view.state))) return;
    ours++;
    view.dispatch({ effects: setSearchQuery.of(next) });
  };
  const recount = () => {
    if (timer) clearTimeout(timer);
    const q = { ...draft };
    const id = ++asked;
    // A literal search is safe to highlight at once; a regex waits for its count.
    if (!q.regexp) apply(q);
    if (!q.search) { result = null; apply(q); show(); return; }
    timer = setTimeout(() => {
      void countIt(view.state.doc.toString(), q).then((r) => {
        if (id !== asked) return;
        result = r;
        apply(r === 'invalid' || r === 'timeout' ? null : q);
        show();
      });
    }, COUNT_DEBOUNCE_MS);
  };
  const flip = (k: 'caseSensitive' | 'regexp' | 'wholeWord') => { draft = { ...draft, [k]: !draft[k] }; recount(); show(); };

  const show = () => {
    if (input.value !== draft.search) input.value = draft.search;
    for (const [k, b] of Object.entries(toggles)) {
      const on = draft[k as keyof typeof toggles];
      b.setAttribute('aria-pressed', String(on));
      b.classList.toggle('glass-pill', on);
      b.classList.toggle('cm-find-on', on);
    }
    const bad = result === 'invalid' || result === 'timeout';
    input.setAttribute('aria-invalid', String(bad));
    input.classList.toggle('cm-find-bad', bad);
    count.textContent = !draft.search || !result ? '' : result === 'invalid' ? 'Invalid' : result === 'timeout' ? '—' : countLabel(result, view.state.selection.main);
    count.title = result === 'timeout' ? 'Too slow to count' : result === 'invalid' ? 'Not a valid regular expression' : '';
    count.classList.toggle('cm-find-none', count.textContent === 'No results' || bad);
  };

  input.addEventListener('input', () => { draft = { ...draft, search: input.value }; recount(); });
  // The replace text joins the query at once, unless the regex isn't safe yet.
  replaceInput.addEventListener('input', () => {
    if (!draft.regexp || (result && result !== 'invalid' && result !== 'timeout')) apply({ ...draft });
  });
  replaceInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    e.stopPropagation();
    if (e.metaKey || e.ctrlKey) replaceAll(view); else replaceNext(view);
  });
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

  recount();
  return {
    dom,
    top: true,
    mount: () => {
      if (replaceWanted.delete(view)) setReplacing(true);
      else { input.focus(); input.select(); }
    },
    update: (u: ViewUpdate) => {
      // ⌘F with a selection sets the query from outside: take it as the box's text.
      for (const tr of u.transactions) for (const ef of tr.effects) {
        if (!ef.is(setSearchQuery)) continue;
        if (ours > 0) { ours--; continue; }
        draft = pick(ef.value);
        recount();
      }
      // An edit (a replace, typing) moves the matches: count again.
      if (u.docChanged && draft.search) recount();
      // A cursor move only re-reads "n of N" from the matches already counted.
      else if (u.selectionSet) show();
    },
    destroy: () => { if (timer) clearTimeout(timer); asked++; showReplace.delete(view); },
  };
}
