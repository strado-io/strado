import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { AppError } from '../errors.js';

// Credentials live OUTSIDE the repo on purpose — the API token must never
// end up in git. Saved to ~/.strado/jira.json via the Jira Connection
// settings dialog (or by hand):
//   { "baseUrl": "https://yourorg.atlassian.net", "email": "you@org.com", "apiToken": "..." }
const ConfigSchema = z.object({
  baseUrl: z.string().url(),
  email: z.string().email(),
  apiToken: z.string().min(1),
});
export type JiraConfig = z.infer<typeof ConfigSchema>;

export type JiraIssue = {
  key: string;
  summary: string;
  status: string;
  // Jira's three status buckets: new (todo), indeterminate (in progress), done.
  category: 'new' | 'indeterminate' | 'done';
  assignee: string | null;
  priority: string | null;
  // Jira time tracking, human-form ("2d 4h") — null when not estimated/logged.
  estimate: string | null;
  timeSpent: string | null;
  remaining: string | null;
  // Seconds versions so the UI can draw Jira's progress bar.
  timeSpentSeconds: number | null;
  remainingSeconds: number | null;
};

const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

export function jiraConfigPath(): string {
  // Honors the same override as the rest of the machine-local state so
  // isolated instances (fresh-user testing) don't see the real credentials.
  const home = process.env.STRADO_HOME || path.join(os.homedir(), '.strado');
  return path.join(home, 'jira.json');
}

export async function readJiraConfig(): Promise<JiraConfig | null> {
  try {
    const raw = await fsp.readFile(jiraConfigPath(), 'utf8');
    return ConfigSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

// Validates the credentials against Jira before persisting; a typo'd token
// should fail loudly here, not as mystery VALIDATION errors on every poll.
export async function writeJiraConfig(input: unknown): Promise<{ accountName: string }> {
  const cfg = ConfigSchema.parse(input);
  const me = (await jiraFetch(cfg, '/rest/api/3/myself')) as { displayName?: string };
  const file = jiraConfigPath();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  return { accountName: me?.displayName ?? cfg.email };
}

export async function testJiraConfig(): Promise<{ accountName: string }> {
  const cfg = await readJiraConfig();
  if (!cfg) throw new AppError('VALIDATION', 'Jira is not connected');
  const me = (await jiraFetch(cfg, '/rest/api/3/myself')) as { displayName?: string };
  return { accountName: me?.displayName ?? cfg.email };
}

function authHeaders(cfg: JiraConfig): Record<string, string> {
  const token = Buffer.from(`${cfg.email}:${cfg.apiToken}`).toString('base64');
  return { authorization: `Basic ${token}`, accept: 'application/json' };
}

type IssueFields = {
  summary?: string;
  status?: { name?: string; statusCategory?: { key?: string } };
  assignee?: { displayName?: string } | null;
  priority?: { name?: string } | null;
  timetracking?: {
    originalEstimate?: string;
    timeSpent?: string;
    remainingEstimate?: string;
    timeSpentSeconds?: number;
    remainingEstimateSeconds?: number;
  } | null;
};

function toIssue(key: string, fields: IssueFields | undefined): JiraIssue {
  const catKey = fields?.status?.statusCategory?.key;
  return {
    key: key.toUpperCase(),
    summary: fields?.summary ?? '',
    status: fields?.status?.name ?? 'Unknown',
    category: catKey === 'done' ? 'done' : catKey === 'indeterminate' ? 'indeterminate' : 'new',
    assignee: fields?.assignee?.displayName ?? null,
    priority: fields?.priority?.name ?? null,
    estimate: fields?.timetracking?.originalEstimate ?? null,
    timeSpent: fields?.timetracking?.timeSpent ?? null,
    remaining: fields?.timetracking?.remainingEstimate ?? null,
    timeSpentSeconds: fields?.timetracking?.timeSpentSeconds ?? null,
    remainingSeconds: fields?.timetracking?.remainingEstimateSeconds ?? null,
  };
}

async function jiraFetch(cfg: JiraConfig, pathname: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`${cfg.baseUrl}${pathname}`, {
    ...init,
    headers: { ...authHeaders(cfg), ...(init?.body ? { 'content-type': 'application/json' } : {}), ...init?.headers },
  });
  if (res.status === 404) throw new AppError('NOT_FOUND', 'Jira issue not found');
  if (res.status === 401 || res.status === 403) {
    throw new AppError('VALIDATION', 'Jira rejected the credentials — update them in Jira Connection settings');
  }
  if (!res.ok) throw new AppError('SHELL_FAILED', `Jira responded ${res.status}`);
  if (res.status === 204) return undefined; // e.g. transition POST has no body
  return res.json();
}

export type JiraSprint = {
  id: number;
  name: string;
  state: 'active' | 'future';
  startDate: string | null; // yyyy-mm-dd
  endDate: string | null;
};

function isoDay(v: string | undefined): string | null {
  return v && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null;
}

// Sprints for the New Worktree picker, zero-config: resolve the project's
// scrum boards, then each board's active+future sprints, deduped. Active
// sprints sort first so the dialog can default to "current sprint".
export async function getOpenSprints(cfg: JiraConfig, projectKey: string): Promise<JiraSprint[]> {
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(projectKey)) {
    throw new AppError('VALIDATION', `invalid project key: ${projectKey}`);
  }
  const boards = (await jiraFetch(
    cfg,
    `/rest/agile/1.0/board?projectKeyOrId=${encodeURIComponent(projectKey)}&type=scrum&maxResults=10`,
  )) as { values?: { id: number }[] };
  const out = new Map<number, JiraSprint>();
  for (const board of (boards.values ?? []).slice(0, 5)) {
    try {
      const sprints = (await jiraFetch(
        cfg,
        `/rest/agile/1.0/board/${board.id}/sprint?state=active,future&maxResults=50`,
      )) as { values?: { id: number; name: string; state: string; startDate?: string; endDate?: string }[] };
      for (const s of sprints.values ?? []) {
        if (s.state !== 'active' && s.state !== 'future') continue;
        const prev = out.get(s.id);
        out.set(s.id, {
          id: s.id,
          name: s.name,
          state: s.state,
          // boards can report the same sprint with/without dates — keep any
          startDate: prev?.startDate ?? isoDay(s.startDate),
          endDate: prev?.endDate ?? isoDay(s.endDate),
        });
      }
    } catch {
      // kanban-ish boards 400 on the sprint endpoint — skip them
    }
  }
  return [...out.values()].sort((a, b) =>
    a.state === b.state ? a.name.localeCompare(b.name) : a.state === 'active' ? -1 : 1,
  );
}

// Open (non-done) tickets of one sprint, freshest first. Uses the Agile
// sprint endpoint rather than JQL `sprint = id`: the JQL form matches the
// sprint FIELD, which keeps history — tickets carried over to the next
// sprint would still show under the old one.
export async function getSprintIssues(cfg: JiraConfig, sprintId: number, onlyMine = false): Promise<JiraIssue[]> {
  if (!Number.isInteger(sprintId) || sprintId <= 0) {
    throw new AppError('VALIDATION', `invalid sprint id: ${sprintId}`);
  }
  // Team sprints hold every squad's tickets — onlyMine narrows to the caller.
  const jql = encodeURIComponent(
    `${onlyMine ? 'assignee = currentUser() AND ' : ''}statusCategory != Done ORDER BY updated DESC`,
  );
  const body = (await jiraFetch(
    cfg,
    `/rest/agile/1.0/sprint/${sprintId}/issue?jql=${jql}&fields=summary,status,assignee,priority,timetracking&maxResults=100`,
  )) as { issues?: { key: string; fields?: IssueFields }[] };
  return (body.issues ?? []).map((it) => toIssue(it.key, it.fields));
}

// The New Worktree dialog's ticket picker: the caller's open issues,
// freshest first. One JQL call, no caching — it's fetched on dialog open.
export async function getMyOpenIssues(cfg: JiraConfig): Promise<JiraIssue[]> {
  const body = (await jiraFetch(cfg, '/rest/api/3/search/jql', {
    method: 'POST',
    body: JSON.stringify({
      jql: 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC',
      fields: ['summary', 'status', 'assignee', 'priority', 'timetracking'],
      maxResults: 50,
    }),
  })) as { issues?: { key: string; fields?: IssueFields }[] };
  return (body.issues ?? []).map((it) => toIssue(it.key, it.fields));
}

export type JiraTransition = {
  id: string;
  name: string;
  toStatus: string;
  toCategory: JiraIssue['category'];
};

type TransitionDto = {
  id?: string;
  name?: string;
  to?: { name?: string; statusCategory?: { key?: string } };
};

export async function getTransitions(cfg: JiraConfig, key: string): Promise<JiraTransition[]> {
  if (!KEY_PATTERN.test(key)) throw new AppError('VALIDATION', `invalid issue key: ${key}`);
  const body = (await jiraFetch(cfg, `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`)) as {
    transitions?: TransitionDto[];
  };
  return (body.transitions ?? [])
    .filter((t) => t.id && t.name)
    .map((t) => {
      const catKey = t.to?.statusCategory?.key;
      return {
        id: t.id!,
        name: t.name!,
        toStatus: t.to?.name ?? t.name!,
        toCategory: catKey === 'done' ? 'done' as const : catKey === 'indeterminate' ? 'indeterminate' as const : 'new' as const,
      };
    });
}

// Executes the transition, then re-reads the issue so the caller (and our
// cache) reflect Jira's actual post-transition state rather than a guess.
export async function doTransition(cfg: JiraConfig, key: string, transitionId: string): Promise<JiraIssue> {
  if (!KEY_PATTERN.test(key)) throw new AppError('VALIDATION', `invalid issue key: ${key}`);
  if (!/^\d+$/.test(transitionId)) throw new AppError('VALIDATION', `invalid transition id: ${transitionId}`);
  await jiraFetch(cfg, `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, {
    method: 'POST',
    body: JSON.stringify({ transition: { id: transitionId } }),
  });
  const issue = await getIssue(cfg, key);
  cache.set(issue.key, { at: Date.now(), issue });
  return issue;
}

export async function getIssue(cfg: JiraConfig, key: string): Promise<JiraIssue> {
  if (!KEY_PATTERN.test(key)) throw new AppError('VALIDATION', `invalid issue key: ${key}`);
  const body = (await jiraFetch(cfg, `/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,status,assignee,priority,timetracking`)) as {
    key?: string;
    fields?: IssueFields;
  };
  return toIssue(body.key ?? key, body.fields);
}

// Batch lookup for dashboard rows. Hits are cached briefly so the 60s
// browser poll (possibly from several tabs) doesn't hammer Jira; misses are
// cached much longer — worktrees whose ticket ids aren't real Jira issues
// would otherwise force the per-issue fallback on every poll, forever.
const cache = new Map<string, { at: number; issue: JiraIssue | null }>();
const HIT_TTL_MS = 45_000;
const MISS_TTL_MS = 10 * 60_000;

export type BatchResult = { issues: Record<string, JiraIssue>; missing: string[] };

export async function getIssues(cfg: JiraConfig, keys: string[]): Promise<BatchResult> {
  const valid = [...new Set(keys.map((k) => k.toUpperCase()))].filter((k) => KEY_PATTERN.test(k)).slice(0, 100);
  const now = Date.now();
  const issues: Record<string, JiraIssue> = {};
  const missing: string[] = [];
  const unknown: string[] = [];
  for (const k of valid) {
    const hit = cache.get(k);
    if (hit && hit.issue && now - hit.at < HIT_TTL_MS) issues[k] = hit.issue;
    else if (hit && hit.issue === null && now - hit.at < MISS_TTL_MS) missing.push(k);
    else unknown.push(k);
  }
  if (unknown.length > 0) {
    try {
      const body = (await jiraFetch(cfg, '/rest/api/3/search/jql', {
        method: 'POST',
        body: JSON.stringify({
          jql: `key in (${unknown.join(',')})`,
          fields: ['summary', 'status', 'assignee', 'priority', 'timetracking'],
          maxResults: unknown.length,
        }),
      })) as { issues?: { key: string; fields?: IssueFields }[] };
      for (const it of body.issues ?? []) {
        const issue = toIssue(it.key, it.fields);
        cache.set(issue.key, { at: now, issue });
        issues[issue.key] = issue;
      }
    } catch {
      // `key in (...)` 400s if ANY key is unknown to Jira (deleted ticket,
      // typo'd branch name). Fall back to per-issue fetches and skip misses.
      const settled = await Promise.allSettled(unknown.map((k) => getIssue(cfg, k)));
      for (const s of settled) {
        if (s.status === 'fulfilled') {
          cache.set(s.value.key, { at: now, issue: s.value });
          issues[s.value.key] = s.value;
        }
      }
    }
    // Everything we asked about and didn't get back is confirmed missing.
    for (const k of unknown) {
      if (!issues[k]) {
        cache.set(k, { at: now, issue: null });
        missing.push(k);
      }
    }
  }
  return { issues, missing };
}
