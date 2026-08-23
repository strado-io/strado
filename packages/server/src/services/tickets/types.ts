export type TicketProviderId = 'jira' | 'linear';

export type TicketIssue = {
  provider: TicketProviderId;
  key: string;               // "FD-1" / "ENG-45", uppercase
  summary: string;
  status: string;            // provider's display name
  category: 'new' | 'indeterminate' | 'done';
  assignee: string | null;
  priority: string | null;
  estimate: string | null;   // Jira "2d 4h" | Linear points as string
  url: string;               // canonical issue URL
  // Jira-only extras; always null for Linear
  timeSpent: string | null;
  remaining: string | null;
  timeSpentSeconds: number | null;
  remainingSeconds: number | null;
};

export type TicketSprint = {
  id: string;                // Jira numeric id stringified; Linear cycle UUID
  name: string;
  state: 'active' | 'future';
  startDate: string | null;  // yyyy-mm-dd
  endDate: string | null;
};

export type TicketTransition = {
  id: string;
  name: string;
  toStatus: string;
  toCategory: TicketIssue['category'];
};

export type TicketBatchResult = { issues: Record<string, TicketIssue>; missing: string[] };

export interface TicketProvider {
  readonly id: TicketProviderId;
  readonly label: string;
  configured(): Promise<boolean>;
  getMyOpenIssues(): Promise<TicketIssue[]>;
  // project: Jira project key; ignored by Linear (cycles come from all teams)
  getSprints(project?: string): Promise<TicketSprint[]>;
  getSprintIssues(sprintId: string, onlyMine: boolean): Promise<TicketIssue[]>;
  getIssue(key: string): Promise<TicketIssue>;
  getIssues(keys: string[]): Promise<TicketBatchResult>;
  getTransitions(key: string): Promise<TicketTransition[]>;
  doTransition(key: string, transitionId: string): Promise<TicketIssue>;
}
