import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { OnboardingCard } from './OnboardingCard';

const detect = vi.fn();
const add = vi.fn();
vi.mock('../api', () => ({
  api: {
    repos: {
      detect: (...a: unknown[]) => detect(...a),
      add: (...a: unknown[]) => add(...a),
    },
  },
}));

const DETECTED = {
  id: 'my-app',
  name: 'My App',
  path: '/Users/me/code/my-app',
  projectSubdir: null,
  startCommand: 'npm run dev',
  defaultPort: 5173,
  editor: 'code',
  runCommands: [{ id: 'dev', name: 'dev', command: 'npm run dev', envFile: '.env.dev' }, { id: 'storybook', name: 'storybook', command: 'npm run storybook' }],
  warnings: ['could not detect a port — defaulted to 8080'],
};

beforeEach(() => {
  detect.mockReset().mockResolvedValue(DETECTED);
  add.mockReset().mockResolvedValue(DETECTED);
});

describe('OnboardingCard', () => {
  it('detects from a pasted path and adds the prefilled repo', async () => {
    const onAdded = vi.fn();
    render(<OnboardingCard wsId="default" onAdded={onAdded} onOpenRepos={() => {}} />);

    fireEvent.change(screen.getByLabelText('Repo folder path'), {
      target: { value: '/Users/me/code/my-app' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Detect' }));

    expect(detect).toHaveBeenCalledWith('default', '/Users/me/code/my-app');
    const card = await screen.findByTestId('detected-repo');
    expect(card).toHaveTextContent('My App');
    expect(card).toHaveTextContent('npm run dev');
    expect(card).toHaveTextContent('could not detect a port');

    fireEvent.click(screen.getByRole('button', { name: 'Add repo' }));
    await vi.waitFor(() => expect(onAdded).toHaveBeenCalled());
    // warnings are stripped from the create payload
    const { warnings: _w, ...repo } = DETECTED;
    expect(add).toHaveBeenCalledWith('default', repo);
  });

  it('lists the detected run commands (the first, the default, with its port), and never env profiles', async () => {
    render(<OnboardingCard wsId="default" onAdded={() => {}} onOpenRepos={() => {}} />);
    fireEvent.change(screen.getByLabelText('Repo folder path'), { target: { value: '/Users/me/code/my-app' } });
    fireEvent.click(screen.getByRole('button', { name: 'Detect' }));
    const card = await screen.findByTestId('detected-repo');
    expect(card).toHaveTextContent('dev: npm run dev → port 5173');
    expect(card).toHaveTextContent('storybook: npm run storybook');
    expect(card).not.toHaveTextContent(/env profile/i);
    expect(screen.queryByText(/env profiles/i)).toBeNull();
  });

  it('shows the server error when detection fails', async () => {
    detect.mockRejectedValue(new Error('/nope is not inside a git repository'));
    render(<OnboardingCard wsId="default" onAdded={() => {}} onOpenRepos={() => {}} />);
    fireEvent.change(screen.getByLabelText('Repo folder path'), { target: { value: '/nope' } });
    fireEvent.click(screen.getByRole('button', { name: 'Detect' }));
    expect(await screen.findByText(/not inside a git repository/)).toBeInTheDocument();
    expect(screen.queryByTestId('detected-repo')).not.toBeInTheDocument();
  });

  it('offers the manual settings escape hatch', () => {
    const onOpenRepos = vi.fn();
    render(<OnboardingCard wsId="default" onAdded={() => {}} onOpenRepos={onOpenRepos} />);
    fireEvent.click(screen.getByText(/configure manually/));
    expect(onOpenRepos).toHaveBeenCalled();
  });
});
