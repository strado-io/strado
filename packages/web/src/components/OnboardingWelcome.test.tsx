import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const envCheck = vi.hoisted(() => vi.fn());
const licenseGet = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ required: false, apiUrl: '', license: null }),
);
const profileGet = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ fullName: '', callMe: '', telemetryOptOut: false }),
);
const installStart = vi.hoisted(() => vi.fn().mockResolvedValue({ started: true }));
const installCancel = vi.hoisted(() => vi.fn().mockResolvedValue({ cancelled: true }));
vi.mock('../api', () => ({
  api: {
    envCheck,
    license: { get: licenseGet },
    profile: { get: profileGet },
    envInstall: { start: installStart, cancel: installCancel },
  },
}));

// Captures the live-output handler so a test can play the server's side of an
// install without an EventSource.
const emit = vi.hoisted(() => ({ send: null as null | ((evt: unknown) => void) }));
vi.mock('../eventStream', () => ({
  subscribeEnvInstall: (handler: (evt: unknown) => void) => {
    emit.send = handler;
    return () => { emit.send = null; };
  },
}));

import { OnboardingWelcome } from './OnboardingWelcome';

describe('OnboardingWelcome', () => {
  it('blocks continue while any tool is missing, with install hints', async () => {
    envCheck.mockResolvedValue([
      { id: 'git', label: 'git', found: true, version: 'git version 2.44.0', optional: false, hint: null },
      { id: 'claude', label: 'Claude Code', found: false, version: null, optional: false, hint: 'npm i -g @anthropic-ai/claude-code' },
      { id: 'codex', label: 'Codex CLI', found: false, version: null, optional: true, hint: 'npm i -g @openai/codex — the Codex button hides until installed' },
    ]);
    const onContinue = vi.fn();
    render(<OnboardingWelcome onContinue={onContinue} />);

    expect(screen.getByText(/One worktree per ticket/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('git version 2.44.0')).toBeInTheDocument());
    expect(screen.getByText(/@anthropic-ai\/claude-code/)).toBeInTheDocument();

    const cta = screen.getByRole('button', { name: /set up my first repo/i });
    expect(cta).toBeDisabled();
    expect(screen.getByText(/install the missing tools above/i)).toBeInTheDocument();
    fireEvent.click(cta);
    expect(onContinue).not.toHaveBeenCalled();
  });

  it('lets the user in once every tool is found, and re-checks fresh', async () => {
    envCheck.mockResolvedValue([
      { id: 'git', label: 'git', found: true, version: 'git version 2.44.0', optional: false, hint: null },
      { id: 'claude', label: 'Claude Code', found: true, version: '2.1.0', optional: false, hint: null },
    ]);
    const onContinue = vi.fn();
    render(<OnboardingWelcome onContinue={onContinue} />);

    await waitFor(() => expect(screen.getByText('git version 2.44.0')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /set up my first repo/i }));
    expect(onContinue).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /re-check/i }));
    expect(envCheck).toHaveBeenLastCalledWith(true);
  });

  it('excludes OpenCode from the setup check so a missing OpenCode does not block entry', async () => {
    envCheck.mockResolvedValue([
      { id: 'git', label: 'git', found: true, version: 'git version 2.44.0', optional: false, hint: null },
      { id: 'claude', label: 'Claude Code', found: true, version: '2.1.0', optional: false, hint: null },
      { id: 'opencode', label: 'OpenCode', found: false, version: null, optional: true, hint: 'OpenCode needs to be installed to use' },
    ]);
    const onContinue = vi.fn();
    render(<OnboardingWelcome onContinue={onContinue} />);

    await waitFor(() => expect(screen.getByText('git version 2.44.0')).toBeInTheDocument());
    // OpenCode is not listed in the environment probe...
    expect(screen.queryByText('OpenCode')).not.toBeInTheDocument();
    // ...and its absence does not gate the continue button.
    const cta = screen.getByRole('button', { name: /set up my first repo/i });
    expect(cta).not.toBeDisabled();
    fireEvent.click(cta);
    expect(onContinue).toHaveBeenCalled();
  });

  it('greets by the profile callMe when set', async () => {
    envCheck.mockResolvedValue([]);
    profileGet.mockResolvedValue({ fullName: 'Kamlesh Bishnoi', callMe: 'KB', telemetryOptOut: false });
    render(<OnboardingWelcome onContinue={() => {}} />);
    await waitFor(() => expect(screen.getByText(/, KB/)).toBeInTheDocument());
  });

  it('installs a missing tool in place and goes green when the re-probe confirms it', async () => {
    envCheck.mockResolvedValue([
      { id: 'git', label: 'git', found: true, version: 'git version 2.44.0', optional: false, hint: null, installable: false, installCommand: null },
      { id: 'claude', label: 'Claude Code', found: false, version: null, optional: false, hint: 'npm i -g @anthropic-ai/claude-code', installable: true, installCommand: 'npm install -g @anthropic-ai/claude-code' },
    ]);
    const onContinue = vi.fn();
    render(<OnboardingWelcome onContinue={onContinue} />);

    const installBtn = await screen.findByRole('button', { name: /^install$/i });
    fireEvent.click(installBtn);
    expect(installStart).toHaveBeenCalledWith('claude');

    // Output streams in while it runs, newest line visible.
    act(() => emit.send!({ type: 'output', data: { id: 'claude', line: 'added 47 packages' } }));
    expect(screen.getByText('added 47 packages')).toBeInTheDocument();

    // The row flips on the server's re-probe, not on the exit code — so the
    // user never has to press Re-check after a successful install.
    act(() =>
      emit.send!({
        type: 'done',
        data: {
          id: 'claude',
          ok: true,
          message: null,
          tool: { id: 'claude', label: 'Claude Code', found: true, version: '2.1.0', optional: false, hint: null, installable: true, installCommand: 'npm install -g @anthropic-ai/claude-code' },
        },
      }),
    );
    await waitFor(() => expect(screen.getByText('2.1.0')).toBeInTheDocument());
    const cta = screen.getByRole('button', { name: /set up my first repo/i });
    expect(cta).not.toBeDisabled();
  });

  it('keeps a failed install actionable: the reason, and the command to run by hand', async () => {
    envCheck.mockResolvedValue([
      { id: 'claude', label: 'Claude Code', found: false, version: null, optional: false, hint: 'npm i -g @anthropic-ai/claude-code', installable: true, installCommand: 'npm install -g @anthropic-ai/claude-code' },
    ]);
    render(<OnboardingWelcome onContinue={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: /^install$/i }));

    act(() => emit.send!({ type: 'output', data: { id: 'claude', line: 'npm ERR! EACCES permission denied' } }));
    act(() =>
      emit.send!({
        type: 'done',
        data: { id: 'claude', ok: false, message: 'npm install -g @anthropic-ai/claude-code exited with code 243.', tool: null },
      }),
    );

    expect(screen.getByText(/exited with code 243/)).toBeInTheDocument();
    // the log stays open on failure — the reason is in it
    expect(screen.getByText(/EACCES permission denied/)).toBeInTheDocument();
    expect(screen.getByText('npm install -g @anthropic-ai/claude-code')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /set up my first repo/i })).toBeDisabled();
  });

  it('offers no Install for a tool that cannot be installed from here', async () => {
    envCheck.mockResolvedValue([
      { id: 'git', label: 'git', found: false, version: null, optional: false, hint: 'install Xcode command line tools', installable: false, installCommand: null },
    ]);
    render(<OnboardingWelcome onContinue={() => {}} />);
    await waitFor(() => expect(screen.getByText(/install Xcode command line tools/)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /^install$/i })).not.toBeInTheDocument();
  });

  // Plenty of developers don't use VS Code, and Codex is one agent among
  // several. Gating entry on either stranded them on this screen with no way
  // forward but installing an editor they didn't want.
  it('lets an optional tool stay missing without blocking entry', async () => {
    envCheck.mockResolvedValue([
      { id: 'git', label: 'git', found: true, version: 'git version 2.44.0', optional: false, hint: null, installable: false, installCommand: null },
      { id: 'claude', label: 'Claude Code', found: true, version: '2.1.0', optional: false, hint: null, installable: true, installCommand: 'npm install -g @anthropic-ai/claude-code' },
      { id: 'vscode', label: 'VS Code (embedded editor)', found: false, version: null, optional: true, hint: "VS Code → Cmd+Shift+P → \"Shell Command: Install 'code'\"", installable: false, installCommand: null },
      { id: 'codex', label: 'Codex CLI', found: false, version: null, optional: true, hint: 'npm i -g @openai/codex', installable: true, installCommand: 'npm install -g @openai/codex' },
    ]);
    const onContinue = vi.fn();
    render(<OnboardingWelcome onContinue={onContinue} />);

    const cta = await screen.findByRole('button', { name: /set up my first repo/i });
    await waitFor(() => expect(cta).not.toBeDisabled());
    // ...and the card doesn't nag about tools that were never required
    expect(screen.queryByText(/install the missing tools above/i)).not.toBeInTheDocument();
    expect(screen.getAllByText('optional')).toHaveLength(2);
    fireEvent.click(cta);
    expect(onContinue).toHaveBeenCalled();
  });

  it('still blocks on a missing required tool even when the optional ones are fine', async () => {
    envCheck.mockResolvedValue([
      { id: 'git', label: 'git', found: true, version: 'git version 2.44.0', optional: false, hint: null, installable: false, installCommand: null },
      { id: 'claude', label: 'Claude Code', found: false, version: null, optional: false, hint: 'npm i -g @anthropic-ai/claude-code', installable: true, installCommand: 'npm install -g @anthropic-ai/claude-code' },
      { id: 'codex', label: 'Codex CLI', found: true, version: '0.1.0', optional: true, hint: null, installable: true, installCommand: 'npm install -g @openai/codex' },
    ]);
    render(<OnboardingWelcome onContinue={() => {}} />);
    await waitFor(() => expect(screen.getByRole('button', { name: /set up my first repo/i })).toBeDisabled());
    expect(screen.getByText(/install the missing tools above/i)).toBeInTheDocument();
  });
});
