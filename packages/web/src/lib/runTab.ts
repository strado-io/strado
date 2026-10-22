/** The header Run's tabs: each run command's own pty for that worktree. They
 * look like shell tabs ({ mode: 'shell', id }) but attach to /ws/run, which
 * never spawns anything and is not a listed shell session. The default run
 * command's tab is 'run'; another's is 'run:<runId>'. */
export const RUN_SESSION_ID = 'run';

/** The run tab id for a run command (null/undefined = the default). */
export const runTabId = (runId?: string | null): string => (runId ? `${RUN_SESSION_ID}:${runId}` : RUN_SESSION_ID);

/** The run command a tab id belongs to: '' for the default's tab, its runId for another's; null for any other tab. */
export function runIdOfTab(id: string): string | null {
  if (id === RUN_SESSION_ID) return '';
  return id.startsWith(`${RUN_SESSION_ID}:`) ? id.slice(RUN_SESSION_ID.length + 1) : null;
}
export const isRunTab = (id: string): boolean => runIdOfTab(id) !== null;
