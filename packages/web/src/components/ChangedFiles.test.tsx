import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ChangedFiles } from './ChangedFiles';
import type { MergeRequestChange } from '../types';

const diff = (p: string) => `--- a/${p}\n+++ b/${p}\n@@ -1 +1 @@\n-old\n+new\n`;
const files: MergeRequestChange[] = ['src/a.ts', 'src/b.ts', 'src/c.ts'].map((path) => ({ path, status: 'M', diff: diff(path) }));

const row = (path: string) => document.querySelector(`[data-mr-file="${path}"]`)!;
const isSelected = (path: string) => row(path).className.includes('bg-zinc-800');

describe('ChangedFiles keyboard navigation', () => {
  it('↑/↓ walk the MR file list and stop at the ends', () => {
    const onSelectFile = vi.fn();
    render(<ChangedFiles files={files} providerName="GitLab" onOpenExternal={() => {}} onSelectFile={onSelectFile} />);
    expect(isSelected('src/a.ts')).toBe(true);

    fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(isSelected('src/b.ts')).toBe(true);
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    fireEvent.keyDown(window, { key: 'ArrowDown' }); // already at the bottom
    expect(isSelected('src/c.ts')).toBe(true);
    expect(onSelectFile).toHaveBeenLastCalledWith(files[2]);

    fireEvent.keyDown(window, { key: 'ArrowUp' });
    fireEvent.keyDown(window, { key: 'ArrowUp' });
    fireEvent.keyDown(window, { key: 'ArrowUp' }); // already at the top
    expect(isSelected('src/a.ts')).toBe(true);
  });

  it('leaves arrow keys alone while typing a comment', () => {
    render(
      <>
        <textarea aria-label="comment" />
        <ChangedFiles files={files} providerName="GitLab" onOpenExternal={() => {}} />
      </>,
    );
    fireEvent.keyDown(screen.getByLabelText('comment'), { key: 'ArrowDown' });
    expect(isSelected('src/a.ts')).toBe(true);
  });
});
