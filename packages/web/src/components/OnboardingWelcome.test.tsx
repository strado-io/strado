import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const envCheck = vi.hoisted(() => vi.fn());
const licenseGet = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ required: false, apiUrl: '', license: null }),
);
const profileGet = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ fullName: '', callMe: '', telemetryOptOut: false }),
);
vi.mock('../api', () => ({ api: { envCheck, license: { get: licenseGet }, profile: { get: profileGet } } }));

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

    expect(screen.getByText(/Every ticket gets its own worktree/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('git version 2.44.0')).toBeInTheDocument());
    expect(screen.getByText(/@anthropic-ai\/claude-code/)).toBeInTheDocument();

    const cta = screen.getByRole('button', { name: /set up my first repo/i });
    expect(cta).toBeDisabled();
    expect(screen.getByText(/all of them are required/i)).toBeInTheDocument();
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
});
