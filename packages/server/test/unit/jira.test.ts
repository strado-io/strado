import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getIssue, getIssues, getTransitions, doTransition, writeJiraConfig, jiraConfigPath, type JiraConfig } from '../../src/services/jira';

const cfg: JiraConfig = {
  baseUrl: 'https://org.atlassian.net',
  email: 'me@org.com',
  apiToken: 'tok',
};

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

afterEach(() => fetchMock.mockReset());

describe('jira service', () => {
  it('getIssue maps summary and status category', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        key: 'FD-1',
        fields: {
          summary: 'Fix the thing',
          status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
          assignee: { displayName: 'Kamlesh' },
          priority: { name: 'High' },
          timetracking: { originalEstimate: '2d', timeSpent: '1d 4h', remainingEstimate: '4h', timeSpentSeconds: 43200, remainingEstimateSeconds: 14400 },
        },
      }),
    );
    const issue = await getIssue(cfg, 'fd-1');
    expect(issue).toEqual({
      key: 'FD-1',
      summary: 'Fix the thing',
      status: 'In Progress',
      category: 'indeterminate',
      assignee: 'Kamlesh',
      priority: 'High',
      estimate: '2d',
      timeSpent: '1d 4h',
      remaining: '4h',
      timeSpentSeconds: 43200,
      remainingSeconds: 14400,
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://org.atlassian.net/rest/api/3/issue/fd-1?fields=summary,status,assignee,priority,timetracking');
    expect((init.headers as Record<string, string>).authorization).toMatch(/^Basic /);
  });

  it('getIssue rejects malformed keys without calling Jira', async () => {
    await expect(getIssue(cfg, 'DROP TABLE')).rejects.toThrow(/invalid issue key/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('getIssue surfaces auth failures clearly', async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, {}));
    await expect(getIssue(cfg, 'FD-1')).rejects.toThrow(/rejected the credentials/);
  });

  it('getIssues batches via JQL and caches results', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        issues: [
          { key: 'FD-10', fields: { summary: 'a', status: { name: 'Done', statusCategory: { key: 'done' } } } },
          { key: 'FD-11', fields: { summary: 'b', status: { name: 'To Do', statusCategory: { key: 'new' } } } },
        ],
      }),
    );
    const first = await getIssues(cfg, ['fd-10', 'FD-11']);
    expect(first.issues['FD-10']!.category).toBe('done');
    expect(first.issues['FD-11']!.status).toBe('To Do');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // second call inside the TTL is served from cache
    const second = await getIssues(cfg, ['FD-10', 'FD-11']);
    expect(second.issues['FD-10']).toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('getIssues falls back to per-issue fetches when the batch 400s and reports misses', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(400, {})) // batch rejects unknown key
      .mockResolvedValueOnce(
        jsonResponse(200, {
          key: 'FD-20',
          fields: { summary: 'ok', status: { name: 'To Do', statusCategory: { key: 'new' } } },
        }),
      )
      .mockResolvedValueOnce(jsonResponse(404, {})); // deleted ticket skipped
    const out = await getIssues(cfg, ['FD-20', 'FD-99999']);
    expect(Object.keys(out.issues)).toEqual(['FD-20']);
    expect(out.missing).toEqual(['FD-99999']);
  });

  it('getIssues caches misses so unknown tickets stop hitting Jira', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { issues: [] })); // batch finds nothing
    const first = await getIssues(cfg, ['FD-77777']);
    expect(first.missing).toEqual(['FD-77777']);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // next poll: served from the negative cache, no Jira traffic at all
    const second = await getIssues(cfg, ['FD-77777']);
    expect(second.missing).toEqual(['FD-77777']);
    expect(second.issues).toEqual({});
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('getOpenSprints merges board sprints, dedupes, and puts active first', async () => {
    const { getOpenSprints } = await import('../../src/services/jira');
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { values: [{ id: 1 }, { id: 2 }] })) // boards
      .mockResolvedValueOnce(
        jsonResponse(200, {
          values: [
            { id: 100, name: 'FMS 36', state: 'future' },
            { id: 99, name: 'FMS 35', state: 'active', startDate: '2026-07-06T03:33:00.000Z', endDate: '2026-07-17T03:33:00.000Z' },
          ],
        }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { values: [{ id: 99, name: 'FMS 35', state: 'active' }] })); // dupe on board 2
    const sprints = await getOpenSprints(cfg, 'FD');
    expect(sprints).toEqual([
      { id: 99, name: 'FMS 35', state: 'active', startDate: '2026-07-06', endDate: '2026-07-17' },
      { id: 100, name: 'FMS 36', state: 'future', startDate: null, endDate: null },
    ]);
    expect(fetchMock.mock.calls[0]![0]).toContain('/rest/agile/1.0/board?projectKeyOrId=FD');
  });

  it('getOpenSprints rejects a malformed project key without calling Jira', async () => {
    const { getOpenSprints } = await import('../../src/services/jira');
    await expect(getOpenSprints(cfg, 'FD OR 1=1')).rejects.toThrow(/invalid project key/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('getSprintIssues asks the Agile endpoint (current members only), not JQL sprint history', async () => {
    const { getSprintIssues } = await import('../../src/services/jira');
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        issues: [{ key: 'FD-3', fields: { summary: 'c', status: { name: 'To Do', statusCategory: { key: 'new' } } } }],
      }),
    );
    const issues = await getSprintIssues(cfg, 99);
    expect(issues[0]!.key).toBe('FD-3');
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain('/rest/agile/1.0/sprint/99/issue');
    expect(url).toContain(encodeURIComponent('statusCategory != Done'));
    expect(url).not.toContain(encodeURIComponent('currentUser()'));
  });

  it('getSprintIssues narrows to the caller with onlyMine', async () => {
    const { getSprintIssues } = await import('../../src/services/jira');
    fetchMock.mockResolvedValue(jsonResponse(200, { issues: [] }));
    await getSprintIssues(cfg, 99, true);
    expect(fetchMock.mock.calls[0]![0] as string).toContain(
      encodeURIComponent('assignee = currentUser() AND statusCategory != Done'),
    );
  });

  it('getMyOpenIssues queries currentUser open issues sorted by recency', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        issues: [
          { key: 'FD-2', fields: { summary: 'b', status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } } } },
        ],
      }),
    );
    const { getMyOpenIssues } = await import('../../src/services/jira');
    const issues = await getMyOpenIssues(cfg);
    expect(issues).toEqual([
      { key: 'FD-2', summary: 'b', status: 'In Progress', category: 'indeterminate', assignee: null, priority: null, estimate: null, timeSpent: null, remaining: null, timeSpentSeconds: null, remainingSeconds: null },
    ]);
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(init.body as string);
    expect(body.jql).toContain('assignee = currentUser()');
    expect(body.jql).toContain('statusCategory != Done');
  });

  it('getTransitions maps ids, names, and target status', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        transitions: [
          { id: '21', name: 'Start Progress', to: { name: 'In Progress', statusCategory: { key: 'indeterminate' } } },
          { id: '31', name: 'Done', to: { name: 'Done', statusCategory: { key: 'done' } } },
        ],
      }),
    );
    const ts = await getTransitions(cfg, 'FD-1');
    expect(ts).toEqual([
      { id: '21', name: 'Start Progress', toStatus: 'In Progress', toCategory: 'indeterminate' },
      { id: '31', name: 'Done', toStatus: 'Done', toCategory: 'done' },
    ]);
  });

  it('doTransition posts the transition then returns the refreshed issue', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 204, json: async () => { throw new Error('no body'); } } as unknown as Response)
      .mockResolvedValueOnce(
        jsonResponse(200, {
          key: 'FD-5',
          fields: { summary: 's', status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } } },
        }),
      );
    const issue = await doTransition(cfg, 'FD-5', '21');
    expect(issue.status).toBe('In Progress');
    const [, postInit] = fetchMock.mock.calls[0]!;
    expect(postInit.method).toBe('POST');
    expect(JSON.parse(postInit.body as string)).toEqual({ transition: { id: '21' } });
  });

  it('doTransition rejects a non-numeric transition id', async () => {
    await expect(doTransition(cfg, 'FD-5', '21; rm -rf')).rejects.toThrow(/invalid transition id/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('writeJiraConfig validates against /myself before persisting (0600)', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-home-'));
    const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(home);
    try {
      fetchMock.mockResolvedValue(jsonResponse(200, { displayName: 'Kamlesh B' }));
      const res = await writeJiraConfig({ baseUrl: cfg.baseUrl, email: cfg.email, apiToken: 'tok' });
      expect(res.accountName).toBe('Kamlesh B');
      expect(fetchMock.mock.calls[0]![0]).toBe('https://org.atlassian.net/rest/api/3/myself');
      const file = jiraConfigPath();
      expect(JSON.parse(fs.readFileSync(file, 'utf8')).email).toBe(cfg.email);
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    } finally {
      homedirSpy.mockRestore();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('writeJiraConfig rejects bad credentials without writing anything', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-home-'));
    const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(home);
    try {
      fetchMock.mockResolvedValue(jsonResponse(401, {}));
      await expect(
        writeJiraConfig({ baseUrl: cfg.baseUrl, email: cfg.email, apiToken: 'bad' }),
      ).rejects.toThrow(/credentials/);
      expect(fs.existsSync(jiraConfigPath())).toBe(false);
    } finally {
      homedirSpy.mockRestore();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
