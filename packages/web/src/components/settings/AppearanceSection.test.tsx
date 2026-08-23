import { render, screen, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { AppearanceSection } from './AppearanceSection';

beforeEach(() => localStorage.clear());

describe('AppearanceSection', () => {
  it('toggles density and persists it', () => {
    render(<AppearanceSection />);
    fireEvent.click(screen.getByRole('button', { name: 'Compact' }));
    expect(localStorage.getItem('strado:density')).toBe('compact');
  });

  it('shows the theme row with a Dark indicator', () => {
    render(<AppearanceSection />);
    expect(screen.getByText('Dark')).toBeInTheDocument();
  });
});
