/** Pure text helpers for showing PTY output to a human or an agent. Nothing
 * here is a terminal emulator: escapes are removed, not interpreted, and the
 * result is a best-effort plain-text view — good enough for previews and for
 * an agent reading a peer tab, and deliberately never used by handoffs. */

/** Remove ANSI escapes and control bytes; apply carriage-return overwrites; CRLF → LF. */
export function stripAnsi(text: string): string {
  return text
    // OSC sequences (titles, hyperlinks), then CSI/other escapes
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[0-9A-Za-z]/g, '')
    .replace(/\x1b[()][0-9A-Za-z]/g, '')
    .replace(/\x1b[=>]/g, '')
    // carriage-return overwrites: keep what the terminal would show
    .replace(/^.*\r(?!\n)/gm, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

/** The last `max` non-blank lines of a buffer, right-trimmed, each capped at 200 chars. */
export function peekLines(buffer: string, max: number): string[] {
  return stripAnsi(buffer)
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(-max)
    .map((line) => (line.length > 200 ? `${line.slice(0, 200)}…` : line));
}

/** Keep at most `max` UTF-8 bytes from the end of `text`; when something was
 * cut, prefix `marker`. Never starts inside a multi-byte sequence. */
export function tailBytes(text: string, max: number, marker: string): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= max) return text;
  let start = buf.length - max;
  while (start < buf.length && ((buf[start] ?? 0) & 0xc0) === 0x80) start += 1;
  return marker + buf.subarray(start).toString('utf8');
}
