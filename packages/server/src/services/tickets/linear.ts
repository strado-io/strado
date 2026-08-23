import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { AppError } from '../../errors.js';
import type { TicketIssue, TicketProvider, TicketSprint, TicketTransition, TicketBatchResult } from './types.js';

const ConfigSchema = z.object({ accessToken: z.string().min(1), workspaceName: z.string() });
export type LinearConfig = z.infer<typeof ConfigSchema>;

const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9]*-\d+$/;
const GRAPHQL_URL = 'https://api.linear.app/graphql';

export function linearConfigPath(): string {
  const home = process.env.STRADO_HOME || path.join(os.homedir(), '.strado');
  return path.join(home, 'linear.json');
}

export async function readLinearConfig(): Promise<LinearConfig | null> {
  // Clear cache when home directory changes (test isolation);
  // within a test, same home = cache persists.
  const home = process.env.STRADO_HOME || path.join(os.homedir(), '.strado');
  if (home !== lastHome) {
    lastHome = home;
    cache.clear();
  }
  try {
    return ConfigSchema.parse(JSON.parse(await fsp.readFile(linearConfigPath(), 'utf8')));
  } catch {
    return null;
  }
}

export async function deleteLinearConfig(): Promise<void> {
  await fsp.rm(linearConfigPath(), { force: true });
}

async function gqlRaw(accessToken: string, query: string, variables?: Record<string, unknown>): Promise<{ data?: Record<string, unknown> | null }> {
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (res.status === 401 || res.status === 403) {
    throw new AppError('VALIDATION', 'Linear rejected the token — reconnect in Connections settings');
  }
  if (!res.ok) throw new AppError('SHELL_FAILED', `Linear responded ${res.status}`);
  const body = (await res.json()) as { data?: Record<string, unknown> | null; errors?: Array<{ message?: string }> };
  // A whole-query failure has no data at all — that must not be treated as
  // "everything came back empty" (e.g. a batch caching every key as missing).
  // Errors coexisting WITH data (one alias missing) is the intended
  // partial-batch path and is left to the caller.
  if (body.errors && body.errors.length > 0 && (body.data === null || body.data === undefined)) {
    const first = body.errors[0]?.message ?? 'unknown error';
    throw new AppError('SHELL_FAILED', `Linear GraphQL error: ${first.slice(0, 120)}`);
  }
  return body;
}

// Validates the token against Linear before persisting (same policy as writeJiraConfig).
export async function writeLinearConfig(accessToken: string): Promise<{ workspaceName: string }> {
  const body = await gqlRaw(accessToken, '{ organization { name } }');
  const workspaceName = (body.data?.organization as { name?: string } | undefined)?.name ?? 'Linear';
  const file = linearConfigPath();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify({ accessToken, workspaceName }, null, 2), { mode: 0o600 });
  return { workspaceName };
}

async function requireConfig(): Promise<LinearConfig> {
  const cfg = await readLinearConfig();
  if (!cfg) throw new AppError('VALIDATION', 'Linear is not connected — open Connections in settings');
  return cfg;
}

type IssueNode = {
  identifier?: string; title?: string; url?: string; estimate?: number | null;
  priority?: number | null; priorityLabel?: string | null;
  state?: { name?: string; type?: string } | null;
  assignee?: { name?: string } | null;
};

const ISSUE_FIELDS = 'identifier title url estimate priority priorityLabel state { name type } assignee { name }';

function toCategory(type: string | undefined): TicketIssue['category'] {
  if (type === 'completed' || type === 'canceled') return 'done';
  if (type === 'started') return 'indeterminate';
  return 'new'; // backlog | unstarted | triage | unknown
}

function toIssue(node: IssueNode): TicketIssue {
  return {
    provider: 'linear',
    key: (node.identifier ?? '').toUpperCase(),
    summary: node.title ?? '',
    status: node.state?.name ?? 'Unknown',
    category: toCategory(node.state?.type),
    assignee: node.assignee?.name ?? null,
    priority: node.priority ? node.priorityLabel ?? null : null,
    estimate: node.estimate != null ? String(node.estimate) : null,
    url: node.url ?? '',
    timeSpent: null, remaining: null, timeSpentSeconds: null, remainingSeconds: null,
  };
}

// Module-level cache, same TTLs as the Jira service (services/jira.ts).
const cache = new Map<string, { at: number; issue: TicketIssue | null }>();
const HIT_TTL_MS = 45_000;
const MISS_TTL_MS = 10 * 60_000;
let lastHome = '';

export function createLinearTicketProvider(): TicketProvider {
  return {
    id: 'linear',
    label: 'Linear',
    configured: async () => (await readLinearConfig()) !== null,

    getMyOpenIssues: async () => {
      const cfg = await requireConfig();
      const body = await gqlRaw(cfg.accessToken, `{ viewer { assignedIssues(first: 50, orderBy: updatedAt, filter: { state: { type: { nin: ["completed", "canceled"] } } }) { nodes { ${ISSUE_FIELDS} } } } }`);
      const nodes = ((body.data?.viewer as { assignedIssues?: { nodes?: IssueNode[] } } | undefined)?.assignedIssues?.nodes) ?? [];
      return nodes.map(toIssue);
    },

    getSprints: async () => {
      const cfg = await requireConfig();
      const body = await gqlRaw(cfg.accessToken, '{ cycles(first: 50, filter: { or: [{ isActive: { eq: true } }, { isFuture: { eq: true } }] }) { nodes { id name number startsAt endsAt isActive team { key } } } }');
      type CycleNode = { id: string; name: string | null; number: number; startsAt: string | null; endsAt: string | null; isActive: boolean; team?: { key?: string } };
      const nodes = ((body.data?.cycles as { nodes?: CycleNode[] } | undefined)?.nodes) ?? [];
      const day = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
      return nodes.map((c): TicketSprint => ({
        id: c.id,
        name: c.name ?? `${c.team?.key ?? 'Team'} Cycle ${c.number}`,
        state: c.isActive ? 'active' : 'future',
        startDate: day(c.startsAt),
        endDate: day(c.endsAt),
      })).sort((a, b) => (a.state === b.state ? a.name.localeCompare(b.name) : a.state === 'active' ? -1 : 1));
    },

    getSprintIssues: async (sprintId, onlyMine) => {
      const cfg = await requireConfig();
      if (!/^[A-Za-z0-9-]{8,64}$/.test(sprintId)) throw new AppError('VALIDATION', `invalid cycle id: ${sprintId}`);
      const filter = onlyMine ? ', filter: { assignee: { isMe: { eq: true } } }' : '';
      const body = await gqlRaw(cfg.accessToken, `query($id: String!) { cycle(id: $id) { issues(first: 100${filter}) { nodes { ${ISSUE_FIELDS} } } } }`, { id: sprintId });
      const nodes = ((body.data?.cycle as { issues?: { nodes?: IssueNode[] } } | undefined)?.issues?.nodes) ?? [];
      return nodes.map(toIssue).filter((i) => i.category !== 'done');
    },

    getIssue: async (key) => {
      if (!KEY_PATTERN.test(key)) throw new AppError('VALIDATION', `invalid issue key: ${key}`);
      const cfg = await requireConfig();
      const body = await gqlRaw(cfg.accessToken, 'query($id: String!) { issue(id: $id) { ' + ISSUE_FIELDS + ' } }', { id: key.toUpperCase() });
      const node = body.data?.issue as IssueNode | null | undefined;
      if (!node) throw new AppError('NOT_FOUND', 'Linear issue not found');
      const issue = toIssue(node);
      cache.set(issue.key, { at: Date.now(), issue });
      return issue;
    },

    getIssues: async (keys): Promise<TicketBatchResult> => {
      const cfg = await requireConfig();
      const valid = [...new Set(keys.map((k) => k.toUpperCase()))].filter((k) => KEY_PATTERN.test(k)).slice(0, 100);
      const now = Date.now();
      const issues: Record<string, TicketIssue> = {};
      const missing: string[] = [];
      const unknown: string[] = [];
      for (const k of valid) {
        const hit = cache.get(k);
        if (hit && hit.issue && now - hit.at < HIT_TTL_MS) issues[k] = hit.issue;
        else if (hit && hit.issue === null && now - hit.at < MISS_TTL_MS) missing.push(k);
        else unknown.push(k);
      }
      if (unknown.length > 0) {
        // One request: alias per key. Keys are regex-validated above, safe to inline.
        const q = `{ ${unknown.map((k, i) => `i${i}: issue(id: "${k}") { ${ISSUE_FIELDS} }`).join(' ')} }`;
        const body = await gqlRaw(cfg.accessToken, q);
        if (!body.data) throw new AppError('SHELL_FAILED', 'Linear GraphQL error: response had no data');
        unknown.forEach((k, i) => {
          const node = body.data?.[`i${i}`] as IssueNode | null | undefined;
          if (node) {
            const issue = toIssue(node);
            cache.set(issue.key, { at: now, issue });
            issues[issue.key] = issue;
          } else {
            cache.set(k, { at: now, issue: null });
            missing.push(k);
          }
        });
      }
      return { issues, missing };
    },

    getTransitions: async (key) => {
      if (!KEY_PATTERN.test(key)) throw new AppError('VALIDATION', `invalid issue key: ${key}`);
      const cfg = await requireConfig();
      const body = await gqlRaw(cfg.accessToken, 'query($id: String!) { issue(id: $id) { team { states(first: 50) { nodes { id name type position } } } } }', { id: key.toUpperCase() });
      type StateNode = { id: string; name: string; type: string; position: number };
      const nodes = (((body.data?.issue as { team?: { states?: { nodes?: StateNode[] } } } | null | undefined)?.team?.states?.nodes) ?? []) as StateNode[];
      return [...nodes].sort((a, b) => a.position - b.position).map((s): TicketTransition => ({
        id: s.id, name: s.name, toStatus: s.name, toCategory: toCategory(s.type),
      }));
    },

    doTransition: async (key, transitionId) => {
      if (!KEY_PATTERN.test(key)) throw new AppError('VALIDATION', `invalid issue key: ${key}`);
      if (!/^[A-Za-z0-9-]{1,64}$/.test(transitionId)) throw new AppError('VALIDATION', `invalid state id: ${transitionId}`);
      const cfg = await requireConfig();
      const body = await gqlRaw(cfg.accessToken, `mutation($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success issue { ${ISSUE_FIELDS} } } }`, { id: key.toUpperCase(), stateId: transitionId });
      const node = (body.data?.issueUpdate as { success?: boolean; issue?: IssueNode } | undefined)?.issue;
      if (!node) throw new AppError('SHELL_FAILED', 'Linear did not confirm the update');
      const issue = toIssue(node);
      cache.set(issue.key, { at: Date.now(), issue });
      return issue;
    },
  };
}
