import path from 'node:path';
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { assertPathUnder } from '../paths.js';
import { exec } from '../shell.js';
import { findOwningRepo, worktreeRootsFor } from '../services/worktreeRoot.js';
import { claudeKey, codexKey, opencodeKey, piKey } from '../services/terminalManager.js';
import { collectAgentConversation } from '../services/agentConversation.js';
import { handoffPrompt, type AgentMode } from '../services/handoffStore.js';
import type { RepoConfigStore } from '../repoConfig.js';

const AgentModeSchema = z.enum(['claude', 'codex', 'opencode', 'pi']);
const SessionIdSchema = z.string().regex(/^\d+$/);

const CreateBody = z.object({
  source: z.object({ mode: AgentModeSchema, sessionId: SessionIdSchema }),
  target: z.object({ mode: AgentModeSchema, sessionId: SessionIdSchema }),
  notes: z.string().max(4_000).default(''),
}).refine((body) => body.source.mode !== body.target.mode || body.source.sessionId !== body.target.sessionId, {
  message: 'source and target sessions must be different',
});

function sessionKey(worktreePath: string, mode: AgentMode, id: string): string {
  return mode === 'codex' ? codexKey(worktreePath, id)
    : mode === 'opencode' ? opencodeKey(worktreePath, id)
    : mode === 'pi' ? piKey(worktreePath, id)
    : claudeKey(worktreePath, id);
}

export async function registerHandoffRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { encodedPath: string } }>('/worktrees/:encodedPath/handoffs', async (req) => {
    const target = await ownedPath(app, req.workspace!.stores.repos, req.params.encodedPath);
    return { handoffs: await req.workspace!.stores.handoffs.list(target) };
  });

  app.post<{ Params: { encodedPath: string } }>('/worktrees/:encodedPath/handoffs', async (req, reply) => {
    const body = CreateBody.parse(req.body);
    const target = await ownedPath(app, req.workspace!.stores.repos, req.params.encodedPath);
    const targetKey = sessionKey(target, body.target.mode, body.target.sessionId);
    if (app.deps.terminal.status(targetKey).status === 'running') {
      throw new AppError('PROCESS_ALREADY_RUNNING', `${body.target.mode} session ${body.target.sessionId} is already running`);
    }

    const [head, porcelain, unstaged, staged] = await Promise.all([
      exec('git', ['-C', target, 'rev-parse', 'HEAD']),
      exec('git', ['-C', target, 'status', '--short']),
      exec('git', ['-C', target, 'diff', '--stat']),
      exec('git', ['-C', target, 'diff', '--cached', '--stat']),
    ]);
    const gitStatus = await app.deps.status.status(target);
    const meta = await req.workspace!.stores.state.get(target);
    const label = meta?.ticketId?.trim() || meta?.title?.trim() || path.basename(target);
    const sourceReference = await app.deps.agentSessions.get(
      body.source.mode,
      target,
      body.source.sessionId,
    );
    const conversation = await collectAgentConversation(
      body.source.mode,
      target,
      sourceReference,
      { homeDir: app.deps.agentHomeDir },
    );
    const diffStat = [unstaged.stdout.trim(), staged.stdout.trim()].filter(Boolean).join('\n');
    const record = await req.workspace!.stores.handoffs.create({
      workspaceId: req.workspace!.id,
      worktreePath: target,
      taskLabel: label,
      source: body.source,
      target: body.target,
      notes: body.notes,
      conversation: conversation.messages,
      contextSource: conversation.source,
      repository: {
        branch: gitStatus.branch,
        head: head.stdout.trim(),
        status: porcelain.stdout.split('\n').map((line) => line.trimEnd()).filter(Boolean),
        diffStat,
      },
    });
    return reply.code(201).send({ handoff: record, prompt: handoffPrompt(record) });
  });

  app.delete<{ Params: { encodedPath: string; handoffId: string } }>(
    '/worktrees/:encodedPath/handoffs/:handoffId',
    async (req, reply) => {
      const target = await ownedPath(app, req.workspace!.stores.repos, req.params.encodedPath);
      const record = await req.workspace!.stores.handoffs.get(req.params.handoffId);
      if (!record || record.worktreePath !== target) throw new AppError('NOT_FOUND', 'handoff not found');
      await req.workspace!.stores.handoffs.cancel(record.id);
      return reply.code(204).send();
    },
  );
}

async function ownedPath(
  app: FastifyInstance,
  repos: RepoConfigStore,
  encodedPath: string,
): Promise<string> {
  const target = decodeURIComponent(encodedPath);
  const allRepos = await repos.list();
  const repo = findOwningRepo(allRepos, target, app.deps.homeStateDir, { includeRepoRoot: true });
  if (!repo) throw new AppError('NOT_FOUND', `no repo owns ${target}`);
  assertPathUnder(target, [repo.path, ...worktreeRootsFor(app.deps.homeStateDir, repo)]);
  return target;
}
