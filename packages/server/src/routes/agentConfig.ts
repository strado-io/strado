// Settings → Coding agents: list agents, read/patch their config surfaces,
// and read/write a raw config file directly. Device-global (registered at
// root, not under /api/w/:wsId) — an agent's config lives under its own
// home or a worktree, never inside a Strado workspace.
import fsp from 'node:fs/promises';
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { descriptors } from '../services/agentConfig/descriptors/claude.js';
import { readSurfaces, writeSurface, writeFileGuarded, resolveWriteTarget } from '../services/agentConfig/engine.js';
import { dirDriver } from '../services/agentConfig/formats/dir.js';
import { resolveAllowedFile, resolveTarget, allowedFiles, type ResolveCtx } from '../services/agentConfig/targets.js';
import { checkTools, type ToolStatus } from '../services/toolCheck.js';
import { INSTALL_CHANNEL, type InstallEvent } from '../services/toolInstall.js';
import type { AgentSummary, Scope } from '../services/agentConfig/types.js';
import type { RunnerFetch } from '../services/runnerFetch.js';

const PatchBody = z.object({
  surfaceId: z.string().min(1),
  scope: z.enum(['global', 'project']),
  worktree: z.string().min(1).optional(),
  value: z.unknown(),
});

const RawBody = z.object({ file: z.string().min(1), text: z.string() });

// All agents Strado knows how to launch (the terminal tabs' `AgentMode`),
// independent of whether a config descriptor exists for one yet. `GET
// /agents` must list every one of these — not just `Object.values(descriptors)`
// — or an agent Strado can run but can't yet configure (Codex today) simply
// vanishes from the panel instead of showing up as "not yet supported".
const KNOWN_AGENTS: { id: string; label: string; toolCheckId: string }[] = [
  { id: 'claude', label: 'Claude', toolCheckId: 'claude' },
  { id: 'codex', label: 'Codex', toolCheckId: 'codex' },
  { id: 'opencode', label: 'OpenCode', toolCheckId: 'opencode' },
  { id: 'pi', label: 'Pi', toolCheckId: 'pi' },
];

function descriptorOr404(agent: string) {
  const d = descriptors[agent];
  if (!d) throw new AppError('NOT_FOUND', `unknown agent ${agent}`);
  return d;
}

function parseScope(raw: string | undefined): Scope {
  const scope = raw ?? 'global';
  if (scope !== 'global' && scope !== 'project') {
    throw new AppError('VALIDATION', `unknown scope ${scope}`);
  }
  return scope;
}

function ctxFor(home: string, scope: Scope, worktree?: string): ResolveCtx {
  if (scope === 'project' && !worktree) {
    throw new AppError('VALIDATION', 'project scope requires a worktree');
  }
  return { home, worktree };
}

function isRemote(host: string | undefined): host is string {
  return !!host && host !== 'local';
}

// Strips `host` before handing the request on to the runner it names: the
// runner's own server answers this same route on its own filesystem, and a
// `host` param surviving the hop would make IT try to forward again (to
// itself, or whatever "host" happens to resolve to from its side) instead of
// finally executing locally.
function stripHost(url: string): string {
  const parsed = new URL(url, 'http://internal');
  parsed.searchParams.delete('host');
  return `${parsed.pathname}${parsed.search}`;
}

export type AgentConfigRouteOpts = { runnerFetch: RunnerFetch };

export async function registerAgentConfigRoutes(
  app: FastifyInstance,
  { runnerFetch }: AgentConfigRouteOpts,
): Promise<void> {
  // The user's real home — never STRADO_HOME (~/.strado, this app's own state
  // dir). `agentHomeDir` is shared with usage tracking and is overridable via
  // buildDeps({ agentHomeDir }) in tests.
  const home = () => app.deps.agentHomeDir;

  // A second `checkTools()` cache, deliberately not the SAME instance as
  // envCheck.ts's: that one lives in a closure private to
  // registerEnvCheckRoutes with no exported accessor, so sharing it would
  // mean restructuring how both routes are wired into app.ts rather than a
  // fix scoped to this file. Same probe, same bus-driven invalidation — an
  // install still flips this route's `installed` flag without a full
  // re-probe — just a second cache rather than a shared one.
  let toolsCache: ToolStatus[] | null = null;
  app.deps.bus.on(INSTALL_CHANNEL, (evt) => {
    const { type, data } = evt as InstallEvent;
    if (type !== 'done' || !data.tool || !toolsCache) return;
    toolsCache = toolsCache.map((t) => (t.id === data.tool!.id ? data.tool! : t));
  });
  async function cachedTools(): Promise<ToolStatus[]> {
    if (!toolsCache) toolsCache = await checkTools();
    return toolsCache;
  }

  app.get<{ Querystring: { host?: string } }>('/api/agent-config/agents', async (req) => {
    if (isRemote(req.query.host)) {
      return runnerFetch.fetch(req.query.host, '/api/agent-config/agents');
    }

    const tools = await cachedTools();
    // `installed` (the CLI is on this machine, from checkTools) and
    // `supported` (Strado has a descriptor, so the panel can actually manage
    // its config) are independent — an agent can be installed but
    // unsupported (Codex today), supported but not installed, both, or
    // neither. Reporting an installed-but-unsupported agent as
    // `installed: false` would be the panel lying about the user's own
    // system, which is exactly the failure mode this endpoint exists to
    // avoid.
    const agents: AgentSummary[] = KNOWN_AGENTS.map((known) => {
      const descriptor = descriptors[known.id];
      return {
        id: known.id,
        label: descriptor?.label ?? known.label,
        installed: tools.find((t) => t.id === known.toolCheckId)?.found ?? false,
        supported: descriptor !== undefined,
        // No descriptor means no declared config surfaces to read files
        // from — an empty list, never a guess.
        files: descriptor ? allowedFiles(descriptor, { home: home() }) : [],
      };
    });
    return { agents };
  });

  app.get<{ Params: { agent: string }; Querystring: { scope?: string; worktree?: string; host?: string } }>(
    '/api/agent-config/:agent',
    async (req) => {
      const scope = parseScope(req.query.scope);
      if (isRemote(req.query.host)) {
        return runnerFetch.fetch(req.query.host, stripHost(req.url));
      }

      const descriptor = descriptorOr404(req.params.agent);
      const ctx = ctxFor(home(), scope, req.query.worktree);
      const surfaces = await readSurfaces(descriptor, scope, ctx);
      return { agent: req.params.agent, scope, surfaces };
    },
  );

  app.patch<{ Params: { agent: string }; Querystring: { host?: string } }>(
    '/api/agent-config/:agent',
    async (req) => {
      const body = PatchBody.parse(req.body);
      if (isRemote(req.query.host)) {
        return runnerFetch.fetch(req.query.host, stripHost(req.url), { method: 'PATCH', body });
      }

      const descriptor = descriptorOr404(req.params.agent);
      const ctx = ctxFor(home(), body.scope, body.worktree);
      const surfaces = await writeSurface(descriptor, body.surfaceId, body.scope, body.value, ctx);
      return { agent: req.params.agent, scope: body.scope, surfaces };
    },
  );

  // Removes one skill directory (moved into `.backups`, never destroyed —
  // see dirDriver.remove) at the given scope. `writeSurface` refuses every
  // `dir`-format surface with "use the skills route" (there's no single JSON
  // key to patch for a directory listing); this is that route.
  app.delete<{
    Params: { agent: string; name: string };
    Querystring: { scope?: string; worktree?: string; host?: string };
  }>('/api/agent-config/:agent/skills/:name', async (req) => {
    const scope = parseScope(req.query.scope);
    if (isRemote(req.query.host)) {
      return runnerFetch.fetch(req.query.host, stripHost(req.url), { method: 'DELETE' });
    }

    const descriptor = descriptorOr404(req.params.agent);
    const ctx = ctxFor(home(), scope, req.query.worktree);

    const surface = descriptor.surfaces.find((s) => s.kind === 'skill-list');
    if (!surface) throw new AppError('NOT_FOUND', `${req.params.agent} has no skills surface`);
    const target = scope === 'global' ? surface.global : surface.project;
    if (!target || target.format !== 'dir') {
      throw new AppError('VALIDATION', `${req.params.agent} has no ${scope}-scope skills directory`);
    }

    const dir = resolveTarget(target, ctx);
    // Same allowlist the raw-file routes gate on — proof `dir` really is one
    // of this descriptor's own declared directories for this agent, not
    // wherever a future refactor of the lookup above happened to point.
    const allowed = allowedFiles(descriptor, ctx);
    if (!allowed.includes(dir)) {
      throw new AppError('PATH_FORBIDDEN', `${dir} is not a managed skills directory`, {
        target: dir,
        allowedRoots: allowed,
      });
    }

    await dirDriver.remove(dir, req.params.name);
    const surfaces = await readSurfaces(descriptor, scope, ctx);
    return { agent: req.params.agent, scope, surfaces };
  });

  app.get<{ Params: { agent: string }; Querystring: { file?: string; worktree?: string; host?: string } }>(
    '/api/agent-config/:agent/raw',
    async (req) => {
      if (isRemote(req.query.host)) {
        return runnerFetch.fetch(req.query.host, stripHost(req.url));
      }

      const descriptor = descriptorOr404(req.params.agent);
      const file = req.query.file;
      if (!file) throw new AppError('VALIDATION', 'file is required');
      const ctx: ResolveCtx = { home: home(), worktree: req.query.worktree };
      // Allowlist gate BEFORE any filesystem access — `file` is untrusted
      // input that, unchecked, would make this an arbitrary file read
      // reachable over a relay tunnel from any paired host. Read the path
      // THIS check resolved, not `file` again — see resolveAllowedFile's doc.
      const resolved = await resolveAllowedFile(descriptor, file, ctx);
      // A declared-but-not-yet-created config file (e.g. no .mcp.json in a
      // brand new project) reads as empty rather than 404 — the raw editor
      // opens on a blank file the user can fill in and save.
      const text = await fsp.readFile(resolved, 'utf8').catch(() => '');
      return { file, text };
    },
  );

  app.put<{ Params: { agent: string }; Querystring: { worktree?: string; host?: string } }>(
    '/api/agent-config/:agent/raw',
    async (req) => {
      const body = RawBody.parse(req.body);
      if (isRemote(req.query.host)) {
        return runnerFetch.fetch(req.query.host, stripHost(req.url), { method: 'PUT', body });
      }

      const descriptor = descriptorOr404(req.params.agent);
      const ctx: ResolveCtx = { home: home(), worktree: req.query.worktree };
      // Allowlist gate on the caller's declared path — same check as the
      // read above, this is the write half of the same arbitrary-file
      // primitive. Crucially, use what it RETURNS (the descriptor's own
      // declared spelling for the matching surface), not `body.file` and
      // not a realpath of either — see resolveAllowedFile's own doc. Any
      // OTHER spelling fed into `resolveWriteTarget` below — the caller's
      // own string, or its realpath — would compute a different
      // `withFileLock` key than `writeSurface` does for the identical
      // file, letting a raw PUT and a surface PATCH race past each other's
      // lock undetected under a symlinked ancestor directory.
      const declared = await resolveAllowedFile(descriptor, body.file, ctx);
      // The actual write target is resolved through the SAME symlink policy
      // `writeSurface` uses (`resolveWriteTarget`, exported from the
      // engine) — not a second, realpath-based resolution of our own. It
      // throws outright on a dangling symlink instead of walking its
      // chain, so `writeAtomic`'s rename would land on — and destroy —
      // the link itself rather than creating its (not-yet-existing) real
      // target.
      const target = await resolveWriteTarget(declared);
      // Same lock/backup/atomic-write/mode-preservation guarantees as a
      // surface patch (`writeSurface`) — a bare `fsp.writeFile` here would
      // both race a concurrent PATCH to the same file and default a
      // brand-new file (e.g. a first-ever `.mcp.json`, holding MCP `env`
      // API keys) to a world-readable mode instead of 0600.
      await writeFileGuarded(target, body.text, ctx.worktree);
      return { file: body.file, saved: true };
    },
  );
}
