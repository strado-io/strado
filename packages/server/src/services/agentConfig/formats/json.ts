import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser';
import type { FormatDriver, Path } from '../types.js';

export class ConfigParseError extends Error {
  detail: string;
  constructor(detail: string) {
    super(`config file is not valid JSON: ${detail}`);
    this.name = 'ConfigParseError';
    this.detail = detail;
  }
}

const FORMATTING = { formattingOptions: { insertSpaces: true, tabSize: 2 } };

function rootOf(text: string): unknown {
  if (text.trim() === '') return {};
  const errors: ParseError[] = [];
  const root = parse(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    const first = errors[0]!;
    throw new ConfigParseError(`parse error code ${first.error} at offset ${first.offset}`);
  }
  return root;
}

export const jsonDriver: FormatDriver = {
  get(text: string, path: Path): unknown {
    let node = rootOf(text);
    for (const key of path) {
      if (node == null || typeof node !== 'object') return undefined;
      node = (node as Record<string | number, unknown>)[key];
    }
    return node;
  },

  set(text: string, path: Path, value: unknown): string {
    const base = text.trim() === '' ? '{}' : text;
    rootOf(base); // refuse to patch a file we could not parse
    return applyEdits(base, modify(base, path, value, FORMATTING));
  },

  remove(text: string, path: Path): string {
    const base = text.trim() === '' ? '{}' : text;
    rootOf(base);
    return applyEdits(base, modify(base, path, undefined, FORMATTING));
  },
};
