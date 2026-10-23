import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MissionStack } from './MissionStack';
import { AgentLine } from './AgentLine';

describe('MissionStack', () => {
  it('top to bottom: approvals, then the strip; one column, nothing floating over the strip', () => {
    render(<MissionStack approvals={<div>APPROVAL</div>} strip={<div>STRIP</div>} />);
    const [a, s] = ['APPROVAL', 'STRIP'].map((t) => screen.getByText(t));
    expect(a!.compareDocumentPosition(s!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const stack = screen.getByTestId('mission-stack');
    expect(stack.className).not.toMatch(/absolute|fixed/);
    for (const el of [a, s]) expect(stack).toContainElement(el!);
  });
  it('only the strip when nothing is selected or pending', () => {
    render(<MissionStack approvals={null} strip={<div>STRIP</div>} />);
    expect(screen.getByTestId('mission-stack').textContent).toBe('STRIP');
  });
  it('never hides: no yielded state; the strip stays visible and clickable', () => {
    render(<MissionStack approvals={null} strip={<button type="button">PILL</button>} />);
    const stack = screen.getByTestId('mission-stack');
    expect(stack.className).not.toMatch(/\binvisible\b/);
    expect(stack).not.toHaveAttribute('aria-hidden');
    expect(stack).not.toHaveAttribute('inert');
  });

  it('reports its height (so the bar\'s popover can open above the whole stack)', () => {
    let cb: ((entries: { contentRect: { height: number } }[]) => void) | null = null;
    const observe = vi.fn();
    const disconnect = vi.fn();
    vi.stubGlobal('ResizeObserver', class { constructor(f: typeof cb) { cb = f; } observe = observe; disconnect = disconnect; });
    try {
      const onHeight = vi.fn();
      const { unmount } = render(<MissionStack approvals={null} strip={<div>STRIP</div>} onHeight={onHeight} />);
      expect(observe).toHaveBeenCalledWith(screen.getByTestId('mission-stack'));
      cb!([{ contentRect: { height: 72 } }]);
      expect(onHeight).toHaveBeenLastCalledWith(72);
      unmount();
      expect(disconnect).toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });
});
