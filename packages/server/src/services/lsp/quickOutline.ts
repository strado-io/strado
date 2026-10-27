// A JS/TS file's outline from its declarations, by pattern: what the outline
// shows at once, while the language server is still loading the project
// (~10 s on a big app), then the server's own replaces it. Top-level
// declarations, and a class's methods under it.
import { promises as fs } from 'node:fs';
import { isJsLike } from './importDefinition.js';
import type { OutlineSymbol } from './types.js';

const TOP = /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(function\s*\*?|class|const|let|var|type|interface|enum)\s+([A-Za-z_$][\w$]*)/;
const METHOD = /^\s+(?:(?:public|private|protected|static|async|get|set|readonly|override|abstract)\s+)*\*?\s*([A-Za-z_$#][\w$]*)\s*(?:<[^>]*>)?\s*\([^)]*\)?[^;=]*\{\s*$/;
const FIELD_FN = /^\s+(?:(?:public|private|protected|static|readonly)\s+)*([A-Za-z_$#][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/;
const NOT_METHOD = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'else', 'do', 'try', 'with']);
/** A const holding a function reads as one. */
const ARROW = /=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/;

const KIND: Record<string, string> = {
  function: 'func', class: 'class', const: 'const', let: 'var', var: 'var', type: 'type', interface: 'interface', enum: 'enum',
};

/** The outline, or null when this file is not JS/TS (or unreadable). */
export async function quickOutline(abs: string): Promise<OutlineSymbol[] | null> {
  if (!isJsLike(abs)) return null;
  const text = await fs.readFile(abs, 'utf8').catch(() => null);
  if (text === null) return null;
  const out: OutlineSymbol[] = [];
  let klass: OutlineSymbol | null = null;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const top = TOP.exec(line);
    if (top) {
      const word = top[1]!.startsWith('function') ? 'function' : top[1]!;
      const kind = word === 'const' && ARROW.test(line) ? 'func' : KIND[word]!;
      const sym: OutlineSymbol = { name: top[2]!, kind, line: i + 1, col: line.indexOf(top[2]!) + 1 };
      out.push(sym);
      klass = kind === 'class' ? sym : null;
      continue;
    }
    // A closing brace at the margin ends the class.
    if (klass && /^\}/.test(line)) { klass = null; continue; }
    if (!klass) continue;
    const m = METHOD.exec(line) ?? FIELD_FN.exec(line);
    if (!m || NOT_METHOD.has(m[1]!)) continue;
    (klass.children ??= []).push({ name: m[1]!, kind: m[1] === 'constructor' ? 'constructor' : 'method', line: i + 1, col: line.indexOf(m[1]!) + 1 });
  }
  return out;
}
