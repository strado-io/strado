import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const profileGet = vi.hoisted(() => vi.fn());
const profileSave = vi.hoisted(() => vi.fn());
vi.mock('../../api', () => ({ api: { profile: { get: profileGet, save: profileSave } } }));

import { PrivacySection } from './PrivacySection';

describe('PrivacySection', () => {
  it('persists the opt-out when toggled off', async () => {
    profileGet.mockResolvedValue({ fullName: '', callMe: '', telemetryOptOut: false });
    profileSave.mockResolvedValue({ fullName: '', callMe: '', telemetryOptOut: true });
    render(<PrivacySection />);
    const toggle = await screen.findByRole('checkbox', { name: /anonymous usage/i });
    expect(toggle).toBeChecked(); // sending is ON by default
    fireEvent.click(toggle);
    await waitFor(() => expect(profileSave).toHaveBeenCalledWith({ telemetryOptOut: true }));
  });
});
