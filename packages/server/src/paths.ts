import path from 'node:path';
import { AppError } from './errors.js';

export function assertPathUnder(target: string, allowedRoots: string[]): void {
  const resolved = path.resolve(target);
  for (const root of allowedRoots) {
    const resolvedRoot = path.resolve(root);
    if (resolved === resolvedRoot) return;
    const withSep = resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep;
    if (resolved.startsWith(withSep)) return;
  }
  // Message is deliberately caller-independent: it reaches the client verbatim via
  // toResponse, and must not leak host filesystem paths. The real target/allowedRoots
  // still go in `details` for server-side logging (toResponse strips details for this code).
  throw new AppError('PATH_FORBIDDEN', 'path is not under an allowed root', {
    target,
    allowedRoots,
  });
}

export function encodePath(p: string): string {
  return encodeURIComponent(p);
}

export function decodePath(p: string): string {
  return decodeURIComponent(p);
}
