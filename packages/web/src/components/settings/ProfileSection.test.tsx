import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const profileGet = vi.hoisted(() => vi.fn());
const profileSave = vi.hoisted(() => vi.fn());
const credGet = vi.hoisted(() => vi.fn());
const credSave = vi.hoisted(() => vi.fn());
vi.mock('../../api', () => ({
  api: {
    profile: { get: profileGet, save: profileSave },
    modelCredential: { get: credGet, save: credSave },
  },
}));

import { ProfileSection } from './ProfileSection';

describe('ProfileSection', () => {
  it('renders initials from the full name and saves edits', async () => {
    profileGet.mockResolvedValue({ fullName: 'Kamlesh Bishnoi', callMe: 'kamlesh', telemetryOptOut: false });
    profileSave.mockResolvedValue({ fullName: 'Kamlesh Bishnoi', callMe: 'KB', telemetryOptOut: false });
    credGet.mockResolvedValue({ present: false, last4: null });
    render(<ProfileSection />);

    await waitFor(() => expect(screen.getByText('KB')).toBeInTheDocument()); // avatar initials
    const callMe = screen.getByLabelText(/call you/i);
    fireEvent.change(callMe, { target: { value: 'KB' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(profileSave).toHaveBeenCalledWith({ fullName: 'Kamlesh Bishnoi', callMe: 'KB' }));
  });

  it('saves and clears the model API key without ever showing it', async () => {
    profileGet.mockResolvedValue({ fullName: 'A B', callMe: 'a', telemetryOptOut: false });
    credGet.mockResolvedValue({ present: false, last4: null });
    credSave.mockResolvedValue({ present: true, last4: '9876' });
    render(<ProfileSection />);

    const input = await screen.findByLabelText(/anthropic api key/i);
    fireEvent.change(input, { target: { value: 'sk-ant-supersecret-9876' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save key' }));
    await waitFor(() => expect(credSave).toHaveBeenCalledWith('sk-ant-supersecret-9876'));

    // Once set, the field never re-renders the key — only the masked last four.
    await waitFor(() => expect(screen.getByPlaceholderText(/•••• 9876/)).toBeInTheDocument());
    expect((screen.getByLabelText(/anthropic api key/i) as HTMLInputElement).value).toBe('');

    credSave.mockResolvedValue({ present: false, last4: null });
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(credSave).toHaveBeenCalledWith(null));
  });

  it('states the billing consequence verbatim', async () => {
    profileGet.mockResolvedValue({ fullName: '', callMe: '', telemetryOptOut: false });
    credGet.mockResolvedValue({ present: false, last4: null });
    render(<ProfileSection />);
    expect(
      await screen.findByText(
        'Runs on runners are billed as API credits to this key — this is separate from a Claude subscription.',
      ),
    ).toBeInTheDocument();
  });
});
