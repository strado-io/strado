import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AgentsSection } from './AgentsSection';
import { api } from '../../../api';
import { WorkspaceContext } from '../../../contexts/WorkspaceContext';
import type { Workspace } from '../../../types';

vi.mock('../../../api', () => ({
  api: {
    agentConfig: {
      agents: vi.fn(), read: vi.fn(), patch: vi.fn(), raw: vi.fn(), saveRaw: vi.fn(), removeSkill: vi.fn(),
    },
    runners: { list: vi.fn().mockResolvedValue({ runners: [] }) },
    worktrees: { list: vi.fn().mockResolvedValue([]) },
  },
}));

const workspace: Workspace = {
  id: 'default', name: 'Default', color: '#333333', icon: 'D',
  defaultEditor: 'code', defaultPortBase: 8080, logDir: null,
};

const surfaces = [
  { id: 'theme', label: 'Theme', group: 'Model & behavior', kind: 'enum',
    readOnly: false, value: 'dark', source: 'set',
    file: '/home/u/.claude/settings.json', exists: true },
];

beforeEach(() => {
  // Each test's mock call history must start clean — several tests below
  // assert `not.toHaveBeenCalled()` / exact call args, which a leftover call
  // from a prior test would corrupt.
  vi.clearAllMocks();
  vi.mocked(api.runners.list).mockResolvedValue({ runners: [] });
  vi.mocked(api.worktrees.list).mockResolvedValue([]);
  vi.mocked(api.agentConfig.agents).mockResolvedValue({
    agents: [
      { id: 'claude', label: 'Claude', installed: true, supported: true, files: [] },
      { id: 'codex', label: 'Codex', installed: false, supported: false, files: [] },
    ],
  });
  vi.mocked(api.agentConfig.read).mockResolvedValue({
    agent: 'claude', scope: 'global', surfaces: surfaces as never,
  });
});

describe('AgentsSection', () => {
  it('renders a tab per agent and selects the first installed one', async () => {
    render(<AgentsSection />);
    expect(await screen.findByRole('tab', { name: /Claude/ })).toHaveAttribute('aria-selected', 'true');
  });

  // The brief's fixture lists the installed agent first, so `agents[0]` would
  // also pass. Put the NOT-installed agent first to prove the selection
  // logic actually looks at `installed` rather than position.
  it('selects the first installed agent even when it is not first in the list', async () => {
    vi.mocked(api.agentConfig.agents).mockResolvedValue({
      agents: [
        { id: 'codex', label: 'Codex', installed: false, supported: false, files: [] },
        { id: 'claude', label: 'Claude', installed: true, supported: true, files: [] },
      ],
    });
    render(<AgentsSection />);
    expect(await screen.findByRole('tab', { name: /Claude/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /Codex/ })).toHaveAttribute('aria-selected', 'false');
    expect(api.agentConfig.read).toHaveBeenCalledWith('claude', expect.anything());
  });

  it('shows an empty state and never calls read when no agent is installed', async () => {
    vi.mocked(api.agentConfig.agents).mockResolvedValue({
      agents: [
        { id: 'claude', label: 'Claude', installed: false, supported: true, files: [] },
        { id: 'codex', label: 'Codex', installed: false, supported: false, files: [] },
      ],
    });
    render(<AgentsSection />);
    expect(await screen.findByText(/No agents are installed/)).toBeInTheDocument();
    expect(api.agentConfig.read).not.toHaveBeenCalled();
  });

  it('disables the tab of an agent that is not installed', async () => {
    render(<AgentsSection />);
    expect(await screen.findByRole('tab', { name: /Codex/ })).toBeDisabled();
  });

  // `installed` (the CLI exists) and `supported` (Strado has a descriptor for
  // it) are independent, so there are three distinct reasons a tab can be
  // disabled — each must be worded honestly and distinguishably. In
  // particular, Codex today is installed but unsupported: it must NOT read
  // as "not installed", which would be the panel lying about the user's own
  // system.
  it('gives each of the three disabled combinations its own, distinct wording', async () => {
    vi.mocked(api.agentConfig.agents).mockResolvedValue({
      agents: [
        { id: 'claude', label: 'Claude', installed: true, supported: true, files: [] },
        // Installed, but Strado has no descriptor yet — the real Codex case.
        { id: 'codex', label: 'Codex', installed: true, supported: false, files: [] },
        // Supported, but the CLI isn't on this machine.
        { id: 'opencode', label: 'OpenCode', installed: false, supported: true, files: [] },
        // Neither installed nor supported.
        { id: 'pi', label: 'Pi', installed: false, supported: false, files: [] },
      ],
    });
    render(<AgentsSection />);

    const codexTab = await screen.findByRole('tab', { name: /Codex/ });
    const opencodeTab = await screen.findByRole('tab', { name: /OpenCode/ });
    const piTab = await screen.findByRole('tab', { name: /Pi/ });
    expect(codexTab).toBeDisabled();
    expect(opencodeTab).toBeDisabled();
    expect(piTab).toBeDisabled();

    // The installed-but-unsupported reason must say so, and must NOT claim
    // the agent isn't installed.
    const codexReason = codexTab.getAttribute('title') ?? '';
    expect(codexReason).toMatch(/support/i);
    expect(codexReason).not.toMatch(/not installed/i);

    // The supported-but-not-installed reason says it's not installed, and
    // does not raise Strado's own lack of support (support isn't the issue).
    const opencodeReason = opencodeTab.getAttribute('title') ?? '';
    expect(opencodeReason).toMatch(/not installed/i);
    expect(opencodeReason).not.toMatch(/doesn't support|does not support/i);

    // The neither case names both facts.
    const piReason = piTab.getAttribute('title') ?? '';
    expect(piReason).toMatch(/not installed/i);
    expect(piReason).toMatch(/support/i);

    // All three reasons are distinct from one another.
    expect(new Set([codexReason, opencodeReason, piReason]).size).toBe(3);
  });

  // A selectable tab needs BOTH facts true — installed alone (the old
  // behavior) is not enough once an agent can be installed but unsupported.
  it('does not auto-select an installed-but-unsupported agent', async () => {
    vi.mocked(api.agentConfig.agents).mockResolvedValue({
      agents: [
        { id: 'codex', label: 'Codex', installed: true, supported: false, files: [] },
        { id: 'claude', label: 'Claude', installed: true, supported: true, files: [] },
      ],
    });
    render(<AgentsSection />);
    expect(await screen.findByRole('tab', { name: /Claude/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /Codex/ })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('tab', { name: /Codex/ })).toBeDisabled();
  });

  it('passes the selected host through to both the agent list and the surface read', async () => {
    vi.mocked(api.runners.list).mockResolvedValue({
      runners: [{ runnerId: 'r1', name: 'Box', online: true, lastOnlineAt: null, createdAt: '2024-01-01', runnerVersion: null }],
    });
    render(<AgentsSection />);
    await screen.findByRole('tab', { name: /Claude/ });
    await userEvent.selectOptions(screen.getByLabelText('Host'), 'r1');
    await waitFor(() => expect(api.agentConfig.agents).toHaveBeenCalledWith('r1'));
    await waitFor(() =>
      expect(api.agentConfig.read).toHaveBeenCalledWith('claude', expect.objectContaining({ host: 'r1' })),
    );
  });

  it('shows the resolved file path for each group', async () => {
    render(<AgentsSection />);
    expect(await screen.findByText('/home/u/.claude/settings.json')).toBeInTheDocument();
  });

  // A group is a UI label, not a promise that every surface in it lives in
  // one file — project-scope "MCP" holds both `mcp` (.mcp.json) and
  // `mcp-approved` (~/.claude.json). Each surface must show ITS OWN file, not
  // a path collapsed from a sibling. Assert per-surface, via `within`, so a
  // regression that shows one shared (wrong) path for both can't pass.
  it('shows each surface\'s own file when a group mixes files, not one path for the whole group', async () => {
    vi.mocked(api.agentConfig.read).mockResolvedValue({
      agent: 'claude', scope: 'project',
      surfaces: [
        { id: 'mcp', label: 'MCP servers', group: 'MCP', kind: 'mcp-list',
          readOnly: false, value: [], source: 'set',
          file: '/wt/project/.mcp.json', exists: true },
        { id: 'mcp-approved', label: 'Approved for this project', group: 'MCP', kind: 'kv',
          readOnly: false, value: {}, source: 'set',
          file: '/home/u/.claude.json', exists: true },
      ] as never,
    });
    render(<AgentsSection />);
    const mcpRow = within(await screen.findByTestId('surface-mcp'));
    const approvedRow = within(await screen.findByTestId('surface-mcp-approved'));
    expect(mcpRow.getByText('/wt/project/.mcp.json')).toBeInTheDocument();
    expect(approvedRow.getByText('/home/u/.claude.json')).toBeInTheDocument();
    // Neither surface's own file should bleed into the other's row.
    expect(mcpRow.queryByText('/home/u/.claude.json')).not.toBeInTheDocument();
    expect(approvedRow.queryByText('/wt/project/.mcp.json')).not.toBeInTheDocument();
  });

  it('re-reads when the scope switches to project and a worktree is picked', async () => {
    // Project scope is disabled with no worktree to scope it to (final
    // review fix: the scope switcher must not offer a scope with nowhere to
    // apply it) — a workspace and at least one worktree are both required
    // for this switch to actually be selectable at all.
    vi.mocked(api.worktrees.list).mockResolvedValue([{ path: '/wt/project' }] as never);
    render(
      <WorkspaceContext.Provider value={{ workspace, allWorkspaces: [workspace], refresh: vi.fn(), switchTo: vi.fn() }}>
        <AgentsSection />
      </WorkspaceContext.Provider>,
    );
    await screen.findByRole('tab', { name: /Claude/ });
    await userEvent.selectOptions(screen.getByLabelText('Scope'), 'project');
    await userEvent.selectOptions(await screen.findByLabelText('Worktree'), '/wt/project');
    await waitFor(() =>
      expect(api.agentConfig.read).toHaveBeenCalledWith('claude', expect.objectContaining({ scope: 'project', worktree: '/wt/project' })),
    );
  });

  it('disables project scope and never fires a project-scope read when the workspace has no worktrees', async () => {
    render(<AgentsSection />);
    await screen.findByRole('tab', { name: /Claude/ });
    expect(screen.getByRole('option', { name: 'Project' })).toBeDisabled();
    // userEvent respects `disabled` — it must not force the value through.
    await userEvent.selectOptions(screen.getByLabelText('Scope'), 'project').catch(() => undefined);
    expect(api.agentConfig.read).not.toHaveBeenCalledWith('claude', expect.objectContaining({ scope: 'project' }));
  });

  it('shows a neutral prompt instead of a raw error when project scope has no worktree selected yet', async () => {
    vi.mocked(api.worktrees.list).mockResolvedValue([{ path: '/wt/project' }] as never);
    render(
      <WorkspaceContext.Provider value={{ workspace, allWorkspaces: [workspace], refresh: vi.fn(), switchTo: vi.fn() }}>
        <AgentsSection />
      </WorkspaceContext.Provider>,
    );
    await screen.findByRole('tab', { name: /Claude/ });
    await userEvent.selectOptions(screen.getByLabelText('Scope'), 'project');
    // Not `/select a worktree/i` — that also matches the worktree <select>'s
    // own "Select a worktree…" placeholder option, giving a multiple-match
    // false failure unrelated to what this test checks.
    expect(await screen.findByText(/select a worktree above/i)).toBeInTheDocument();
    expect(api.agentConfig.read).not.toHaveBeenCalledWith('claude', expect.objectContaining({ scope: 'project' }));
  });

  it('shows a retry when the selected host is offline', async () => {
    vi.mocked(api.agentConfig.read).mockRejectedValue(
      Object.assign(new Error('runner r1 is offline'), { code: 'CLOUD_UNREACHABLE' }),
    );
    render(<AgentsSection />);
    expect(await screen.findByText(/offline/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Retry/ })).toBeInTheDocument();
  });

  it('surfaces a parse error instead of the form', async () => {
    vi.mocked(api.agentConfig.read).mockResolvedValue({
      agent: 'claude', scope: 'global',
      surfaces: [{ ...surfaces[0], error: 'config file is not valid JSON: parse error' }] as never,
    });
    render(<AgentsSection />);
    expect(await screen.findByText(/not valid JSON/)).toBeInTheDocument();
  });

  // Not in the brief: `inheritedError` is a distinct failure from `error` —
  // the GLOBAL config failed to parse while computing inheritance for a
  // project-scope surface that has no error of its own. Telling someone
  // their project file is broken when it's actually their global file would
  // send them to the wrong file, so the two must render distinguishably.
  it('surfaces an inherited (global) parse error distinctly from the surface having no error of its own', async () => {
    vi.mocked(api.agentConfig.read).mockResolvedValue({
      agent: 'claude', scope: 'project',
      surfaces: [{
        ...surfaces[0],
        error: undefined,
        source: 'unset',
        inheritedError: 'global config file is not valid JSON: unexpected token',
      }] as never,
    });
    render(<AgentsSection />);
    // Mentions the global file specifically, not the project file.
    expect(await screen.findByText(/global/i)).toBeInTheDocument();
    expect(await screen.findByText(/unexpected token/)).toBeInTheDocument();
  });

  // `error` (this scope's own file is broken) and `inheritedError` (the
  // global file is broken) are independent — a project file can be
  // unparseable at the same time as the global one. Showing only one would
  // leave the user thinking they'd fixed everything after fixing one file.
  it('shows both the surface\'s own parse error and an inherited parse error when both are set', async () => {
    vi.mocked(api.agentConfig.read).mockResolvedValue({
      agent: 'claude', scope: 'project',
      surfaces: [{
        ...surfaces[0],
        error: 'config file is not valid JSON: parse error',
        inheritedError: 'global config file is not valid JSON: unexpected token',
      }] as never,
    });
    render(<AgentsSection />);
    expect(await screen.findByText(/not valid JSON: parse error/)).toBeInTheDocument();
    expect(await screen.findByText(/unexpected token/)).toBeInTheDocument();
  });

  // List surfaces (mcp-list, skill-list, plugin-list, hook-list) commit the
  // instant a row changes — no Save button involved — and the section must
  // adopt whatever `patch` returns rather than guessing the new state itself.
  it('commits a list-surface edit immediately via patch and adopts the returned surfaces', async () => {
    const mcpSurface = {
      id: 'mcp', label: 'MCP servers', group: 'MCP', kind: 'mcp-list',
      readOnly: false, value: { figma: { url: 'http://x' } }, source: 'set',
      file: '/home/u/.claude.json', exists: true,
    };
    vi.mocked(api.agentConfig.read).mockResolvedValue({
      agent: 'claude', scope: 'global', surfaces: [mcpSurface] as never,
    });
    vi.mocked(api.agentConfig.patch).mockResolvedValue({
      agent: 'claude', scope: 'global', surfaces: [{ ...mcpSurface, value: undefined, source: 'unset' }] as never,
    });
    render(<AgentsSection />);
    await userEvent.click(await screen.findByLabelText('Remove figma'));
    // Removing the only server sends `undefined` (not `{}`) so the write
    // path's `jsonDriver.remove` deletes the `mcpServers` key entirely
    // rather than leaving an explicitly-empty object behind.
    expect(api.agentConfig.patch).toHaveBeenCalledWith(
      'claude',
      { surfaceId: 'mcp', scope: 'global', worktree: undefined, value: undefined },
      'local',
    );
    // Adopted the server's response: the removed server is gone from the DOM.
    await waitFor(() => expect(screen.queryByText('figma')).not.toBeInTheDocument());
  });

  // Scalar surfaces (enum, toggle, kv, permissions, markdown, raw) must NOT
  // hit the network on every keystroke/selection — only the group's Save
  // button flushes what's staged.
  it('stages a scalar edit behind the group Save button and only patches on Save', async () => {
    const effortSurface = {
      id: 'effortLevel', label: 'Effort level', group: 'Model & behavior', kind: 'enum',
      readOnly: false, value: 'low', options: ['low', 'high'], source: 'set',
      file: '/home/u/.claude/settings.json', exists: true,
    };
    vi.mocked(api.agentConfig.read).mockResolvedValue({
      agent: 'claude', scope: 'global', surfaces: [effortSurface] as never,
    });
    vi.mocked(api.agentConfig.patch).mockResolvedValue({
      agent: 'claude', scope: 'global', surfaces: [{ ...effortSurface, value: 'high' }] as never,
    });
    render(<AgentsSection />);
    await userEvent.selectOptions(await screen.findByLabelText('Effort level'), 'high');
    // Selecting stages the value — nothing hits the network yet.
    expect(api.agentConfig.patch).not.toHaveBeenCalled();
    await userEvent.click(await screen.findByRole('button', { name: 'Save' }));
    expect(api.agentConfig.patch).toHaveBeenCalledWith(
      'claude',
      { surfaceId: 'effortLevel', scope: 'global', worktree: undefined, value: 'high' },
      'local',
    );
    // The Save button disappears once there's nothing left staged.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument());
  });

  // The "Open raw editor" button in the parse-error banner is the Task 11
  // handoff point — wired here to the raw-file endpoints so a broken config
  // can be fixed without hand-editing it outside the app.
  it('opens the raw editor for an unparseable surface and saves the fixed text', async () => {
    vi.mocked(api.agentConfig.read).mockResolvedValue({
      agent: 'claude', scope: 'global',
      surfaces: [{ ...surfaces[0], error: 'config file is not valid JSON: parse error' }] as never,
    });
    vi.mocked(api.agentConfig.raw).mockResolvedValue({
      file: '/home/u/.claude/settings.json', text: '{ broken',
    });
    vi.mocked(api.agentConfig.saveRaw).mockResolvedValue({
      file: '/home/u/.claude/settings.json', saved: true,
    });
    render(<AgentsSection />);
    await userEvent.click(await screen.findByRole('button', { name: 'Open raw editor' }));
    await waitFor(() =>
      expect(api.agentConfig.raw).toHaveBeenCalledWith('claude', '/home/u/.claude/settings.json', {
        worktree: undefined, host: 'local',
      }),
    );
    const textarea = await screen.findByDisplayValue('{ broken');
    fireEvent.change(textarea, { target: { value: '{}' } });
    await userEvent.click(screen.getByRole('button', { name: 'Save file' }));
    await waitFor(() =>
      expect(api.agentConfig.saveRaw).toHaveBeenCalledWith(
        'claude', '/home/u/.claude/settings.json', '{}', { worktree: undefined, host: 'local' },
      ),
    );
    // Saving re-reads the surfaces so the (now-fixed) file's real value shows.
    await waitFor(() => expect(api.agentConfig.read).toHaveBeenCalledTimes(2));
  });

  // Review fix round 1, item 1: a group Save that patches multiple dirty
  // surfaces sequentially must not wait until the whole loop finishes to
  // apply anything. If surface #1 succeeds and #2 then throws, #1 is already
  // committed on disk — the panel must reflect that immediately and drop it
  // from `dirty`, while #2 stays dirty (so retrying resubmits only what
  // didn't land) and the error names which surface failed.
  it('applies each surface\'s patch as it lands, keeping a later failure from rolling back an earlier success', async () => {
    const effortSurface = {
      id: 'effortLevel', label: 'Effort level', group: 'Model & behavior', kind: 'enum',
      readOnly: false, value: 'low', options: ['low', 'high'], source: 'set',
      file: '/home/u/.claude/settings.json', exists: true,
    };
    const thinkingSurface = {
      id: 'alwaysThinking', label: 'Always thinking', group: 'Model & behavior', kind: 'toggle',
      readOnly: false, value: false, source: 'set',
      file: '/home/u/.claude/settings.json', exists: true,
    };
    vi.mocked(api.agentConfig.read).mockResolvedValue({
      agent: 'claude', scope: 'global', surfaces: [effortSurface, thinkingSurface] as never,
    });
    vi.mocked(api.agentConfig.patch).mockImplementation(async (_agent, body) => {
      if ((body as { surfaceId: string }).surfaceId === 'effortLevel') {
        return {
          agent: 'claude', scope: 'global',
          surfaces: [{ ...effortSurface, value: 'high' }, thinkingSurface] as never,
        };
      }
      throw new Error('disk full');
    });
    render(<AgentsSection />);
    await userEvent.selectOptions(await screen.findByLabelText('Effort level'), 'high');
    await userEvent.click(await screen.findByLabelText('Always thinking'));
    await userEvent.click(await screen.findByRole('button', { name: 'Save' }));

    await waitFor(() => expect(api.agentConfig.patch).toHaveBeenCalledTimes(2));
    // The first surface's successful patch is reflected...
    await waitFor(() => expect(screen.getByLabelText('Effort level')).toHaveValue('high'));
    // ...and the error names the surface whose patch actually failed.
    expect(await screen.findByText(/Failed to save "Always thinking"/)).toBeInTheDocument();
    expect(screen.getByText(/disk full/)).toBeInTheDocument();
    // The failed surface is still dirty, so Save is still offered to retry it.
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });

  // Review fix round 1, item 2: the raw editor shows a whole file's text
  // as-is (it can't redact — the redacted text would be what gets written
  // back), so it needs an explicit warning that credentials may be visible.
  // Assert it's there from the moment the editor opens, before the file
  // text has even arrived, so it isn't accidentally gated on `status === 'ready'`.
  it('shows a credentials notice as soon as the raw editor opens, before the file loads', async () => {
    vi.mocked(api.agentConfig.read).mockResolvedValue({
      agent: 'claude', scope: 'global',
      surfaces: [{ ...surfaces[0], error: 'config file is not valid JSON: parse error' }] as never,
    });
    let resolveRaw!: (v: { file: string; text: string }) => void;
    vi.mocked(api.agentConfig.raw).mockReturnValue(
      new Promise((resolve) => {
        resolveRaw = resolve;
      }),
    );
    render(<AgentsSection />);
    await userEvent.click(await screen.findByRole('button', { name: 'Open raw editor' }));
    expect(await screen.findByText(/may include credentials/i)).toBeInTheDocument();
    resolveRaw({ file: '/home/u/.claude/settings.json', text: '{}' });
  });

  // Review fix round 1, item 3: a raw-editor *load* failure must not leave a
  // Save button that looks active but silently no-ops (there's no text to
  // save). It must show the failure with a Retry, and Save must not be
  // reachable until a load actually succeeds.
  it('shows a retry — not a silently inert Save — when the raw file fails to load', async () => {
    vi.mocked(api.agentConfig.read).mockResolvedValue({
      agent: 'claude', scope: 'global',
      surfaces: [{ ...surfaces[0], error: 'config file is not valid JSON: parse error' }] as never,
    });
    vi.mocked(api.agentConfig.raw).mockRejectedValue(new Error('permission denied'));
    render(<AgentsSection />);
    await userEvent.click(await screen.findByRole('button', { name: 'Open raw editor' }));
    expect(await screen.findByText('permission denied')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save file' })).not.toBeInTheDocument();
    const retry = screen.getByRole('button', { name: 'Retry' });

    vi.mocked(api.agentConfig.raw).mockResolvedValue({ file: '/home/u/.claude/settings.json', text: '{}' });
    await userEvent.click(retry);
    expect(await screen.findByDisplayValue('{}')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save file' })).toBeInTheDocument();
  });

  // Review fix round 2, item 1: a save in flight must never be re-enabled by
  // typing. The textarea disables while `status === 'saving'`, and the
  // `onChange` handler itself ignores edits in that state too (defense in
  // depth — `fireEvent.change` bypasses the DOM `disabled` guard, which is
  // exactly how the original bug was caught).
  it('does not re-enable Save when the editor is (attempted to be) edited during an in-flight save', async () => {
    vi.mocked(api.agentConfig.read).mockResolvedValue({
      agent: 'claude', scope: 'global',
      surfaces: [{ ...surfaces[0], error: 'config file is not valid JSON: parse error' }] as never,
    });
    vi.mocked(api.agentConfig.raw).mockResolvedValue({ file: '/home/u/.claude/settings.json', text: '{}' });
    let resolveSave!: (v: { file: string; saved: boolean }) => void;
    vi.mocked(api.agentConfig.saveRaw).mockReturnValue(
      new Promise((resolve) => {
        resolveSave = resolve;
      }),
    );
    render(<AgentsSection />);
    await userEvent.click(await screen.findByRole('button', { name: 'Open raw editor' }));
    const textarea = await screen.findByDisplayValue('{}');
    await userEvent.click(screen.getByRole('button', { name: 'Save file' }));

    const savingButton = await screen.findByRole('button', { name: 'Saving…' });
    expect(savingButton).toBeDisabled();
    expect(textarea).toBeDisabled();

    // A change event during the in-flight save (bypassing `disabled`, which
    // is exactly how this bug was reproduced) must not flip status back to
    // 'ready' and re-enable Save.
    fireEvent.change(textarea, { target: { value: '{"a":1}' } });
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save file' })).not.toBeInTheDocument();

    resolveSave({ file: '/home/u/.claude/settings.json', saved: true });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Saving…' })).not.toBeInTheDocument());
  });

  // Review fix round 2, item 2 (success half): an in-flight save's `.then`
  // captured the OLD text in its closure. If the editor session moves on
  // before that save resolves (closed, reopened, edited), applying the old
  // result must not discard what the user has since typed.
  it('ignores a stale save SUCCESS from a session the user has since replaced', async () => {
    vi.mocked(api.agentConfig.read).mockResolvedValue({
      agent: 'claude', scope: 'global',
      surfaces: [{ ...surfaces[0], error: 'config file is not valid JSON: parse error' }] as never,
    });
    vi.mocked(api.agentConfig.raw).mockResolvedValue({ file: '/home/u/.claude/settings.json', text: '{}' });
    let resolveStaleSave!: (v: { file: string; saved: boolean }) => void;
    vi.mocked(api.agentConfig.saveRaw).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveStaleSave = resolve;
      }),
    );
    render(<AgentsSection />);

    // Session 1: open, start a save, then abandon it (Cancel) while it's
    // still in flight.
    await userEvent.click(await screen.findByRole('button', { name: 'Open raw editor' }));
    await screen.findByDisplayValue('{}');
    await userEvent.click(screen.getByRole('button', { name: 'Save file' }));
    await screen.findByRole('button', { name: 'Saving…' });
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('button', { name: 'Saving…' })).not.toBeInTheDocument();

    // Session 2: reopen and type something new.
    vi.mocked(api.agentConfig.raw).mockResolvedValue({ file: '/home/u/.claude/settings.json', text: '{}' });
    await userEvent.click(await screen.findByRole('button', { name: 'Open raw editor' }));
    const textarea = await screen.findByDisplayValue('{}');
    fireEvent.change(textarea, { target: { value: '{"typed":1}' } });
    expect(screen.getByDisplayValue('{"typed":1}')).toBeInTheDocument();
    const readCallsBeforeStaleResolution = vi.mocked(api.agentConfig.read).mock.calls.length;

    // Session 1's save now resolves. It must be ignored: it must not close
    // session 2's editor, discard the freshly typed text, or trigger a
    // reload on session 2's behalf.
    resolveStaleSave({ file: '/home/u/.claude/settings.json', saved: true });
    // Give the stale promise's `.then` a full macrotask tick to run — if the
    // bug were present, this is when it would close the editor and reload.
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByDisplayValue('{"typed":1}')).toBeInTheDocument();
    expect(api.agentConfig.read).toHaveBeenCalledTimes(readCallsBeforeStaleResolution);
  });

  // Review fix round 2, item 2 (failure half): same as above, but the stale
  // save REJECTS. It must not overwrite the newer text with the old
  // (pre-edit) text via a stale `save-error` state.
  it('ignores a stale save FAILURE from a session the user has since replaced', async () => {
    vi.mocked(api.agentConfig.read).mockResolvedValue({
      agent: 'claude', scope: 'global',
      surfaces: [{ ...surfaces[0], error: 'config file is not valid JSON: parse error' }] as never,
    });
    vi.mocked(api.agentConfig.raw).mockResolvedValue({ file: '/home/u/.claude/settings.json', text: '{}' });
    let rejectStaleSave!: (err: Error) => void;
    vi.mocked(api.agentConfig.saveRaw).mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectStaleSave = reject;
      }),
    );
    render(<AgentsSection />);

    await userEvent.click(await screen.findByRole('button', { name: 'Open raw editor' }));
    await screen.findByDisplayValue('{}');
    await userEvent.click(screen.getByRole('button', { name: 'Save file' }));
    await screen.findByRole('button', { name: 'Saving…' });
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    vi.mocked(api.agentConfig.raw).mockResolvedValue({ file: '/home/u/.claude/settings.json', text: '{}' });
    await userEvent.click(await screen.findByRole('button', { name: 'Open raw editor' }));
    const textarea = await screen.findByDisplayValue('{}');
    fireEvent.change(textarea, { target: { value: '{"typed":1}' } });

    // The old session's save now fails. Its stale error/text must not
    // reach the screen and overwrite the newer text with the old '{}'.
    rejectStaleSave(new Error('disk full'));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByDisplayValue('{"typed":1}')).toBeInTheDocument();
    expect(screen.queryByText('disk full')).not.toBeInTheDocument();
  });
});
