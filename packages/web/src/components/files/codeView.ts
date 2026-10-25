// The Files tab's read-only CodeMirror view. Imported only with import() from
// FileViewer, so CodeMirror stays out of the main bundle. Colours come from
// the app's theme vars (zinc/sky scales, --pane-card), so every preset —
// GitHub Light included — holds without a hex in sight.
import { EditorState, RangeSetBuilder, StateEffect, StateField } from '@codemirror/state';
import { EditorView, GutterMarker, gutter, highlightActiveLine, hoverTooltip, keymap, lineNumbers } from '@codemirror/view';
import { HighlightStyle, LanguageDescription, syntaxHighlighting } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { tags as t } from '@lezer/highlight';
import type { FileMarks } from '../../types';
import { changeStarts, lineMarks, stepChange, type LineMark } from './changes';
import { renderHover } from './hoverMarkdown';

const v = (name: string, alpha?: number) => `rgb(var(--${name})${alpha != null ? ` / ${alpha}` : ''})`;

const theme = EditorView.theme({
  '&': { height: '100%', backgroundColor: v('pane-card'), color: v('zinc-200'), fontSize: '13px' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.55' },
  '.cm-content': { caretColor: v('zinc-200') },
  '.cm-gutters': { backgroundColor: v('pane-card'), color: v('zinc-600'), border: 'none', fontSize: '11px' },
  '.cm-activeLine': { backgroundColor: v('zinc-50', 0.03) },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: v('zinc-400') },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: v('sky-500', 0.25) },
  '.cm-selectionMatch': { backgroundColor: v('sky-500', 0.12) },
  '.cm-change-gutter': { width: '3px', paddingLeft: '2px' },
  '.cm-searchMatch': { backgroundColor: v('sky-500', 0.2), outline: `1px solid ${v('sky-500', 0.4)}` },
  '.cm-panels': { backgroundColor: v('zinc-900'), color: v('zinc-200'), fontSize: '11px' },
  '.cm-panels input, .cm-panels button': { fontSize: '11px' },
  '.cm-tooltip': { backgroundColor: v('zinc-900'), color: v('zinc-200'), border: `1px solid ${v('zinc-700')}`, borderRadius: '8px', overflow: 'hidden' },
  '.cm-tooltip-hover': { maxWidth: '560px', maxHeight: '320px', overflow: 'auto' },
  '.cm-hover-doc': { padding: '6px 8px', fontSize: '11px', lineHeight: '1.5' },
  '.cm-hover-code': { margin: '0 0 4px', fontFamily: 'var(--font-mono)', fontSize: '11px', whiteSpace: 'pre-wrap', color: v('zinc-100') },
  '.cm-hover-text': { margin: '0 0 4px', whiteSpace: 'pre-wrap', color: v('zinc-300') },
  '&.cm-nav-mod .cm-content': { cursor: 'pointer' },
});

// Only theme scales: keywords and types in the accent, strings and numbers in
// its other shades, comments quiet. Enough to read code by; no rainbow.
const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.operatorKeyword, t.controlKeyword, t.definitionKeyword], color: v('sky-400') },
  { tag: [t.typeName, t.className, t.namespace, t.tagName], color: v('sky-300') },
  { tag: [t.string, t.special(t.string), t.regexp, t.attributeValue], color: v('sky-200') },
  { tag: [t.number, t.bool, t.null, t.atom], color: v('sky-300') },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: v('zinc-500'), fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.variableName)], color: v('zinc-100') },
  { tag: [t.propertyName, t.attributeName], color: v('zinc-300') },
  { tag: [t.punctuation, t.bracket, t.operator], color: v('zinc-400') },
  { tag: t.heading, color: v('zinc-100'), fontWeight: '600' },
  { tag: t.link, color: v('sky-400'), textDecoration: 'underline' },
]);

// The change gutter: a bar for added/modified lines, a notch where lines went.
const MARK_CLASS: Record<LineMark, string> = {
  added: 'cm-mark-added bg-emerald-500/80',
  modified: 'cm-mark-modified bg-amber-400/80',
  deleted: 'cm-mark-deleted bg-red-400/80',
};
class ChangeMarker extends GutterMarker {
  constructor(readonly kind: LineMark) { super(); }
  eq(other: ChangeMarker) { return other.kind === this.kind; }
  toDOM() {
    const el = document.createElement('div');
    el.className = `${MARK_CLASS[this.kind]} ${this.kind === 'deleted' ? 'h-0.5 mt-0' : 'h-full'} w-[3px] rounded-sm`;
    el.dataset.mark = this.kind;
    return el;
  }
}
const setMarks = StateEffect.define<FileMarks | null>();
const marksField = StateField.define<FileMarks | null>({
  create: () => null,
  update: (value, tr) => tr.effects.reduce((acc, e) => (e.is(setMarks) ? e.value : acc), value),
});
const changeGutter = gutter({
  class: 'cm-change-gutter',
  markers: (view) => {
    const builder = new RangeSetBuilder<GutterMarker>();
    const doc = view.state.doc;
    const byLine = lineMarks(view.state.field(marksField), doc.lines);
    for (const n of [...byLine.keys()].sort((a, b) => a - b)) {
      const line = doc.line(n);
      builder.add(line.from, line.from, new ChangeMarker(byLine.get(n)!));
    }
    return builder.finish();
  },
});

export type Selection = { from: number; to: number; text: string } | null;
/** 1-based, like the navigation routes. */
export type Pos = { line: number; col: number };
export type NavKind = 'definition' | 'references';

export type CodeView = {
  goToLine(line: number, col?: number): void;
  /** Where the cursor is (1-based). */
  cursor(): Pos;
  /** Jump to the next/previous change; returns the line it landed on, or null. */
  step(dir: 1 | -1): number | null;
  setMarks(marks: FileMarks | null): void;
  destroy(): void;
};

export async function createCodeView(parent: HTMLElement, o: {
  doc: string;
  path: string;
  language: string | null;
  marks: FileMarks | null;
  onSelection: (s: Selection) => void;
  /** ⌘/Ctrl-click or F12 (definition), ⇧F12 (references), at a 1-based position. */
  onNavigate?: (kind: NavKind, at: Pos) => void;
  /** The hover's markdown at a position, or null; aborted when a newer hover supersedes it. */
  hover?: (at: Pos, signal: AbortSignal) => Promise<string | null>;
}): Promise<CodeView> {
  const desc = (o.language && LanguageDescription.matchLanguageName(languages, o.language, true))
    || LanguageDescription.matchFilename(languages, o.path.split('/').pop() ?? o.path);
  const lang = desc ? await desc.load().catch(() => null) : null;

  let view: EditorView;
  const current = () => view.state.doc.lineAt(view.state.selection.main.head).number;
  const posOf = (offset: number): Pos => {
    const line = view.state.doc.lineAt(offset);
    return { line: line.number, col: offset - line.from + 1 };
  };
  const goToLine = (n: number, col = 1) => {
    const line = view.state.doc.line(Math.min(Math.max(1, n), view.state.doc.lines));
    const anchor = Math.min(line.from + Math.max(0, col - 1), line.to);
    view.dispatch({ selection: { anchor }, effects: EditorView.scrollIntoView(anchor, { y: 'center' }) });
  };
  const navigate = (kind: NavKind) => {
    if (!o.onNavigate) return false;
    o.onNavigate(kind, posOf(view.state.selection.main.head));
    return true;
  };
  // One hover in flight: a newer one cancels the older.
  let hoverAbort: AbortController | null = null;
  const hoverExt = o.hover ? hoverTooltip(async (_view, pos) => {
    hoverAbort?.abort();
    const ac = new AbortController();
    hoverAbort = ac;
    const md = await o.hover!(posOf(pos), ac.signal).catch(() => null);
    if (ac.signal.aborted || !md || !md.trim()) return null;
    return { pos, above: true, create: () => ({ dom: renderHover(md) }) };
  }, { hoverTime: 400 }) : [];
  const modClick = EditorView.domEventHandlers({
    mousedown(e, v) {
      if (!o.onNavigate || e.button !== 0 || !(e.metaKey || e.ctrlKey)) return false;
      const pos = v.posAtCoords({ x: e.clientX, y: e.clientY });
      if (pos == null) return false;
      e.preventDefault();
      v.dispatch({ selection: { anchor: pos } });
      o.onNavigate('definition', posOf(pos));
      return true;
    },
    keydown(e, v) { v.dom.classList.toggle('cm-nav-mod', e.metaKey || e.ctrlKey); return false; },
    keyup(e, v) { v.dom.classList.toggle('cm-nav-mod', e.metaKey || e.ctrlKey); return false; },
  });
  const step = (dir: 1 | -1) => {
    const to = stepChange(changeStarts(view.state.field(marksField)), current(), dir);
    if (to != null) goToLine(to);
    return to;
  };

  view = new EditorView({
    parent,
    state: EditorState.create({
      doc: o.doc,
      extensions: [
        EditorState.readOnly.of(true),
        lineNumbers(),
        marksField.init(() => o.marks),
        changeGutter,
        highlightActiveLine(),
        search({ top: true }),
        highlightSelectionMatches(),
        keymap.of([
          // Read-only, so plain letters are free: n/p walk the changes.
          { key: 'n', run: () => step(1) != null },
          { key: 'p', run: () => step(-1) != null },
          { key: 'F12', run: () => navigate('definition') },
          { key: 'Shift-F12', run: () => navigate('references') },
          ...searchKeymap,
        ]),
        hoverExt,
        modClick,
        syntaxHighlighting(highlight),
        theme,
        EditorView.lineWrapping,
        ...(lang ? [lang] : []),
        EditorView.updateListener.of((u) => {
          if (!u.selectionSet) return;
          const sel = u.state.selection.main;
          if (sel.empty) return o.onSelection(null);
          const from = u.state.doc.lineAt(sel.from).number;
          const to = u.state.doc.lineAt(sel.to).number;
          o.onSelection({ from, to, text: u.state.sliceDoc(sel.from, sel.to) });
        }),
      ],
    }),
  });

  return {
    goToLine,
    cursor: () => posOf(view.state.selection.main.head),
    step,
    setMarks: (marks) => view.dispatch({ effects: setMarks.of(marks) }),
    destroy: () => { hoverAbort?.abort(); view.destroy(); },
  };
}
