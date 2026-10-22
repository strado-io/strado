import { describe, expect, it, vi } from 'vitest';
import type { JarvisContext } from './jarvisModel';
import { createJevRouter, JEV_MODEL } from './jevRouter';

const ctx: JarvisContext = {
  worktree: { name: 'master' }, focused: 'claude-1',
  tabs: [{ name: 'claude-1', mode: 'claude', busy: false, worktree: 'master' }, { name: 'shell-1', mode: 'shell', busy: false, worktree: 'master' }],
  worktrees: [{ name: 'master' }, { name: 'FD-00029_hotfix' }], focuses: [], scripts: ['dev'], packageManager: 'npm', agents: [],
};
const choice = (c: string, confidence = 0.95) => ({ type: 'choice', choice: c, confidence });
const reply = (answers: Record<string, unknown>) => async () => ({ answers });
const input = (text: string) => ({ text, context: ctx, thread: [] });

describe('jevRouter', () => {
  it('a confident single move becomes a tab.place plan, from one Decisions call', async () => {
    const fetch = vi.fn(reply({ free_text: { type: 'noul', noul: 0.05 }, several: { type: 'noul', noul: 0.05 }, action: choice('tab_place'), tab: choice('shell-1'), anchor: choice('claude-1'), split: choice('right') }));
    const r = await createJevRouter({ fetch, readKey: async () => 'or-key' }).route(input('put the shell next to claude'));
    expect(r).toMatchObject({ kind: 'plan', model: JEV_MODEL, steps: [{ action: 'tab.place', args: { tab: 'shell-1', anchor: 'claude-1', split: 'right' } }] });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [key, body] = fetch.mock.calls[0] as unknown as [string, { model: string; questions: Record<string, { criteria: Record<string, unknown> }> }];
    expect(key).toBe('or-key');
    expect(body.model).toBe(JEV_MODEL);
    // Options are exactly the names Strado knows (+ "this" and "none"): Jev picks, never writes.
    expect(Object.keys(body.questions.tab!.criteria)).toEqual(['claude-1', 'shell-1', 'this', 'none']);
    expect(Object.keys(body.questions.worktree!.criteria)).toEqual(['master', 'FD-00029_hotfix', 'none']);
  });

  it('a new empty tab is a choice too: "open shell below shell 1" → tab.open, placement optional', async () => {
    const r = (answers: Record<string, unknown>) => createJevRouter({ readKey: async () => 'k', fetch: reply({ worktree: choice('none'), ...answers }) }).route(input('can you open shell below shell 1?'));
    expect(await r({ free_text: { type: 'noul', noul: 0.05 }, several: { type: 'noul', noul: 0.05 }, action: choice('tab_open'), mode: choice('shell'), split: choice('down'), anchor: choice('shell-1') }))
      .toMatchObject({ steps: [{ action: 'tab.open', args: { mode: 'shell', split: 'down', anchor: 'shell-1', command: null, prompt: null, worktree: null } }] });
    expect(await r({ free_text: { type: 'noul', noul: 0.05 }, several: { type: 'noul', noul: 0.05 }, action: choice('tab_open'), mode: choice('claude'), split: choice('none'), anchor: choice('none') }))
      .toMatchObject({ steps: [{ action: 'tab.open', args: { mode: 'claude', split: null, anchor: null } }] });
    expect(await r({ free_text: { type: 'noul', noul: 0.05 }, several: { type: 'noul', noul: 0.05 }, action: choice('tab_open'), mode: choice('none') })).toBeNull();
    // "in a new tab" is its own tab, never a split beside the focused one
    expect(await r({ free_text: { type: 'noul', noul: 0.05 }, several: { type: 'noul', noul: 0.05 }, action: choice('tab_open'), mode: choice('shell'), split: choice('tab'), anchor: choice('none') }))
      .toMatchObject({ steps: [{ action: 'tab.open', args: { mode: 'shell', split: 'tab' } }] });
  });

  it('asks Jev with "tab" (a new tab) as a placement it can pick', async () => {
    const fetch = vi.fn(reply({}));
    await createJevRouter({ fetch, readKey: async () => 'k' }).route(input('open a shell in a new tab'));
    const body = (fetch.mock.calls[0] as unknown as [string, { questions: Record<string, { criteria: Record<string, unknown> }> }])[1];
    expect(Object.keys(body.questions.split!.criteria)).toContain('tab');
  });

  describe('named run commands', () => {
    const base = { free_text: { type: 'noul', noul: 0.05 }, several: { type: 'noul', noul: 0.05 }, worktree: choice('none') };
    const withRuns = { ...ctx, runCommands: [{ name: 'dev' }, { name: 'api' }] };
    const route = (answers: Record<string, unknown>, context: JarvisContext = withRuns) => {
      const fetch = vi.fn(reply({ ...base, ...answers }));
      return { fetch, result: createJevRouter({ fetch, readKey: async () => 'k' }).route({ text: 'stop api', context, thread: [] }) };
    };
    it('asks which run when there are several, and passes it on', async () => {
      const { fetch, result } = route({ action: choice('server_stop'), run: choice('api') });
      expect(await result).toMatchObject({ steps: [{ action: 'server.stop', args: { run: 'api', worktree: null } }] });
      const body = (fetch.mock.calls[0] as unknown as [string, { questions: Record<string, { criteria: Record<string, unknown> }> }])[1];
      expect(Object.keys(body.questions.run!.criteria)).toEqual(['dev', 'api', 'none']);
    });
    it('"none named" is the default run (run null)', async () => {
      expect(await route({ action: choice('server_start'), run: choice('none') }).result).toMatchObject({ steps: [{ action: 'server.start', args: { run: null } }] });
    });
    it('unsure which run: Haiku decides, never the default', async () => {
      expect(await route({ action: choice('server_stop'), run: choice('api', 0.3) }).result).toBeNull();
    });
    it('one run command (or none): not asked; run null', async () => {
      const { fetch, result } = route({ action: choice('server_start') }, { ...ctx, runCommands: [{ name: 'dev' }] });
      expect(await result).toMatchObject({ steps: [{ action: 'server.start', args: { run: null } }] });
      const body = (fetch.mock.calls[0] as unknown as [string, { questions: Record<string, unknown> }])[1];
      expect(body.questions).not.toHaveProperty('run');
    });
  });

  it('maps worktree navigation to nav.worktree {name}, and a server action to {worktree}', async () => {
    const go = await createJevRouter({ readKey: async () => 'k', fetch: reply({ free_text: { type: 'noul', noul: 0.05 }, several: { type: 'noul', noul: 0.05 }, action: choice('nav_worktree'), worktree: choice('FD-00029_hotfix') }) }).route(input('go to the hotfix'));
    expect(go).toMatchObject({ steps: [{ action: 'nav.worktree', args: { name: 'FD-00029_hotfix' } }] });
    const stop = await createJevRouter({ readKey: async () => 'k', fetch: reply({ free_text: { type: 'noul', noul: 0.05 }, several: { type: 'noul', noul: 0.05 }, action: choice('server_stop'), worktree: choice('none') }) }).route(input('stop the dev server'));
    expect(stop).toMatchObject({ steps: [{ action: 'server.stop', args: { worktree: null } }] });
  });

  it('a new tab whose placement Jev is unsure of goes to Haiku — never silently the default (live: "below shell 1" landed right)', async () => {
    const r = (answers: Record<string, unknown>) => createJevRouter({ readKey: async () => 'k', fetch: reply({ free_text: { type: 'noul', noul: 0.05 }, several: { type: 'noul', noul: 0.05 }, action: choice('tab_open'), mode: choice('shell'), worktree: choice('none'), ...answers }) }).route(input('open a shell below shell 1'));
    expect(await r({ split: choice('down', 0.6), anchor: choice('shell-1') })).toBeNull();
    expect(await r({ split: choice('down'), anchor: choice('shell-1', 0.5) })).toBeNull();
    // Confidently "not said" is still the default placement.
    expect(await r({ split: choice('none'), anchor: choice('none') })).toMatchObject({ steps: [{ args: { split: null, anchor: null } }] });
  });

  it('a named worktree is honoured on a new tab ("open a shell in master" from elsewhere); on home with none named, Haiku asks', async () => {
    const answers = { free_text: { type: 'noul', noul: 0.05 }, several: { type: 'noul', noul: 0.05 }, action: choice('tab_open'), mode: choice('shell'), split: choice('none'), anchor: choice('none') };
    const named = await createJevRouter({ readKey: async () => 'k', fetch: reply({ ...answers, worktree: choice('FD-00029_hotfix') }) }).route(input('open a shell in the hotfix'));
    expect(named).toMatchObject({ steps: [{ action: 'tab.open', args: { worktree: 'FD-00029_hotfix' } }] });
    const homeCtx = { ...ctx, worktree: null, focused: null, tabs: [] };
    const onHome = await createJevRouter({ readKey: async () => 'k', fetch: reply({ ...answers, worktree: choice('none') }) }).route({ text: 'open a shell', context: homeCtx, thread: [] });
    expect(onHome).toBeNull();
    const unsure = await createJevRouter({ readKey: async () => 'k', fetch: reply({ ...answers, worktree: choice('master', 0.4) }) }).route(input('open a shell in master'));
    expect(unsure).toBeNull();
  });

  it('a malformed answer never throws: Haiku decides (strings for nouls, inherited names, options it was not offered)', async () => {
    const r = (answers: Record<string, unknown>) => createJevRouter({ readKey: async () => 'k', fetch: reply(answers) }).route(input('x'));
    await expect(r({ free_text: { type: 'noul', noul: 'low' }, several: { type: 'noul', noul: null }, action: choice('tab_close'), tab: choice('shell-1') })).resolves.toBeNull();
    await expect(r({ free_text: { type: 'noul', noul: 0.05 }, several: { type: 'noul', noul: 0.05 }, action: choice('constructor') })).resolves.toBeNull();
    await expect(r({ free_text: { type: 'noul', noul: 0.05 }, several: { type: 'noul', noul: 0.05 }, action: choice('tab_close'), tab: choice('shell-99') })).resolves.toBeNull();
    await expect(createJevRouter({ readKey: async () => 'k', fetch: async () => 'not json' }).route(input('x'))).resolves.toBeNull();
    await expect(createJevRouter({ readKey: async () => 'k', fetch: async () => ({ answers: null }) }).route(input('x'))).resolves.toBeNull();
  });

  it('pages and Settings sections are choices too: "open usage" → nav.page, "open the theme settings" → settings.open', async () => {
    const r = (answers: Record<string, unknown>) => createJevRouter({ readKey: async () => 'k', fetch: reply({ free_text: { type: 'noul', noul: 0.05 }, several: { type: 'noul', noul: 0.05 }, ...answers }) }).route(input('x'));
    expect(await r({ action: choice('nav_page'), page: choice('usage') })).toMatchObject({ steps: [{ action: 'nav.page', args: { page: 'usage' } }] });
    expect(await r({ action: choice('settings_open'), section: choice('appearance') })).toMatchObject({ steps: [{ action: 'settings.open', args: { section: 'appearance' } }] });
    expect(await r({ action: choice('nav_page'), page: choice('none') })).toBeNull();
    expect(await r({ action: choice('ui_sidebar'), show: choice('show') })).toMatchObject({ steps: [{ action: 'ui.sidebar', args: { show: true } }] });
    expect(await r({ action: choice('ui_sidebar'), show: choice('toggle') })).toMatchObject({ steps: [{ action: 'ui.sidebar', args: { show: null } }] });
  });

  it('falls back (null) when it does not fit, the action or a needed slot is unsure, or is none', async () => {
    const r = (answers: Record<string, unknown>) => createJevRouter({ readKey: async () => 'k', fetch: reply(answers) }).route(input('x'));
    expect(await r({ free_text: { type: 'noul', noul: 0.9 }, several: { type: 'noul', noul: 0.05 }, action: choice('tab_open', 1), mode: choice('shell') })).toBeNull(); // "…and run git status"
    expect(await r({ free_text: { type: 'noul', noul: 0.05 }, several: { type: 'noul', noul: 0.8 }, action: choice('tab_focus'), tab: choice('shell-1') })).toBeNull(); // two things
    expect(await r({ free_text: { type: 'noul', noul: 0.05 }, several: { type: 'noul', noul: 0.05 }, action: choice('tab_focus', 0.5), tab: choice('shell-1') })).toBeNull();
    expect(await r({ free_text: { type: 'noul', noul: 0.05 }, several: { type: 'noul', noul: 0.05 }, action: choice('none') })).toBeNull();
    expect(await r({ free_text: { type: 'noul', noul: 0.05 }, several: { type: 'noul', noul: 0.05 }, action: choice('tab_close'), tab: choice('none') })).toBeNull();
    expect(await r({ free_text: { type: 'noul', noul: 0.05 }, several: { type: 'noul', noul: 0.05 }, action: choice('tab_place'), tab: choice('shell-1'), anchor: choice('claude-1', 0.3), split: choice('right') })).toBeNull();
    expect(await r({})).toBeNull();
  });

  it('no key → null without a network call; errors and timeouts → null', async () => {
    const fetch = vi.fn();
    expect(await createJevRouter({ fetch, readKey: async () => null }).route(input('x'))).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(await createJevRouter({ readKey: async () => 'k', fetch: async () => { throw new Error('jev 402'); } }).route(input('x'))).toBeNull();
    const hang = createJevRouter({ readKey: async () => 'k', timeoutMs: 20, fetch: (_k, _b, signal) => new Promise((_r, rej) => signal.addEventListener('abort', () => rej(new Error('aborted')))) });
    expect(await hang.route(input('x'))).toBeNull();
  });
});
