// "Open in editor": which desktop editor this machine hands files to, shared by
// every button that offers it (Files, the hover card, the ⋯ menu, Settings).
// Loaded once per page; a new preference reaches every user of the hook.
import { useEffect, useState } from 'react';
import { api } from '../api';
import type { EditorId, EditorStatus, EditorsAnswer, OpenInEditorBody } from '../types';

export const OPEN_IN_EDITOR_FAILED = "Couldn't open the editor";

const SYSTEM: EditorStatus = { id: 'system', label: 'Default app', available: true, lines: false };

/** The person's choice when it is installed; else the first installed editor; else the OS default app. */
export function chosenEditor(a: EditorsAnswer): EditorStatus {
  const ok = a.editors.filter((e) => e.available);
  return ok.find((e) => e.id === a.preferred) ?? ok.find((e) => e.id !== 'system') ?? ok.find((e) => e.id === 'system') ?? SYSTEM;
}

let cache: Promise<EditorsAnswer | null> | null = null;
let current: EditorsAnswer | null = null;
const listeners = new Set<(a: EditorsAnswer | null) => void>();

function load(force = false): Promise<EditorsAnswer | null> {
  if (!cache || force) {
    cache = api.editors.list().then(
      (a) => { current = a; for (const l of listeners) l(a); return a; },
      () => null,
    );
  }
  return cache;
}

/** For tests. */
export function resetEditorsCache(): void {
  cache = null;
  current = null;
}

export function useEditors(): { answer: EditorsAnswer | null; chosen: EditorStatus | null; loaded: boolean } {
  const [answer, setAnswer] = useState<EditorsAnswer | null>(current);
  const [loaded, setLoaded] = useState(current !== null);
  useEffect(() => {
    let alive = true;
    listeners.add(setAnswer);
    void load().then((a) => { if (alive) { setAnswer(a); setLoaded(true); } });
    return () => { alive = false; listeners.delete(setAnswer); };
  }, []);
  return { answer, chosen: answer ? chosenEditor(answer) : null, loaded };
}

/** Saves the choice (null = automatic) and refreshes everyone's view of it. */
export async function setPreferredEditor(editor: EditorId | null): Promise<void> {
  await api.editors.setPreferred(editor);
  await load(true);
}

/** Opens a worktree (no path) or a file at a line. Fails with one fixed message. */
export async function openInEditor(wsId: string, body: OpenInEditorBody): Promise<void> {
  try {
    await api.editors.open(wsId, body);
  } catch {
    throw new Error(OPEN_IN_EDITOR_FAILED);
  }
}
