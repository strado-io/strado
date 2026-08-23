import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { parseKbFileQuery } from '../../src/routes/knowledgeBase';

describe('parseKbFileQuery', () => {
  it('accepts a relative file path', () => {
    expect(parseKbFileQuery({ file: 'docs/a.md' })).toEqual({ file: 'docs/a.md' });
  });

  it('rejects a missing or empty file param', () => {
    // Asserting the exact error type, not just "throws": app.ts keys its 400
    // response off `instanceof ZodError` (see app.ts:122) — anything else
    // degrades a bad `?file=` into a 500 SHELL_FAILED instead of 400.
    expect(() => parseKbFileQuery({})).toThrow(ZodError);
    expect(() => parseKbFileQuery({ file: '' })).toThrow(ZodError);
  });

  it('rejects a non-string file param', () => {
    expect(() => parseKbFileQuery({ file: ['a.md'] })).toThrow(ZodError);
  });
});
