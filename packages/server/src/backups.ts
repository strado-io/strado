import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

// Rotating safety net for the JSON stores now that config/ is out of git:
// before a store overwrites a file, the current version is copied into a
// sibling .backups/ dir. Throttled so state.json's constant writes don't
// churn, pruned so it never grows unbounded, and always best-effort — a
// failed backup must never block the real write.
const DEFAULT_KEEP = 10;
const DEFAULT_MIN_INTERVAL_MS = 5 * 60_000;

export async function backupBeforeWrite(
  filePath: string,
  opts: { keep?: number; minIntervalMs?: number } = {},
): Promise<void> {
  const keep = opts.keep ?? DEFAULT_KEEP;
  const minIntervalMs = opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  try {
    if (!fs.existsSync(filePath)) return;
    const dir = path.join(path.dirname(filePath), '.backups');
    const base = path.basename(filePath);
    await fsp.mkdir(dir, { recursive: true });

    const entries = (await fsp.readdir(dir))
      .filter((f) => f.startsWith(`${base}.`))
      .sort(); // timestamp-prefixed names sort chronologically

    if (entries.length > 0) {
      const newest = path.join(dir, entries[entries.length - 1]!);
      const stat = await fsp.stat(newest).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs < minIntervalMs) return;
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await fsp.copyFile(filePath, path.join(dir, `${base}.${stamp}`));

    const all = (await fsp.readdir(dir)).filter((f) => f.startsWith(`${base}.`)).sort();
    for (const stale of all.slice(0, Math.max(0, all.length - keep))) {
      await fsp.unlink(path.join(dir, stale)).catch(() => undefined);
    }
  } catch {
    // best-effort only
  }
}
