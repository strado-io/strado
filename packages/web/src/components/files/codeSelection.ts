// The code view's selection, readable without loading CodeMirror: codeView
// (imported lazily) registers each editor's element here, so the Files tab's
// ⌘⇧F can seed its search from the selection while CodeMirror stays out of
// the main bundle.
const readers = new WeakMap<Element, () => string>();

export function registerSelection(editor: Element, read: () => string): void {
  readers.set(editor, read);
}

/** The selected text of the editor in `root` (its .cm-editor), or ''. */
export function selectionIn(root: Element | null | undefined): string {
  const editor = root?.querySelector('.cm-editor');
  return (editor && readers.get(editor)?.()) ?? '';
}
