import fs from 'node:fs';
import path from 'node:path';

// A single combined, rolling debug log on the user's machine so we can debug
// a report without live access: server lifecycle plus a tagged line per
// worktree dev-server event. Lives at `${STRADO_LOG_DIR || ~/.strado/logs}/
// strado.log`; rotates to strado.log.1 at a size cap. Logging must never
// throw — a broken log file can't be allowed to take the server down.

export type DebugLog = {
  log(tag: string, message: string): void;
  path: string;
};

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024; // 5 MB, then rotate (keep one old file)

export function createDebugLog(logDir: string, opts: { maxBytes?: number } = {}): DebugLog {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const filePath = path.join(logDir, 'strado.log');
  let bytes = 0;
  try {
    fs.mkdirSync(logDir, { recursive: true });
    bytes = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
  } catch {
    // if we can't even prepare the dir, log() will keep failing silently
  }

  function rotate(): void {
    try {
      fs.renameSync(filePath, `${filePath}.1`); // overwrites the previous .1
    } catch {
      // nothing to rotate, or rename failed — keep appending to the current file
    }
    bytes = 0;
  }

  function log(tag: string, message: string): void {
    // one physical line per call; collapse embedded newlines so a multi-line
    // chunk stays greppable as a single tagged record
    const line = `${new Date().toISOString()} [${tag}] ${message.replace(/\r?\n/g, ' ')}\n`;
    const size = Buffer.byteLength(line);
    try {
      if (bytes + size > maxBytes) rotate();
      fs.appendFileSync(filePath, line);
      bytes += size;
    } catch {
      // never throw from logging
    }
  }

  return { log, path: filePath };
}
