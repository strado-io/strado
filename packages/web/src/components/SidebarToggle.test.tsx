import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenSidebarButton } from './SidebarToggle';

afterEach(() => { delete (window as { strado?: unknown }).strado; });

describe('OpenSidebarButton', () => {
  it('leaves a draggable slot for the traffic lights in the macOS shell', () => {
    (window as { strado?: unknown }).strado = { insetTitleBar: true };
    const onClick = vi.fn();
    const { container } = render(<OpenSidebarButton shown onClick={onClick} />);
    expect(container.querySelector('[style*="width: 72px"]')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open sidebar' }));
    expect(onClick).toHaveBeenCalled();
  });

  // macOS hides the lights in full screen; the room for them would be a blank gap.
  it('drops the slot in full screen, and brings it back on leaving', () => {
    let notify: (on: boolean) => void = () => {};
    (window as { strado?: unknown }).strado = {
      insetTitleBar: true,
      isFullScreen: () => true,
      onFullScreen: (cb: (on: boolean) => void) => { notify = cb; return () => {}; },
    };
    const { container } = render(<OpenSidebarButton shown onClick={vi.fn()} />);
    expect(container.querySelector('[style*="width: 72px"]')).toBeNull();
    act(() => notify(false));
    expect(container.querySelector('[style*="width: 72px"]')).not.toBeNull();
  });

  it('renders nothing while the sidebar shows', () => {
    const { container } = render(<OpenSidebarButton shown={false} onClick={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('is just the button in a browser', () => {
    const { container } = render(<OpenSidebarButton shown onClick={vi.fn()} />);
    expect(container.querySelector('[style*="width: 72px"]')).toBeNull();
    expect(screen.getByRole('button', { name: 'Open sidebar' })).toBeInTheDocument();
  });
});
