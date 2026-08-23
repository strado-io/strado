import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MarkdownView, resolveRelative } from './MarkdownView';

describe('MarkdownView', () => {
  it('renders headings, GFM tables and fenced code', () => {
    render(
      <MarkdownView
        currentDir=""
        onNavigate={() => {}}
        content={[
          '# Title',
          '',
          '| a | b |',
          '| - | - |',
          '| 1 | 2 |',
          '',
          '```ts',
          'const x: number = 1;',
          '```',
        ].join('\n')}
      />,
    );

    expect(screen.getByRole('heading', { level: 1, name: 'Title' })).toBeInTheDocument();
    expect(screen.getByRole('table')).toBeInTheDocument();
    // rehype-highlight tokenizes the line into sibling <span>s (e.g. "const"
    // and "x" are separate nodes), so the text is broken up across elements
    // and a plain regex match against a single node's own text will never
    // find it (this is also what Testing Library's own error message says).
    // Match on the <code> element's full textContent instead.
    expect(
      screen.getByText(
        (_, element) => element?.tagName.toLowerCase() === 'code' && /const x/.test(element.textContent ?? ''),
      ),
    ).toBeInTheDocument();
  });

  it('does not leak the hast node prop onto a rendered table (N2, same root cause as M1)', () => {
    // react-markdown passes the hast node as a `node` prop to every
    // overridden component (passNode: true), including the custom `table`
    // override added for the overflow-x-auto wrapper — it must be
    // destructured out, never spread onto the DOM element.
    render(
      <MarkdownView
        currentDir=""
        onNavigate={() => {}}
        content={['| a | b |', '| - | - |', '| 1 | 2 |'].join('\n')}
      />,
    );

    expect(screen.getByRole('table')).not.toHaveAttribute('node');
  });

  it('routes a relative .md link through onNavigate, resolved against currentDir', () => {
    const onNavigate = vi.fn();
    render(
      <MarkdownView
        currentDir="docs/specs"
        onNavigate={onNavigate}
        content="[sibling](./other.md) and [up](../guide.md)"
      />,
    );

    fireEvent.click(screen.getByRole('link', { name: 'sibling' }));
    expect(onNavigate).toHaveBeenCalledWith('docs/specs/other.md');

    fireEvent.click(screen.getByRole('link', { name: 'up' }));
    expect(onNavigate).toHaveBeenCalledWith('docs/guide.md');
  });

  it('opens http(s) links via target=_blank instead of navigating the window in place', () => {
    // C1: a bare click on a same-window <a> has nothing intercepting it in
    // the desktop shell (no `will-navigate` handler in main.cjs), so it
    // would replace the whole dashboard. target=_blank routes it through
    // the existing setWindowOpenHandler -> shell.openExternal instead.
    const onNavigate = vi.fn();
    render(
      <MarkdownView currentDir="" onNavigate={onNavigate} content="[ext](https://example.com/a.md)" />,
    );

    const link = screen.getByRole('link', { name: 'ext' });
    expect(link).toHaveAttribute('href', 'https://example.com/a.md');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    fireEvent.click(link);
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('treats a scheme-only https link (no //) as external too', () => {
    // N1: `https:example.com` is a legal URL that browsers normalize to
    // `https://example.com`; defaultUrlTransform's allowlist is scheme-only
    // so it survives sanitizing untouched. A `//`-anchored regex here would
    // miss it and let it fall through to a plain anchor — the same
    // whole-window navigation C1 was about.
    const onNavigate = vi.fn();
    render(<MarkdownView currentDir="" onNavigate={onNavigate} content="[h](https:example.com)" />);

    const link = screen.getByRole('link', { name: 'h' });
    expect(link).toHaveAttribute('target', '_blank');
    fireEvent.click(link);
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('leaves non-markdown relative links alone', () => {
    const onNavigate = vi.fn();
    render(<MarkdownView currentDir="" onNavigate={onNavigate} content="[code](./src/index.ts)" />);

    fireEvent.click(screen.getByRole('link', { name: 'code' }));
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('gives headings ids and scrolls in-document anchors instead of navigating', () => {
    const onNavigate = vi.fn();
    render(
      <MarkdownView
        currentDir="docs"
        onNavigate={onNavigate}
        content={['[jump](#the-section)', '', '## The Section', '', 'body'].join('\n')}
      />,
    );

    const heading = screen.getByRole('heading', { level: 2, name: 'The Section' });
    expect(heading).toHaveAttribute('id', 'the-section');

    const scrollIntoView = vi.fn();
    heading.scrollIntoView = scrollIntoView;
    fireEvent.click(screen.getByRole('link', { name: 'jump' }));

    expect(scrollIntoView).toHaveBeenCalled();
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('scopes in-document anchor scroll to its own pane when heading ids collide across panes', () => {
    // C2: Task 7 keeps multiple panes of the same repo mounted while
    // hidden, and identical heading text produces identical rehype-slug
    // ids. A global document.getElementById lookup would scroll whichever
    // pane happened to render its heading first.
    const content = ['[jump](#dup)', '', '## Dup', '', 'body'].join('\n');
    render(
      <>
        <MarkdownView currentDir="" onNavigate={() => {}} content={content} />
        <MarkdownView currentDir="" onNavigate={() => {}} content={content} />
      </>,
    );

    const headings = screen.getAllByRole('heading', { level: 2, name: 'Dup' });
    expect(headings).toHaveLength(2);
    const firstScroll = vi.fn();
    const secondScroll = vi.fn();
    headings[0]!.scrollIntoView = firstScroll;
    headings[1]!.scrollIntoView = secondScroll;

    const jumpLinks = screen.getAllByRole('link', { name: 'jump' });
    fireEvent.click(jumpLinks[1]!);

    expect(secondScroll).toHaveBeenCalled();
    expect(firstScroll).not.toHaveBeenCalled();
  });

  it('turns on syntax highlighting token classes (regression guard: removing the plugin must fail this)', () => {
    const { container } = render(
      <MarkdownView
        currentDir=""
        onNavigate={() => {}}
        content={['```ts', 'const x: number = 1;', '```'].join('\n')}
      />,
    );

    expect(container.querySelector('pre code .hljs-keyword')).not.toBeNull();
  });

  it('sanitizes dangerous URL schemes and never renders embedded raw HTML as live elements', () => {
    const onNavigate = vi.fn();
    const { container } = render(
      <MarkdownView
        currentDir=""
        onNavigate={onNavigate}
        content={[
          '[x](javascript:alert(1))',
          '',
          '[y](data:text/html,<script>alert(1)</script>)',
          '',
          '<img src=x onerror="alert(1)">',
          '',
          '<script>alert(document.cookie)</script>',
        ].join('\n')}
      />,
    );

    // react-markdown's defaultUrlTransform allowlists only
    // http(s)/ircs/mailto/xmpp; javascript: and data: are sanitized to ''.
    expect(screen.getByRole('link', { name: 'x' })).toHaveAttribute('href', '');
    expect(screen.getByRole('link', { name: 'y' })).toHaveAttribute('href', '');
    fireEvent.click(screen.getByRole('link', { name: 'x' }));
    expect(onNavigate).not.toHaveBeenCalled();

    // No rehype-raw / dangerouslySetInnerHTML anywhere: embedded HTML never
    // becomes a live DOM element.
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
  });

  it('renders as plain text instead of parsing when content exceeds the render-size threshold', () => {
    // Table-heavy markdown above ~200KB can freeze the renderer for tens of
    // seconds with no spinner and no cancel (remark-gfm's table parsing is
    // quadratic) — size is reported by the caller (a real byte count from
    // the server), not derived from content.length here.
    const { container } = render(
      <MarkdownView
        currentDir=""
        onNavigate={() => {}}
        content="# Heading"
        size={300_000}
      />,
    );

    expect(container.querySelector('.kb-markdown')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Heading' })).not.toBeInTheDocument();
    expect(screen.getByText(/too large to render/i)).toBeInTheDocument();
    expect(container.querySelector('pre')).toHaveTextContent('# Heading');
  });

  it('still parses normally when content is under the render-size threshold', () => {
    const { container } = render(
      <MarkdownView currentDir="" onNavigate={() => {}} content="# Heading" size={100} />,
    );

    expect(container.querySelector('.kb-markdown')).not.toBeNull();
    expect(screen.getByRole('heading', { name: 'Heading' })).toBeInTheDocument();
  });
});

describe('resolveRelative', () => {
  it.each([
    ['docs', './x.md', 'docs/x.md'],
    ['docs', '../g.md', 'g.md'],
    ['', '../escape.md', 'escape.md'],
    ['docs', '/root/abs.md', 'root/abs.md'],
    ['docs', './a//b.md', 'docs/a/b.md'],
    ['docs/', 'sib.md', 'docs/sib.md'],
  ])('resolveRelative(%j, %j) -> %j', (currentDir, href, expected) => {
    expect(resolveRelative(currentDir, href)).toBe(expected);
  });
});
