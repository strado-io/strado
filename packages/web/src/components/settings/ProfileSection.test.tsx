import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const profileGet = vi.hoisted(() => vi.fn());
const profileSave = vi.hoisted(() => vi.fn());
vi.mock('../../api', () => ({
  api: {
    profile: { get: profileGet, save: profileSave },
  },
}));

import { ProfileSection } from './ProfileSection';

describe('ProfileSection', () => {
  it('renders initials from the full name and saves edits', async () => {
    profileGet.mockResolvedValue({ fullName: 'Kamlesh Bishnoi', callMe: 'kamlesh', telemetryOptOut: false });
    profileSave.mockResolvedValue({ fullName: 'Kamlesh Bishnoi', callMe: 'KB', telemetryOptOut: false });
    render(<ProfileSection />);

    await waitFor(() => expect(screen.getByText('KB')).toBeInTheDocument()); // avatar initials
    const callMe = screen.getByLabelText(/call you/i);
    fireEvent.change(callMe, { target: { value: 'KB' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(profileSave).toHaveBeenCalledWith({ fullName: 'Kamlesh Bishnoi', callMe: 'KB' }));
    expect(screen.queryByLabelText(/anthropic api key/i)).toBeNull();
  });
});
