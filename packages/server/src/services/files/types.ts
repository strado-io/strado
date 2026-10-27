// The contract for the Files tab: a light view of a worktree's folders and
// files, with in-place editing of existing text files (instead of opening VS
// Code). The only write is `write`: it replaces an existing file's text, never
// creates, renames or deletes, and refuses when the file changed since it was
// read (the caller's `version`). Shared by the server routes,
// the web client and the viewer. Every path in and out is RELATIVE to the
// worktree root, uses '/', and never leaves the root (no '..', no absolute
// paths, no symlink escape, never inside .git).
//
// Remote worktrees use the same routes on the runner's own server, reached
// through GET /api/runners/:id/rpc?path=/api/w/<remoteWsId>/worktrees/... .

/** Git state of a path, as the tree badges it. '?' = untracked. */
export type FileChange = 'M' | 'A' | 'D' | 'R' | '?';

export type FileTreeEntry = {
  name: string;
  /** Relative to the worktree root, e.g. "src/app.ts". */
  path: string;
  kind: 'dir' | 'file';
  /** Bytes, files only. */
  size?: number;
  /** Files: its own change. Dirs: set when anything under it changed. */
  change?: FileChange;
  /** Matched by .gitignore (only listed when the caller asked for ignored). */
  ignored?: boolean;
};

/** GET FILES_ROUTES.tree?dir=<rel, '' = root>&ignored=1 — one level, dirs first, then names. */
export type FileTreePage = {
  dir: string;
  entries: FileTreeEntry[];
  /** More than FILES_LIMITS.treeEntries in this folder; the rest are left out. */
  truncated: boolean;
};

/** GET FILES_ROUTES.list — every tracked + untracked (not ignored) file, for ⌘P. */
export type FileList = { files: string[]; truncated: boolean };

/** GET FILES_ROUTES.read?path=<rel> */
export type FileContent = {
  path: string;
  size: number;
  /** Looks binary (NUL in the first 8 KB): no text is sent. */
  binary: boolean;
  /** Over FILES_LIMITS.readBytes: no text is sent. */
  tooLarge: boolean;
  text?: string;
  /** A CodeMirror language hint from the extension, e.g. "typescript"; null = plain. */
  language: string | null;
  change?: FileChange;
  /** Set when `text` is: an opaque token for the bytes read (sha-256 of the
   * content). A write must send it back; a different file on disk means
   * someone else changed it. */
  version?: string;
};

/**
 * GET FILES_ROUTES.marks?path=<rel> — where the working copy differs from
 * HEAD (staged + unstaged), for the gutter and n/p. Line numbers are 1-based
 * in the CURRENT file.
 */
export type FileMarks = {
  path: string;
  /** Inclusive [from, to] ranges of new lines. */
  added: [number, number][];
  /** Inclusive [from, to] ranges of changed lines. */
  modified: [number, number][];
  /** Lines AFTER which something was deleted (0 = before the first line). */
  deletedAfter: number[];
};

export const FILES_LIMITS = {
  treeEntries: 2000,
  listFiles: 50_000,
  readBytes: 1024 * 1024,
} as const;

/** Mounted under /api/w/:ws (the same scope as /worktrees/:encodedPath/git/*). */
export const FILES_ROUTES = {
  tree: '/worktrees/:encodedPath/files/tree',
  list: '/worktrees/:encodedPath/files/list',
  read: '/worktrees/:encodedPath/files/read',
  marks: '/worktrees/:encodedPath/files/marks',
  /** POST FileWriteBody → FileWriteResult (200) | 409 FileWriteConflict.
   * Behind assertLocalHub. Same path rules as read, plus: the file must exist,
   * be a regular text file within FILES_LIMITS.readBytes, and stay within it. */
  write: '/worktrees/:encodedPath/files/write',
} as const;

export type FileWriteBody = {
  path: string;
  text: string;
  /** The FileContent.version this edit started from. */
  baseVersion: string;
  /** Write even if the file changed on disk (the person chose Overwrite). */
  force?: boolean;
};
export type FileWriteResult = { path: string; version: string; size: number };
/** 409: the file on disk is not baseVersion any more. */
export type FileWriteConflict = { error: 'conflict'; path: string; version: string };

/** What "Ask an agent about these lines" sends over the intercom (as the message context). */
export type FileAskContext = {
  worktreePath: string;
  path: string;
  from: number;
  to: number;
  /** The selected text, capped at 8 KB. */
  snippet: string;
};
