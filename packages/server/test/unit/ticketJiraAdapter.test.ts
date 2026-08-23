import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createJiraTicketProvider } from '../../src/services/tickets/jira.js';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'strado-jira-'));
  process.env.STRADO_HOME = home;
  fs.writeFileSync(
    path.join(home, 'jira.json'),
    JSON.stringify({ baseUrl: 'https://org.atlassian.net', email: 'me@org.com', apiToken: 'tok' }),
  );
});
afterEach(() => {
  fetchMock.mockReset();
  delete process.env.STRADO_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

describe('jira ticket provider adapter', () => {
  it('stamps provider and url onto issues', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {
      key: 'FD-1',
      fields: { summary: 'Fix', status: { name: 'To Do', statusCategory: { key: 'new' } } },
    }));
    const p = createJiraTicketProvider();
    const issue = await p.getIssue('FD-1');
    expect(issue.provider).toBe('jira');
    expect(issue.url).toBe('https://org.atlassian.net/browse/FD-1');
    expect(issue.category).toBe('new');
  });

  it('stringifies sprint ids', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { values: [{ id: 7 }] }))
      .mockResolvedValueOnce(jsonResponse(200, {
        values: [{ id: 42, name: 'Sprint 9', state: 'active', startDate: '2026-08-01T00:00:00Z' }],
      }));
    const p = createJiraTicketProvider();
    const sprints = await p.getSprints('FD');
    expect(sprints).toEqual([{ id: '42', name: 'Sprint 9', state: 'active', startDate: '2026-08-01', endDate: null }]);
  });

  it('configured() reflects the config file', async () => {
    const p = createJiraTicketProvider();
    expect(await p.configured()).toBe(true);
    fs.rmSync(path.join(home, 'jira.json'));
    expect(await p.configured()).toBe(false);
  });

  it('throws VALIDATION when unconfigured', async () => {
    fs.rmSync(path.join(home, 'jira.json'));
    const p = createJiraTicketProvider();
    await expect(p.getMyOpenIssues()).rejects.toThrow(/Jira is not configured/);
  });
});
