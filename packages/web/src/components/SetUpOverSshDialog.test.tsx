import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobEvent } from '../eventStream';

const jobs = vi.hoisted(() => ({ handlers: new Map<string, (e: JobEvent) => void>() }));
vi.mock('../eventStream', () => ({
  subscribeJob: (id: string, h: (e: JobEvent) => void) => { jobs.handlers.set(id, h); return () => jobs.handlers.delete(id); },
}));
const mounts = vi.hoisted(() => ({ n: 0 }));
vi.mock('./CommandTerminal', async () => {
  const { useEffect } = await import('react');
  return {
    CommandTerminal: ({ lines, attach }: { lines: string[]; attach: { url: string; seq: number } | null }) => {
      useEffect(() => { mounts.n += 1; }, []);
      return <div data-testid="term" data-url={attach?.url ?? ''} data-seq={attach?.seq ?? ''} data-lines={JSON.stringify(lines)} />;
    },
  };
});
const ssh = vi.hoisted(() => ({ start: vi.fn(), answer: vi.fn(), cancel: vi.fn() }));
vi.mock('../api', () => ({ api: { runners: { sshSetup: ssh } } }));

import { SetUpOverSshDialog, destinationProblem } from './SetUpOverSshDialog';

const emit = (e: JobEvent) => act(() => { jobs.handlers.get('job-1')!(e); });
const progress = (data: unknown) => emit({ type: 'progress', data: { message: 'm', data } });
const termLines = () => JSON.parse(screen.getByTestId('term').getAttribute('data-lines')!) as string[];
const stepState = (id: string) => document.querySelector(`[data-step="${id}"]`)!.getAttribute('data-state');

async function started(onClose = vi.fn(), onAdded = vi.fn(), onOpenHost = vi.fn()) {
  render(<SetUpOverSshDialog onClose={onClose} onAdded={onAdded} onOpenHost={onOpenHost} />);
  fireEvent.change(screen.getByLabelText('SSH destination'), { target: { value: 'me@box' } });
  fireEvent.click(screen.getByRole('button', { name: 'Set up' }));
  await waitFor(() => expect(jobs.handlers.has('job-1')).toBe(true));
  return { onClose, onAdded, onOpenHost };
}

beforeEach(() => {
  jobs.handlers.clear();
  ssh.start.mockReset().mockResolvedValue({ jobId: 'job-1' });
  ssh.answer.mockReset().mockResolvedValue(undefined);
  ssh.cancel.mockReset().mockResolvedValue(undefined);
});

describe('SetUpOverSshDialog', () => {
  it('validates the destination: no leading dash, no spaces; the name sits under More', () => {
    expect(destinationProblem('-oProxyCommand=x')).toMatch(/cannot start/);
    expect(destinationProblem('me@ box')).toMatch(/no spaces/);
    expect(destinationProblem('ssh://me@box:2222')).toBeNull();
    render(<SetUpOverSshDialog onClose={vi.fn()} />);
    expect(screen.getByLabelText('SSH destination')).toHaveAttribute('placeholder', 'user@host, ssh://user@host:2222, or an ssh config alias');
    expect(screen.queryByLabelText('Runner name')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.getByLabelText('Runner name')).toBeInTheDocument();
  });

  it('sends only the destination and name; renders the steps as they advance', async () => {
    render(<SetUpOverSshDialog onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('SSH destination'), { target: { value: ' me@box ' } });
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.change(screen.getByLabelText('Runner name'), { target: { value: 'homebox' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set up' }));
    await waitFor(() => expect(ssh.start).toHaveBeenCalledWith({ destination: 'me@box', name: 'homebox' }));
    expect(screen.getByTestId('ssh-banner')).toHaveTextContent('Answer any questions in the terminal below, such as a password.');
    progress({ step: 'connect' });
    progress({ terminal: { key: '\0ssh-setup:job-1' } });
    expect(screen.getByTestId('term').getAttribute('data-url')).toBe('/ws/ssh-setup-terminal?key=%00ssh-setup%3Ajob-1');
    progress({ step: 'install', detail: 'downloading 0.1.32' });
    expect(stepState('connect')).toBe('done');
    expect(stepState('check')).toBe('done');
    expect(stepState('install')).toBe('active');
    expect(stepState('pair')).toBe('pending');
    expect(screen.getByTestId('ssh-detail')).toHaveTextContent('downloading 0.1.32');
  });

  it('one terminal for the whole run: each terminal frame re-attaches it (same key respawned), never remounts it', async () => {
    mounts.n = 0;
    await started();
    expect(mounts.n).toBe(1);
    expect(screen.getByTestId('term').getAttribute('data-url')).toBe('');
    progress({ terminal: { key: '\0ssh-setup:job-1' } });
    const first = screen.getByTestId('term').getAttribute('data-seq');
    progress({ step: 'podman' });
    progress({ terminal: { key: '\0ssh-setup:job-1' } });
    expect(screen.getByTestId('term').getAttribute('data-seq')).not.toBe(first);
    expect(mounts.n).toBe(1);
  });

  it('every step\'s detail is a transcript line, kept across step changes and a second terminal attach', async () => {
    await started();
    progress({ step: 'connect', detail: '▸ Connect' });
    progress({ terminal: { key: '\0ssh-setup:job-1' } });
    progress({ step: 'check', detail: '▸ Check machine' });
    progress({ step: 'check', detail: 'x86_64, systemd 255, podman 4.9' });
    progress({ step: 'install', detail: '▸ Install' });
    progress({ terminal: { key: '\0ssh-setup:job-1' } });
    progress({ step: 'install', detail: 'downloading 0.1.72' });
    expect(termLines()).toEqual(['▸ Connect', '▸ Check machine', 'x86_64, systemd 255, podman 4.9', '▸ Install', 'downloading 0.1.72']);
    expect(screen.getByTestId('ssh-detail')).toHaveTextContent('downloading 0.1.72');
    expect(stepState('install')).toBe('active');
  });

  it('a late subscriber\'s replayed transcript comes first', async () => {
    await started();
    progress({ transcript: '▸ Connect\nconnected as me' });
    progress({ step: 'check', detail: '▸ Check machine' });
    expect(termLines()).toEqual(['▸ Connect\nconnected as me', '▸ Check machine']);
  });

  it('a failure keeps the transcript and adds the error as its last line; Retry starts a fresh terminal', async () => {
    mounts.n = 0;
    await started();
    progress({ step: 'check', detail: '▸ Check machine' });
    emit({ type: 'error', data: { message: 'This machine is arm64; runners are x86_64 only.' } });
    expect(termLines()).toEqual(['▸ Check machine', '\x1b[31m✗ This machine is arm64; runners are x86_64 only.\x1b[0m']);
    expect(screen.getByTestId('term').getAttribute('data-url')).toBe('');
    ssh.start.mockResolvedValue({ jobId: 'job-2' });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(jobs.handlers.has('job-2')).toBe(true));
    expect(mounts.n).toBe(2);
    expect(termLines()).toEqual([]);
  });

  it('a question shows the exact command; Yes and No answer it', async () => {
    await started();
    progress({ step: 'podman' });
    progress({ question: { id: 'q1', kind: 'podman', message: 'Podman is missing. Install it?', command: 'sudo apt-get install -y podman uidmap slirp4netns' } });
    expect(screen.getByTestId('ssh-question')).toHaveTextContent('sudo apt-get install -y podman uidmap slirp4netns');
    fireEvent.click(screen.getByRole('button', { name: 'Yes' }));
    await waitFor(() => expect(ssh.answer).toHaveBeenCalledWith('job-1', { questionId: 'q1', yes: true }));
    expect(screen.queryByTestId('ssh-question')).toBeNull();
    progress({ question: { id: 'q2', kind: 'linger', message: 'Keep it running after you log out?' } });
    fireEvent.click(screen.getByRole('button', { name: 'No' }));
    await waitFor(() => expect(ssh.answer).toHaveBeenLastCalledWith('job-1', { questionId: 'q2', yes: false }));
  });

  it('cannot be dismissed while running; Cancel cancels the job', async () => {
    const { onClose } = await started();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(ssh.cancel).toHaveBeenCalledWith('job-1'));
    expect(screen.getByRole('button', { name: 'Set up' })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('a failure marks its step red with the reason; Retry starts a new run', async () => {
    await started();
    progress({ step: 'check' });
    emit({ type: 'error', data: { message: 'This machine is arm64; runners are x86_64 only.' } });
    expect(stepState('check')).toBe('failed');
    expect(screen.getByTestId('ssh-failed')).toHaveTextContent('Setup stopped at Check machine. This machine is arm64; runners are x86_64 only.');
    ssh.start.mockResolvedValue({ jobId: 'job-2' });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(ssh.start).toHaveBeenCalledTimes(2));
  });

  it('success shows the runner and "Open host", which goes to its Connections', async () => {
    const { onAdded, onOpenHost } = await started();
    emit({ type: 'done', data: { result: { runnerId: 'r9', name: 'homebox', sandboxes: false, warnings: ['gh is not signed in on homebox'] } } });
    expect(onAdded).toHaveBeenCalledWith('r9');
    const done = screen.getByTestId('ssh-success');
    expect(done).toHaveTextContent('homebox');
    expect(done).toHaveTextContent('sandboxes off');
    expect(done).toHaveTextContent('gh is not signed in on homebox');
    expect(done).toHaveTextContent('Connect Claude, Codex and the rest on its Connections tab.');
    expect(stepState('online')).toBe('done');
    expect(screen.queryByRole('button', { name: /sync logins/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open host' }));
    expect(onOpenHost).toHaveBeenCalledWith('r9');
    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument();
  });
});
