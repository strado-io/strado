import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Detect } from './detect.js';
import { createLspManager, type LspManager, type SearchFallback } from './manager.js';
import { createLspEnabledStore } from './store.js';
import type { LspServerSpec, NavHit } from './types.js';

const FAKE = fileURLToPath(new URL('./fakeLsp.fixture.cjs', import.meta.url));

let tmp: string;
let root: string;
let logFile: string;
let mgr: LspManager | null;
let clock: number;

/** A wrapper script so the server's argv[0] is a real executable. */
async function fakeBinary(mode = 'normal', extraEnv = ''): Promise<string> {
  const bin = path.join(tmp, `fake-lsp-${mode}`);
  await fs.writeFile(
    bin,
    `#!/bin/sh\n${extraEnv} FAKE_LSP_MODE=${mode} FAKE_LSP_LOG='${logFile}' FAKE_LSP_PIDFILE='${tmp}/kid.pid' exec '${process.execPath}' '${FAKE}' "$@"\n`,
    { mode: 0o755 },
  );
  return bin;
}

const spec = (bin: string): LspServerSpec => ({
  id: 'typescript',
  lang: 'TypeScript and JavaScript',
  cmd: [bin, '--stdio'],
  extensions: ['.ts'],
  install: [{ command: 'npm i -g x', needs: 'npm' }, { command: 'brew install x', os: 'darwin', needs: 'brew' }],
});

const detect = (found: Record<string, string | null> = {}): Detect => ({
  dirs: async () => ['/usr/bin', '/bin'],
  which: async (name) => (name in found ? found[name]! : name.startsWith('/') ? name : null),
});

const searchCalls: string[] = [];
const fakeSearch: SearchFallback = {
  async searchWord(_root, sym) {
    searchCalls.push(sym);
    return {
      engine: 'git-grep',
      truncated: false,
      hits: [
        { path: 'src/use.ts', line: 1, col: 10, preview: `import { ${sym} } from './def';` },
        { path: 'src/def.ts', line: 2, col: 14, preview: `export const ${sym} = 1;` },
      ],
    };
  },
  isDefinition: (h: NavHit, sym) => h.preview.includes(`const ${sym}`),
  classifyDefinitions: (hits) => hits,
};

async function make(bin: string, over: Partial<Parameters<typeof createLspManager>[0]> = {}) {
  mgr = createLspManager({
    detect: detect(),
    store: createLspEnabledStore(() => path.join(tmp, 'lsp-servers.json')),
    specs: [spec(bin)],
    search: fakeSearch,
    limits: { requestMs: 4000, startMs: 15000 },
    now: () => clock,
    rss: async () => 4096,
    ...over,
  });
  return mgr;
}

async function received(): Promise<{ id?: number; method?: string; result?: unknown; error?: { code: number }; params?: any }[]> {
  const raw = await fs.readFile(logFile, 'utf8').catch(() => '');
  return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

async function until(fn: () => Promise<boolean>, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('condition not met');
}

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lsp-')));
  root = path.join(tmp, 'wt');
  logFile = path.join(tmp, 'lsp.log');
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'use.ts'), "import { foo } from './def';\nconsole.log(foo);\n");
  await fs.writeFile(path.join(root, 'src', 'def.ts'), '// def\nexport const foo = 1;\n');
  await fs.writeFile(path.join(root, 'notes.txt'), 'foo\n');
  searchCalls.length = 0;
  clock = 1_000_000;
  mgr = null;
});

afterEach(async () => {
  await mgr?.closeAll();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('definition and references through a language server', () => {
  it('starts on demand, opens the file, answers with hits inside the worktree only', async () => {
    const m = await make(await fakeBinary());
    const ans = await m.definition(root, 'src/use.ts', 2, 14);
    expect(ans).toEqual({
      source: 'lsp',
      server: 'typescript',
      hits: [{ path: 'src/def.ts', line: 2, col: 14, endLine: 2, endCol: 17, preview: 'export const foo = 1;' }],
    });
    const msgs = await received();
    const init = msgs.find((x) => x.method === 'initialize')!;
    expect(init.params.rootUri).toBe(`file://${root}`);
    expect(init.params.capabilities.general.positionEncodings).toEqual(['utf-16']);
    const open = msgs.find((x) => x.method === 'textDocument/didOpen')!;
    expect(open.params.textDocument).toMatchObject({ uri: `file://${root}/src/use.ts`, languageId: 'typescript', version: 1 });
    const def = msgs.find((x) => x.method === 'textDocument/definition')!;
    expect(def.params.position).toEqual({ line: 1, character: 13 });
    expect(searchCalls).toEqual([]);
  });

  it('references: LocationLinks too, sorted, includeDeclaration', async () => {
    const m = await make(await fakeBinary());
    const ans = await m.references(root, 'src/use.ts', 2, 14);
    expect(ans.source).toBe('lsp');
    expect(ans.hits.map((h) => `${h.path}:${h.line}:${h.col}`)).toEqual(['src/def.ts:2:14', 'src/def.ts:2:21', 'src/use.ts:1:10']);
    const req = (await received()).find((x) => x.method === 'textDocument/references')!;
    expect(req.params.context).toEqual({ includeDeclaration: true });
  });

  it('one server per worktree and id; didChange only when the file changed', async () => {
    const m = await make(await fakeBinary());
    await m.definition(root, 'src/use.ts', 2, 14);
    await m.definition(root, 'src/use.ts', 2, 14);
    await fs.writeFile(path.join(root, 'src', 'use.ts'), "import { foo } from './def';\nconsole.log(foo, 2);\n");
    await m.definition(root, 'src/use.ts', 2, 14);
    const msgs = await received();
    expect(msgs.filter((x) => x.method === 'initialize')).toHaveLength(1);
    expect(msgs.filter((x) => x.method === 'textDocument/didOpen')).toHaveLength(1);
    const changes = msgs.filter((x) => x.method === 'textDocument/didChange');
    expect(changes).toHaveLength(1);
    expect(changes[0]!.params.textDocument.version).toBe(2);
    expect(changes[0]!.params.contentChanges[0].text).toContain('foo, 2');
  });

  it('answers configuration with nulls, accepts registrations, refuses edits and commands', async () => {
    const m = await make(await fakeBinary());
    await m.definition(root, 'src/use.ts', 2, 14);
    await until(async () => (await received()).filter((x) => x.method === undefined && x.id !== undefined && x.id >= 1000).length === 6);
    const replies = new Map((await received()).filter((x) => x.method === undefined && x.id! >= 1000).map((x) => [x.id, x]));
    expect(replies.get(1000)!.result).toEqual([null, null]); // workspace/configuration
    expect(replies.get(1001)).toMatchObject({ result: null }); // client/registerCapability
    expect(replies.get(1002)).toMatchObject({ result: null }); // window/workDoneProgress/create
    expect(replies.get(1003)!.error!.code).toBe(-32601); // workspace/applyEdit
    expect(replies.get(1004)!.error!.code).toBe(-32601); // workspace/executeCommand
    expect(replies.get(1005)!.error!.code).toBe(-32601); // foo/bar
  });
});

describe('hover and outline', () => {
  it('hover returns the markdown', async () => {
    const m = await make(await fakeBinary());
    expect(await m.hover(root, 'src/use.ts', 2, 14)).toEqual({ server: 'typescript', markdown: '```ts\nconst foo: number\n```' });
  });

  it('outline maps kinds and nests children, 1-based', async () => {
    const m = await make(await fakeBinary());
    expect(await m.outline(root, 'src/def.ts')).toEqual({
      server: 'typescript',
      symbols: [
        { name: 'Box', kind: 'class', line: 1, col: 7, children: [{ name: 'open', kind: 'method', line: 2, col: 3 }] },
        { name: 'foo', kind: 'const', line: 6, col: 14 },
      ],
    });
  });

  it('no server for the file: hover null, outline empty', async () => {
    const m = await make(await fakeBinary());
    expect(await m.hover(root, 'notes.txt', 1, 1)).toBeNull();
    expect(await m.outline(root, 'notes.txt')).toEqual({ server: null, symbols: [] });
  });
});

describe('fallback to search', () => {
  it('no server for the language', async () => {
    const m = await make(await fakeBinary());
    const ans = await m.references(root, 'notes.txt', 1, 2);
    expect(ans).toMatchObject({ source: 'search', fallback: 'no-server' });
    expect(ans.server).toBeUndefined();
    expect(searchCalls).toEqual(['foo']);
  });

  it('not installed', async () => {
    const m = await make('typescript-language-server');
    const ans = await m.definition(root, 'src/use.ts', 2, 14);
    expect(ans).toMatchObject({ source: 'search', server: 'typescript', fallback: 'not-installed' });
    // Definitions only, when the search can tell.
    expect(ans.hits.map((h) => h.path)).toEqual(['src/def.ts']);
  });

  it('disabled, and disabling stops a running server', async () => {
    const m = await make(await fakeBinary());
    await m.definition(root, 'src/use.ts', 2, 14);
    await m.setEnabled('typescript', false);
    expect((await m.servers())[0]).toMatchObject({ enabled: false, running: [] });
    expect(await m.definition(root, 'src/use.ts', 2, 14)).toMatchObject({ source: 'search', fallback: 'disabled' });
    await m.setEnabled('typescript', true);
    expect((await m.definition(root, 'src/use.ts', 2, 14)).source).toBe('lsp');
  });

  it('still starting after requestMs', async () => {
    const m = await make(await fakeBinary('slow-init'));
    expect(await m.definition(root, 'src/use.ts', 2, 14)).toMatchObject({ source: 'search', fallback: 'starting' });
  });

  it('a request that takes too long', async () => {
    const m = await make(await fakeBinary('hang'));
    expect(await m.definition(root, 'src/use.ts', 2, 14)).toMatchObject({ source: 'search', fallback: 'timeout' });
  });

  it('a crash is failed; the next request retries once, then it stays failed', async () => {
    const m = await make(await fakeBinary('crash-on-request'));
    expect(await m.definition(root, 'src/use.ts', 2, 14)).toMatchObject({ fallback: 'failed' });
    expect(await m.definition(root, 'src/use.ts', 2, 14)).toMatchObject({ fallback: 'failed' });
    expect(await m.definition(root, 'src/use.ts', 2, 14)).toMatchObject({ fallback: 'failed' });
    expect((await received()).filter((x) => x.method === 'initialize')).toHaveLength(2);
    // A deliberate stop clears it.
    await m.stop('typescript');
    await m.definition(root, 'src/use.ts', 2, 14);
    expect((await received()).filter((x) => x.method === 'initialize')).toHaveLength(3);
  });

  it('a server that will not start', async () => {
    const m = await make(await fakeBinary('exit-at-start'));
    expect(await m.definition(root, 'src/use.ts', 2, 14)).toMatchObject({ source: 'search', fallback: 'failed' });
  });

  it('no word under the cursor: no hits, no search', async () => {
    const m = await make('typescript-language-server');
    // col 16 is ')' just after "foo": the word before the caret still counts.
    await m.definition(root, 'src/use.ts', 2, 16);
    expect(searchCalls).toEqual(['foo']);
    expect(await m.definition(root, 'src/use.ts', 3, 1)).toMatchObject({ hits: [] });
    expect(searchCalls).toEqual(['foo']);
  });
});

describe('review fixes', () => {
  it('concurrent first requests share one server', async () => {
    const m = await make(await fakeBinary());
    await Promise.all([
      m.outline(root, 'src/use.ts'),
      m.hover(root, 'src/use.ts', 2, 14),
      m.definition(root, 'src/use.ts', 2, 14),
    ]);
    expect((await received()).filter((x) => x.method === 'initialize')).toHaveLength(1);
    expect((await m.servers())[0]!.running).toHaveLength(1);
  });

  it('concurrent starts in different worktrees never exceed maxServers', async () => {
    const m = await make(await fakeBinary(), { limits: { requestMs: 4000, startMs: 15000, maxServers: 2 } });
    const roots = ['a', 'b', 'c', 'd'].map((n) => path.join(tmp, n));
    for (const r of roots) {
      await fs.mkdir(path.join(r, 'src'), { recursive: true });
      await fs.writeFile(path.join(r, 'src', 'use.ts'), 'foo\n');
    }
    await Promise.all(roots.map((r) => m.outline(r, 'src/use.ts')));
    expect((await m.servers())[0]!.running.length).toBeLessThanOrEqual(2);
    await m.closeAll();
    mgr = null;
    // Every one that was started was also stopped.
    expect((await received()).filter((x) => x.method === 'initialize').length).toBe(
      (await received()).filter((x) => x.method === 'shutdown').length,
    );
  });

  it("the server keeps the user's env but never a secret or Strado's identity", async () => {
    const kept = { GOPATH: '/go', GOPRIVATE: 'x.com/*', VIRTUAL_ENV: '/v', JAVA_HOME: '/jdk', LC_ALL: 'C', RANDOM_THING: 'r' };
    const set: Record<string, string> = {
      STRADO_AGENT_TOKEN: 'tok', STRADO_HOME: '/x', PORT: '1234', ANTHROPIC_API_KEY: 'k', OPENAI_BASE: 'u',
      CLAUDE_CODE_OAUTH_TOKEN: 'c', GITHUB_TOKEN: 'g', GH_HOST: 'h', GITLAB_HOST: 'l', MY_SECRET: 's', NPM_TOKEN: 'n',
      AWS_ACCESS_KEY_ID: 'a', AWS_SESSION_X: 'x', DB_PASSWORD: 'p', DB_PASSWD: 'p', GOOGLE_APPLICATION_CREDENTIALS: '/c',
      STRIPE_API_KEY: 'k', SSH_PRIVATE_KEY: 'k', BASIC_AUTH: 'b', OPENROUTER_X: 'o', ELEVENLABS_X: 'e',
      ...kept,
    };
    const prev = { ...process.env };
    Object.assign(process.env, set);
    try {
      const m = await make(await fakeBinary());
      await m.definition(root, 'src/use.ts', 2, 14);
    } finally {
      for (const k of Object.keys(set)) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k];
      }
    }
    const env = ((await received()).find((x: any) => x.env) as any).env as string[];
    for (const k of [...Object.keys(kept), 'PATH']) expect(env).toContain(k);
    for (const k of Object.keys(set).filter((k) => !(k in kept))) expect(env).not.toContain(k);
  });

  it('a hit through a symlink that leaves the worktree is dropped', async () => {
    await fs.mkdir(path.join(tmp, 'outside'));
    await fs.writeFile(path.join(tmp, 'outside', 'secret.ts'), 'SECRET\n');
    await fs.symlink(path.join(tmp, 'outside'), path.join(root, 'link'));
    const m = await make(await fakeBinary('normal', 'FAKE_LSP_ESCAPE=1'));
    expect(await m.definition(root, 'src/use.ts', 2, 14)).toEqual({ source: 'lsp', server: 'typescript', hits: [] });
  });

  it("stopping kills the server's whole process group", async () => {
    const m = await make(await fakeBinary('grandchild'));
    await m.definition(root, 'src/use.ts', 2, 14);
    const kid = Number(await fs.readFile(path.join(tmp, 'kid.pid'), 'utf8'));
    expect(() => process.kill(kid, 0)).not.toThrow();
    await m.stop('typescript');
    await until(async () => {
      try {
        process.kill(kid, 0);
        return false;
      } catch {
        return true;
      }
    });
  });

  it('a file over the read cap is not sent to the server', async () => {
    await fs.writeFile(path.join(root, 'src', 'big.ts'), 'foo '.repeat(300_000));
    const m = await make(await fakeBinary());
    expect(await m.definition(root, 'src/big.ts', 1, 1)).toMatchObject({ source: 'search', fallback: 'failed' });
    expect((await received()).some((x) => x.method === 'textDocument/didOpen')).toBe(false);
  });
});

describe('project loading ($/progress)', () => {
  it('the first answer waits for the load that the open started', async () => {
    const m = await make(await fakeBinary('progress'));
    const t = Date.now();
    const ans = await m.definition(root, 'src/use.ts', 2, 14);
    expect(ans.hits.map((h) => `${h.path}:${h.line}`)).toEqual(['src/def.ts:2']);
    expect(Date.now() - t).toBeGreaterThan(1000);
    // Loaded: the next one is immediate.
    const t2 = Date.now();
    await m.hover(root, 'src/use.ts', 2, 14);
    expect(Date.now() - t2).toBeLessThan(1000);
  });

  it('a load that never ends is waited for at most requestMs, then asked anyway', async () => {
    const m = await make(await fakeBinary('progress-stuck'), { limits: { requestMs: 1200, startMs: 15000 } });
    const t = Date.now();
    const ans = await m.definition(root, 'src/use.ts', 2, 14);
    expect(ans.source).toBe('lsp');
    expect(ans.hits.map((h) => `${h.path}:${h.line}`)).toEqual(['src/use.ts:1']);
    expect(Date.now() - t).toBeLessThan(4000);
  });

  it('a server that reports no progress is not held up past the grace', async () => {
    const m = await make(await fakeBinary());
    const t = Date.now();
    await m.definition(root, 'src/use.ts', 2, 14);
    await m.definition(root, 'src/def.ts', 2, 14);
    expect(Date.now() - t).toBeLessThan(3000);
  });
});

describe('lifecycle', () => {
  it('reaps a server idle for idleMs', async () => {
    const m = await make(await fakeBinary(), { limits: { requestMs: 4000, startMs: 15000, idleMs: 60_000 } });
    await m.definition(root, 'src/use.ts', 2, 14);
    expect((await m.servers())[0]!.running).toHaveLength(1);
    clock += 30_000;
    await m.sweep();
    expect((await m.servers())[0]!.running).toHaveLength(1);
    clock += 31_000;
    await m.sweep();
    expect((await m.servers())[0]!.running).toEqual([]);
    expect((await received()).some((x) => x.method === 'shutdown')).toBe(true);
  });

  it('at most maxServers on the machine; the least recently used goes', async () => {
    const m = await make(await fakeBinary(), { limits: { requestMs: 4000, startMs: 15000, maxServers: 2 } });
    const roots = ['a', 'b', 'c'].map((n) => path.join(tmp, n));
    for (const r of roots) {
      await fs.mkdir(path.join(r, 'src'), { recursive: true });
      await fs.writeFile(path.join(r, 'src', 'use.ts'), 'foo\n');
    }
    await m.definition(roots[0]!, 'src/use.ts', 1, 1);
    clock += 1;
    await m.definition(roots[1]!, 'src/use.ts', 1, 1);
    clock += 1;
    await m.definition(roots[0]!, 'src/use.ts', 1, 1); // a is now the most recent
    clock += 1;
    await m.definition(roots[2]!, 'src/use.ts', 1, 1);
    expect((await m.servers())[0]!.running.map((r) => path.basename(r.worktreePath)).sort()).toEqual(['a', 'c']);
  });

  it('servers(): status, binary, install options for this OS, running with rss', async () => {
    const bin = await fakeBinary();
    const m = await make(bin, { detect: detect({ npm: '/usr/bin/npm', brew: null }) });
    await m.definition(root, 'src/use.ts', 2, 14);
    const [s] = await m.servers();
    expect(s).toMatchObject({ id: 'typescript', enabled: true, installed: true, binary: bin });
    expect(s!.install[0]).toEqual({ command: 'npm i -g x', needs: 'npm', available: true });
    if (process.platform === 'darwin') expect(s!.install[1]).toMatchObject({ needs: 'brew', available: false });
    expect(s!.running).toEqual([
      expect.objectContaining({ worktreePath: root, rssBytes: 4096, startedAt: new Date(clock).toISOString() }),
    ]);
    expect(s!.running[0]!.pid).toBeGreaterThan(0);
  });

  it('refuses paths outside the worktree', async () => {
    const m = await make(await fakeBinary());
    await expect(m.definition(root, '../x.ts', 1, 1)).rejects.toMatchObject({ httpStatus: 400 });
    await fs.writeFile(path.join(tmp, 'secret.ts'), 'x');
    await fs.symlink(path.join(tmp, 'secret.ts'), path.join(root, 'out.ts'));
    await expect(m.definition(root, 'out.ts', 1, 1)).rejects.toMatchObject({ httpStatus: 403 });
  });

  it('closeAll stops everything', async () => {
    const m = await make(await fakeBinary());
    await m.definition(root, 'src/use.ts', 2, 14);
    const pid = (await m.servers())[0]!.running[0]!.pid;
    await m.closeAll();
    mgr = null;
    expect(() => process.kill(pid, 0)).toThrow();
  });
});
