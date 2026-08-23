// Shared by the KB panel's over-cap read error and MarkdownView's oversized
// notice — both describe the same byte count to the user, and disagreeing
// KiB/decimal-KB math between them (1 file, two different numbers on
// adjacent messages) reads as a bug even when neither number is wrong.
export function formatBytes(n: number): string {
  return n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
}
