// A hover's markdown, shown safely: text stays text (never parsed as HTML),
// fenced code becomes a <pre>. Enough for what language servers send
// (a signature in a code fence, then prose).
export type HoverPart = { kind: 'code'; text: string } | { kind: 'text'; text: string };

export function hoverParts(md: string): HoverPart[] {
  const parts: HoverPart[] = [];
  const re = /```[^\n]*\n([\s\S]*?)```/g;
  let last = 0;
  for (let m = re.exec(md); m; m = re.exec(md)) {
    const before = md.slice(last, m.index).trim();
    if (before) parts.push({ kind: 'text', text: plain(before) });
    parts.push({ kind: 'code', text: m[1]!.replace(/\n$/, '') });
    last = m.index + m[0].length;
  }
  const rest = md.slice(last).trim();
  if (rest) parts.push({ kind: 'text', text: plain(rest) });
  return parts;
}

/** Markdown decoration dropped, the words kept: `code`, **bold**, _em_, [label](url), escapes. */
function plain(s: string): string {
  return s
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=[^\w*]|$)/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\\([\\`*_{}[\]()#+\-.!|<>])/g, '$1')
    .replace(/\n{3,}/g, '\n\n');
}

/** The tooltip's DOM, built with textContent only. */
export function renderHover(md: string): HTMLElement {
  const box = document.createElement('div');
  box.className = 'cm-hover-doc';
  for (const part of hoverParts(md)) {
    const el = document.createElement(part.kind === 'code' ? 'pre' : 'p');
    el.className = part.kind === 'code' ? 'cm-hover-code' : 'cm-hover-text';
    el.textContent = part.text;
    box.append(el);
  }
  return box;
}
