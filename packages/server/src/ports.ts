import net from 'node:net';
import { AppError } from './errors.js';

const MAX_OFFSET = 200;
const PRIVILEGED_FALLBACK_BASE = 8000;

export async function findFreePort(
  base: number,
  reserved: Set<number>,
  // A stopped instance leaves its own port bindable, so a worktree dev server
  // could take it and block the next launch. Treat it as reserved always.
  selfPort: number = Number(process.env.PORT ?? 7777),
): Promise<number> {
  const blocked = Number.isInteger(selfPort) ? new Set([...reserved, selfPort]) : reserved;
  // Privileged ports (< 1024) can't be bind-tested as a non-root process on macOS/Linux.
  // Trust the configured base if no other worktree has reserved it; otherwise fall back
  // to scanning a non-privileged range.
  if (base < 1024) {
    if (!blocked.has(base)) return base;
    return scan(PRIVILEGED_FALLBACK_BASE, blocked);
  }
  return scan(base, blocked);
}

async function scan(base: number, reserved: Set<number>): Promise<number> {
  for (let offset = 0; offset <= MAX_OFFSET; offset++) {
    const candidate = base + offset;
    if (reserved.has(candidate)) continue;
    if (await isFree(candidate)) return candidate;
  }
  throw new AppError('PORT_IN_USE', `no free port near ${base}`);
}

function isFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
}
