// The contract for code navigation in the Files tab: go to definition, find
// references, hover, outline (via real language servers, as px0 does), plus a
// whole-word search fallback when no server is installed, and ⌘⇧F search.
//
// Rules every part keeps:
// - Servers come only from LSP_SERVERS below; argv is never taken from a request.
// - Read-only: the client never applies edits or runs commands a server asks for.
// - On demand: a server starts on the first navigation request for its language
//   in a worktree, stops after LSP_LIMITS.idleMs unused, at most
//   LSP_LIMITS.maxServers per machine (least recently used goes first).
// - Paths in and out are relative to the worktree (same rules as files/types.ts).
//   Lines and columns are 1-based (the server converts to LSP's 0-based UTF-16).
// - Runner worktrees use the same routes on the runner via /api/runners/:id/rpc.

export type LspServerId =
  | 'typescript' | 'pyright' | 'gopls' | 'rust-analyzer' | 'clangd'
  | 'jdtls' | 'solargraph' | 'lua' | 'zls' | 'omnisharp' | 'texlab';

export type LspInstall = {
  /** Shown and typed into a visible Shell tab; never run in the background. */
  command: string;
  os?: 'darwin' | 'linux';
  /** What it needs first, e.g. "npm", "go", "rustup", "brew". */
  needs?: string;
};

export type LspServerSpec = {
  id: LspServerId;
  /** "TypeScript and JavaScript". */
  lang: string;
  /** argv to start it over stdio; argv[0] looked up on PATH and common bin dirs. */
  cmd: string[];
  /** File extensions it serves, lowercase with the dot. */
  extensions: string[];
  install: LspInstall[];
};

// The fixed list. Commands mirror px0's lsp.go table.
export const LSP_SERVERS: LspServerSpec[] = [
  { id: 'typescript', lang: 'TypeScript and JavaScript', cmd: ['typescript-language-server', '--stdio'],
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'],
    install: [{ command: 'npm install -g typescript-language-server typescript@5', needs: 'npm' }] },
  { id: 'pyright', lang: 'Python', cmd: ['pyright-langserver', '--stdio'], extensions: ['.py', '.pyi'],
    install: [{ command: 'npm install -g pyright', needs: 'npm' }, { command: 'pipx install pyright', needs: 'pipx' }] },
  { id: 'gopls', lang: 'Go', cmd: ['gopls'], extensions: ['.go'],
    install: [{ command: 'go install golang.org/x/tools/gopls@latest', needs: 'go' }, { command: 'brew install gopls', os: 'darwin', needs: 'brew' }] },
  { id: 'rust-analyzer', lang: 'Rust', cmd: ['rust-analyzer'], extensions: ['.rs'],
    install: [{ command: 'rustup component add rust-analyzer', needs: 'rustup' }, { command: 'brew install rust-analyzer', os: 'darwin', needs: 'brew' }] },
  { id: 'clangd', lang: 'C and C++', cmd: ['clangd'], extensions: ['.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.hh'],
    install: [{ command: 'brew install llvm', os: 'darwin', needs: 'brew' }, { command: 'sudo apt-get install -y clangd', os: 'linux', needs: 'apt-get' }] },
  { id: 'jdtls', lang: 'Java', cmd: ['jdtls'], extensions: ['.java'],
    install: [{ command: 'brew install jdtls', os: 'darwin', needs: 'brew' }] },
  { id: 'solargraph', lang: 'Ruby', cmd: ['solargraph', 'stdio'], extensions: ['.rb'],
    install: [{ command: 'gem install --user-install solargraph', needs: 'gem' }] },
  { id: 'lua', lang: 'Lua', cmd: ['lua-language-server'], extensions: ['.lua'],
    install: [{ command: 'brew install lua-language-server', os: 'darwin', needs: 'brew' }] },
  { id: 'zls', lang: 'Zig', cmd: ['zls'], extensions: ['.zig'],
    install: [{ command: 'brew install zls', os: 'darwin', needs: 'brew' }] },
  { id: 'omnisharp', lang: 'C#', cmd: ['OmniSharp', '-lsp'], extensions: ['.cs'],
    install: [{ command: 'brew install omnisharp/omnisharp-roslyn/omnisharp-mono', os: 'darwin', needs: 'brew' }] },
  { id: 'texlab', lang: 'LaTeX', cmd: ['texlab'], extensions: ['.tex', '.bib'],
    install: [{ command: 'brew install texlab', os: 'darwin', needs: 'brew' }, { command: 'cargo install --locked texlab', needs: 'cargo' }] },
];

export const LSP_LIMITS = {
  idleMs: 10 * 60_000,
  maxServers: 3,
  /** Per navigation request, after the server is up. */
  requestMs: 10_000,
  /** Starting + initialize, before the first answer. */
  startMs: 60_000,
  maxHits: 500,
} as const;

/** One place in the code. 1-based. */
export type NavHit = {
  path: string;
  line: number;
  col: number;
  endLine?: number;
  endCol?: number;
  /** The line's text, trimmed to 200 chars. */
  preview: string;
};

/** Why an answer came from search instead of a language server. */
export type NavFallback = 'no-server' | 'not-installed' | 'disabled' | 'starting' | 'failed' | 'timeout';

export type NavAnswer = {
  /** 'lsp' = exact; 'search' = whole-word search guess (px0's level 1). */
  source: 'lsp' | 'search';
  server?: LspServerId;
  fallback?: NavFallback;
  hits: NavHit[];
};

export type HoverAnswer = { server: LspServerId; markdown: string } | null;

export type OutlineSymbol = {
  name: string;
  /** LSP SymbolKind display name: "func", "class", "method", … */
  kind: string;
  line: number;
  col: number;
  children?: OutlineSymbol[];
};

/** GET LSP_ROUTES.search — ⌘⇧F and the fallback both use it. rg when on PATH, else git grep. */
export type SearchQuery = { q: string; word?: boolean; case?: boolean; regex?: boolean; glob?: string };
export type SearchAnswer = { hits: NavHit[]; truncated: boolean; engine: 'rg' | 'git-grep' };

export type LspServerStatus = {
  id: LspServerId;
  lang: string;
  enabled: boolean;
  /** Found on PATH or a common bin dir, with the resolved binary path. */
  installed: boolean;
  binary?: string;
  /** Install commands for THIS machine's OS, with `available` = its `needs` tool is present. */
  install: (LspInstall & { available: boolean })[];
  running: { worktreePath: string; pid: number; rssBytes: number | null; startedAt: string; lastUsedAt: string }[];
  /** Why it last failed to start or died (secrets redacted); cleared by a good answer or re-enabling. */
  lastError?: string;
};

/** Per-worktree navigation: mounted under /api/w/:ws, like files. Query: path, line, col (1-based). */
export const LSP_ROUTES = {
  definition: '/worktrees/:encodedPath/lsp/definition', // → NavAnswer
  references: '/worktrees/:encodedPath/lsp/references', // → NavAnswer
  hover: '/worktrees/:encodedPath/lsp/hover', // → HoverAnswer
  outline: '/worktrees/:encodedPath/lsp/outline', // ?path → { server, symbols: OutlineSymbol[] } | { server: null, symbols: [] }
  search: '/worktrees/:encodedPath/files/search', // ?q&word&case&regex&glob → SearchAnswer
} as const;

/** Machine-wide: status and settings (Settings › Files › Language servers). */
export const LSP_ADMIN_ROUTES = {
  servers: '/api/lsp/servers', // GET → { servers: LspServerStatus[] }
  setEnabled: '/api/lsp/servers/:id/enabled', // POST { enabled } → 204   (assertLocalHub)
  stop: '/api/lsp/servers/:id/stop', // POST → 204, stops every running instance   (assertLocalHub)
} as const;
