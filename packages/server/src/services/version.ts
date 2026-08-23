// Compares dotted numeric versions ("0.2.0" > "0.1.9"). Suffixes like
// "-beta" are out of scope (our versions are plain x.y.z) — parseInt reads
// only the leading number of each segment, so a suffix is ignored.
export function isNewer(current: string, latest: string): boolean {
  const parse = (v: string) => v.split('.').map((p) => parseInt(p, 10) || 0);
  const a = parse(current);
  const b = parse(latest);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (b[i] ?? 0) - (a[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}
