// Runs countMatches for findPanel.ts, so a slow regex never blocks the page.
import { countMatches, type FindSpec } from './findCount';

self.onmessage = (e: MessageEvent<{ id: number; doc: string; q: FindSpec }>) => {
  const { id, doc, q } = e.data;
  (self as unknown as Worker).postMessage({ id, result: countMatches(doc, q) });
};
