import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../hooks/entitlements', () => ({ useEntitlements: () => ({ features: { runners: true } }) }));
vi.mock('../RunnersPanel', () => ({
  RunnersPanel: ({ initialHost }: { initialHost?: { runnerId: string; tab?: string } }) => (
    <div data-testid="runners" data-host={initialHost ? `${initialHost.runnerId}:${initialHost.tab}` : 'none'} />
  ),
}));
vi.mock('../../api', () => ({ api: {} }));

import { SettingsPage } from './SettingsPage';

describe('SettingsPage → a runner\'s host page', () => {
  it('the opener can name a runner and a tab; Runners opens on that host', () => {
    render(<SettingsPage section="runners" host={{ runnerId: 'r1', tab: 'connections' }} onClose={() => {}} />);
    expect(screen.getByTestId('runners')).toHaveAttribute('data-host', 'r1:connections');
  });

  it('without a host, Runners opens on the list', () => {
    render(<SettingsPage section="runners" onClose={() => {}} />);
    expect(screen.getByTestId('runners')).toHaveAttribute('data-host', 'none');
  });
});
