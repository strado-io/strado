import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp, buildDeps } from '../../src/app';
import { claudeDescriptor } from '../../src/services/agentConfig/descriptors/claude';
import { resolveTarget, resolveAllowedFile } from '../../src/services/agentConfig/targets';
import { resolveWriteTarget } from '../../src/services/agentConfig/engine';
import type { ToolStatus } from '../../src/services/toolCheck';

// `checkTools()` really shells out (`<tool> --version`), so its result
// depends on what happens to be installed on whatever machine runs this
// suite. Mocked here so the `installed`/`supported` fixture below can pick
// values that DISCRIMINATE the two flags on purpose — most importantly codex
// found=true (installed) with no descriptor (unsupported), the exact
// installed-but-unsupported combination the panel must tell apart from
// "not installed at all" rather than lying that it's the same thing.
const mockCheckTools = vi.fn<[], Promise<ToolStatus[]>>();
vi.mock('../../src/services/toolCheck', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/toolCheck')>();
  return { ...actual, checkTools: () => mockCheckTools() };
});

function toolStatus(overrides: Partial<ToolStatus> & { id: string }): ToolStatus {
  return {
    label: overrides.id, found: false, version: null, optional: true, hint: null,
    installable: false, installCommand: null, ...overrides,
  };
}

let tmp: string;
let home: string;
let worktree: string;
let app: Awaited<ReturnType<typeof buildApp>>;

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'api-agentconfig-')));
  home = path.join(tmp, 'home');
  worktree = path.join(tmp, 'worktree');
  await fs.mkdir(path.join(home, '.claude'), { recursive: true });
  await fs.mkdir(path.join(worktree, '.claude'), { recursive: true });

  mockCheckTools.mockResolvedValue([
    toolStatus({ id: 'git', found: true, version: 'git version 2.0' }),
    // Both installed AND supported (has a descriptor) — the fully-usable case.
    toolStatus({ id: 'claude', label: 'Claude Code', found: true, version: 'v1', optional: false, installable: true, installCommand: 'npm i -g @anthropic-ai/claude-code' }),
    // Installed but NOT supported — no descriptor exists yet. This is the
    // real Codex CLI state on the machine this feature was built on: the
    // panel must say "not yet supported", never "not installed" (that would
    // be the app lying about the user's own system).
    toolStatus({ id: 'codex', label: 'Codex CLI', found: true, version: 'v1', installable: true, installCommand: 'npm i -g @openai/codex' }),
    // Neither installed nor supported.
    toolStatus({ id: 'opencode', label: 'OpenCode', found: false, installable: true, installCommand: 'npm install -g opencode-ai', hint: 'OpenCode needs to be installed to use' }),
    toolStatus({ id: 'pi', label: 'Pi', found: false, installable: true, installCommand: 'npm install -g --ignore-scripts @earendil-works/pi-coding-agent', hint: 'Pi needs to be installed to use' }),
    toolStatus({ id: 'vscode', found: false }),
  ]);

  const deps = await buildDeps({
    configDir: path.join(tmp, 'config'),
    homeStateDir: path.join(tmp, 'state'),
    agentHomeDir: home,
  });
  app = await buildApp(deps);
});

afterEach(async () => {
  await app.close();
  await fs.rm(tmp, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('GET /api/agent-config/agents', () => {
  it('lists agents with installed state', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/agent-config/agents' });
    expect(res.statusCode).toBe(200);
    const { agents } = res.json();
    expect(agents.map((a: { id: string }) => a.id)).toContain('claude');
    const claude = agents.find((a: { id: string }) => a.id === 'claude');
    expect(typeof claude.installed).toBe('boolean');
    expect(Array.isArray(claude.files)).toBe(true);
  });

  // The gap this task closes: only claude had a descriptor, so codex,
  // opencode and pi never appeared at all — the panel looked claude-only
  // even on a machine with other agents installed. All four known agents
  // must come back regardless of whether Strado can manage their config yet.
  it('lists all four known agents, not only the ones with a descriptor', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/agent-config/agents' });
    expect(res.statusCode).toBe(200);
    const ids = res.json().agents.map((a: { id: string }) => a.id);
    expect(ids).toEqual(expect.arrayContaining(['claude', 'codex', 'opencode', 'pi']));
  });

  // `installed` (the CLI is on PATH) and `supported` (Strado has a
  // descriptor for it) are independent facts. The fixture above deliberately
  // makes them disagree for codex — installed=true but supported=false — so
  // a test that only ever sees them agree (e.g. every unsupported agent also
  // happens to be uninstalled) couldn't tell the two fields apart. This one
  // can: it would fail if `supported` were derived from `installed`, or vice
  // versa.
  it('reports installed and supported as independent flags, per the real Codex case (installed, unsupported)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/agent-config/agents' });
    const byId: Record<string, { installed: boolean; supported: boolean; files: string[] }> =
      Object.fromEntries(res.json().agents.map((a: { id: string }) => [a.id, a]));

    expect(byId.claude).toMatchObject({ installed: true, supported: true });
    // The critical case: installed, but Strado has no descriptor for it yet.
    expect(byId.codex).toMatchObject({ installed: true, supported: false });
    expect(byId.opencode).toMatchObject({ installed: false, supported: false });
    expect(byId.pi).toMatchObject({ installed: false, supported: false });

    // An unsupported agent has no descriptor to declare files from — reporting
    // any would imply Strado can manage config it actually can't touch.
    expect(byId.codex.files).toEqual([]);
    expect(byId.opencode.files).toEqual([]);
    expect(byId.pi.files).toEqual([]);
    // The supported agent's files come from its descriptor, same as before.
    expect(byId.claude.files.length).toBeGreaterThan(0);
  });
});

describe('GET /api/agent-config/:agent', () => {
  it('reads global surfaces', async () => {
    await fs.writeFile(path.join(home, '.claude/settings.json'), '{"theme":"dark"}');
    const res = await app.inject({ method: 'GET', url: '/api/agent-config/claude?scope=global' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.agent).toBe('claude');
    expect(body.scope).toBe('global');
    const theme = body.surfaces.find((s: { id: string }) => s.id === 'theme');
    expect(theme).toMatchObject({ value: 'dark', source: 'set', exists: true });
  });

  it('reads project surfaces given a worktree, inheriting from global', async () => {
    await fs.writeFile(path.join(home, '.claude/settings.json'), '{"permissions":{"allow":["Bash"]}}');
    const res = await app.inject({
      method: 'GET',
      url: `/api/agent-config/claude?scope=project&worktree=${encodeURIComponent(worktree)}`,
    });
    expect(res.statusCode).toBe(200);
    const permissions = res.json().surfaces.find((s: { id: string }) => s.id === 'permissions');
    expect(permissions.source).toBe('inherited');
    expect(permissions.inheritedValue).toEqual({ allow: ['Bash'] });
  });

  it('rejects an unknown agent with NOT_FOUND', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/agent-config/nope?scope=global' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('rejects project scope without a worktree with VALIDATION', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/agent-config/claude?scope=project' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION');
  });

  it('rejects an unknown scope with VALIDATION', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/agent-config/claude?scope=bogus' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION');
  });
});

describe('PATCH /api/agent-config/:agent', () => {
  it('patches a surface and returns the re-read surfaces', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/agent-config/claude',
      payload: { surfaceId: 'theme', scope: 'global', value: 'light' },
    });
    expect(res.statusCode).toBe(200);
    const theme = res.json().surfaces.find((s: { id: string }) => s.id === 'theme');
    expect(theme.value).toBe('light');

    // Actually landed on disk, not just echoed back.
    const onDisk = JSON.parse(await fs.readFile(path.join(home, '.claude/settings.json'), 'utf8'));
    expect(onDisk.theme).toBe('light');
  });

  it('rejects project scope without a worktree with VALIDATION', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/agent-config/claude',
      payload: { surfaceId: 'model', scope: 'project', value: 'opus' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION');
  });

  it('refuses to patch a malformed config with CONFIG_UNPARSEABLE', async () => {
    await fs.writeFile(path.join(home, '.claude/settings.json'), '{ broken');
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/agent-config/claude',
      payload: { surfaceId: 'theme', scope: 'global', value: 'dark' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('CONFIG_UNPARSEABLE');
  });

  it('rejects an unknown agent with NOT_FOUND', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/agent-config/nope',
      payload: { surfaceId: 'theme', scope: 'global', value: 'dark' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('rejects a malformed body with VALIDATION', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/agent-config/claude',
      payload: { scope: 'global', value: 'dark' }, // missing surfaceId
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION');
  });
});

// Final review fix #2: the Skills panel's "Remove" button PATCHed
// `surfaceId: 'skills'`, but `writeSurface` rejects every `dir`-format
// surface with "use the skills route" — and no such route existed, so the
// button always 400ed. `dirDriver.remove` (with its own traversal guards and
// tests in formats/dir.test.ts) was reachable only from its own test file.
// This route wires it up end to end: it must actually remove the skill on
// disk, re-read the surfaces afterward (mirroring PATCH's contract), and
// reject a traversal attempt through the ROUTE — not just prove the driver
// alone rejects it, which formats/dir.test.ts already does.
describe('DELETE /api/agent-config/:agent/skills/:name', () => {
  async function makeSkill(dir: string, name: string): Promise<void> {
    await fs.mkdir(path.join(dir, name), { recursive: true });
    await fs.writeFile(path.join(dir, name, 'SKILL.md'), `# ${name}\n`);
  }

  it('removes a global-scope skill and returns the re-read surfaces', async () => {
    const skillsDir = path.join(home, '.claude', 'skills');
    await makeSkill(skillsDir, 'brainstorming');
    await makeSkill(skillsDir, 'other');

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/agent-config/claude/skills/brainstorming?scope=global',
    });
    expect(res.statusCode).toBe(200);
    const skills = res.json().surfaces.find((s: { id: string }) => s.id === 'skills');
    expect(skills.value.map((e: { name: string }) => e.name)).toEqual(['other']);

    // Actually gone from disk (moved into .backups, per dirDriver.remove),
    // not just missing from the response.
    const remaining = await fs.readdir(skillsDir);
    expect(remaining).not.toContain('brainstorming');
  });

  it('removes a project-scope skill given a worktree', async () => {
    const skillsDir = path.join(worktree, '.claude', 'skills');
    await makeSkill(skillsDir, 'local-skill');

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/agent-config/claude/skills/local-skill?scope=project&worktree=${encodeURIComponent(worktree)}`,
    });
    expect(res.statusCode).toBe(200);
    const remaining = await fs.readdir(skillsDir);
    expect(remaining).not.toContain('local-skill');
  });

  it('rejects a traversal name through the route with VALIDATION, not a filesystem escape', async () => {
    // A bare `..` (or `../x`) segment is normalized away by the HTTP layer
    // itself before routing even sees it (`/skills/..` collapses to
    // `/skills`), so it can't discriminate the ROUTE's own guard. `.backups`
    // survives as an ordinary single path segment — dirDriver's own
    // `assertSimpleName` rejects it (see formats/dir.test.ts), and this
    // proves the route actually forwards to that guard rather than, say,
    // silently no-op-ing or 200ing on an unrecognized name.
    const skillsDir = path.join(home, '.claude', 'skills');
    await makeSkill(skillsDir, 'safe');
    await fs.mkdir(path.join(skillsDir, '.backups'), { recursive: true });
    await fs.writeFile(path.join(skillsDir, '.backups', 'marker'), 'still here');

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/agent-config/claude/skills/.backups?scope=global',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION');
    expect(await fs.readFile(path.join(skillsDir, '.backups', 'marker'), 'utf8')).toBe('still here');
  });

  it('rejects project scope without a worktree with VALIDATION', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/agent-config/claude/skills/brainstorming?scope=project',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION');
  });

  it('rejects an unknown agent with NOT_FOUND', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/agent-config/nope/skills/brainstorming?scope=global',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('reports NOT_FOUND when the named skill does not exist', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/agent-config/claude/skills/nonexistent?scope=global',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });
});

describe('raw file routes — allowlist enforcement', () => {
  it('refuses a raw read outside the allowlist with PATH_FORBIDDEN', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/agent-config/claude/raw?file=${encodeURIComponent('/etc/passwd')}`,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('PATH_FORBIDDEN');
  });

  it('refuses a traversal path built from an allowed directory with PATH_FORBIDDEN', async () => {
    // ~/.claude/skills is an allowed (dir) surface — walk out of it with `..`
    // to reach an otherwise-forbidden file, to prove the allowlist resolves
    // real paths rather than doing a string prefix match.
    const traversal = path.join(home, '.claude', 'skills', '..', '..', '.ssh', 'id_rsa');
    const res = await app.inject({
      method: 'GET',
      url: `/api/agent-config/claude/raw?file=${encodeURIComponent(traversal)}`,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('PATH_FORBIDDEN');
  });

  it('reads an allowed raw file', async () => {
    const file = path.join(home, '.claude/settings.json');
    await fs.writeFile(file, '{"theme":"dark"}');
    const res = await app.inject({
      method: 'GET',
      url: `/api/agent-config/claude/raw?file=${encodeURIComponent(file)}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ file, text: '{"theme":"dark"}' });
  });

  it('refuses a raw write outside the allowlist with PATH_FORBIDDEN and does not touch the filesystem', async () => {
    const outside = path.join(tmp, 'not-managed.json');
    const res = await app.inject({
      method: 'PUT',
      url: '/api/agent-config/claude/raw',
      payload: { file: outside, text: 'pwned' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('PATH_FORBIDDEN');
    await expect(fs.access(outside)).rejects.toThrow();
  });

  it('writes an allowed raw file', async () => {
    const file = path.join(home, '.claude/CLAUDE.md');
    const res = await app.inject({
      method: 'PUT',
      url: '/api/agent-config/claude/raw',
      payload: { file, text: '# hello' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ file, saved: true });
    expect(await fs.readFile(file, 'utf8')).toBe('# hello');
  });

  it('creates a brand-new raw file as 0600, never a umask-default world-readable mode', async () => {
    // ~/.claude.json — a declared, allowed global target (the `mcp` and
    // `mcp-approved` surfaces) — holds MCP `env` blocks and Claude's own
    // OAuth token. A first raw save through the editor must not hand every
    // other local user read access to it.
    const file = path.join(home, '.claude.json');
    await expect(fs.access(file)).rejects.toThrow(); // doesn't exist yet
    const res = await app.inject({
      method: 'PUT',
      url: '/api/agent-config/claude/raw',
      payload: { file, text: '{}' },
    });
    expect(res.statusCode).toBe(200);
    const mode = (await fs.stat(file)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('preserves an existing file\'s mode rather than rewriting it to a default', async () => {
    const file = path.join(home, '.claude/CLAUDE.md');
    await fs.writeFile(file, '# old');
    await fs.chmod(file, 0o640);
    const res = await app.inject({
      method: 'PUT',
      url: '/api/agent-config/claude/raw',
      payload: { file, text: '# new' },
    });
    expect(res.statusCode).toBe(200);
    const mode = (await fs.stat(file)).mode & 0o777;
    expect(mode).toBe(0o640);
  });

  it('rejects an unknown agent with NOT_FOUND before touching the filesystem', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/agent-config/nope/raw?file=${encodeURIComponent(path.join(home, '.claude/settings.json'))}`,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  // Final review fix #7: `writeSurface` git-excludes its `.backups` directory
  // for a project-scope write (engine.write.test.ts covers that path
  // directly), but `writeFileGuarded` — the raw-file route's write path —
  // did not, so repairing a broken `<worktree>/.mcp.json` through the raw
  // editor left an untracked `.claude/.backups` in `git status`. Exercised
  // through the raw PUT route itself, not the engine helper, since that's
  // the path that was actually missing the exclude.
  it('git-excludes the project-scope backups directory for a raw PUT, same as a surface patch', async () => {
    execFileSync('git', ['init', '-q'], { cwd: worktree });
    await fs.writeFile(path.join(worktree, '.claude/settings.json'), '{}');

    const file = path.join(worktree, '.claude/settings.json');
    const res = await app.inject({
      method: 'PUT',
      url: `/api/agent-config/claude/raw?worktree=${encodeURIComponent(worktree)}`,
      payload: { file, text: '{"custom":true}' },
    });
    expect(res.statusCode).toBe(200);

    const exclude = await fs.readFile(path.join(worktree, '.git/info/exclude'), 'utf8');
    expect(exclude).toContain('.claude/.backups/');
    const status = execFileSync('git', ['status', '--short', '--ignored'], { cwd: worktree, encoding: 'utf8' });
    expect(status).toContain('!! .claude/.backups/');
  });
});

describe('raw file routes — symlink policy shared with the engine', () => {
  it('writes a raw PUT through a dangling symlink instead of destroying it', async () => {
    // The symlink's target — including its parent directory — does not
    // exist yet: the common "dotfiles tree not materialized" case. Mirrors
    // engine.write.test.ts's identical scenario for writeSurface, but
    // exercised through the raw route.
    const target = path.join(home, 'dotfiles', 'nested', 'CLAUDE.md');
    const linkPath = path.join(home, '.claude', 'CLAUDE.md');
    await fs.symlink(target, linkPath);

    const res = await app.inject({
      method: 'PUT',
      url: '/api/agent-config/claude/raw',
      payload: { file: linkPath, text: '# hello' },
    });

    expect(res.statusCode).toBe(200);
    expect(await fs.readFile(target, 'utf8')).toBe('# hello');
    // The link itself must survive, still pointing at `target` — not be
    // replaced by a plain file.
    expect((await fs.lstat(linkPath)).isSymbolicLink()).toBe(true);
  });

  it('shares one write-target (and so one lock key) with writeSurface under a symlinked ANCESTOR directory', async () => {
    // Not the file itself — the directory ABOVE it. `home` here is a
    // symlink to the real directory (an automounted/NFS-style home, or a
    // chezmoi-managed `~/.claude` link), while settings.json underneath it
    // is a perfectly plain regular file. `fsp.realpath` resolves ancestor
    // symlinks; `resolveWriteTarget` deliberately does not (see its own
    // doc comment) — so a raw-write path that resolved the write target
    // via `realpath` (round 1) would compute a DIFFERENT string here than
    // `writeSurface`'s own resolution, meaning two different
    // `withFileLock` keys for the physically identical file.
    const realHome = await fs.mkdtemp(path.join(os.tmpdir(), 'api-agentconfig-realhome-'));
    await fs.mkdir(path.join(realHome, '.claude'), { recursive: true });
    await fs.writeFile(path.join(realHome, '.claude/settings.json'), '{}');
    const linkedHome = path.join(tmp, 'home-ancestor-link');
    await fs.symlink(realHome, linkedHome);

    const deps = await buildDeps({
      configDir: path.join(tmp, 'config2'),
      homeStateDir: path.join(tmp, 'state2'),
      agentHomeDir: linkedHome,
    });
    const linkedApp = await buildApp(deps);
    try {
      // Fired concurrently and unawaited-between: if the two write paths
      // computed different lock keys, these could interleave — the PATCH
      // reading `{}` before the raw PUT lands, then committing on that
      // stale read and silently discarding the raw PUT's content. With a
      // shared key, `withFileLock`'s per-file promise chain forces one to
      // run to completion before the other's body starts, so whichever
      // runs second always sees the first's result — the raw PUT's key is
      // never lost, however the two happen to interleave.
      const [patchRes, rawRes] = await Promise.all([
        linkedApp.inject({
          method: 'PATCH',
          url: '/api/agent-config/claude',
          payload: { surfaceId: 'effortLevel', scope: 'global', value: 'high' },
        }),
        linkedApp.inject({
          method: 'PUT',
          url: '/api/agent-config/claude/raw',
          payload: { file: path.join(linkedHome, '.claude/settings.json'), text: '{"custom":"fromRawPut"}' },
        }),
      ]);
      expect(patchRes.statusCode).toBe(200);
      expect(rawRes.statusCode).toBe(200);

      // Read the REAL file (not through the symlink) — proves both writes
      // landed on the identical inode, and that the raw PUT's own key
      // survived whichever write happened to run last.
      const doc = JSON.parse(await fs.readFile(path.join(realHome, '.claude/settings.json'), 'utf8'));
      expect(doc.custom).toBe('fromRawPut');
    } finally {
      await linkedApp.close();
    }
  });

  it('computes the identical write target as writeSurface for the same surface, deterministically (not timing-dependent)', async () => {
    // The property that must ALWAYS hold, asserted directly rather than
    // through a race's outcome (a race can pass by luck on one scheduling
    // and hide the bug on another — see the timing-sensitive version of
    // this test above). `home` is again a symlinked ancestor directory.
    const realHome = await fs.mkdtemp(path.join(os.tmpdir(), 'api-agentconfig-realhome-det-'));
    await fs.mkdir(path.join(realHome, '.claude'), { recursive: true });
    await fs.writeFile(path.join(realHome, '.claude/settings.json'), '{}');
    const linkedHome = path.join(tmp, 'home-ancestor-link-det');
    await fs.symlink(realHome, linkedHome);
    const ctx = { home: linkedHome };

    // What writeSurface computes internally for the 'model' surface's
    // global target (settings.json) — engine.ts's own `resolveTarget` then
    // `resolveWriteTarget`, called here through the same public exports it
    // uses, not by reaching into its module internals.
    const modelSurface = claudeDescriptor.surfaces.find((s) => s.id === 'model')!;
    const writeSurfaceTarget = await resolveWriteTarget(resolveTarget(modelSurface.global!, ctx));

    // What the raw route computes for a client naming the SAME real file
    // via the OTHER accepted spelling — the canonical, already-resolved
    // path, not the descriptor's own linkedHome-based one.
    const alternateSpelling = path.join(realHome, '.claude/settings.json');
    const declared = await resolveAllowedFile(claudeDescriptor, alternateSpelling, ctx);
    const rawRouteTarget = await resolveWriteTarget(declared);

    expect(rawRouteTarget).toBe(writeSurfaceTarget);
  });

  it('does not discard a raw PUT that names the file via the canonical (realpath) spelling instead of the descriptor\'s own', async () => {
    // The residual NB-4 scenario: a client is not required to send back the
    // exact spelling `GET /agents` reported — anything that resolves to the
    // same real file passes the allowlist. This fires a PATCH (which always
    // uses the descriptor's own linkedHome-based spelling internally) and a
    // raw PUT naming the file via realHome's canonical path — concurrently,
    // proving the raw PUT's write is never silently discarded regardless of
    // which accepted spelling the caller used.
    const realHome = await fs.mkdtemp(path.join(os.tmpdir(), 'api-agentconfig-realhome-alt-'));
    await fs.mkdir(path.join(realHome, '.claude'), { recursive: true });
    await fs.writeFile(path.join(realHome, '.claude/settings.json'), '{}');
    const linkedHome = path.join(tmp, 'home-ancestor-link-alt');
    await fs.symlink(realHome, linkedHome);

    const deps = await buildDeps({
      configDir: path.join(tmp, 'config3'),
      homeStateDir: path.join(tmp, 'state3'),
      agentHomeDir: linkedHome,
    });
    const linkedApp = await buildApp(deps);
    try {
      const [patchRes, rawRes] = await Promise.all([
        linkedApp.inject({
          method: 'PATCH',
          url: '/api/agent-config/claude',
          payload: { surfaceId: 'effortLevel', scope: 'global', value: 'high' },
        }),
        linkedApp.inject({
          method: 'PUT',
          url: '/api/agent-config/claude/raw',
          // The alternate, canonical spelling — NOT `linkedHome`-based.
          payload: { file: path.join(realHome, '.claude/settings.json'), text: '{"custom":"fromRawPut"}' },
        }),
      ]);
      expect(patchRes.statusCode).toBe(200);
      expect(rawRes.statusCode).toBe(200);

      const doc = JSON.parse(await fs.readFile(path.join(realHome, '.claude/settings.json'), 'utf8'));
      expect(doc.custom).toBe('fromRawPut');
    } finally {
      await linkedApp.close();
    }
  });
});

describe('remote forwarding (host=)', () => {
  const RUNNER_HTTP_BASE = 'https://fake-runner.test';
  let prevStradoHome: string | undefined;

  beforeEach(async () => {
    // runnerFetch's ticket mint reads the account token from
    // STRADO_HOME/license.json (via createCloudApi) — independent of
    // `agentHomeDir`, which is only the AGENT's home, never this app's own
    // state dir. See runners.killSession.route.test.ts for the same recipe.
    prevStradoHome = process.env.STRADO_HOME;
    const stradoHome = path.join(tmp, 'strado-home');
    await fs.mkdir(stradoHome, { recursive: true });
    await fs.writeFile(
      path.join(stradoHome, 'license.json'),
      JSON.stringify({ token: 'a'.repeat(64), name: 'Tester', deviceId: 'device-1', email: 'test@example.com' }),
    );
    process.env.STRADO_HOME = stradoHome;
  });

  afterEach(() => {
    if (prevStradoHome === undefined) delete process.env.STRADO_HOME;
    else process.env.STRADO_HOME = prevStradoHome;
    vi.unstubAllGlobals();
  });

  function stubRunner(onRunnerCall: (url: string, init?: RequestInit) => Response | Promise<Response>) {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = url.toString();
        calls.push({ url: u, init });
        if (u.includes('/v1/runners/socket-ticket')) {
          return new Response(
            JSON.stringify({
              ticket: 'tkt-1',
              httpBase: RUNNER_HTTP_BASE,
              expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (u.startsWith(RUNNER_HTTP_BASE)) return onRunnerCall(u, init);
        throw new Error(`unexpected fetch to ${u}`);
      }),
    );
    return calls;
  }

  it('forwards GET /agents to the runner with no extra query params', async () => {
    const calls = stubRunner(
      () => new Response(JSON.stringify({ agents: [{ id: 'claude', label: 'Claude', installed: true, files: [] }] }), { status: 200 }),
    );
    const res = await app.inject({ method: 'GET', url: '/api/agent-config/agents?host=runner-1' });
    expect(res.statusCode).toBe(200);
    expect(res.json().agents[0].id).toBe('claude');
    const runnerCall = calls.find((c) => c.url.startsWith(RUNNER_HTTP_BASE));
    expect(runnerCall).toBeTruthy();
    const u = new URL(runnerCall!.url);
    expect(u.pathname).toBe('/api/agent-config/agents');
    expect(u.searchParams.get('host')).toBeNull();
  });

  it('strips host from a forwarded GET /:agent while keeping scope and worktree', async () => {
    const calls = stubRunner(
      () => new Response(JSON.stringify({ agent: 'claude', scope: 'project', surfaces: [] }), { status: 200 }),
    );
    const res = await app.inject({
      method: 'GET',
      url: `/api/agent-config/claude?scope=project&worktree=${encodeURIComponent(worktree)}&host=runner-1`,
    });
    expect(res.statusCode).toBe(200);
    const runnerCall = calls.find((c) => c.url.startsWith(RUNNER_HTTP_BASE));
    const u = new URL(runnerCall!.url);
    expect(u.pathname).toBe('/api/agent-config/claude');
    expect(u.searchParams.get('host')).toBeNull();
    expect(u.searchParams.get('scope')).toBe('project');
    expect(u.searchParams.get('worktree')).toBe(worktree);
  });

  it('returns the far side response body to the caller unchanged', async () => {
    stubRunner(
      () => new Response(JSON.stringify({ agent: 'claude', scope: 'global', surfaces: [{ id: 'theme', value: 'dark' }] }), {
        status: 200,
      }),
    );
    const res = await app.inject({ method: 'GET', url: '/api/agent-config/claude?scope=global&host=runner-1' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ agent: 'claude', scope: 'global', surfaces: [{ id: 'theme', value: 'dark' }] });
  });

  it('forwards a DELETE skill request and strips host from the query', async () => {
    const calls = stubRunner(
      () => new Response(JSON.stringify({ agent: 'claude', scope: 'global', surfaces: [] }), { status: 200 }),
    );
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/agent-config/claude/skills/brainstorming?scope=global&host=runner-1',
    });
    expect(res.statusCode).toBe(200);
    const runnerCall = calls.find((c) => c.url.startsWith(RUNNER_HTTP_BASE));
    expect(runnerCall!.init?.method).toBe('DELETE');
    const u = new URL(runnerCall!.url);
    expect(u.pathname).toBe('/api/agent-config/claude/skills/brainstorming');
    expect(u.searchParams.get('host')).toBeNull();
    expect(u.searchParams.get('scope')).toBe('global');
  });

  it('forwards a PATCH body and strips host from the query', async () => {
    const calls = stubRunner(
      () => new Response(JSON.stringify({ agent: 'claude', scope: 'global', surfaces: [] }), { status: 200 }),
    );
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/agent-config/claude?host=runner-1',
      payload: { surfaceId: 'theme', scope: 'global', value: 'light' },
    });
    expect(res.statusCode).toBe(200);
    const runnerCall = calls.find((c) => c.url.startsWith(RUNNER_HTTP_BASE));
    expect(runnerCall!.init?.method).toBe('PATCH');
    expect(JSON.parse(runnerCall!.init!.body as string)).toEqual({
      surfaceId: 'theme', scope: 'global', value: 'light',
    });
    expect(new URL(runnerCall!.url).searchParams.get('host')).toBeNull();
  });

  it('forwards raw GET keeping file and worktree, stripping host', async () => {
    const calls = stubRunner(() => new Response(JSON.stringify({ file: '/remote/f', text: 'y' }), { status: 200 }));
    const res = await app.inject({
      method: 'GET',
      url: `/api/agent-config/claude/raw?file=${encodeURIComponent('/remote/settings.json')}&worktree=${encodeURIComponent(worktree)}&host=runner-1`,
    });
    expect(res.statusCode).toBe(200);
    const runnerCall = calls.find((c) => c.url.startsWith(RUNNER_HTTP_BASE));
    const u = new URL(runnerCall!.url);
    expect(u.searchParams.get('host')).toBeNull();
    expect(u.searchParams.get('file')).toBe('/remote/settings.json');
    expect(u.searchParams.get('worktree')).toBe(worktree);
  });

  it('forwards a raw PUT body and strips host from the query', async () => {
    const calls = stubRunner(
      () => new Response(JSON.stringify({ file: '/remote/CLAUDE.md', saved: true }), { status: 200 }),
    );
    const res = await app.inject({
      method: 'PUT',
      url: '/api/agent-config/claude/raw?host=runner-1',
      payload: { file: '/remote/CLAUDE.md', text: 'hi' },
    });
    expect(res.statusCode).toBe(200);
    const runnerCall = calls.find((c) => c.url.startsWith(RUNNER_HTTP_BASE));
    expect(runnerCall!.init?.method).toBe('PUT');
    expect(JSON.parse(runnerCall!.init!.body as string)).toEqual({ file: '/remote/CLAUDE.md', text: 'hi' });
    expect(new URL(runnerCall!.url).searchParams.get('host')).toBeNull();
  });

  it('never calls out to the network when host is "local"', async () => {
    const calls = stubRunner(() => {
      throw new Error('must not reach the runner');
    });
    const res = await app.inject({ method: 'GET', url: '/api/agent-config/claude?scope=global&host=local' });
    expect(res.statusCode).toBe(200);
    expect(calls).toHaveLength(0);
  });

  it('never calls out to the network when host is absent', async () => {
    const calls = stubRunner(() => {
      throw new Error('must not reach the runner');
    });
    const res = await app.inject({ method: 'GET', url: '/api/agent-config/claude?scope=global' });
    expect(res.statusCode).toBe(200);
    expect(calls).toHaveLength(0);
  });
});
