import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { UpdateFooter } from './UpdateFooter';

const base = {
  info: { updateAvailable: true, version: '0.2.0', notes: 'changelog stuff', url: 'u', sha256: 's', mandatory: false },
  progress: 0, error: null as string | null,
  mode: 'swap' as const,
  onUpdate: vi.fn(), onInstall: vi.fn(), onDismiss: vi.fn(),
};

describe('UpdateFooter', () => {
  it('shows the version and fires onUpdate', () => {
    render(<UpdateFooter phase="available" {...base} />);
    expect(screen.getByText(/0\.2\.0/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /update to 0\.2\.0/i }));
    expect(base.onUpdate).toHaveBeenCalled();
  });

  it('never shows the release notes/changelog', () => {
    render(<UpdateFooter phase="available" {...base} />);
    expect(screen.queryByText(/changelog stuff/)).not.toBeInTheDocument();
  });

  it('shows a progress indicator while downloading', () => {
    render(<UpdateFooter phase="downloading" {...base} progress={42} />);
    expect(screen.getByText(/42%/)).toBeInTheDocument();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('shows Restart at ready and fires onInstall', () => {
    render(<UpdateFooter phase="ready" {...base} />);
    fireEvent.click(screen.getByRole('button', { name: /restart/i }));
    expect(base.onInstall).toHaveBeenCalled();
  });

  it('renders nothing when idle', () => {
    const { container } = render(<UpdateFooter phase="idle" {...base} />);
    expect(container).toBeEmptyDOMElement();
  });
});
