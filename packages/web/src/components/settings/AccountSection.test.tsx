import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

const licenseGet = vi.hoisted(() => vi.fn());
const authSignout = vi.hoisted(() => vi.fn());
vi.mock('../../api', () => ({ api: { license: { get: licenseGet }, auth: { signout: authSignout } } }));

import { AccountSection } from './AccountSection';

describe('AccountSection', () => {
  it('signout triggers a full reload so the gate re-evaluates', async () => {
    licenseGet.mockResolvedValue({
      required: true,
      apiUrl: '',
      license: { email: 'k@x.io', token: 't', name: 'Kamlesh', deviceId: 'd' },
      status: 'ok',
    });
    authSignout.mockResolvedValue(undefined);
    const reload = vi.fn();

    render(<AccountSection reload={reload} />);
    await screen.findByText(/signed in as/i);
    await userEvent.click(screen.getByRole('button', { name: /sign out/i }));

    await waitFor(() => expect(authSignout).toHaveBeenCalled());
    expect(reload).toHaveBeenCalled();
  });

  it('does not label a signed-in email as an invite code', async () => {
    licenseGet.mockResolvedValue({
      required: true,
      apiUrl: '',
      license: { email: 'k@x.io', token: 't', name: 'Kamlesh', deviceId: 'd' },
      status: 'ok',
    });

    render(<AccountSection reload={vi.fn()} />);
    await screen.findByText(/signed in as/i);
    expect(screen.queryByText(/invite code/i)).not.toBeInTheDocument();
  });
});
