import { createContext, useEffect, useState, ReactNode } from 'react';
import { api } from '../api';
import { CreateWorkspaceScreen } from '../components/CreateWorkspaceScreen';
import { useCapabilities } from '../hooks/capabilities';
import type { Workspace } from '../types';

export type WorkspaceContextValue = {
  workspace: Workspace;
  allWorkspaces: Workspace[];
  refresh: () => Promise<void>;
  switchTo: (id: string) => Promise<void>;
};

export const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({
  wsId,
  onSwitchTo,
  children,
}: {
  wsId: string;
  onSwitchTo: (id: string) => void;
  children: ReactNode;
}) {
  const [state, setState] = useState<{ all: Workspace[]; active: Workspace } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const caps = useCapabilities();

  async function load() {
    const result = await api.workspaces.list();
    const ws = result.workspaces.find((w) => w.id === wsId);
    if (!ws) {
      setError(`workspace '${wsId}' not found`);
      if (result.workspaces.length > 0) {
        setState({ all: result.workspaces, active: result.workspaces[0]! });
      } else {
        setState(null);
      }
      return;
    }
    setError(null);
    setState({ all: result.workspaces, active: ws });
  }

  useEffect(() => { void load(); }, [wsId]);

  // Update tab title when active workspace changes, or once capabilities
  // resolve so a dev build corrects the title instead of staying "Strado"
  // until the next workspace switch.
  useEffect(() => {
    if (state) {
      const name = caps.profile === 'dev' ? 'Strado Dev' : 'Strado';
      document.title = `${state.active.icon} ${name} — ${state.active.name}`;
    }
  }, [state?.active?.id, caps.profile]);

  if (error) {
    // No workspaces at all (fresh registry or a recovered config): app-level
    // onboarding — offer to create one instead of dead-ending.
    if (!state) {
      return (
        <CreateWorkspaceScreen
          onCreated={async (id) => {
            onSwitchTo(id);
            await load();
          }}
        />
      );
    }
    return (
      <div className="flex h-screen items-center justify-center bg-zinc-950 p-4">
        <div className="w-full max-w-sm rounded-lg border border-zinc-800 bg-zinc-950 p-6 shadow-2xl">
          <h2 className="text-lg font-semibold text-zinc-100">Workspace not found</h2>
          <p className="mt-1 text-xs text-zinc-500">{error}. Pick one of your workspaces:</p>
          <div className="mt-4 flex flex-col gap-1.5">
            {state.all.map((w) => (
              <button
                key={w.id}
                onClick={() => onSwitchTo(w.id)}
                className="flex items-center gap-2.5 rounded-md border border-zinc-800 px-3 py-2 text-left text-sm text-zinc-200 hover:bg-zinc-900"
              >
                <span
                  className="flex h-6 w-6 items-center justify-center rounded text-xs font-semibold text-white"
                  style={{ backgroundColor: w.color }}
                  aria-hidden
                >
                  {w.icon}
                </span>
                {w.name}
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }
  if (!state) return null;

  const value: WorkspaceContextValue = {
    workspace: state.active,
    allWorkspaces: state.all,
    refresh: load,
    // The swipe has already moved the pixels, and the pane the user is looking
    // at stays inert until `workspace` changes — so flip it now and persist
    // afterwards. Waiting on the POST plus the reload it triggers left the
    // sidebar frozen for as long as those two round trips took, which on a
    // saturated boot is seconds.
    switchTo: async (id) => {
      const target = state.all.find((w) => w.id === id);
      const previous = state.active;
      if (target) setState({ all: state.all, active: target });
      onSwitchTo(id);
      try {
        await api.workspaces.setActive(id);
      } catch (err) {
        setState({ all: state.all, active: previous });
        onSwitchTo(previous.id);
        throw err;
      }
    },
  };
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}
