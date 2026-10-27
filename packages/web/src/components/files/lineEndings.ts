// A file's line endings, so an edit keeps them: CodeMirror joins lines with
// "\n" unless told the separator. One kind throughout is editable (LF, or
// CRLF with that separator); a mix (or a lone CR) can't round-trip, so it is
// read-only.
export type LineEndings = 'lf' | 'crlf' | 'mixed';

export function lineEndings(text: string): LineEndings {
  let crlf = 0;
  let lf = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 13) {
      if (text.charCodeAt(i + 1) !== 10) return 'mixed'; // a lone CR
      crlf++;
      i++;
    } else if (c === 10) {
      lf++;
    }
    if (crlf && lf) return 'mixed';
  }
  return crlf ? 'crlf' : 'lf';
}
