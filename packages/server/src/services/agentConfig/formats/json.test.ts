import { describe, it, expect } from 'vitest';
import { jsonDriver, ConfigParseError } from './json.js';

describe('jsonDriver', () => {
  it('reads a nested path', () => {
    const text = '{"mcpServers":{"figma":{"url":"http://x"}}}';
    expect(jsonDriver.get(text, ['mcpServers', 'figma', 'url'])).toBe('http://x');
  });

  it('returns undefined for a missing path instead of throwing', () => {
    expect(jsonDriver.get('{}', ['a', 'b'])).toBeUndefined();
  });

  it('treats empty text as an empty object', () => {
    expect(jsonDriver.get('', ['a'])).toBeUndefined();
    expect(jsonDriver.set('', ['a'], 1)).toContain('"a"');
  });

  it('throws ConfigParseError on malformed input', () => {
    expect(() => jsonDriver.get('{ not json', ['a'])).toThrow(ConfigParseError);
  });

  it('preserves comments and unrelated keys when setting', () => {
    const text = [
      '{',
      '  // keep me',
      '  "model": "opus-5",',
      '  "env": { "A": "1" }',
      '}',
    ].join('\n');
    const out = jsonDriver.set(text, ['env', 'B'], '2');
    expect(out).toContain('// keep me');
    expect(out).toContain('"model": "opus-5"');
    expect(out).toContain('"A": "1"');
    expect(jsonDriver.get(out, ['env', 'B'])).toBe('2');
  });

  it('is idempotent — setting the same value twice yields identical text', () => {
    const text = '{"env":{"A":"1"}}';
    const once = jsonDriver.set(text, ['env', 'A'], '2');
    expect(jsonDriver.set(once, ['env', 'A'], '2')).toBe(once);
  });

  it('removes a key entirely rather than leaving an empty object', () => {
    const text = '{"mcpServers":{"a":{"url":"x"},"b":{"url":"y"}}}';
    const out = jsonDriver.remove(text, ['mcpServers', 'a']);
    expect(jsonDriver.get(out, ['mcpServers', 'a'])).toBeUndefined();
    expect(jsonDriver.get(out, ['mcpServers', 'b', 'url'])).toBe('y');
  });
});
