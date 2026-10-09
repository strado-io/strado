import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenSidebarButton } from './SidebarToggle';

afterEach(() => { delete (window as { strado?: unknown }).strado; });

describe('OpenSidebarButton', () => {
  it('leaves a draggable slot for the traffic lights in the macOS shell', () => {
    (window as { strado?: unknown }).strado = { insetTitleBar: true };
    const onClick = vi.fn();
    const { container } = render(<OpenSidebarButton onClick={onClick} />);
    expect(container.querySelector('[style*="width: 72px"]')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open sidebar' }));
    expect(onClick).toHaveBeenCalled();
  });

  it('is just the button in a browser', () => {
    const { container } = render(<OpenSidebarButton onClick={vi.fn()} />);
    expect(container.querySelector('[style*="width: 72px"]')).toBeNull();
    expect(screen.getByRole('button', { name: 'Open sidebar' })).toBeInTheDocument();
  });
});
