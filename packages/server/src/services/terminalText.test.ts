import { describe, expect, it } from 'vitest';
import { peekLines, stripAnsi, tailBytes } from './terminalText.js';

describe('stripAnsi', () => {
  it('drops CSI colours and cursor moves, OSC titles, charset selects, and control bytes; keeps text, tabs and newlines', () => {
    const raw = '\x1b]0;title\x07\x1b[31mred\x1b[0m\x1b[2K\x1b(B\x1b=\ta\x07b\r\n';
    expect(stripAnsi(raw)).toBe('red\tab\n');   // the bell (\x07) is a control byte and goes too
  });

  it('keeps only what a carriage-return overwrite would leave visible', () => {
    expect(stripAnsi('12%\r45%\r100%\r\n')).toBe('100%\n');
  });

  it('turns CRLF into LF', () => {
    expect(stripAnsi('one\r\ntwo\r\n')).toBe('one\ntwo\n');
  });
});

describe('peekLines', () => {
  it('returns the last N non-blank lines, right-trimmed, each capped at 200 chars with an ellipsis', () => {
    const buffer = ['first   ', '', '   ', 'second', 'x'.repeat(250)].join('\r\n');
    expect(peekLines(buffer, 2)).toEqual(['second', `${'x'.repeat(200)}…`]);
    expect(peekLines(buffer, 10)).toEqual(['first', 'second', `${'x'.repeat(200)}…`]);
  });

  it('is empty for an empty or all-escape buffer', () => {
    expect(peekLines('', 5)).toEqual([]);
    expect(peekLines('\x1b[2J\x1b[H', 5)).toEqual([]);
  });
});

describe('tailBytes', () => {
  it('returns the text unchanged when it fits', () => {
    expect(tailBytes('abc', 3, 'M')).toBe('abc');
  });

  it('keeps the last max bytes and prefixes the marker', () => {
    expect(tailBytes('abcdef', 4, '>')).toBe('>cdef');
  });

  it('never splits a multi-byte character', () => {
    // 'é' is 2 bytes; a 3-byte cut would start inside the second 'é'.
    expect(tailBytes('aéé', 3, '>')).toBe('>é');
  });
});
