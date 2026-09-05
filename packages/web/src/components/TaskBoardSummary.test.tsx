import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TaskBoardSummary } from './TaskBoardSummary';

const counts = { 'needs-you': 2, review: 1, working: 3, running: 1, idle: 7 } as const;

describe('TaskBoardSummary', () => {
  it('renders as inline text chips, not boxed tiles', () => {
    render(<TaskBoardSummary counts={{ ...counts }} active={null} onToggle={() => {}} />);
    const chip = screen.getByTestId('tile-needs-you');
    expect(chip.className).not.toMatch(/border/);
    expect(chip.className).not.toMatch(/uppercase/);
  });

  it('shows the four actionable tiles with counts, in priority order', () => {
    render(<TaskBoardSummary counts={{ ...counts }} active={null} onToggle={() => {}} />);
    const tiles = screen.getAllByRole('button');
    expect(tiles.map((t) => t.textContent)).toEqual(['Needs you2', 'Working3', 'Running1', 'Review1']);
    expect(screen.queryByText('Idle')).toBeNull();
  });

  it('a tile toggles as a filter', () => {
    const onToggle = vi.fn();
    render(<TaskBoardSummary counts={{ ...counts }} active="working" onToggle={onToggle} />);
    expect(screen.getByTestId('tile-working')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('tile-needs-you')).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByTestId('tile-needs-you'));
    expect(onToggle).toHaveBeenCalledWith('needs-you');
  });

  it('a zero tile is muted but still present, so the quiet answer is visible', () => {
    render(<TaskBoardSummary counts={{ ...counts, 'needs-you': 0 }} active={null} onToggle={() => {}} />);
    expect(screen.getByTestId('tile-needs-you')).toHaveAttribute('data-empty', 'true');
  });

  it('renders nothing for an empty workspace', () => {
    const { container } = render(
      <TaskBoardSummary counts={{ 'needs-you': 0, review: 0, working: 0, running: 0, idle: 0 }} active={null} onToggle={() => {}} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
