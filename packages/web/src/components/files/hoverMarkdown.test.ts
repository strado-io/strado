import { describe, expect, it } from 'vitest';
import { hoverParts, renderHover } from './hoverMarkdown';

describe('hover markdown', () => {
  it('a fenced signature becomes code; the prose loses its markdown but keeps its words', () => {
    const md = '```typescript\nfunction open(path: string): void\n```\nOpens **the** file at `path`. See [docs](https://x.test).';
    expect(hoverParts(md)).toEqual([
      { kind: 'code', text: 'function open(path: string): void' },
      { kind: 'text', text: 'Opens the file at path. See docs.' },
    ]);
  });
  it('never turns text into HTML', () => {
    const el = renderHover('<img src=x onerror="alert(1)"> and ```\n<script>bad()</script>\n```');
    expect(el.querySelector('img, script')).toBeNull();
    expect(el.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(el.querySelector('pre')!.textContent).toBe('<script>bad()</script>');
  });
  it('plain text alone is one part', () => {
    expect(hoverParts('just words')).toEqual([{ kind: 'text', text: 'just words' }]);
    expect(hoverParts('   ')).toEqual([]);
  });
});
