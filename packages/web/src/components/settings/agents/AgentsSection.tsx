// Settings → Coding agents. This is the shell: agent tabs, host/scope/worktree
// pickers, and surfaces grouped under the file they came from. Per-surface
// editing lives in ./surfaces — this file only wires `onChange` (list
// surfaces, committed immediately) and `onStage` (scalar surfaces, batched
// behind each group's Save button) through to `api.agentConfig.patch`.
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api, type AgentScope, type AgentSummary, type SurfaceValue } from '../../../api';
import { WorkspaceContext } from '../../../contexts/WorkspaceContext';
import type { Worktree } from '../../../types';
import { widgetFor } from './surfaces';

// A tab is selectable only when Strado can both run the agent (`installed`)
// and manage its config (`supported`, i.e. a descriptor exists) — these are
// independent facts (see api.ts's `AgentSummary`), so each of the three
// non-selectable combinations gets its own honest wording. In particular, an
// installed-but-unsupported agent (Codex, today) must never be told it's
// "not installed" — that would be the panel lying about the user's own
// system just because Strado hasn't caught up yet.
function isSelectable(agent: AgentSummary): boolean {
  return agent.installed && agent.supported;
}

function disabledReason(agent: AgentSummary): string | null {
  if (isSelectable(agent)) return null;
  if (agent.installed) return `${agent.label} is installed, but Strado doesn't support configuring it yet`;
  if (agent.supported) return `${agent.label} is not installed`;
  return `${agent.label} is not installed, and Strado doesn't support configuring it yet`;
}

// The panel-wide empty state (no tab is selectable) must be just as honest
// as each tab's own `disabledReason` — "no agents are installed" is a lie
// when one of them actually IS installed, just not yet supported (Codex,
// today). Reuses the same "installed" fact `disabledReason` checks, rather
// than re-deriving a second, possibly-inconsistent wording.
function emptyStateReason(agents: AgentSummary[]): string {
  if (agents.some((a) => a.installed)) {
    return "An agent is installed on this host, but Strado doesn't support configuring it yet.";
  }
  return 'No agents are installed on this host — install one to configure it here.';
}

// Discriminated on `status` so a failed *load* (no text to save — nothing for
// Save to do) is a distinct, statically-checked case from a failed *save*
// (the user's edited text is still there and Save must be able to retry it).
// Collapsing these into one `error` status + optional fields is exactly what
// let Save silently no-op on a load failure before.
type RawEditorState =
  | { surfaceId: string; file: string; status: 'loading' }
  | { surfaceId: string; file: string; status: 'load-error'; error: string }
  | { surfaceId: string; file: string; status: 'ready'; text: string }
  | { surfaceId: string; file: string; status: 'saving'; text: string }
  | { surfaceId: string; file: string; status: 'save-error'; text: string; error: string };

// 'no-worktree' is its own case (not folded into 'error') so a project scope
// selected before a worktree is picked yet — the normal, transient state
// right after switching — never fires a request that would 400, nor shows
// the same alarming amber banner a real load failure gets.
type SurfacesState =
  | { status: 'loading' }
  | { status: 'no-worktree' }
  | { status: 'error'; message: string; offline: boolean }
  | { status: 'ready'; surfaces: SurfaceValue[] };

const GROUP_HELP: Record<string, string> = {
  MCP: 'Connect your agent to tools and external services.',
  'Model & behavior': 'Choose how your agent thinks, responds and looks.',
  Permissions: 'Control which tools can run and when your agent asks first.',
  Environment: 'Set variables available to your coding agent.',
  Hooks: 'Manage commands that run when agent events occur.',
  Plugins: 'Enable or disable extensions and manage their marketplaces.',
  Skills: 'Manage reusable instructions that give your agent specific capabilities.',
  Instructions: 'Give your agent persistent guidance for its work.',
};

export function AgentsSection() {
  const workspace = useContext(WorkspaceContext);

  const [category, setCategory] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [agentsLoaded, setAgentsLoaded] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const [host, setHost] = useState('local');
  const [hosts, setHosts] = useState<{ id: string; label: string; online: boolean }[]>([]);
  const [scope, setScope] = useState<AgentScope>('global');
  const [worktree, setWorktree] = useState<string | undefined>(undefined);
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [state, setState] = useState<SurfacesState>({ status: 'loading' });
  // Staged (not-yet-saved) values for scalar surfaces, keyed by surface id.
  // Cleared per-surface once that group's Save flushes it through `patch`.
  const [dirty, setDirty] = useState<Record<string, unknown>>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savingGroup, setSavingGroup] = useState<string | null>(null);
  const [rawEditor, setRawEditor] = useState<RawEditorState | null>(null);
  // Bumped whenever the raw-editor "session" is intentionally ended (Cancel,
  // switching agent/scope/host, or starting a fresh load) — see
  // `closeRawEditor`/`openRawEditor`. An in-flight load/save's `.then`/
  // `.catch` captures the token at call time and checks it before applying
  // its result, so a stale response (from a request whose editor has since
  // been closed or reopened) is silently ignored instead of clobbering
  // whatever the user is looking at now.
  const rawEditorTokenRef = useRef(0);

  // Host list. 'This machine' is always available; runners that report in
  // add themselves. A runner that's currently offline still shows up (so the
  // user can see it's there) but can't be selected.
  useEffect(() => {
    api.runners
      .list()
      .then(({ runners }) => setHosts(runners.map((r) => ({ id: r.runnerId, label: r.name, online: r.online }))))
      .catch(() => setHosts([]));
  }, []);

  // Agents for the selected host. Re-fetches whenever the host changes since
  // a runner can have a different set of agents installed.
  useEffect(() => {
    let live = true;
    api.agentConfig
      .agents(host)
      .then(({ agents: list }) => {
        if (!live) return;
        setAgents(list);
        setActive((current) => {
          if (current && list.some((a) => a.id === current)) return current;
          return list.find(isSelectable)?.id ?? null;
        });
        setAgentsLoaded(true);
      })
      .catch(() => {
        if (!live) return;
        setAgents([]);
        setActive(null);
        setAgentsLoaded(true);
      });
    return () => {
      live = false;
    };
  }, [host]);

  // Worktrees for the project-scope picker. Fetched whenever a workspace is
  // known — NOT gated on `scope === 'project'` — so the scope switcher can
  // tell upfront whether project scope is even viable (there's at least one
  // worktree) before the user switches to it, rather than only discovering
  // an empty list after already switching.
  useEffect(() => {
    if (!workspace) {
      setWorktrees([]);
      return;
    }
    let live = true;
    api.worktrees
      .list(workspace.workspace.id)
      .then((list) => {
        if (live) setWorktrees(list);
      })
      .catch(() => {
        if (live) setWorktrees([]);
      });
    return () => {
      live = false;
    };
  }, [workspace]);

  // Project scope is unavailable — with an honest reason, not a silent
  // disable — in two cases:
  //  - No worktree exists for this workspace at all: there is nothing to
  //    scope a project-level config write to.
  //  - The selected host isn't this machine: `api.worktrees.list` above
  //    always queries the LOCAL server, so its paths describe worktrees on
  //    THIS machine, not the remote runner. Forwarding them there anyway
  //    created a full, wrong `.claude/` tree on the runner's filesystem —
  //    sourcing worktrees from the actually-selected host is real work left
  //    to a later slice; this only prevents the harmful write in the
  //    meantime.
  const projectScopeUnavailableReason = useMemo(() => {
    if (host !== 'local') return "Project scope isn't available for a remote host yet.";
    if (worktrees.length === 0) return 'No worktrees found for this workspace.';
    return null;
  }, [host, worktrees]);

  // If project scope was selected and then became unavailable out from under
  // it (the host changed, or the worktree list emptied out), fall back to
  // global rather than leaving a selected-but-disabled option in effect.
  useEffect(() => {
    if (scope === 'project' && projectScopeUnavailableReason) setScope('global');
  }, [scope, projectScopeUnavailableReason]);

  const load = useCallback(() => {
    if (!active) return;
    // A worktree not being picked yet is the ordinary state right after
    // switching to project scope — not a load failure. Firing the request
    // anyway would 400 and surface as a raw error banner.
    if (scope === 'project' && !worktree) {
      setState({ status: 'no-worktree' });
      return;
    }
    setState({ status: 'loading' });
    api.agentConfig
      .read(active, { scope, worktree, host })
      .then(({ surfaces }) => setState({ status: 'ready', surfaces }))
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        const code = (err as { code?: string } | null)?.code;
        setState({ status: 'error', message, offline: code === 'CLOUD_UNREACHABLE' });
      });
  }, [active, scope, worktree, host]);

  // Ends the raw-editor session: bumps the token (so any load/save in
  // flight for it is ignored when it resolves) and clears the panel.
  const closeRawEditor = useCallback(() => {
    rawEditorTokenRef.current += 1;
    setRawEditor(null);
  }, []);

  useEffect(() => {
    load();
    // A fresh read makes any staged-but-unsaved edit or open raw editor
    // stale — it referred to the previous agent/scope/host's surfaces.
    setDirty({});
    setSaveError(null);
    closeRawEditor();
  }, [load, closeRawEditor]);

  const groups = useMemo(() => {
    if (state.status !== 'ready') return [];
    const byGroup = new Map<string, SurfaceValue[]>();
    for (const s of state.surfaces) {
      const list = byGroup.get(s.group) ?? [];
      list.push(s);
      byGroup.set(s.group, list);
    }
    return [...byGroup.entries()];
  }, [state]);

  const selectedCategory = groups.some(([name]) => name === category) ? category : groups[0]?.[0];

  // List surfaces (mcp-list, skill-list, plugin-list, hook-list) commit a
  // row's edit the instant it happens — `onChange` on the widget.
  const commit = useCallback(
    async (surfaceId: string, value: unknown) => {
      if (!active) return;
      setSaveError(null);
      try {
        const res = await api.agentConfig.patch(active, { surfaceId, scope, worktree, value }, host);
        setState({ status: 'ready', surfaces: res.surfaces });
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : String(err));
      }
    },
    [active, scope, worktree, host],
  );

  // `skill-list`'s own removal path: a directory surface has no JSON key for
  // `commit`'s PATCH to target, so this goes through the dedicated skills
  // route instead, then reloads surfaces the same way `commit` does.
  const removeSkill = useCallback(
    async (name: string) => {
      if (!active) return;
      setSaveError(null);
      try {
        const res = await api.agentConfig.removeSkill(active, name, { scope, worktree, host });
        setState({ status: 'ready', surfaces: res.surfaces });
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : String(err));
      }
    },
    [active, scope, worktree, host],
  );

  // Scalar surfaces (enum, toggle, kv, permissions, markdown, raw) stage an
  // edit locally; nothing is sent until the group's Save button flushes it.
  const stage = useCallback((surfaceId: string, value: unknown) => {
    setDirty((d) => ({ ...d, [surfaceId]: value }));
  }, []);

  const saveGroup = useCallback(
    async (groupSurfaces: SurfaceValue[]) => {
      if (!active) return;
      const dirtySurfaces = groupSurfaces.filter((s) => Object.prototype.hasOwnProperty.call(dirty, s.id));
      if (dirtySurfaces.length === 0) return;
      setSavingGroup(groupSurfaces[0]!.group);
      setSaveError(null);
      // Apply and un-dirty each surface as ITS patch lands, one at a time —
      // not after the whole loop. A patch that throws must not roll back or
      // withhold surfaces that already committed on disk: the panel has to
      // keep agreeing with the real config, and a stopped-short surface must
      // stay dirty so a retry re-submits exactly what didn't land.
      for (const surface of dirtySurfaces) {
        try {
          const res = await api.agentConfig.patch(
            active,
            { surfaceId: surface.id, scope, worktree, value: dirty[surface.id] },
            host,
          );
          setState({ status: 'ready', surfaces: res.surfaces });
          setDirty((d) => {
            const next = { ...d };
            delete next[surface.id];
            return next;
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          setSaveError(`Failed to save "${surface.label}": ${message}`);
          setSavingGroup(null);
          return;
        }
      }
      setSavingGroup(null);
    },
    [active, scope, worktree, host, dirty],
  );

  // The shell's error banner (surface.error) leaves a broken config file
  // unparseable through the structured widgets — this is the handoff Task 11
  // left open: fetch the raw text so the user can fix the syntax directly.
  const openRawEditor = useCallback(
    (surface: SurfaceValue) => {
      if (!active) return;
      const token = (rawEditorTokenRef.current += 1);
      setRawEditor({ surfaceId: surface.id, file: surface.file, status: 'loading' });
      api.agentConfig
        .raw(active, surface.file, { worktree, host })
        .then(({ text }) => {
          // A closed/reopened/retried editor invalidates this token — this
          // response is no longer about what's on screen. Applying it
          // anyway would clobber whatever the user has since started with.
          if (rawEditorTokenRef.current !== token) return;
          setRawEditor({ surfaceId: surface.id, file: surface.file, status: 'ready', text });
        })
        .catch((err: unknown) => {
          if (rawEditorTokenRef.current !== token) return;
          const message = err instanceof Error ? err.message : String(err);
          setRawEditor({ surfaceId: surface.id, file: surface.file, status: 'load-error', error: message });
        });
    },
    [active, worktree, host],
  );

  // Retrying a *save* (not a load) re-submits from the ready state OR from a
  // previous save-error — both have text worth saving. A load failure never
  // reaches here (the button guarding this is disabled in that state).
  const saveRawEditor = useCallback(() => {
    if (!active || !rawEditor) return;
    if (rawEditor.status !== 'ready' && rawEditor.status !== 'save-error') return;
    const { surfaceId, file, text } = rawEditor;
    const token = rawEditorTokenRef.current;
    setRawEditor({ surfaceId, file, status: 'saving', text });
    api.agentConfig
      .saveRaw(active, file, text, { worktree, host })
      .then(() => {
        // The save landed, but if the token moved on (editor closed/reopened
        // meanwhile) this response is stale — closing again or reloading now
        // would step on whatever session replaced it.
        if (rawEditorTokenRef.current !== token) return;
        closeRawEditor();
        load();
      })
      .catch((err: unknown) => {
        if (rawEditorTokenRef.current !== token) return;
        const message = err instanceof Error ? err.message : String(err);
        setRawEditor({ surfaceId, file, status: 'save-error', text, error: message });
      });
  }, [active, rawEditor, worktree, host, load, closeRawEditor]);

  return (
    <div className="flex w-full min-w-0 max-w-3xl flex-col gap-5">
      <div>
        <h2 className="text-xl font-semibold tracking-tight text-zinc-100">Coding agents</h2>
        <p className="text-xs text-zinc-500">
          Manage MCP servers, skills, plugins and permissions for each coding agent.
        </p>
      </div>

      <div className="flex flex-wrap items-start gap-4 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
        <label className="flex min-w-0 flex-1 flex-col gap-1.5 text-xs text-zinc-400">
          Host
          <select
            aria-label="Host"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100 focus:border-zinc-500 focus:outline-none"
          >
            <option value="local">This machine</option>
            {hosts.map((h) => (
              <option key={h.id} value={h.id} disabled={!h.online}>
                {h.label}{h.online ? '' : ' (offline)'}
              </option>
            ))}
          </select>
        </label>

        <label className="flex min-w-0 flex-1 flex-col gap-1.5 text-xs text-zinc-400">
          Scope
          <select
            aria-label="Scope"
            value={scope}
            onChange={(e) => setScope(e.target.value as AgentScope)}
            className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100 focus:border-zinc-500 focus:outline-none"
          >
            <option value="global">Global</option>
            <option value="project" disabled={projectScopeUnavailableReason !== null} title={projectScopeUnavailableReason ?? undefined}>
              Project
            </option>
          </select>
          {projectScopeUnavailableReason && (
            <span className="text-[10px] text-zinc-500">{projectScopeUnavailableReason}</span>
          )}
        </label>

        {scope === 'project' && (
          <label className="flex min-w-0 flex-1 flex-col gap-1.5 text-xs text-zinc-400">
            Worktree
            <select
              aria-label="Worktree"
              value={worktree ?? ''}
              onChange={(e) => setWorktree(e.target.value || undefined)}
              className="w-full min-w-0 rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100 focus:border-zinc-500 focus:outline-none"
            >
              <option value="">Select a worktree…</option>
              {worktrees.map((w) => (
                <option key={w.path} value={w.path}>
                  {w.meta?.title ?? w.path}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div role="tablist" aria-label="Coding agent" className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {agents.map((a) => (
          <button
            key={a.id}
            role="tab"
            type="button"
            aria-selected={active === a.id}
            disabled={!isSelectable(a)}
            title={disabledReason(a) ?? undefined}
            onClick={() => setActive(a.id)}
            className={`min-w-0 rounded-lg border px-3 py-3 text-left text-sm transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500 ${
              active === a.id
                ? 'border-sky-500/60 bg-sky-500/10 text-zinc-100'
                : 'border-zinc-800 bg-zinc-900/30 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200'
            } disabled:cursor-not-allowed`}
          >
            <span className="block truncate font-medium">{a.label}</span>
            <span className={`mt-1 block text-[10px] ${isSelectable(a) ? 'text-sky-400' : 'text-zinc-500'}`}>
              {isSelectable(a) ? 'Available' : a.installed ? 'Not supported yet' : 'Not installed'}
            </span>
          </button>
        ))}
      </div>

      {agentsLoaded && !active ? (
        <p className="text-sm text-zinc-500">{emptyStateReason(agents)}</p>
      ) : (
        <>
          {state.status === 'loading' && <p className="text-sm text-zinc-500">Loading…</p>}

          {state.status === 'no-worktree' && (
            <p className="text-sm text-zinc-500">Select a worktree above to configure project-scope settings.</p>
          )}

          {state.status === 'error' && (
            <div className="flex flex-col gap-2 rounded border border-amber-900/60 bg-amber-950/40 px-3 py-2 text-sm text-amber-200">
              <span>{state.offline ? `This host is offline: ${state.message}` : state.message}</span>
              <button
                type="button"
                onClick={load}
                className="self-start rounded border border-amber-800 px-2.5 py-1 text-xs text-amber-200 hover:bg-amber-900/40"
              >
                Retry
              </button>
            </div>
          )}

          {state.status === 'ready' && (
            <div className="flex min-w-0 flex-col gap-4">
              <nav aria-label="Agent settings categories" className="sticky top-0 z-10 flex flex-wrap gap-1.5 bg-zinc-950 py-2">
                {groups.map(([name, items]) => {
                  const pending = items.some((item) => Object.prototype.hasOwnProperty.call(dirty, item.id));
                  return (
                    <button key={name} type="button" aria-pressed={selectedCategory === name}
                      onClick={() => setCategory(name)}
                      className={`flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500 ${selectedCategory === name ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'}`}>
                      {name}
                      {pending && <span aria-label="Unsaved changes" className="h-1.5 w-1.5 rounded-full bg-amber-400" />}
                    </button>
                  );
                })}
              </nav>
              {groups.length === 0 && <p className="rounded-lg border border-dashed border-zinc-800 p-6 text-center text-sm text-zinc-400">No settings are available for this agent in this scope.</p>}
              {saveError && (
                <div className="rounded border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-200">
                  {saveError}
                </div>
              )}
              {groups.map(([group, groupSurfaces]) => {
                // A group is a UI grouping, not a guarantee that every surface
                // in it lives in the same file (e.g. project-scope "MCP"
                // holds both `mcp` from .mcp.json and `mcp-approved` from
                // ~/.claude.json). Collapsing one path into the header is
                // only safe when every surface in the group actually shares
                // it; otherwise each surface must show its own path so
                // nobody is pointed at the wrong file.
                const sharedFile = groupSurfaces.every((s) => s.file === groupSurfaces[0]!.file)
                  ? groupSurfaces[0]!.file
                  : null;
                const groupDirtyCount = groupSurfaces.filter((s) =>
                  Object.prototype.hasOwnProperty.call(dirty, s.id),
                ).length;
                const immediateKinds = ['mcp-list', 'plugin-list', 'skill-list', 'hook-list'];
                const hasImmediateChanges = groupSurfaces.some((s) => !s.readOnly && immediateKinds.includes(s.kind));
                const hasStagedChanges = groupSurfaces.some((s) => !s.readOnly && !immediateKinds.includes(s.kind));
                const saveHint = hasImmediateChanges
                  ? hasStagedChanges ? 'List actions save immediately. Other edits require Save.' : 'Changes in this list save immediately.'
                  : hasStagedChanges ? 'Edit the fields, then select Save to apply your changes.' : 'These settings are read-only.';
                return (
                  <section key={group} aria-label={group} hidden={selectedCategory !== group}
                    className={selectedCategory === group ? 'flex min-w-0 flex-col gap-5 rounded-xl border border-zinc-800 bg-zinc-900/20 p-4' : 'hidden'}>
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <h3 className="text-sm font-semibold text-zinc-100">{group}</h3>
                        {GROUP_HELP[group] && <p className="mt-1 text-xs leading-relaxed text-zinc-400">{GROUP_HELP[group]}</p>}
                        {sharedFile && (
                          <details className="mt-2 text-[11px] text-zinc-500">
                            <summary className="cursor-pointer hover:text-zinc-300">Configuration file</summary>
                            <p className="mt-1 break-all font-mono">{sharedFile}</p>
                          </details>
                        )}
                      </div>
                      {groupDirtyCount > 0 && (
                        <button
                          type="button"
                          disabled={savingGroup === group}
                          onClick={() => saveGroup(groupSurfaces)}
                          className="shrink-0 rounded-lg bg-sky-500 px-3 py-2 text-xs font-semibold text-white hover:bg-sky-600 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {savingGroup === group ? 'Saving…' : 'Save'}
                        </button>
                      )}
                    </div>
                    <div className="flex min-w-0 flex-col gap-5">
                      {groupSurfaces.map((surface) => {
                        const Widget = widgetFor(surface.kind);
                        return (
                          <div key={surface.id} data-testid={`surface-${surface.id}`} className="flex min-w-0 flex-col gap-2">
                            <span className="text-xs text-zinc-400">{surface.label}</span>
                            {!sharedFile && <p className="break-all font-mono text-[11px] text-zinc-500">{surface.file}</p>}
                            {surface.error && (
                              <div className="flex flex-col gap-2 rounded border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-200">
                                <span>
                                  {scope === 'project' ? "This project's config file is unparseable: " : 'This config file is unparseable: '}
                                  {surface.error}
                                </span>
                                <button
                                  type="button"
                                  onClick={() => openRawEditor(surface)}
                                  className="self-start rounded border border-red-800 px-2.5 py-1 text-xs text-red-200 hover:bg-red-900/40"
                                >
                                  Open raw editor
                                </button>
                              </div>
                            )}
                            {surface.inheritedError && (
                              <div className="rounded border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-200">
                                Your global config file is unparseable, so inheritance can't be computed: {surface.inheritedError}
                              </div>
                            )}
                            {rawEditor?.surfaceId === surface.id && (
                              <div className="flex flex-col gap-2 rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs">
                                <p className="break-all font-mono text-[11px] text-zinc-500">{rawEditor.file}</p>
                                <p className="text-amber-300">
                                  This file's raw contents may include credentials such as API keys — edit
                                  carefully.
                                </p>
                                {rawEditor.status === 'loading' && <p className="text-zinc-400">Loading…</p>}
                                {rawEditor.status === 'load-error' && (
                                  <>
                                    <p className="text-red-300">{rawEditor.error}</p>
                                    <div className="flex gap-2">
                                      <button
                                        type="button"
                                        onClick={() => openRawEditor(surface)}
                                        className="rounded border border-red-800 px-2.5 py-1 text-xs text-red-200 hover:bg-red-900/40"
                                      >
                                        Retry
                                      </button>
                                      <button
                                        type="button"
                                        onClick={closeRawEditor}
                                        className="rounded border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
                                      >
                                        Cancel
                                      </button>
                                    </div>
                                  </>
                                )}
                                {(rawEditor.status === 'ready' ||
                                  rawEditor.status === 'saving' ||
                                  rawEditor.status === 'save-error') && (
                                  <>
                                    <textarea
                                      aria-label={`Raw editor for ${surface.label}`}
                                      value={rawEditor.text}
                                      disabled={rawEditor.status === 'saving'}
                                      onChange={(e) => {
                                        const text = e.target.value;
                                        setRawEditor((cur) => {
                                          if (!cur) return cur;
                                          // A save in flight must never be re-enabled by typing —
                                          // `disabled` already blocks a real user from reaching
                                          // this, but guard the handler itself too rather than
                                          // rely solely on the DOM attribute.
                                          if (cur.status === 'saving') return cur;
                                          return { surfaceId: cur.surfaceId, file: cur.file, status: 'ready', text };
                                        });
                                      }}
                                      rows={10}
                                      className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 font-mono text-xs text-zinc-100 focus:border-zinc-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                                    />
                                    {rawEditor.status === 'save-error' && (
                                      <p className="text-red-300">{rawEditor.error}</p>
                                    )}
                                    <div className="flex gap-2">
                                      <button
                                        type="button"
                                        disabled={rawEditor.status === 'saving'}
                                        onClick={saveRawEditor}
                                        className="rounded border border-sky-800 px-2.5 py-1 text-xs text-sky-200 hover:bg-sky-900/40 disabled:cursor-not-allowed disabled:opacity-50"
                                      >
                                        {rawEditor.status === 'saving' ? 'Saving…' : 'Save file'}
                                      </button>
                                      <button
                                        type="button"
                                        onClick={closeRawEditor}
                                        className="rounded border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
                                      >
                                        Cancel
                                      </button>
                                    </div>
                                  </>
                                )}
                              </div>
                            )}
                            {!surface.error && (
                              <Widget
                                surface={surface}
                                onChange={(value) => commit(surface.id, value)}
                                onStage={(value) => stage(surface.id, value)}
                                onRemoveSkill={removeSkill}
                              />
                            )}
                          </div>
                        );
                      })}
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-zinc-800 pt-3 text-[11px] text-zinc-500">
                      <span>{groupDirtyCount > 0 ? `${groupDirtyCount} unsaved ${groupDirtyCount === 1 ? 'change' : 'changes'}` : saveHint}</span>
                      {groupDirtyCount > 0 && <span className="text-amber-400">Save this section before leaving settings</span>}
                    </div>
                  </section>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
