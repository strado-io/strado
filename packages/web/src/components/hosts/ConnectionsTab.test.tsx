import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobEvent } from '../../eventStream';
import type { AgentConnection } from '../../types';

const jobs = vi.hoisted(() => ({ handlers: new Map<string, (e: JobEvent) => void>() }));
vi.mock('../../eventStream', () => ({
  subscribeJob: (id: string, h: (e: JobEvent) => void) => { jobs.handlers.set(id, h); return () => jobs.handlers.delete(id); },
}));
const conn = vi.hoisted(() => ({ list: vi.fn(), connect: vi.fn(), check: vi.fn(), disconnect: vi.fn(), answer: vi.fn(), cancel: vi.fn() }));
const claudeToken = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn() }));
vi.mock('../../api', () => ({ api: { runners: { connections: conn }, agentLogins: { claudeToken } } }));

import { ConnectionsTab } from './ConnectionsTab';

const MIN = 60_000;
const c = (agent: AgentConnection['agent'], over: Partial<AgentConnection> = {}): AgentConnection => ({ agent, state: 'not-connected', detail: null, checkedAt: Date.now() - 2 * MIN, ...over });
const ALL: AgentConnection[] = [
  c('claude', { state: 'connected', detail: 'Logged in with a Claude subscription' }),
  c('codex'),
  c('opencode', { state: 'failed', detail: 'opencode not found in the sandbox image' }),
  c('pi', { state: 'unknown', checkedAt: null }),
];
const row = (agent: string) => screen.getByTestId(`conn-${agent}`);
const emit = (jobId: string, e: JobEvent) => act(() => { jobs.handlers.get(jobId)!(e); });
const progress = (jobId: string, data: unknown) => emit(jobId, { type: 'progress', data: { message: 'm', data } });

async function shown(props: Partial<Parameters<typeof ConnectionsTab>[0]> = {}) {
  render(<ConnectionsTab runnerId="r1" online pinnedRunnerFingerprint="ab12-cd34" {...props} />);
  await screen.findByTestId('conn-claude');
}
async function connecting(agent: string, jobId = 'job-1') {
  conn.connect.mockResolvedValueOnce({ jobId });
  fireEvent.click(within(row(agent)).getByRole('button', { name: /^(Connect|Retry)$/ }));
  await waitFor(() => expect(jobs.handlers.has(jobId)).toBe(true));
}

beforeEach(() => {
  jobs.handlers.clear();
  conn.list.mockReset().mockResolvedValue({ connections: ALL, stale: false });
  for (const f of [conn.connect, conn.check, conn.disconnect, conn.answer, conn.cancel]) f.mockReset();
  conn.answer.mockResolvedValue(undefined);
  conn.cancel.mockResolvedValue(undefined);
  claudeToken.get.mockReset().mockResolvedValue({ present: false, last4: null });
  claudeToken.save.mockReset().mockResolvedValue({ present: true, last4: 'wxyz' });
});
afterEach(() => { vi.restoreAllMocks(); });

describe('ConnectionsTab', () => {
  it('one row per agent, its state in words and one primary action', async () => {
    await shown();
    expect(conn.list).toHaveBeenCalledWith('r1');
    expect(row('claude')).toHaveTextContent('Claude');
    expect(row('claude')).toHaveTextContent('✓ Connected · checked 2m ago');
    expect(row('claude')).toHaveTextContent('on every runner');
    expect(row('claude')).toHaveTextContent('Logged in with a Claude subscription');
    expect(within(row('claude')).getByRole('button', { name: 'Disconnect' })).toBeEnabled();
    expect(row('codex')).toHaveTextContent('Not connected');
    expect(within(row('codex')).getByRole('button', { name: 'Connect' })).toBeEnabled();
    expect(row('opencode')).toHaveTextContent('Failed · opencode not found in the sandbox image');
    expect(within(row('opencode')).getByRole('button', { name: 'Retry' })).toBeEnabled();
    expect(row('pi')).toHaveTextContent('Not checked yet');
    expect(within(row('pi')).getByRole('button', { name: 'Check now' })).toBeEnabled();
    for (const a of ['claude', 'codex', 'opencode', 'pi']) expect(row(a)).toHaveAttribute('data-state');
    expect(row('claude')).toHaveAttribute('data-state', 'connected');
  });

  it('Codex: waits for browser approval, shows the code big with Copy, opens the page once and again on demand', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    await shown();
    await connecting('codex');
    expect(conn.connect).toHaveBeenCalledWith('r1', 'codex');
    progress('job-1', { phase: 'waiting-approval' });
    expect(row('codex')).toHaveTextContent('Waiting for you to approve in the browser…');
    progress('job-1', { device: { url: 'https://auth.openai.com/codex/device', code: 'ABCD-12345', expiresAt: Date.now() + 15 * MIN } });
    expect(screen.getByTestId('device-code')).toHaveTextContent('ABCD-12345');
    expect(row('codex')).toHaveTextContent('Enter this code on the page that opened');
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith('https://auth.openai.com/codex/device', '_blank', 'noopener');
    progress('job-1', { device: { url: 'https://auth.openai.com/codex/device', code: 'ABCD-12345', expiresAt: Date.now() + 15 * MIN } });
    expect(open).toHaveBeenCalledTimes(1);
    fireEvent.click(within(row('codex')).getByRole('button', { name: 'Copy code' }));
    expect(writeText).toHaveBeenCalledWith('ABCD-12345');
    fireEvent.click(within(row('codex')).getByRole('button', { name: 'Open page again' }));
    expect(open).toHaveBeenCalledTimes(2);
    progress('job-1', { phase: 'checking' });
    expect(row('codex')).toHaveTextContent('Checking on the runner…');
    expect(screen.queryByTestId('device-code')).not.toBeInTheDocument();
    emit('job-1', { type: 'done', data: { result: { connection: c('codex', { state: 'connected', detail: 'Logged in with ChatGPT', checkedAt: Date.now() }) } } });
    expect(row('codex')).toHaveTextContent('✓ Connected · checked just now');
    expect(row('codex')).toHaveTextContent('Logged in with ChatGPT');
    expect(row('codex')).not.toHaveTextContent('on every runner');
  });

  it.each(['javascript:alert(1)', 'http://auth.openai.com/codex/device', 'https://auth.openai.com.evil.example/codex/device', 'https://evil.example/?u=https://auth.openai.com/'])(
    'a device page other than https://auth.openai.com is never opened: %s', async (url) => {
      const open = vi.spyOn(window, 'open').mockReturnValue(null);
      await shown();
      await connecting('codex');
      progress('job-1', { device: { url, code: 'ABCD-1234', expiresAt: Date.now() + MIN } });
      expect(open).not.toHaveBeenCalled();
      expect(screen.getByTestId('device-code')).toHaveTextContent('ABCD-1234');
      expect(within(row('codex')).queryByRole('button', { name: 'Open page again' })).not.toBeInTheDocument();
    });

  it('Cancel stops the job and puts the row back', async () => {
    await shown();
    await connecting('codex');
    progress('job-1', { phase: 'waiting-approval' });
    fireEvent.click(within(row('codex')).getByRole('button', { name: 'Cancel' }));
    expect(conn.cancel).toHaveBeenCalledWith('job-1');
    expect(row('codex')).toHaveTextContent('Not connected');
    expect(within(row('codex')).getByRole('button', { name: 'Connect' })).toBeEnabled();
  });

  it('Claude connect: opening the browser, waiting, syncing, checking — never a code', async () => {
    conn.list.mockResolvedValue({ connections: [c('claude'), ...ALL.slice(1)] });
    await shown();
    await connecting('claude');
    expect(conn.connect).toHaveBeenCalledWith('r1', 'claude');
    progress('job-1', { phase: 'opening-browser' });
    expect(row('claude')).toHaveTextContent('Opening your browser…');
    progress('job-1', { phase: 'waiting-approval' });
    expect(row('claude')).toHaveTextContent('Waiting for you to approve in the browser…');
    progress('job-1', { phase: 'syncing' });
    expect(row('claude')).toHaveTextContent('Sending to the runner…');
    expect(screen.queryByTestId('device-code')).not.toBeInTheDocument();
    emit('job-1', { type: 'done', data: { result: { connection: c('claude', { state: 'connected', checkedAt: Date.now() }) } } });
    expect(row('claude')).toHaveTextContent('✓ Connected · checked just now');
  });

  it('first contact asks to trust the runner with both fingerprints; yes answers the job', async () => {
    await shown({ pinnedRunnerFingerprint: null });
    expect(screen.getByTestId('first-trust-hint')).toHaveTextContent('The first Connect asks you to compare this laptop’s key with the runner’s.');
    await connecting('codex');
    progress('job-1', { question: { id: 'q1', kind: 'pin', runnerFingerprint: '1111-2222', laptopFingerprint: '9f8e-7d6c' } });
    const banner = screen.getByTestId('pin-question');
    expect(banner).toHaveTextContent('Trust this runner?');
    expect(banner).toHaveTextContent('Runner’s key 1111-2222');
    expect(banner).toHaveTextContent('This laptop’s key 9f8e-7d6c');
    expect(banner).toHaveTextContent('strado-runner key');
    fireEvent.click(within(banner).getByRole('button', { name: 'Trust & connect' }));
    await waitFor(() => expect(conn.answer).toHaveBeenCalledWith('job-1', { questionId: 'q1', yes: true }));
    expect(screen.queryByTestId('pin-question')).not.toBeInTheDocument();
  });

  it('saying no to the first pin leaves the row as it was and says why', async () => {
    await shown({ pinnedRunnerFingerprint: null });
    await connecting('codex');
    progress('job-1', { question: { id: 'q1', kind: 'pin', runnerFingerprint: '1111-2222', laptopFingerprint: '9f8e-7d6c' } });
    fireEvent.click(within(screen.getByTestId('pin-question')).getByRole('button', { name: 'Don’t trust' }));
    await waitFor(() => expect(conn.answer).toHaveBeenCalledWith('job-1', { questionId: 'q1', yes: false }));
    emit('job-1', { type: 'error', data: { message: 'runner not trusted yet' } });
    expect(within(row('codex')).getByRole('alert')).toHaveTextContent('runner not trusted yet');
    expect(row('codex')).toHaveAttribute('data-state', 'not-connected');
    expect(within(row('codex')).getByRole('button', { name: 'Connect' })).toBeEnabled();
  });

  it('a changed runner key is asked inside the job: old and new keys, "Trust new key & connect"', async () => {
    await shown();
    await connecting('codex');
    progress('job-1', { question: { id: 'q2', kind: 'pin', runnerFingerprint: '1111-2222', laptopFingerprint: '9f8e-7d6c', previousFingerprint: 'aaaa-bbbb' } });
    const q = screen.getByTestId('pin-question');
    expect(q).toHaveTextContent('This runner’s key changed. Trust the new one?');
    expect(q).toHaveTextContent('Trusted before aaaa-bbbb');
    expect(q).toHaveTextContent('Runner’s new key 1111-2222');
    expect(q).toHaveTextContent('This laptop’s key 9f8e-7d6c');
    fireEvent.click(within(q).getByRole('button', { name: 'Trust new key & connect' }));
    await waitFor(() => expect(conn.answer).toHaveBeenCalledWith('job-1', { questionId: 'q2', yes: true }));
  });

  it('a key-changed refusal from the job is a banner with both keys and no trust button', async () => {
    await shown();
    await connecting('codex');
    emit('job-1', { type: 'error', data: { message: 'runner key changed — not trusted', details: { expected: 'aaaa-bbbb', actual: '1111-2222' } } });
    expect(screen.getByTestId('sync-key-changed')).toHaveTextContent('Connect again to compare the new key');
    expect(screen.getByTestId('sync-key-compare')).toHaveTextContent('Expected aaaa-bbbb · Runner now 1111-2222');
    expect(screen.queryByRole('button', { name: /trust new key/i })).not.toBeInTheDocument();
    expect(row('codex')).toHaveAttribute('data-state', 'not-connected');
  });

  it('trust that moved while the job asked leaves the row and says try again', async () => {
    await shown();
    await connecting('codex');
    emit('job-1', { type: 'error', data: { message: 'runner trust changed meanwhile — try again' } });
    expect(within(row('codex')).getByRole('alert')).toHaveTextContent('runner trust changed meanwhile — try again');
    expect(row('codex')).toHaveAttribute('data-state', 'not-connected');
  });

  it('a runner that trusts another laptop, or sends an inconsistent key, says so with no trust button', async () => {
    await shown();
    await connecting('codex');
    emit('job-1', { type: 'error', data: { message: 'sender not trusted by this runner — it trusts a different laptop' } });
    expect(screen.getByTestId('sync-sender-refused')).toHaveTextContent('This runner trusts a different laptop. To reset, delete ~/.strado/runner-sender-pin.json on the runner.');
    await connecting('opencode', 'job-2');
    emit('job-2', { type: 'error', data: { message: 'runner sent an inconsistent key' } });
    expect(screen.getByTestId('sync-inconsistent-key')).toHaveTextContent(/inconsistent key/i);
    expect(screen.queryByRole('button', { name: 'Trust new key' })).not.toBeInTheDocument();
  });

  it('runner offline: last known states, marked as such, every action disabled', async () => {
    await shown({ online: false });
    expect(screen.getByTestId('conn-offline')).toHaveTextContent('Runner offline — showing the last check.');
    expect(row('claude')).toHaveTextContent('✓ Connected · last checked 2m ago');
    for (const b of screen.getAllByRole('button').filter((el) => el.closest('[data-testid^="conn-"]'))) {
      if (b.textContent === 'Paste a token instead') continue;
      expect(b).toBeDisabled();
    }
  });

  it('a stale list (the server can\'t reach the runner) reads as offline even if the row says online', async () => {
    conn.list.mockResolvedValue({ connections: ALL, stale: true });
    await shown({ online: true });
    expect(screen.getByTestId('conn-offline')).toHaveTextContent('Runner offline — showing the last check.');
    expect(row('claude')).toHaveTextContent('last checked 2m ago');
    expect(within(row('codex')).getByRole('button', { name: 'Connect' })).toBeDisabled();
  });

  it('a connect refused before it starts ("already connecting") is said in the row; the state stays', async () => {
    conn.connect.mockRejectedValueOnce(new Error('already connecting'));
    await shown();
    fireEvent.click(within(row('codex')).getByRole('button', { name: 'Connect' }));
    expect(await within(row('codex')).findByRole('alert')).toHaveTextContent('already connecting');
    expect(row('codex')).toHaveTextContent('Not connected');
    expect(row('codex')).toHaveAttribute('data-state', 'not-connected');
  });

  it('Disconnect asks, then shows the runner\'s fresh answer', async () => {
    const ask = vi.spyOn(window, 'confirm').mockReturnValue(true);
    conn.disconnect.mockResolvedValue({ connection: c('claude', { state: 'not-connected', checkedAt: Date.now() }) });
    await shown();
    fireEvent.click(within(row('claude')).getByRole('button', { name: 'Disconnect' }));
    expect(ask).toHaveBeenCalledWith('Removes Claude from this runner. Your other runners keep it.');
    await waitFor(() => expect(row('claude')).toHaveTextContent('Not connected'));
    expect(conn.disconnect).toHaveBeenCalledWith('r1', 'claude');
  });

  it('Check now asks the runner; a failure is said in the row', async () => {
    conn.check.mockResolvedValueOnce({ connection: c('pi', { state: 'connected', detail: '1 provider: OpenRouter', checkedAt: Date.now() }) });
    await shown();
    fireEvent.click(within(row('pi')).getByRole('button', { name: 'Check now' }));
    await waitFor(() => expect(row('pi')).toHaveTextContent('✓ Connected · checked just now'));
    expect(conn.check).toHaveBeenCalledWith('r1', 'pi');
    conn.check.mockRejectedValueOnce(new Error('runner unreachable'));
    fireEvent.click(within(row('pi')).getByRole('button', { name: 'Check now' }));
    expect(await within(row('pi')).findByRole('alert')).toHaveTextContent('runner unreachable');
  });

  it('a provider that only a terminal on the runner can log in says so', async () => {
    conn.list.mockResolvedValue({ connections: [...ALL.slice(0, 3), c('pi', { state: 'connected', detail: '1 provider: OpenRouter', needsTerminal: true })] });
    await shown();
    expect(row('pi')).toHaveTextContent('Some providers need a login in a terminal on this runner.');
  });

  it('Claude: "Paste a token instead" opens the token field; the token is never shown back', async () => {
    await shown();
    fireEvent.click(within(row('claude')).getByRole('button', { name: 'Paste a token instead' }));
    const input = await within(row('claude')).findByLabelText('Claude token');
    fireEvent.change(input, { target: { value: 'sk-ant-oat01-secret-wxyz' } });
    fireEvent.click(within(row('claude')).getByRole('button', { name: 'Save Claude token' }));
    await waitFor(() => expect(claudeToken.save).toHaveBeenCalledWith('sk-ant-oat01-secret-wxyz'));
    expect(row('claude')).toHaveTextContent('••••wxyz');
    expect(row('claude')).not.toHaveTextContent('secret');
  });

  it('"Get a token" beside the pasted-token field copies the setup-token command', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    await shown();
    fireEvent.click(within(row('claude')).getByRole('button', { name: 'Paste a token instead' }));
    fireEvent.click(await within(row('claude')).findByRole('button', { name: 'Get a token' }));
    expect(writeText).toHaveBeenCalledWith('claude setup-token');
  });

  it('a list that fails to load says so', async () => {
    conn.list.mockRejectedValue(new Error('runner unreachable'));
    render(<ConnectionsTab runnerId="r1" online pinnedRunnerFingerprint={null} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t load connections: runner unreachable');
  });
});
