import { describe, expect, it } from 'vitest';
import { buildModelContext, modelText, planFromModel } from './model';
import { findWorktree, resolveAgent, resolveTarget, worktreeLabel } from './parse';
import type { ParseContext, Plan } from './types';

const MCP = '/wt/strado/Strado_Mcp';
const SMAIN = '/wt/strado/main';
const WMAIN = '/wt/website/main';
const OTHER = '/wt/other/feature';
const ctx = (over: Partial<ParseContext> = {}): ParseContext => ({
  tabs: [
    { worktreePath: WMAIN, mode: 'claude', sessionId: '1', label: 'Claude 1', busy: false, agentId: 'claude-1@website-main' },
    { worktreePath: SMAIN, mode: 'shell', sessionId: '1', label: 'Shell 1', busy: false, agentId: 'shell-1@strado-main' },
  ],
  focused: null, lastActedOn: null, currentWorktree: MCP,
  worktrees: [
    { path: MCP, name: 'Strado_Mcp', branch: 'Strado_Mcp', repoName: 'Strado' },
    { path: SMAIN, name: 'Strado/main', branch: 'main', repoName: 'Strado' },
    { path: WMAIN, name: 'Strado Website/main', branch: 'main', repoName: 'Strado Website' },
    { path: OTHER, name: 'feature', branch: 'feature', repoName: 'Other' },
  ],
  focuses: [{ id: 'f1', name: 'Strado MCP', worktreePaths: [MCP, WMAIN] }],
  currentFocus: { id: 'f1', name: 'Strado MCP' },
  packageScripts: {},
  peers: [{ agentId: 'claude-1@website-main', alias: null, mode: 'claude', worktreePath: WMAIN }],
  ...over,
});
const openIn = (worktree: string, c = ctx()) => planFromModel([{ action: 'tab.open', args: { mode: 'shell', command: null, prompt: null, split: 'tab', anchor: null, worktree } }], c);
const wtOf = (p: Plan) => (p.steps[0]?.action === 'tab.open' ? p.steps[0].args.worktreePath : undefined);

describe('worktree context names (made unique by the app)', () => {
  it('labels are the context names as given', () => {
    expect(worktreeLabel(ctx(), MCP)).toBe('Strado_Mcp');
    expect(worktreeLabel(ctx(), OTHER)).toBe('feature');
    expect(worktreeLabel(ctx(), SMAIN)).toBe('Strado/main');
    expect(worktreeLabel(ctx(), WMAIN)).toBe('Strado Website/main');
  });
  it('the model context lists them by those names, with their repo', () => {
    const m = buildModelContext(ctx());
    expect(m.worktrees).toEqual(expect.arrayContaining([
      { name: 'Strado/main', branch: 'main', repo: 'Strado' },
      { name: 'Strado Website/main', branch: 'main', repo: 'Strado Website' },
      { name: 'Strado_Mcp', branch: 'Strado_Mcp', repo: 'Strado' },
    ]));
    expect(m.focuses).toEqual([{ name: 'Strado MCP', worktrees: ['Strado_Mcp', 'Strado Website/main'] }]);
  });
});

describe('resolving a worktree name', () => {
  it('the qualified form', () => {
    expect(wtOf(openIn('Strado Website/main'))).toBe(WMAIN);
    expect(wtOf(openIn('strado/main'))).toBe(SMAIN);
  });
  it('"main" alone is ambiguous: refused with the choices, never a guess', () => {
    const p = openIn('main');
    expect(p.steps).toHaveLength(0);
    expect(p.summary).toMatch(/Strado\/main/);
    expect(p.summary).toMatch(/Strado Website\/main/);
    expect(findWorktree(ctx(), 'main')).toMatchObject({ kind: 'ambiguous' });
  });
  it('a repo with exactly one worktree: its repo name reaches it ("open shell in strado website")', () => {
    expect(wtOf(openIn('Strado Website'))).toBe(WMAIN);
    expect(wtOf(openIn('other'))).toBe(OTHER);
  });
  it('a repo with several worktrees by repo name alone is ambiguous', () => {
    expect(openIn('Strado').steps).toHaveLength(0);
  });
  it('unique plain names, branches and tickets still work', () => {
    expect(wtOf(openIn('Strado_Mcp'))).toBe(MCP);
    expect(wtOf(openIn('feature'))).toBe(OTHER);
  });
  it('nav.worktree uses the same names', () => {
    const p = planFromModel([{ action: 'nav.worktree', args: { name: 'Strado Website/main' } }], ctx());
    expect(p.steps[0]).toMatchObject({ action: 'nav.worktree', args: { path: WMAIN } });
  });
  it('focus members use the same names', () => {
    const p = planFromModel([{ action: 'focus.edit', args: { op: 'add', focus: 'this focus', name: null, worktrees: ['Strado/main'] } }], ctx());
    expect(p.steps[0]).toMatchObject({ args: { worktreePaths: [SMAIN] } });
    expect(planFromModel([{ action: 'focus.edit', args: { op: 'add', focus: 'this focus', name: null, worktrees: ['main'] } }], ctx()).steps).toHaveLength(0);
  });
});

describe('"wt/name" tab and agent prefixes use the unique names', () => {
  it('an agent in a qualified worktree, even with a space and a second slash', () => {
    expect(resolveAgent('Strado Website/main/claude-1', ctx())).toEqual({ kind: 'ok', agentId: 'claude-1@website-main' });
    expect(resolveAgent('strado website/claude', ctx())).toEqual({ kind: 'ok', agentId: 'claude-1@website-main' });
  });
  it('a tab the same way', () => {
    const r = resolveTarget('Strado/main/shell-1', ctx(), null);
    expect(r.kind === 'ok' && r.target.kind === 'tab' && r.target.ref.worktreePath).toBe(SMAIN);
  });
  it('the model\'s tab names for other worktrees carry the unique name', () => {
    const p = planFromModel([{ action: 'agent.message', args: { to: 'Strado Website/main/claude-1', text: 'hi' } }], ctx());
    expect(p.steps[0]).toMatchObject({ action: 'agent.message', args: { agentId: 'claude-1@website-main' } });
  });
  it('a worktree chip reads as its unique name', () => {
    expect(modelText(`open a shell in #{${encodeURIComponent(WMAIN)}}`, ctx())).toBe('open a shell in #Strado Website/main');
  });
});
