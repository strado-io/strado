import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { AnswerText, plainAnswer } from './AnswerText';

const A = 'There are three Focuses: **Focus Feature** (focus-groups), **Remote worktrees** and *Strado MCP*, see `release-0.1.65`.';

describe('AnswerText: the model answers in markdown', () => {
  it('shows bold, italic and code as such, with no stars or backticks left', () => {
    const { container } = render(<AnswerText text={A} />);
    expect(container.textContent).not.toMatch(/[*`]/);
    expect(container.querySelectorAll('strong')).toHaveLength(2);
    expect(container.querySelector('em')?.textContent).toBe('Strado MCP');
    expect(container.querySelector('code')?.textContent).toBe('release-0.1.65');
  });
  it('lists are lists, and paragraphs stay apart', () => {
    const { container } = render(<AnswerText text={'Focuses:\n\n- one\n- two\n\nDone.'} />);
    expect(container.querySelectorAll('li')).toHaveLength(2);
    expect(container.querySelectorAll('p')).toHaveLength(2);
  });
  it('links open outside the app, and raw html is not run', () => {
    const { container } = render(<AnswerText text={'[docs](https://strado.io) <img src=x onerror=alert(1)>'} />);
    expect(container.querySelector('a')).toMatchObject({ href: 'https://strado.io/', target: '_blank', rel: 'noreferrer' });
    expect(container.querySelector('img')).toBeNull();
  });
});

describe('plainAnswer: what is read aloud', () => {
  it('drops the markdown marks', () => {
    expect(plainAnswer(A)).toBe('There are three Focuses: Focus Feature (focus-groups), Remote worktrees and Strado MCP, see release-0.1.65.');
    expect(plainAnswer('# Title\n- one\n- two\n[docs](https://x.io)')).toBe('Title\none\ntwo\ndocs');
  });
  it('leaves snake_case and lone stars alone', () => {
    expect(plainAnswer('focus_id is 2 * 3')).toBe('focus_id is 2 * 3');
  });
});
