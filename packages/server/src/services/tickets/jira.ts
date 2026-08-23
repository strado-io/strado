import { AppError } from '../../errors.js';
import {
  readJiraConfig, getIssue, getIssues, getMyOpenIssues, getOpenSprints,
  getSprintIssues, getTransitions, doTransition,
  type JiraConfig, type JiraIssue,
} from '../jira.js';
import type { TicketIssue, TicketProvider, TicketBatchResult } from './types.js';

async function requireConfig(): Promise<JiraConfig> {
  const cfg = await readJiraConfig();
  if (!cfg) throw new AppError('VALIDATION', 'Jira is not configured — open Jira Connection in settings');
  return cfg;
}

function decorate(cfg: JiraConfig, issue: JiraIssue): TicketIssue {
  return { ...issue, provider: 'jira', url: `${cfg.baseUrl}/browse/${encodeURIComponent(issue.key)}` };
}

export function createJiraTicketProvider(): TicketProvider {
  return {
    id: 'jira',
    label: 'Jira',
    configured: async () => (await readJiraConfig()) !== null,
    getMyOpenIssues: async () => {
      const cfg = await requireConfig();
      return (await getMyOpenIssues(cfg)).map((i) => decorate(cfg, i));
    },
    getSprints: async (project) => {
      const cfg = await requireConfig();
      if (!project) throw new AppError('VALIDATION', 'Jira sprints need a project key');
      return (await getOpenSprints(cfg, project)).map((s) => ({ ...s, id: String(s.id) }));
    },
    getSprintIssues: async (sprintId, onlyMine) => {
      const cfg = await requireConfig();
      const n = Number(sprintId);
      if (!Number.isInteger(n) || n <= 0) throw new AppError('VALIDATION', `invalid sprint id: ${sprintId}`);
      return (await getSprintIssues(cfg, n, onlyMine)).map((i) => decorate(cfg, i));
    },
    getIssue: async (key) => {
      const cfg = await requireConfig();
      return decorate(cfg, await getIssue(cfg, key));
    },
    getIssues: async (keys): Promise<TicketBatchResult> => {
      const cfg = await requireConfig();
      const { issues, missing } = await getIssues(cfg, keys);
      const out: Record<string, TicketIssue> = {};
      for (const [k, v] of Object.entries(issues)) out[k] = decorate(cfg, v);
      return { issues: out, missing };
    },
    getTransitions: async (key) => {
      const cfg = await requireConfig();
      return getTransitions(cfg, key);
    },
    doTransition: async (key, transitionId) => {
      const cfg = await requireConfig();
      return decorate(cfg, await doTransition(cfg, key, transitionId));
    },
  };
}
