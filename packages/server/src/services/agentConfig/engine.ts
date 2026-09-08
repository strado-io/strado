import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { jsonDriver, ConfigParseError } from './formats/json.js';
import { dirDriver } from './formats/dir.js';
import { resolveTarget, resolvePath, type ResolveCtx } from './targets.js';
import type { AgentDescriptor, Scope, ScopeTarget, Surface, SurfaceValue } from './types.js';
import { backupBeforeWrite } from '../../backups.js';
import { AppError } from '../../errors.js';
import { addGitExclude } from '../gitExclude.js';

async function readText(file: string): Promise<string | null> {
  return fsp.readFile(file, 'utf8').catch(() => null);
}

type Read = { value: unknown; exists: boolean; error?: string };

// `target.path` may contain a `'<worktree>'` placeholder segment (e.g.
// `mcp-approved`'s `['projects', '<worktree>']`, since `~/.claude.json` keys
// its `projects` map by absolute project path). Always resolve it through
// `resolvePath` before handing it to the format driver — passing
// `target.path` straight through would look up the literal string
// '<worktree>' instead of this project's entry.
async function readTarget(target: ScopeTarget, file: string, ctx: ResolveCtx): Promise<Read> {
  if (target.format === 'dir') {
    const stat = await fsp.stat(file).catch(() => null);
    if (!stat) return { value: undefined, exists: false };
    if (!stat.isDirectory()) {
      return { value: undefined, exists: true, error: `${file} exists but is not a directory` };
    }
    // `dirDriver.list` swallows every readdir failure (ENOENT, EACCES, ...)
    // into `[]` — that's the right contract for a "does this dir have
    // skills" caller, but it makes an unreadable directory look identical
    // to an empty one here. Probe readdir ourselves first so a permission
    // error surfaces as `error` instead of a silent empty list.
    try {
      await fsp.readdir(file);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return { value: undefined, exists: true, error: `could not read ${file}: ${detail}` };
    }
    const entries = await dirDriver.list(file);
    return { value: entries, exists: true };
  }
  const text = await readText(file);
  if (text == null) return { value: undefined, exists: false };
  if (target.format === 'text') return { value: text, exists: true };
  // 'json' and 'jsonc' share one driver here — `jsonDriver` is already
  // backed by `jsonc-parser` and tolerates comments/trailing commas either
  // way — so reaching this point for either format is the two formats'
  // declared contract, not an accidental fallthrough.
  try {
    return { value: jsonDriver.get(text, resolvePath(target, ctx)), exists: true };
  } catch (err) {
    if (err instanceof ConfigParseError) return { value: undefined, exists: true, error: err.message };
    throw err;
  }
}

function targetFor(surface: Surface, scope: Scope): ScopeTarget | undefined {
  return scope === 'global' ? surface.global : surface.project;
}

export async function readSurfaces(
  descriptor: AgentDescriptor,
  scope: Scope,
  ctx: ResolveCtx,
): Promise<SurfaceValue[]> {
  const out: SurfaceValue[] = [];
  for (const surface of descriptor.surfaces) {
    const target = targetFor(surface, scope);
    if (!target) continue;

    const file = resolveTarget(target, ctx);
    const primary = await readTarget(target, file, ctx);

    let inheritedValue: unknown;
    let inheritedError: string | undefined;
    if (scope === 'project' && surface.global) {
      const globalFile = resolveTarget(surface.global, ctx);
      const globalRead = await readTarget(surface.global, globalFile, ctx);
      inheritedValue = globalRead.value;
      inheritedError = globalRead.error;
    }

    const source: SurfaceValue['source'] =
      primary.value !== undefined ? 'set' : inheritedValue !== undefined ? 'inherited' : 'unset';

    out.push({
      id: surface.id,
      label: surface.label,
      group: surface.group,
      kind: surface.kind,
      readOnly: surface.readOnly ?? false,
      options: surface.options,
      value: primary.value,
      inheritedValue,
      inheritedError,
      source,
      file,
      exists: primary.exists,
      error: primary.error,
    });
  }
  return out;
}

// One promise chain per (resolved) file. Two surfaces in the same
// settings.json patched concurrently would otherwise both read the original
// text, and the second write would drop the first one's key.
const locks = new Map<string, Promise<unknown>>();

function withFileLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(file) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(file, next.catch(() => undefined));
  return next;
}

// Symlinks are followed by policy (see targets.ts assertAllowedFile): a
// declared config file being a symlink (dotfiles managed by chezmoi/stow/
// yadm, say) is legitimate, and the write must land on — and preserve the
// mode of — whatever it points to, never replace a link itself with a
// plain file.
//
// `realpath` handles a *live* symlink or chain (every segment resolves to
// something that exists), but it throws ENOENT for a *dangling* one — a
// chain where the final target doesn't exist yet, the common "first write
// into a not-yet-materialized dotfiles tree" case. A single-hop fallback
// (readlink once, use that) is not enough: for a chain `outer -> mid ->
// nonexistent`, `readlink(outer)` returns `mid`'s path, but `mid` is itself
// a symlink — writing there would replace *that* intermediate link with a
// plain file, the same class of bug as replacing `outer` directly, just one
// hop removed. So walk the chain by hand, one `lstat`+`readlink` hop at a
// time, until we reach something that either doesn't exist or isn't a
// symlink — depth-capped and cycle-checked so a circular chain (`a -> b ->
// a`) is refused with a clear error instead of spinning forever.
const MAX_SYMLINK_DEPTH = 32;

// Exported so a second caller writing a whole file by its declared path (the
// raw-file route) resolves the SAME symlink policy `writeSurface` does below,
// rather than a second, realpath-based resolution of its own: a realpath-based
// resolution (a) throws outright on a dangling symlink instead of walking its
// chain, so a write would land on the link itself and destroy it, and (b)
// normalizes any symlinked ANCESTOR directory too whenever it runs at all —
// this function only reaches `realpath` when the DECLARED PATH ITSELF is a
// symlink (the guard at :154 below); given a plain, non-symlink path, it is
// returned completely untouched, ancestors included. A resolution that
// always normalizes ancestors would compute a different string — hence a
// different `withFileLock` key — for the identical plain file a
// `writeSurface` patch is locking under, letting the two race each other
// undetected.
export async function resolveWriteTarget(declaredFile: string): Promise<string> {
  // Only engage symlink resolution — including `realpath`, which normalizes
  // every symlink along the *entire* path, not just a final symlink
  // component — when the declared path is itself actually a symlink. A
  // plain regular file must come back completely untouched: on macOS
  // `$TMPDIR` (and hence every `os.tmpdir()`-based worktree in tests) lives
  // under `/var`, itself a symlink to `/private/var`, so calling `realpath`
  // unconditionally here silently rewrote `file` to a `/private/var/...`
  // path that no longer matched `ctx.worktree` for callers that compare the
  // two textually (the git-exclude relative-path computation below).
  const lst = await fsp.lstat(declaredFile).catch(() => null);
  if (!lst || !lst.isSymbolicLink()) return declaredFile;

  const real = await fsp.realpath(declaredFile).catch(() => null);
  if (real) return real;

  let current = declaredFile;
  const seen = new Set<string>();
  for (let depth = 0; depth < MAX_SYMLINK_DEPTH; depth++) {
    if (seen.has(current)) throw eloop(`circular symlink at ${current}`);
    seen.add(current);

    const l = await fsp.lstat(current).catch(() => null);
    if (!l || !l.isSymbolicLink()) return current;

    const linkTarget = await fsp.readlink(current);
    current = path.resolve(path.dirname(current), linkTarget);
  }
  throw eloop(`too many levels of symlinks resolving ${declaredFile}`);
}

function eloop(message: string): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = 'ELOOP';
  return err;
}

// Best-effort `realpath`: resolves as much of `p` as actually exists on
// disk, then rejoins any nonexistent tail lexically, rather than giving up
// entirely the moment the final component doesn't exist yet (plain
// `fsp.realpath` requires the *whole* path to exist). This matters for a
// project-scope write whose target hasn't been created yet (a dangling
// symlink's target, or a brand-new file whose parent directories were just
// `mkdir -p`'d): the parent still needs its ancestor symlinks (e.g. macOS's
// `/var` -> `/private/var`) normalized so it lands in the same namespace as
// `ctx.worktree` below.
async function realpathBestEffort(p: string): Promise<string> {
  let existing = p;
  const tail: string[] = [];
  for (;;) {
    const real = await fsp.realpath(existing).catch(() => null);
    if (real) return tail.length ? path.join(real, ...tail) : real;
    const parent = path.dirname(existing);
    if (parent === existing) return p; // reached the filesystem root, nothing resolved
    tail.unshift(path.basename(existing));
    existing = parent;
  }
}

function toWriteError(err: unknown, surfaceId: string): unknown {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'EISDIR') {
    return new AppError('VALIDATION', `${surfaceId}'s config file exists but is a directory, not a file`);
  }
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
    return new AppError('VALIDATION', `${surfaceId}'s config file could not be written (permission denied)`);
  }
  if (code === 'ELOOP') {
    return new AppError('VALIDATION', `${surfaceId}'s config path is a circular or excessively deep symlink chain`);
  }
  return err;
}

// Project-scope backups land inside the user's repo (e.g.
// `<worktree>/.claude/.backups`), which would otherwise pollute `git
// status`. Same fix claudeHooks.ts already applies to settings.local.json:
// git-exclude it. Best-effort — a failure here must never fail the write
// itself. Lives inside `commitWrite` (not each caller) so both write paths —
// `writeSurface`'s JSON patch and `writeFileGuarded`'s whole-file replace —
// share it by construction rather than by remembering to call it: the raw-
// file route used to skip this entirely, leaving an untracked
// `.backups` behind whenever it repaired a broken project config.
//
// `file` and `worktree` are not reliably in the same namespace: `file` only
// goes through `realpath` inside `resolveWriteTarget` when the declared
// config path is itself a symlink (the actual chezmoi/stow/yadm dotfiles
// case the follow-symlinks policy exists for) — a plain regular file is
// deliberately left untouched (see that guard's own comment). `worktree`,
// meanwhile, is whatever the caller handed us, unresolved. On macOS `/var`
// is a symlink to `/private/var`, so a worktree under `os.tmpdir()` means
// either side can independently be in the resolved or unresolved namespace
// depending on whether a symlink was involved — comparing them textually
// without normalizing BOTH consistently silently no-ops this whole
// function for exactly the symlinked-config case, or (if only one side is
// naively resolved) for the plain case instead. Route both through the
// same best-effort resolution so they always land in one namespace,
// regardless of which files happen to exist yet.
async function gitExcludeBackups(file: string, worktree: string | undefined): Promise<void> {
  if (!worktree) return;
  const [fileReal, worktreeReal] = await Promise.all([
    realpathBestEffort(file),
    realpathBestEffort(worktree),
  ]);
  if (!fileReal.startsWith(worktreeReal + path.sep)) return;
  const rel = path.relative(worktreeReal, path.join(path.dirname(fileReal), '.backups'));
  await addGitExclude(worktree, `${rel}/`).catch(() => undefined);
}

// Backup, mode-preservation (or 0600 for a brand-new file), atomic replace,
// and (for a project-scope file) git-excluding its `.backups` directory —
// the write-safety properties every caller of this module needs, regardless
// of whether it's patching one JSON key (`writeSurface`, below) or replacing
// a file's entire contents (`writeFileGuarded`, exported for the raw-file
// route). Must run INSIDE the caller's own `withFileLock` — it takes no
// lock itself, so nesting two calls for the same file would deadlock
// against `withFileLock`'s per-file promise chain.
async function commitWrite(file: string, text: string, worktree?: string): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await backupBeforeWrite(file, { minIntervalMs: 0 });
  // Preserve the target's existing mode (some of these files are 0600, e.g.
  // ~/.claude.json holding OAuth credentials, or an MCP server's `env` block
  // holding API keys); a brand-new file defaults to 0600 rather than a
  // world-readable 0644, since we can't know in advance whether this
  // surface's file is sensitive.
  const mode = await fsp.stat(file).then((s) => s.mode & 0o777).catch(() => 0o600);
  await writeAtomic(file, text, mode);
  await gitExcludeBackups(file, worktree);
}

// Whole-file write with the same lock/backup/atomic-write/mode-preservation
// (and, given a `worktree`, git-exclude) guarantees as `writeSurface`, for a
// caller replacing a file's entire contents rather than patching one JSON
// path — the raw-file route. Takes its own lock (unlike `commitWrite`), so
// this is the one callers outside this module should reach for.
export async function writeFileGuarded(file: string, text: string, worktree?: string): Promise<void> {
  return withFileLock(file, () => commitWrite(file, text, worktree));
}

async function writeAtomic(file: string, text: string, mode: number): Promise<void> {
  // The temp name no longer depends on `Date.now()` alone (three writers in
  // the same millisecond really did collide on it) — uniqueness now comes
  // from `randomUUID`, decoupled from whatever provides serialization.
  const tmp = `${file}.strado-tmp-${process.pid}-${crypto.randomUUID()}`;
  const handle = await fsp.open(tmp, 'w', mode);
  try {
    await handle.writeFile(text);
    // Flush to disk before the rename that makes this the canonical file.
    // This does not make the directory-entry update itself durable across a
    // full power loss (that would need an fsync on the directory too), but
    // it does ensure the temp file's contents are safely on disk before we
    // ever point the real filename at it — the property this feature
    // actually needs: no reader ever observes a truncated or garbage
    // config.
    await handle.sync();
  } finally {
    await handle.close();
  }
  // `open`'s mode argument is masked by the process umask (open(2)
  // semantics) — a `0666` request comes back `0644` under a `022` umask. It
  // only ever serves as a floor, so `chmod` afterwards to pin the exact mode
  // we intend (the original file's, or 0600 for a brand-new one).
  await fsp.chmod(tmp, mode);
  try {
    await fsp.rename(tmp, file);
  } catch (err) {
    // A crash or error here must not leave `<file>.strado-tmp-*` behind
    // forever, accumulating beside the user's config.
    await fsp.unlink(tmp).catch(() => undefined);
    throw err;
  }
}

export async function writeSurface(
  descriptor: AgentDescriptor,
  surfaceId: string,
  scope: Scope,
  value: unknown,
  ctx: ResolveCtx,
): Promise<SurfaceValue[]> {
  const surface = descriptor.surfaces.find((s) => s.id === surfaceId);
  if (!surface) throw new AppError('NOT_FOUND', `unknown surface ${surfaceId}`);
  if (surface.readOnly) throw new AppError('VALIDATION', `${surfaceId} is read-only`);

  const target = targetFor(surface, scope);
  if (!target) throw new AppError('VALIDATION', `${surfaceId} has no ${scope} target`);
  if (target.format === 'dir') {
    throw new AppError('VALIDATION', `${surfaceId} is a directory surface — use the skills route`);
  }

  const declaredFile = resolveTarget(target, ctx);
  const targetPath = resolvePath(target, ctx);

  try {
    await fsp.mkdir(path.dirname(declaredFile), { recursive: true });

    const file = await resolveWriteTarget(declaredFile);
    if (file !== declaredFile) {
      // The symlink's resolved target can live under directories that don't
      // exist yet (a dangling link into an as-yet-uncreated tree).
      await fsp.mkdir(path.dirname(file), { recursive: true });
    }

    await withFileLock(file, async () => {
      const existing = (await readText(file)) ?? '';

      let next: string;
      if (target.format === 'text') {
        // A whole-file text surface (e.g. CLAUDE.md) has no "key" to
        // remove — `undefined` here used to fall through to `next = ''`,
        // silently truncating the user's instructions to zero bytes. Both
        // "remove" and "set a non-string" are refused instead of guessing.
        if (value === undefined) {
          throw new AppError(
            'VALIDATION',
            `${surfaceId} is a whole-file text surface — removing it is not supported; write an explicit value instead`,
          );
        }
        if (typeof value !== 'string') {
          throw new AppError('VALIDATION', `${surfaceId} expects a string value`);
        }
        next = value;
      } else {
        // 'dir' was already rejected above, so the only formats reaching
        // here are 'json' and 'jsonc' — sharing `jsonDriver` by contract,
        // same as the read side in `readTarget`.
        try {
          next =
            value === undefined
              ? jsonDriver.remove(existing, targetPath)
              : jsonDriver.set(existing, targetPath, value);
        } catch (err) {
          if (err instanceof ConfigParseError) {
            // Report the path the caller declared, never the post-symlink-
            // resolution real path — that would leak a symlink target this
            // error's payload otherwise never reveals.
            throw new AppError('CONFIG_UNPARSEABLE', `${declaredFile}: ${err.detail}`);
          }
          throw err;
        }
      }

      await commitWrite(file, next, ctx.worktree);
    });

    // Re-read inside the same try: a rare I/O failure here (the file
    // vanishing or losing permissions between the write and this read-back,
    // e.g. concurrent antivirus/backup activity) should surface as the same
    // named AppError as any other write-path failure, not escape unwrapped.
    return await readSurfaces(descriptor, scope, ctx);
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw toWriteError(err, surfaceId);
  }
}
