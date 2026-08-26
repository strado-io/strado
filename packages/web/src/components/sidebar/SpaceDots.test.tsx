import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SpaceDots } from './SpaceDots';
import type { Workspace } from '../../types';

const ws = (id: string, name: string): Workspace => ({
  id, name, color: '#333', icon: name[0]!, defaultEditor: 'code',
  defaultPortBase: 8080, logDir: null,
});
const A = ws('a', 'Alpha');
const B = ws('b', 'Beta');
const C = ws('c', 'Gamma');

describe('SpaceDots', () => {
  it('renders one dot per space and marks the active one', () => {
    render(<SpaceDots spaces={[A, B, C]} activeId="b" onSelect={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Switch to Alpha' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Switch to Gamma' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Switch to Beta' })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('button', { name: 'Switch to Alpha' })).not.toHaveAttribute('aria-current');
  });

  it('selects a space on dot click', () => {
    const onSelect = vi.fn();
    render(<SpaceDots spaces={[A, B, C]} activeId="b" onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('button', { name: 'Switch to Gamma' }));
    expect(onSelect).toHaveBeenCalledWith('c');
  });

  it('renders nothing when there is only one space', () => {
    const { container } = render(<SpaceDots spaces={[A]} activeId="a" onSelect={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Switch to Alpha' })).toBeNull();
    expect(container).toBeEmptyDOMElement();
  });
});

// A 6px dot is a poor target for the browser's own tooltip: it needs a still,
// sustained hover and never re-arms when the element re-renders under the
// cursor — which these do, on every workspace update.
describe('SpaceDots hover label', () => {
  it('names the space on hover, without waiting for a native tooltip', () => {
    render(<SpaceDots spaces={[A, B, C]} activeId="b" onSelect={vi.fn()} />);
    expect(screen.queryByTestId('space-hover-label')).toBeNull();
    // The label tracks the padded button, not the bare 6px dot — hover must
    // engage the moment the pointer reaches the dot, not halfway across it.
    fireEvent.pointerEnter(screen.getByRole('button', { name: 'Switch to Gamma' }));
    expect(screen.getByTestId('space-hover-label')).toHaveTextContent('Gamma');
  });

  it('drops the label when the pointer leaves', () => {
    render(<SpaceDots spaces={[A, B, C]} activeId="b" onSelect={vi.fn()} />);
    const dot = screen.getByRole('button', { name: 'Switch to Alpha' });
    fireEvent.pointerEnter(dot);
    expect(screen.getByTestId('space-hover-label')).toHaveTextContent('Alpha');
    fireEvent.pointerLeave(dot);
    expect(screen.queryByTestId('space-hover-label')).toBeNull();
  });

  it('names the space on keyboard focus too', () => {
    render(<SpaceDots spaces={[A, B, C]} activeId="b" onSelect={vi.fn()} />);
    fireEvent.focus(screen.getByRole('button', { name: 'Switch to Gamma' }));
    expect(screen.getByTestId('space-hover-label')).toHaveTextContent('Gamma');
  });
});
