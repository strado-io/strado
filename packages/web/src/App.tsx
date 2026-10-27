import { useEffect, useState } from 'react';
import { LicenseGate } from './components/LicenseGate';
import { track } from './telemetry';
import { Dashboard, remoteAsWorktree } from './pages/Dashboard';
import { NewWorktreeDialog, CreatePayload } from './components/NewWorktreeDialog';
import { DeleteWorktreeDialog } from './components/DeleteWorktreeDialog';
import { RebuildSandboxDialog } from './components/RebuildSandboxDialog';
import { WorktreeSettingsDialog } from './components/WorktreeSettingsDialog';
import { LogPanel } from './components/LogPanel';
import { WorkspaceProvider } from './contexts/WorkspaceContext';
import { IntercomProvider } from './contexts/IntercomContext';
import { useWorkspace } from './hooks/useWorkspace';
import { activeFocusOf, ensureFocusesLoaded, useFocuses } from './hooks/useFocuses';
import { createdPinId } from './components/sidebar/pinIds';
import { startWorktreeJob } from './lib/worktreeJob';
import { api, type RemoteWorktree, type FocusTicket } from './api';
import type { MergeRequest, RepoConfig, Worktree } from './types';
import { MrReviewModal } from './components/MrReviewModal';
import { NoteDialog } from './components/NoteDialog';
import { DiffView } from './pages/DiffView';
import { useUpdate } from './hooks/useUpdate';
import { UpdateModal } from './components/UpdateModal';

type Dialog =
  | { kind: 'none' }
  | { kind: 'new'; repoId?: string; ticket?: FocusTicket }
  | { kind: 'delete'; worktree: Worktree }
  | { kind: 'menu'; worktree: Worktree }
  | { kind: 'logs'; worktree: Worktree }
  | { kind: 'note'; worktree: Worktree }
  | { kind: 'diff'; worktree: Worktree }
  | { kind: 'deleteRemote'; remote: RemoteWorktree }
  | { kind: 'rebuildSandbox'; remote: RemoteWorktree }
  | { kind: 'mr'; worktree: Worktree; mr: MergeRequest };

function AppShell() {
  const { workspace } = useWorkspace();
  const wsId = workspace.id;
  const [dialog, setDialog] = useState<Dialog>({ kind: 'none' });
  const [repos, setRepos] = useState<RepoConfig[]>([]);
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  // Remote rows have no SSE channel into this desktop yet. Bump this after a
  // completed remote mutation so Dashboard revalidates immediately instead of
  // waiting for its recovery poll.
  const [remoteRefreshKey, setRemoteRefreshKey] = useState(0);
  const upd = useUpdate();
  const mandatory = !!upd.info?.mandatory && upd.info.updateAvailable && upd.phase !== 'idle';

  useEffect(() => {
    Promise.all([api.repos.list(wsId), api.worktrees.list(wsId)]).then(([r, w]) => {
      setRepos(r);
      setWorktrees(w);
    });
  }, [dialog.kind, wsId]);

  // Machines that can host a worktree, for the dialog's "Where" choice. Absent
  // account or unreachable cloud simply means the choice isn't offered.
  const [runners, setRunners] = useState<{ runnerId: string; name: string; online: boolean }[]>([]);
  useEffect(() => {
    if (dialog.kind !== 'new') return;
    api.runners
      .list()
      .then(({ runners: rs }) => setRunners(rs.map((r) => ({ runnerId: r.runnerId, name: r.name, online: r.online }))))
      .catch(() => setRunners([]));
  }, [dialog.kind]);

  const close = () => setDialog({ kind: 'none' });
  const focusApi = useFocuses(wsId);

  return (
    <IntercomProvider wsId={wsId}>
      <Dashboard
        remoteRefreshKey={remoteRefreshKey}
        modalOpen={dialog.kind !== 'none' || mandatory}
        update={{
          // mandatory updates are handled by the blocking modal below, so the
          // sidebar footer widget stays hidden in that case.
          phase: mandatory ? 'idle' : upd.phase,
          info: upd.info,
          progress: upd.progress,
          error: upd.error,
          mode: upd.mode,
          onUpdate: upd.startDownload,
          onInstall: upd.install,
          onDismiss: upd.dismiss,
        }}
        onNewWorktree={(repoId?: string, ticket?: FocusTicket) => setDialog({ kind: 'new', repoId, ticket })}
        onShowLogs={(w) => setDialog({ kind: 'logs', worktree: w })}
        onMenu={(w) => setDialog({ kind: 'menu', worktree: w })}
        onOpenNote={(w) => setDialog({ kind: 'note', worktree: w })}
        onOpenDiff={(w) => {
          track('diff_opened');
          setDialog({ kind: 'diff', worktree: w });
        }}
        onOpenMr={(w, mr) => {
          track('mr_review_opened');
          setDialog({ kind: 'mr', worktree: w, mr });
        }}
        onCloseOverlays={close}
        onDeleteWorktree={(w) => setDialog({ kind: 'delete', worktree: w })}
        onDeleteRemoteWorktree={(w) => setDialog({ kind: 'deleteRemote', remote: w })}
        onRebuildSandbox={(w) => setDialog({ kind: 'rebuildSandbox', remote: w })}
      />
      {dialog.kind === 'new' && (
        <NewWorktreeDialog
          repos={repos}
          worktrees={worktrees}
          workspaceId={wsId}
          preselectRepoId={dialog.repoId}
          preselectTicket={dialog.ticket}
          onCancel={close}
          runners={runners}
          // Enqueue only. The dialog follows the job's named steps and closes
          // when it finishes — including the remote case, where provisioning
          // (a clone that can run for minutes) is itself part of the job
          // rather than a silent wait inside one long request.
          onSubmit={(payload: CreatePayload) => startWorktreeJob(wsId, payload)}
          onDone={(result) => {
            // Cheap for a local create, essential for a remote one. The dialog
            // owns which runner was selected internally, so one unconditional
            // revalidation avoids duplicating that state in App.
            setRemoteRefreshKey((key) => key + 1);
            close();
            // Made while a Focus is open: it belongs there, not loose in the space.
            const pinId = createdPinId(result);
            if (pinId) {
              void (async () => {
                await ensureFocusesLoaded(wsId);
                const active = activeFocusOf(wsId);
                if (active && !active.members.includes(pinId)) await focusApi.setMembership(active.id, pinId, true);
              })().catch(() => { /* the worktree exists either way; it can be added by hand */ });
            }
          }}
        />
      )}
      {dialog.kind === 'delete' && (
        <DeleteWorktreeDialog
          worktree={dialog.worktree}
          onCancel={close}
          onConfirm={(opts) => api.worktrees.remove(wsId, dialog.worktree.path, opts)}
          onDone={close}
        />
      )}
      {dialog.kind === 'deleteRemote' && (
        <DeleteWorktreeDialog
          worktree={remoteAsWorktree(dialog.remote)}
          onCancel={close}
          onConfirm={(opts) =>
            api.runners.deleteRemote(wsId, {
              runnerId: dialog.remote.runnerId,
              remoteWsId: dialog.remote.remoteWsId,
              path: dialog.remote.path,
              ...opts,
            })
          }
          onDone={() => {
            setRemoteRefreshKey((key) => key + 1);
            close();
          }}
        />
      )}
      {dialog.kind === 'rebuildSandbox' && (
        <RebuildSandboxDialog
          remote={dialog.remote}
          onCancel={close}
          onConfirm={() =>
            api.runners.rebuildSandbox(wsId, {
              runnerId: dialog.remote.runnerId,
              remoteWsId: dialog.remote.remoteWsId,
              path: dialog.remote.path,
              ...(dialog.remote.localRepoId ? { repoId: dialog.remote.localRepoId } : {}),
            })
          }
          onDone={() => {
            setRemoteRefreshKey((key) => key + 1);
            close();
          }}
        />
      )}
      {dialog.kind === 'menu' && (
        <WorktreeSettingsDialog
          worktree={dialog.worktree}
          repo={repos.find((r) => r.id === dialog.worktree.repoId) ?? null}
          onSave={async (patch) => {
            await api.worktrees.patch(wsId, dialog.worktree.path, patch);
            track('settings_saved');
          }}
          onResetTime={async () => {
            if (!confirm('Reset tracked time for this worktree to zero? This cannot be undone.')) {
              close();
              return;
            }
            await api.activity.reset(dialog.worktree.path);
            close();
          }}
          onClose={close}
          worktrees={worktrees}
          onLink={async (source) => {
            const needsReplace = dialog.worktree.nodeModules?.status === 'directory';
            if (needsReplace &&
              !confirm('This worktree has an installed node_modules. Rename it to .bak and replace with a symlink?')) {
              close(); return;
            }
            await api.worktrees.link(wsId, dialog.worktree.path, source, needsReplace);
            close();
          }}
          onUnlink={async () => {
            await api.worktrees.unlink(wsId, dialog.worktree.path);
            close();
          }}
          onRelink={async (source) => {
            await api.worktrees.relink(wsId, dialog.worktree.path, source);
            close();
          }}
          onAdopt={async (ticketId, title) => {
            await api.worktrees.adopt(wsId, dialog.worktree.path, {
              repoId: dialog.worktree.repoId ?? repos[0]?.id ?? '',
              ticketId,
              title: title || ticketId,
            });
            close();
          }}
          onDelete={() => setDialog({ kind: 'delete', worktree: dialog.worktree })}
        />
      )}
      {dialog.kind === 'logs' && <LogPanel worktree={dialog.worktree} onClose={close} />}
      {dialog.kind === 'note' && (
        <NoteDialog
          worktree={dialog.worktree}
          onCancel={close}
          onSave={async (text) => {
            await api.worktrees.patch(wsId, dialog.worktree.path, { note: text.trim() ? text : null });
            close();
          }}
        />
      )}
      {dialog.kind === 'diff' && <DiffView worktree={dialog.worktree} onClose={close} />}
      {dialog.kind === 'mr' && <MrReviewModal worktree={dialog.worktree} mr={dialog.mr} onClose={close} />}
      {mandatory && (
        <UpdateModal
          phase={upd.phase}
          info={upd.info}
          progress={upd.progress}
          error={upd.error}
          mode={upd.mode}
          onUpdate={upd.startDownload}
          onInstall={upd.install}
        />
      )}
    </IntercomProvider>
  );
}

export default function App() {
  const [activeWsId, setActiveWsId] = useState<string | null>(null);

  useEffect(() => {
    api.workspaces.list().then((r) => {
      setActiveWsId(r.activeWorkspaceId ?? r.workspaces[0]?.id ?? 'default');
    }).catch(() => setActiveWsId('default'));
  }, []);

  if (!activeWsId) return null;

  return (
    <LicenseGate>
      <WorkspaceProvider wsId={activeWsId} onSwitchTo={setActiveWsId}>
        <AppShell />
      </WorkspaceProvider>
    </LicenseGate>
  );
}
