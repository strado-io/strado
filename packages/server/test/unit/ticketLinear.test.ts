import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLinearTicketProvider, writeLinearConfig, linearConfigPath } from '../../src/services/tickets/linear';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'strado-linear-'));
  process.env.STRADO_HOME = home;
  fs.writeFileSync(
    path.join(home, 'linear.json'),
    JSON.stringify({ accessToken: 'lin_tok', workspaceName: 'Acme' }),
  );
});
afterEach(() => {
  fetchMock.mockReset();
  delete process.env.STRADO_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

function gql(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const NODE = {
  identifier: 'ENG-45', title: 'Ship it', url: 'https://linear.app/acme/issue/ENG-45',
  estimate: 3, priority: 2, priorityLabel: 'High',
  state: { name: 'In Progress', type: 'started' }, assignee: { name: 'Kamlesh' },
};

describe('linear ticket provider', () => {
  it('maps all five state types to three categories', async () => {
    const p = createLinearTicketProvider();
    for (const [type, category] of [
      ['backlog', 'new'], ['unstarted', 'new'], ['triage', 'new'],
      ['started', 'indeterminate'], ['completed', 'done'], ['canceled', 'done'],
    ] as const) {
      fetchMock.mockResolvedValueOnce(gql(200, {
        data: { issue: { ...NODE, identifier: `ENG-${type}`.toUpperCase().slice(0, 20), state: { name: type, type } } },
      }));
      const issue = await p.getIssue('ENG-1');
      expect(issue.category).toBe(category);
    }
  });

  it('getIssue maps fields, nulls Jira-only extras', async () => {
    fetchMock.mockResolvedValueOnce(gql(200, { data: { issue: NODE } }));
    const p = createLinearTicketProvider();
    const issue = await p.getIssue('eng-45');
    expect(issue).toEqual({
      provider: 'linear', key: 'ENG-45', summary: 'Ship it', status: 'In Progress',
      category: 'indeterminate', assignee: 'Kamlesh', priority: 'High', estimate: '3',
      url: 'https://linear.app/acme/issue/ENG-45',
      timeSpent: null, remaining: null, timeSpentSeconds: null, remainingSeconds: null,
    });
    const [, init] = fetchMock.mock.calls[0]!;
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer lin_tok');
  });

  it('priority 0 means no priority', async () => {
    fetchMock.mockResolvedValueOnce(gql(200, { data: { issue: { ...NODE, priority: 0, priorityLabel: 'No priority' } } }));
    const issue = await createLinearTicketProvider().getIssue('ENG-45');
    expect(issue.priority).toBeNull();
  });

  it('rejects malformed keys without calling Linear', async () => {
    await expect(createLinearTicketProvider().getIssue('DROP TABLE')).rejects.toThrow(/invalid issue key/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces auth failures as VALIDATION', async () => {
    fetchMock.mockResolvedValueOnce(gql(401, {}));
    await expect(createLinearTicketProvider().getIssue('ENG-45')).rejects.toThrow(/Linear rejected the token/);
  });

  it('getIssues batches via aliases and reports missing', async () => {
    fetchMock.mockResolvedValueOnce(gql(200, {
      data: { i0: NODE, i1: null },
      errors: [{ message: 'Entity not found', path: ['i1'] }],
    }));
    const { issues, missing } = await createLinearTicketProvider().getIssues(['ENG-45', 'ENG-99']);
    expect(issues['ENG-45']!.summary).toBe('Ship it');
    expect(missing).toEqual(['ENG-99']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // second call for the same keys is served from cache (hit) and miss-cache
    const again = await createLinearTicketProvider().getIssues(['ENG-45', 'ENG-99']);
    expect(again.issues['ENG-45']).toBeDefined();
    expect(again.missing).toEqual(['ENG-99']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('getIssues rejects on a whole-query GraphQL error and does not cache the keys as missing', async () => {
    fetchMock.mockResolvedValueOnce(gql(200, { data: null, errors: [{ message: 'Internal error' }] }));
    await expect(createLinearTicketProvider().getIssues(['ENG-45'])).rejects.toThrow(/Linear GraphQL error/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // nothing was cached as missing — a retry with the same keys hits fetch again
    fetchMock.mockResolvedValueOnce(gql(200, { data: { i0: NODE } }));
    const { issues, missing } = await createLinearTicketProvider().getIssues(['ENG-45']);
    expect(issues['ENG-45']!.summary).toBe('Ship it');
    expect(missing).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('cycles map to sprints with name fallback', async () => {
    fetchMock.mockResolvedValueOnce(gql(200, { data: { cycles: { nodes: [
      { id: 'uuid-1', name: null, number: 12, startsAt: '2026-08-03T00:00:00Z', endsAt: '2026-08-17T00:00:00Z', isActive: true, team: { key: 'ENG' } },
      { id: 'uuid-2', name: 'Polish', number: 13, startsAt: null, endsAt: null, isActive: false, team: { key: 'ENG' } },
    ] } } }));
    const sprints = await createLinearTicketProvider().getSprints();
    expect(sprints[0]).toEqual({ id: 'uuid-1', name: 'ENG Cycle 12', state: 'active', startDate: '2026-08-03', endDate: '2026-08-17' });
    expect(sprints[1]!.name).toBe('Polish');
    expect(sprints[1]!.state).toBe('future');
  });

  it('transitions list the team workflow states in position order', async () => {
    fetchMock.mockResolvedValueOnce(gql(200, { data: { issue: { team: { states: { nodes: [
      { id: 's2', name: 'In Progress', type: 'started', position: 2 },
      { id: 's1', name: 'Todo', type: 'unstarted', position: 1 },
    ] } } } } }));
    const ts = await createLinearTicketProvider().getTransitions('ENG-45');
    expect(ts.map((t) => t.name)).toEqual(['Todo', 'In Progress']);
    expect(ts[1]).toEqual({ id: 's2', name: 'In Progress', toStatus: 'In Progress', toCategory: 'indeterminate' });
  });

  it('doTransition updates state and returns the fresh issue', async () => {
    fetchMock.mockResolvedValueOnce(gql(200, { data: { issueUpdate: { success: true, issue: NODE } } }));
    const issue = await createLinearTicketProvider().doTransition('ENG-45', 's2');
    expect(issue.status).toBe('In Progress');
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(init.body as string).query).toContain('issueUpdate');
  });

  it('writeLinearConfig validates the token and persists workspace name', async () => {
    fs.rmSync(path.join(home, 'linear.json'));
    fetchMock.mockResolvedValueOnce(gql(200, { data: { organization: { name: 'Acme' } } }));
    const res = await writeLinearConfig('lin_new');
    expect(res.workspaceName).toBe('Acme');
    const saved = JSON.parse(fs.readFileSync(linearConfigPath(), 'utf8'));
    expect(saved).toEqual({ accessToken: 'lin_new', workspaceName: 'Acme' });
  });
});
