// Start making a worktree: on this machine, or on a runner that clones the
// repo itself. Enqueue only; the caller follows the job's named steps
// (useJobSteps) and learns the new worktree's path from its result.
import { api } from '../api';
import { track } from '../telemetry';
import type { CreatePayload } from '../components/NewWorktreeDialog';

export function startWorktreeJob(wsId: string, payload: CreatePayload) {
  if (payload.runnerId) {
    track('worktree_created_remote');
    return api.runners.createRemote(wsId, {
      runnerId: payload.runnerId,
      repoId: payload.repoId,
      ticketId: payload.ticketId,
      ticketProvider: payload.ticketProvider,
      title: payload.title,
      sourceBranch: payload.sourceBranch,
    });
  }
  track('worktree_created');
  return api.worktrees.create(wsId, payload);
}
