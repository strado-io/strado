import { fireEvent, screen } from '@testing-library/react';

/** Home hides the sidebar whatever is stored. Tests that drive the sidebar
 * store it open; this shows it once home is up (as the user's ⌘B would). */
export function showSidebarOnHome(): void {
  if (localStorage.getItem('strado:sidebar-collapsed:v2') !== '0') return;
  void screen.findByLabelText('Open sidebar', undefined, { timeout: 3_000 })
    .then((b) => { if (screen.queryByRole('heading', { name: 'What do you want to do?' })) fireEvent.click(b); })
    .catch(() => { /* never reached home: the sidebar already shows */ });
}

/** The same, right now: shows the sidebar if home is up and hiding it. */
export function openSidebarIfHome(): void {
  const b = screen.queryByLabelText('Open sidebar');
  if (b && screen.queryByRole('heading', { name: 'What do you want to do?' })) fireEvent.click(b);
}
