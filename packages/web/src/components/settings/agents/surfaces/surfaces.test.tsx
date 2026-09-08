import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { widgetFor } from './index';
import type { SurfaceKind, SurfaceValue } from '../../../../api';

const base = {
  id: 'x', label: 'X', group: 'G', readOnly: false,
  source: 'set' as const, file: '/f', exists: true,
};

describe('widgetFor', () => {
  it('returns a component for every kind', () => {
    for (const kind of ['mcp-list','skill-list','plugin-list','hook-list','permissions','kv','enum','toggle','markdown','raw'] as const) {
      expect(widgetFor(kind)).toBeTruthy();
    }
  });

  it('McpList renders one row per server with its transport', () => {
    const Widget = widgetFor('mcp-list');
    // The second server is deliberately named something other than "local"
    // (its own transport) — the brief's fixture named it "local", which
    // collides with the transport-badge text itself and would let a broken
    // badge (or none at all) pass by accident, since the row's own name
    // already reads "local".
    const surface = { ...base, kind: 'mcp-list' as const, value: {
      figma: { url: 'http://x' },
      worker: { command: 'node', args: ['a.js'] },
    }};
    render(<Widget surface={surface as SurfaceValue} onChange={vi.fn()} />);
    expect(screen.getByText('figma')).toBeInTheDocument();
    expect(screen.getByText('worker')).toBeInTheDocument();
    expect(screen.getByText('remote')).toBeInTheDocument();
    expect(screen.getByText('local')).toBeInTheDocument();
  });

  it('McpList commits a removal immediately', async () => {
    const onChange = vi.fn().mockResolvedValue(undefined);
    const Widget = widgetFor('mcp-list');
    const surface = { ...base, kind: 'mcp-list' as const, value: { figma: { url: 'http://x' } } };
    render(<Widget surface={surface as SurfaceValue} onChange={onChange} />);
    await userEvent.click(screen.getByLabelText('Remove figma'));
    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  // Removing a server when others remain must not trip the "empty object ->
  // undefined" rewrite meant for the LAST entry — this proves the removal
  // fix only ever changes what's sent for the specifically-empty case.
  it('McpList sends the remaining servers, not undefined, when one of several is removed', async () => {
    const onChange = vi.fn().mockResolvedValue(undefined);
    const Widget = widgetFor('mcp-list');
    const surface = { ...base, kind: 'mcp-list' as const, value: {
      figma: { url: 'http://x' },
      worker: { command: 'node' },
    }};
    render(<Widget surface={surface as SurfaceValue} onChange={onChange} />);
    await userEvent.click(screen.getByLabelText('Remove figma'));
    expect(onChange).toHaveBeenCalledWith({ worker: { command: 'node' } });
  });

  it('McpList never renders an env value', () => {
    const Widget = widgetFor('mcp-list');
    const surface = { ...base, kind: 'mcp-list' as const, value: {
      s: { command: 'node', env: { API_KEY: 'sk-secret-value' } },
    }};
    render(<Widget surface={surface as SurfaceValue} onChange={vi.fn()} />);
    expect(screen.queryByText(/sk-secret-value/)).toBeNull();
  });

  // Proves the redaction test above actually protects something: it must
  // fail when the widget stops redacting. Verified manually by rendering
  // `server.env` values directly instead of the count — see task-12-report.md.
  it('McpList shows an env count instead of the values', () => {
    const Widget = widgetFor('mcp-list');
    const surface = { ...base, kind: 'mcp-list' as const, value: {
      s: { command: 'node', env: { API_KEY: 'sk-secret-value', OTHER: 'y' } },
    }};
    render(<Widget surface={surface as SurfaceValue} onChange={vi.fn()} />);
    expect(screen.getByText('2 env vars')).toBeInTheDocument();
  });

  it('ScalarField stages rather than commits', async () => {
    const onStage = vi.fn();
    const onChange = vi.fn();
    const Widget = widgetFor('enum');
    const surface = { ...base, kind: 'enum' as const, value: 'low', options: ['low','high'] };
    render(<Widget surface={surface as SurfaceValue} onChange={onChange} onStage={onStage} />);
    await userEvent.selectOptions(screen.getByRole('combobox'), 'high');
    expect(onStage).toHaveBeenCalledWith('high');
    expect(onChange).not.toHaveBeenCalled();
  });

  // Final review fix #5: an inherited surface has nothing local TO reset —
  // the badge now offers "Override here" instead, and shows the inherited
  // value read-only until the user clicks it.
  it('shows an inherited badge and an Override control, read-only, never a Reset button', () => {
    const Widget = widgetFor('enum');
    const surface = {
      ...base, kind: 'enum' as const, source: 'inherited' as const,
      value: undefined, inheritedValue: 'low', options: ['low','high'],
    };
    render(<Widget surface={surface as SurfaceValue} onChange={vi.fn()} onStage={vi.fn()} />);
    expect(screen.getByText('inherited')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Override here' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reset' })).toBeNull();
    expect(screen.getByRole('combobox')).toBeDisabled();
    expect(screen.getByRole('combobox')).toHaveValue('low');
  });

  // Clicking "Override here" must start the user from EMPTY, not from a copy
  // of the inherited value — the whole point of the fix (silently
  // materializing the parent's value at this scope was the bug).
  it('Override here switches an inherited enum to an editable, EMPTY control — not a copy of the inherited value', async () => {
    const onStage = vi.fn();
    const Widget = widgetFor('enum');
    const surface = {
      ...base, kind: 'enum' as const, source: 'inherited' as const,
      value: undefined, inheritedValue: 'low', options: ['low', 'high'],
    };
    render(<Widget surface={surface as SurfaceValue} onChange={vi.fn()} onStage={onStage} />);
    await userEvent.click(screen.getByRole('button', { name: 'Override here' }));
    const select = screen.getByRole('combobox');
    expect(select).not.toBeDisabled();
    expect(select).toHaveValue('');
    expect(onStage).not.toHaveBeenCalled();
  });

  // The "set here" badge (and its Reset) is the counterpart the review found
  // missing entirely — Reset must stage `undefined` (a real removal via the
  // write path's `jsonDriver.remove`), not `surface.inheritedValue` (which
  // used to convert an inherited value into an explicitly-set identical
  // copy instead of actually reverting).
  it('shows a "set here" badge with Reset for a surface set at this scope, and Reset stages undefined', async () => {
    const onStage = vi.fn();
    const Widget = widgetFor('enum');
    const surface = {
      ...base, kind: 'enum' as const, source: 'set' as const,
      value: 'high', inheritedValue: 'low', options: ['low', 'high'],
    };
    render(<Widget surface={surface as SurfaceValue} onChange={vi.fn()} onStage={onStage} />);
    expect(screen.getByText('set here')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Override here' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(onStage).toHaveBeenCalledWith(undefined);
  });

  it('renders a read-only surface without controls', () => {
    const Widget = widgetFor('mcp-list');
    const surface = { ...base, kind: 'mcp-list' as const, readOnly: true, value: { a: { url: 'u' } } };
    render(<Widget surface={surface as SurfaceValue} onChange={vi.fn()} />);
    expect(screen.queryByLabelText('Remove a')).toBeNull();
  });

  // Final review fix #4, McpList's own case: removing ONE inherited server
  // used to write back every OTHER inherited server at this scope (a
  // partial, silent materialization) without ever removing anything at
  // project scope. An inherited list must render with no Remove controls at
  // all until "Override here" is clicked — proving there is no longer any
  // path to editing an inherited entry directly.
  it('McpList renders inherited servers read-only (no Remove controls) until Override here is clicked', async () => {
    const onChange = vi.fn().mockResolvedValue(undefined);
    const Widget = widgetFor('mcp-list');
    const surface = {
      ...base, kind: 'mcp-list' as const, source: 'inherited' as const,
      value: undefined, inheritedValue: { figma: { url: 'http://x' }, worker: { command: 'node' } },
    };
    render(<Widget surface={surface as SurfaceValue} onChange={onChange} />);
    expect(screen.getByText('figma')).toBeInTheDocument();
    expect(screen.getByText('worker')).toBeInTheDocument();
    expect(screen.queryByLabelText('Remove figma')).toBeNull();
    expect(screen.queryByLabelText('Remove worker')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Override here' }));
    // Starts truly empty — not a copy of the inherited servers a Remove
    // click could then partially write back.
    expect(screen.queryByText('figma')).toBeNull();
    expect(screen.queryByText('worker')).toBeNull();
    expect(screen.getByText('No MCP servers configured.')).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('HookList marks Strado-managed hooks read-only', () => {
    const Widget = widgetFor('hook-list');
    const surface = { ...base, kind: 'hook-list' as const, value: {
      Stop: [{ hooks: [{ type: 'command', command: 'node "/x/claude-status-hook.mjs" idle 7777' }] }],
    }};
    render(<Widget surface={surface as SurfaceValue} onChange={vi.fn()} />);
    expect(screen.getByText('managed by Strado')).toBeInTheDocument();
  });

  it('HookList removes a non-managed hook immediately, leaving managed hooks alone', async () => {
    const onChange = vi.fn().mockResolvedValue(undefined);
    const Widget = widgetFor('hook-list');
    const surface = { ...base, kind: 'hook-list' as const, value: {
      Stop: [{ hooks: [
        { type: 'command', command: 'node "/x/claude-status-hook.mjs" idle 7777' },
        { type: 'command', command: 'echo hi' },
      ] }],
    }};
    render(<Widget surface={surface as SurfaceValue} onChange={onChange} />);
    await userEvent.click(screen.getByLabelText('Remove hook echo hi'));
    expect(onChange).toHaveBeenCalledWith({
      Stop: [{ hooks: [{ type: 'command', command: 'node "/x/claude-status-hook.mjs" idle 7777' }] }],
    });
  });

  it('PluginList toggles a plugin immediately', async () => {
    const onChange = vi.fn().mockResolvedValue(undefined);
    const Widget = widgetFor('plugin-list');
    const surface = { ...base, kind: 'plugin-list' as const, value: { 'foo@bar': false } };
    render(<Widget surface={surface as SurfaceValue} onChange={onChange} />);
    await userEvent.click(screen.getByRole('checkbox'));
    expect(onChange).toHaveBeenCalledWith({ 'foo@bar': true });
  });

  // Removing the last plugin must delete `enabledPlugins` entirely on Save
  // (`undefined`, so `jsonDriver.remove` runs) rather than leaving an
  // explicit `{}` sitting there forever.
  it('PluginList sends undefined, not {}, when the last plugin is removed', async () => {
    const onChange = vi.fn().mockResolvedValue(undefined);
    const Widget = widgetFor('plugin-list');
    const surface = { ...base, kind: 'plugin-list' as const, value: { 'foo@bar': false } };
    render(<Widget surface={surface as SurfaceValue} onChange={onChange} />);
    await userEvent.click(screen.getByLabelText('Remove foo@bar'));
    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  // Final review fix #2: `onChange` PATCHes `surfaceId`, which the server
  // always rejects for a directory surface ("use the skills route") — so
  // Remove must go through the dedicated `onRemoveSkill` callback (the new
  // DELETE route) instead, named by the skill's own name.
  it('SkillList removes a skill via onRemoveSkill (the dedicated skills route), never onChange', async () => {
    const onChange = vi.fn().mockResolvedValue(undefined);
    const onRemoveSkill = vi.fn().mockResolvedValue(undefined);
    const Widget = widgetFor('skill-list');
    const surface = { ...base, kind: 'skill-list' as const, value: [
      { name: 'brainstorming', hasSkillMd: true },
      { name: 'orphan', hasSkillMd: false },
    ]};
    render(<Widget surface={surface as SurfaceValue} onChange={onChange} onRemoveSkill={onRemoveSkill} />);
    expect(screen.getByText('no SKILL.md')).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText('Remove orphan'));
    expect(onRemoveSkill).toHaveBeenCalledWith('orphan');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('KvTable stages an edited value rather than committing', async () => {
    const onStage = vi.fn();
    const onChange = vi.fn();
    const Widget = widgetFor('kv');
    const surface = { ...base, kind: 'kv' as const, value: { FOO: 'bar' } };
    render(<Widget surface={surface as SurfaceValue} onChange={onChange} onStage={onStage} />);
    const input = screen.getByDisplayValue('bar');
    await userEvent.clear(input);
    await userEvent.type(input, 'baz');
    expect(onChange).not.toHaveBeenCalled();
    expect(onStage).toHaveBeenCalledWith({ FOO: 'baz' });
  });

  // Removing the last key must stage `undefined` (so `jsonDriver.remove`
  // deletes the whole `env` key on Save) rather than an explicit `{}`.
  it('KvTable stages undefined, not {}, when the last key is removed', async () => {
    const onStage = vi.fn();
    const Widget = widgetFor('kv');
    const surface = { ...base, kind: 'kv' as const, value: { FOO: 'bar' } };
    render(<Widget surface={surface as SurfaceValue} onChange={vi.fn()} onStage={onStage} />);
    await userEvent.click(screen.getByLabelText('Remove FOO'));
    expect(onStage).toHaveBeenCalledWith(undefined);
  });

  it('PermissionsEditor stages a new allow rule', async () => {
    const onStage = vi.fn();
    const Widget = widgetFor('permissions');
    const surface = { ...base, kind: 'permissions' as const, value: {} };
    render(<Widget surface={surface as SurfaceValue} onChange={vi.fn()} onStage={onStage} />);
    const input = screen.getByLabelText('New Allow rule');
    await userEvent.type(input, 'Bash(ls:*)');
    await userEvent.click(within(input.parentElement!).getByRole('button', { name: 'Add' }));
    expect(onStage).toHaveBeenCalledWith({ allow: ['Bash(ls:*)'] });
  });

  it('MarkdownFile stages edited text', async () => {
    const onStage = vi.fn();
    const Widget = widgetFor('markdown');
    const surface = { ...base, kind: 'markdown' as const, value: 'hello' };
    render(<Widget surface={surface as SurfaceValue} onChange={vi.fn()} onStage={onStage} />);
    await userEvent.type(screen.getByLabelText('X'), '!');
    expect(onStage).toHaveBeenCalledWith('hello!');
  });

  // Final review fix #4, the case the review called out specifically: an
  // inherited `instructions` surface pre-filled the project textarea with
  // the user's WHOLE global CLAUDE.md, so one keystroke plus Save committed
  // their personal global instructions into the repo's checked-in CLAUDE.md.
  // It must render read-only showing that content, and — once the user
  // deliberately clicks "Override here" — must start EMPTY, never
  // pre-filled with what was merely being displayed.
  it('MarkdownFile renders an inherited global CLAUDE.md read-only, and starts EMPTY after Override — never pre-filled with it', async () => {
    const onStage = vi.fn();
    const Widget = widgetFor('markdown');
    const personalGlobalInstructions = "# Kamlesh's personal instructions\nMy home address is ...";
    const surface = {
      ...base, kind: 'markdown' as const, source: 'inherited' as const,
      value: undefined, inheritedValue: personalGlobalInstructions,
    };
    render(<Widget surface={surface as SurfaceValue} onChange={vi.fn()} onStage={onStage} />);

    // Read-only: shows the inherited content, but a keystroke must not be
    // possible to stage — proving the OLD bug (a keystroke here silently
    // committing the whole personal file into the project's CLAUDE.md) is
    // fixed, not merely relabeled.
    const textarea = screen.getByLabelText('X') as HTMLTextAreaElement;
    expect(textarea).toHaveValue(personalGlobalInstructions);
    expect(textarea).toHaveAttribute('readonly');
    fireEvent.change(textarea, { target: { value: `${personalGlobalInstructions}!` } });
    expect(onStage).not.toHaveBeenCalled();

    // Deliberately overriding starts EMPTY — not a copy of what was shown.
    await userEvent.click(screen.getByRole('button', { name: 'Override here' }));
    const overriddenTextarea = screen.getByLabelText('X') as HTMLTextAreaElement;
    expect(overriddenTextarea).not.toHaveAttribute('readonly');
    expect(overriddenTextarea).toHaveValue('');
    expect(onStage).not.toHaveBeenCalled();

    // Now typing stages only what was actually typed, never the personal
    // global content it might otherwise have been seeded with.
    await userEvent.type(overriddenTextarea, 'x');
    expect(onStage).toHaveBeenCalledWith('x');
    expect(onStage).not.toHaveBeenCalledWith(expect.stringContaining('personal instructions'));
  });

  // Deliberate, narrow divergence from the general "set here" + Reset
  // pairing: `instructions` is bound to the 'text' format (a whole file, not
  // a JSON key), and `writeSurface` on the server refuses to "remove" a
  // text-format surface at all — there's no key to delete, only a file whose
  // bytes must be SET to something. A Reset button here would always fail on
  // Save, the exact "always-400s" shape the Skills-panel fix (finding #2)
  // exists to avoid — so "set here" still shows, just without Reset beside it.
  it('MarkdownFile shows "set here" with no Reset button (a whole-file surface can\'t be "removed")', () => {
    const Widget = widgetFor('markdown');
    const surface = { ...base, kind: 'markdown' as const, source: 'set' as const, value: '# hi' };
    render(<Widget surface={surface as SurfaceValue} onChange={vi.fn()} onStage={vi.fn()} />);
    expect(screen.getByText('set here')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reset' })).toBeNull();
  });

  it('RawFile stages parsed JSON and flags invalid input without staging it', () => {
    const onStage = vi.fn();
    const Widget = widgetFor('raw');
    const surface = { ...base, kind: 'raw' as const, value: { a: 1 } };
    render(<Widget surface={surface as SurfaceValue} onChange={vi.fn()} onStage={onStage} />);
    const textbox = screen.getByLabelText('X');
    fireEvent.change(textbox, { target: { value: '{invalid' } });
    expect(screen.getByText(/Invalid JSON/)).toBeInTheDocument();
    onStage.mockClear();
    fireEvent.change(textbox, { target: { value: '{"b":2}' } });
    expect(onStage).toHaveBeenCalledWith({ b: 2 });
  });

  // `mcp-list` already has its own dedicated readOnly test above. The
  // remaining kinds implement `readOnly` correctly by inspection, but until
  // now nothing would catch a regression — and `readOnly` is exactly what
  // keeps `mcp-approved` and Strado-managed hooks from being edited from
  // here. Table-driven over the widget map rather than five near-identical
  // `it` blocks: each case renders editable, asserts its control is present
  // and interactive, then renders read-only and asserts it's gone/disabled.
  describe('readOnly suppresses controls for every remaining kind', () => {
    const cases: Array<{
      kind: SurfaceKind;
      value: unknown;
      options?: string[];
      assertEditable: () => void;
      assertLocked: () => void;
    }> = [
      {
        kind: 'kv',
        value: { FOO: 'bar' },
        assertEditable: () => {
          expect(screen.getByDisplayValue('bar')).toBeInTheDocument();
          expect(screen.getByLabelText('Remove FOO')).toBeInTheDocument();
        },
        assertLocked: () => {
          expect(screen.queryByDisplayValue('bar')).toBeNull();
          expect(screen.queryByLabelText('Remove FOO')).toBeNull();
          expect(screen.getByText('bar')).toBeInTheDocument();
        },
      },
      {
        kind: 'permissions',
        value: { allow: ['Bash(ls:*)'] },
        assertEditable: () => {
          expect(screen.getByLabelText('New Allow rule')).toBeInTheDocument();
          expect(screen.getByLabelText('Remove Bash(ls:*) from Allow')).toBeInTheDocument();
        },
        assertLocked: () => {
          expect(screen.queryByLabelText('New Allow rule')).toBeNull();
          expect(screen.queryByLabelText('Remove Bash(ls:*) from Allow')).toBeNull();
          expect(screen.getByText('Bash(ls:*)')).toBeInTheDocument();
        },
      },
      {
        kind: 'enum',
        value: 'low',
        options: ['low', 'high'],
        assertEditable: () => expect(screen.getByRole('combobox')).not.toBeDisabled(),
        assertLocked: () => expect(screen.getByRole('combobox')).toBeDisabled(),
      },
      {
        kind: 'toggle',
        value: true,
        assertEditable: () => expect(screen.getByRole('checkbox')).not.toBeDisabled(),
        assertLocked: () => expect(screen.getByRole('checkbox')).toBeDisabled(),
      },
      {
        kind: 'plugin-list',
        value: { 'foo@bar': false },
        assertEditable: () => {
          expect(screen.getByRole('checkbox')).not.toBeDisabled();
          expect(screen.getByLabelText('Remove foo@bar')).toBeInTheDocument();
        },
        assertLocked: () => {
          expect(screen.getByRole('checkbox')).toBeDisabled();
          expect(screen.queryByLabelText('Remove foo@bar')).toBeNull();
        },
      },
      {
        kind: 'hook-list',
        value: { Stop: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] },
        assertEditable: () => expect(screen.getByLabelText('Remove hook echo hi')).toBeInTheDocument(),
        assertLocked: () => expect(screen.queryByLabelText('Remove hook echo hi')).toBeNull(),
      },
    ];

    for (const { kind, value, options, assertEditable, assertLocked } of cases) {
      it(`${kind} hides/disables its controls when readOnly, and shows them when not`, () => {
        const Widget = widgetFor(kind);
        const editableProps = { ...base, kind, readOnly: false, value, options } as SurfaceValue;
        const editable = render(<Widget surface={editableProps} onChange={vi.fn()} onStage={vi.fn()} />);
        assertEditable();
        editable.unmount();

        const lockedProps = { ...base, kind, readOnly: true, value, options } as SurfaceValue;
        render(<Widget surface={lockedProps} onChange={vi.fn()} onStage={vi.fn()} />);
        assertLocked();
      });
    }
  });
});
