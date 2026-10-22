// Live eval of the command box's planners (Jev fast path + Haiku) against a
// fixed corpus. Spends a few cents of the user's own keys; never prints them.
//   STRADO_HOME=~/.strado-dev npx tsx scripts/jarvis-eval.ts [--only <substring>] [--repeat N]
// Writes a JSON report next to the summary it prints.
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createJarvisModel, type JarvisContext, type JarvisResult } from '../src/services/jarvisModel';
import { createJevRouter } from '../src/services/jevRouter';

type Step = { action: string; args: Record<string, unknown> };
type Expect = (r: JarvisResult) => string | null; // null = pass, else why it failed

const ctx: JarvisContext = {
  worktree: { name: 'master' },
  focused: 'claude-1',
  tabs: [
    { name: 'claude-1', mode: 'claude', busy: false, worktree: 'master' },
    { name: 'shell-1', mode: 'shell', busy: false, worktree: 'master' },
    { name: 'shell-2', mode: 'shell', busy: true, worktree: 'master' },
  ],
  worktrees: [{ name: 'master', branch: 'master' }, { name: 'FD-00029_hotfix', branch: 'FD-00029_hotfix' }, { name: 'main', branch: 'main' }],
  focuses: [{ name: 'test' }, { name: 'release' }],
  scripts: ['dev', 'build', 'test', 'lint'],
  packageManager: 'npm',
  agents: [{ name: 'claude-1', mode: 'claude', lifecycle: 'idle' }],
  calls: [{ from: 'codex-1', title: 'Should I delete the old migration?' }],
  repos: [{ name: 'Fleetx Dashboard' }, { name: 'Strado' }],
};
const home: JarvisContext = { ...ctx, worktree: null, focused: null, tabs: [] };
/** The "release" Focus is open: FD-00029_hotfix and main, a claude in each. */
const inFocus: JarvisContext = {
  ...ctx, calls: [],
  focus: { name: 'release' },
  focuses: [{ name: 'test', worktrees: ['master'] }, { name: 'release', worktrees: ['FD-00029_hotfix', 'main'] }],
  agents: [...ctx.agents, { name: 'FD-00029_hotfix/claude-1', mode: 'claude', lifecycle: 'idle' }, { name: 'main/claude-2', mode: 'claude', lifecycle: 'working' }],
};
/** Every step is `action`, there are `n` of them, and each passes `check`. */
const each = (action: string, n: number, check: (s: Step) => string | null = () => null): Expect => (r) => {
  const got = steps(r);
  if (got.length !== n || got.some((s) => s.action !== action)) return `steps ${JSON.stringify(got.map((s) => s.action))}, wanted ${n} × ${action}`;
  for (const s of got) { const why = check(s); if (why) return why; }
  return null;
};
/** Two workspaces, this window in FleetX. */
const withWorkspaces: JarvisContext = { ...ctx, calls: [], workspace: { name: 'FleetX' }, workspaces: [{ name: 'FleetX' }, { name: 'Personal' }, { name: 'Strado IO' }] };
/** The repo has named run commands: dev (the default), api, storybook. */
const withRuns: JarvisContext = { ...ctx, calls: [], runCommands: [{ name: 'dev' }, { name: 'api' }, { name: 'storybook' }] };
/** The agents' task board: one open, one claimed. */
const withTasks: JarvisContext = { ...ctx, tasks: [{ title: 'Fix the login test', status: 'claimed', by: 'codex-1' }, { title: 'Bump dependencies', status: 'open' }] };
/** A codex agent running beside claude-1 (and no call open). */
const withCodex: JarvisContext = { ...ctx, calls: [], agents: [...ctx.agents, { name: 'codex-1', mode: 'codex', lifecycle: 'working' }], tabs: [...ctx.tabs, { name: 'codex-1', mode: 'codex', busy: true, worktree: 'master' }] };

const steps = (r: JarvisResult): Step[] => (r.kind === 'plan' ? r.steps : []);
const first = (r: JarvisResult) => steps(r)[0];
const plan = (action: string, args: Record<string, unknown> = {}): Expect => (r) => {
  const s = first(r);
  if (!s) return `no plan (${r.kind === 'answer' ? `answered: ${r.text}` : r.kind})`;
  if (s.action !== action) return `first step ${s.action}, wanted ${action}`;
  for (const [k, v] of Object.entries(args)) {
    const got = s.args[k];
    const ok = v instanceof RegExp ? typeof got === 'string' && v.test(got) : got === v;
    if (!ok) return `${action}.${k} = ${JSON.stringify(got)}, wanted ${v instanceof RegExp ? v : JSON.stringify(v)}`;
  }
  return null;
};
const seq = (...want: string[]): Expect => (r) => {
  const got = steps(r).map((s) => s.action);
  return want.every((w, i) => got[i] === w) && got.length === want.length ? null : `steps ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`;
};
const answers: Expect = (r) => (r.kind === 'answer' ? null : `wanted an answer, got ${steps(r).map((s) => s.action).join(',') || r.kind}`);
const not = (action: string): Expect => (r) => (steps(r).some((s) => s.action === action) ? `must not ${action}` : null);
const all = (...es: Expect[]): Expect => (r) => es.map((e) => e(r)).find((x) => x) ?? null;

type Case = { text: string; expect: Expect; context?: JarvisContext; jev?: boolean };
// jev: true = Jev should answer it alone (fast path); otherwise Haiku's.
const CASES: Case[] = [
  // tabs
  { text: 'open a shell', expect: plan('tab.open', { mode: 'shell' }), jev: true },
  { text: 'open a shell in a new tab', expect: plan('tab.open', { mode: 'shell', split: 'tab' }), jev: true },
  { text: 'open claude on the right', expect: plan('tab.open', { mode: 'claude', split: 'right' }), jev: true },
  { text: 'open a shell below shell 1', expect: plan('tab.open', { mode: 'shell', split: 'down', anchor: 'shell-1' }), jev: true },
  // Two shells, focus on claude: the rule is "the most recently opened one" → shell-2.
  { text: 'focus the shell', expect: plan('tab.focus', { tab: 'shell-2' }) },
  { text: 'open a shell in the hotfix worktree', expect: plan('tab.open', { mode: 'shell', worktree: 'FD-00029_hotfix' }) },
  { text: 'switch to claude', expect: plan('tab.focus', { tab: 'claude-1' }), jev: true },
  { text: 'rename this shell to test', context: { ...ctx, focused: 'shell-1' }, expect: plan('tab.rename', { tab: 'shell-1', name: /^test$/i }) },
  { text: 'call claude 1 reviewer', expect: plan('tab.rename', { tab: 'claude-1', name: /reviewer/i }) },
  // Mission control: stop, or stop and redirect, vs a message that waits for the turn.
  { text: 'stop claude-1', expect: plan('agent.interrupt', { agent: 'claude-1' }) },
  { text: 'tell claude-1 to stop and use pnpm instead', expect: plan('agent.steer', { agent: 'claude-1', text: /pnpm/i }) },
  { text: 'tell claude-1 to also run lint when it is done', expect: plan('agent.message', { to: 'claude-1', text: /lint/i }) },
  { text: 'close shell 1', expect: plan('tab.close', { tab: 'shell-1' }), jev: true },
  { text: 'stop what is running in shell 2', expect: plan('tab.interrupt', { tab: 'shell-2' }) },
  { text: 'move shell 1 below claude', expect: plan('tab.place', { tab: 'shell-1', split: 'down', anchor: 'claude-1' }), jev: true },
  { text: 'open google in a new tab', expect: plan('browser.open', { url: /google/, split: 'tab' }) },
  { text: 'open localhost 5173 next to claude', expect: plan('browser.open', { url: /5173/, split: 'right' }) },
  // shell
  { text: 'run git status in shell 1', expect: plan('shell.run', { command: 'git status' }) },
  { text: 'open a shell and run the dev script', expect: plan('tab.open', { mode: 'shell', command: 'npm run dev' }) },
  { text: 'start the dev server', expect: plan('server.start'), jev: true },
  { text: 'stop the dev server', expect: plan('server.stop'), jev: true },
  // named run commands
  { text: 'run api', context: withRuns, expect: plan('server.start', { run: 'api' }), jev: true },
  { text: 'stop storybook', context: withRuns, expect: plan('server.stop', { run: 'storybook' }), jev: true },
  { text: 'start the api server', context: withRuns, expect: plan('server.start', { run: 'api' }) },
  // The default: "" from Haiku (no nullable params, an API cap), null from Jev.
  { text: 'start the dev server', context: withRuns, expect: all(plan('server.start'), (r) => (['', null, undefined].includes(first(r)?.args.run as string) ? null : `run = ${JSON.stringify(first(r)?.args.run)}, wanted the default`)), jev: true },
  // dev is the default run: naming it or leaving it out ("") both start it.
  { text: 'run dev', context: withRuns, expect: all(plan('server.start'), (r) => (['dev', '', null].includes(first(r)?.args.run as string) ? null : `run = ${JSON.stringify(first(r)?.args.run)}, wanted dev or the default`)) },
  { text: 'run the build script', context: withRuns, expect: all(not('server.start'), (r) => (JSON.stringify(steps(r)).includes('npm run build') ? null : 'wanted npm run build')) },
  // navigation
  { text: 'go to the hotfix worktree', expect: plan('nav.worktree', { name: 'FD-00029_hotfix' }), jev: true },
  { text: 'open main', expect: plan('nav.worktree', { name: 'main' }) },
  { text: 'switch to the test focus', expect: plan('nav.focus', { name: 'test' }), jev: true },
  { text: 'can you change the focus to test', expect: plan('nav.focus', { name: 'test' }) },
  // Calls and the task board are answered in words (the intercom drawer is gone).
  { text: 'what does codex-1 want', context: { ...ctx, calls: [{ from: 'codex-1', title: 'Should I delete the old migration?', body: 'The 2023 users migration is unused. Delete it?' }] }, expect: all(answers, not('call.answer')) },
  { text: 'who needs me', expect: answers },
  { text: 'what tasks are open', context: withTasks, expect: answers },
  { text: 'who is working on the login test', context: withTasks, expect: answers },
  { text: 'add a repo', expect: plan('nav.addRepo') },
  { text: 'create a new worktree in Strado', expect: plan('nav.newWorktree', { repo: 'Strado' }) },
  // Focus editing
  { text: 'can you create a new focus', expect: (r) => (r.kind === 'answer' ? null : plan('focus.edit', { op: 'create' })(r)) }, // no name: asking is fine
  // "release" already exists in this context: a new name, so creating is the only right answer.
  { text: 'create a focus called ship with master and main', expect: (r) => plan('focus.edit', { op: 'create', name: /ship/i })(r) ?? (Array.isArray(first(r)!.args.worktrees) && (first(r)!.args.worktrees as string[]).length === 2 ? null : 'worktrees not both passed') },
  { text: 'rename the test focus to qa', expect: plan('focus.edit', { op: 'rename', focus: 'test', name: /qa/i }) },
  { text: 'add the hotfix worktree to the release focus', expect: plan('focus.edit', { op: 'add', focus: 'release' }) },
  { text: 'delete the test focus', expect: plan('focus.edit', { op: 'delete', focus: 'test' }) },
  { text: 'switch to the release focus', expect: plan('nav.focus', { name: 'release' }) },
  // pages + settings
  { text: 'open usage', expect: plan('nav.page', { page: 'usage' }), jev: true },
  { text: 'show code reviews', expect: plan('nav.page', { page: 'reviews' }), jev: true },
  { text: 'go home', expect: plan('nav.page', { page: 'home' }), jev: true },
  { text: 'show all worktrees', expect: plan('nav.page', { page: 'worktrees' }) },
  { text: 'open settings', expect: plan('settings.open', { section: 'profile' }), jev: true },
  { text: 'open the appearance settings', expect: plan('settings.open', { section: 'appearance' }), jev: true },
  { text: 'open jira settings', expect: plan('settings.open', { section: 'jira' }), jev: true },
  { text: 'change my name to Kamlesh Bishnoi', expect: plan('settings.set', { setting: 'profile.name', value: 'Kamlesh Bishnoi' }) },
  { text: 'switch to the nord theme', expect: plan('settings.set', { setting: 'appearance.theme', value: /nord/i }) },
  { text: 'use the light theme', expect: plan('settings.set', { setting: 'appearance.theme', value: /github-light/i }) },
  { text: 'turn off telemetry', expect: plan('settings.set', { setting: 'privacy.telemetry', value: 'off' }) },
  { text: 'set my anthropic api key to sk-ant-123', expect: all(not('settings.set')) },
  // agents + calls
  { text: 'ask claude how are you', expect: plan('agent.ask', { to: 'claude-1' }) },
  { text: 'ask claude 1 if the tests pass', expect: plan('agent.ask', { to: 'claude-1', question: /test/i }) },
  { text: 'codex why did you change the router', context: withCodex, expect: plan('agent.ask', { to: 'codex-1', question: /router/i }) },
  { text: 'ask claude to add tests for the login page', expect: plan('agent.message', { to: 'claude-1', text: /test/i }) },
  { text: 'tell claude 1 to stop touching the config', expect: plan('agent.message', { to: 'claude-1' }) },
  { text: 'what is claude working on', expect: plan('agent.recap', { agent: 'claude-1' }) },
  { text: 'what has codex done so far', context: withCodex, expect: plan('agent.recap', { agent: 'codex-1' }) },
  { text: 'what are all the agents doing', expect: plan('agent.recap', { agent: 'all' }) },
  // Workspaces
  { text: 'which workspace am I in', context: withWorkspaces, expect: answers },
  { text: 'list my workspaces', context: withWorkspaces, expect: answers },
  { text: 'switch to the personal workspace', context: withWorkspaces, expect: plan('nav.workspace', { name: 'Personal' }) },
  { text: 'go to fleetx', context: { ...withWorkspaces, workspace: { name: 'Personal' } }, expect: plan('nav.workspace', { name: 'FleetX' }) },
  // Focus-wide
  { text: 'open a shell in every worktree in this focus', context: inFocus, expect: each('tab.open', 2, (s) => (s.args.mode === 'shell' && ['FD-00029_hotfix', 'main'].includes(String(s.args.worktree)) ? null : `tab.open ${JSON.stringify(s.args)}`)) },
  { text: 'ask all the claudes in this focus if their tests pass', context: inFocus, expect: each('agent.ask', 2, (s) => (['FD-00029_hotfix/claude-1', 'main/claude-2'].includes(String(s.args.to)) ? null : `asked ${s.args.to}`)) },
  { text: 'what are the agents in this focus doing', context: inFocus, expect: plan('agent.recap', { agent: 'all', focus: 'release' }) },
  { text: 'remove main from this focus', context: inFocus, expect: plan('focus.edit', { op: 'remove', focus: 'release' }) },
  { text: 'open claude in the hotfix worktree', context: inFocus, expect: plan('tab.open', { mode: 'claude', worktree: 'FD-00029_hotfix' }) },
  { text: 'what is in this focus', context: inFocus, expect: answers },
  // Home screen: the only shell lives in another worktree, and the box still sees it.
  { text: 'can you close the shell in strado main?', context: { ...home, calls: [], worktrees: [{ name: 'Strado/main', branch: 'main', repo: 'Strado' }, { name: 'Strado Website/main', branch: 'main', repo: 'Strado Website' }], tabs: [{ name: 'Strado/main/shell-1', mode: 'shell', busy: false, worktree: 'Strado/main' }] }, expect: plan('tab.close', { tab: 'Strado/main/shell-1' }) },
  // A repo named instead of a worktree (the "Strado MCP" Focus holds two repos).
  { text: 'open shell in strado website', context: { ...ctx, calls: [], worktree: { name: 'Strado_Mcp' }, worktrees: [{ name: 'Strado_Mcp', branch: 'Strado_Mcp', repo: 'Strado' }, { name: 'Strado Website/main', branch: 'main', repo: 'Strado Website' }, { name: 'Strado/main', branch: 'main', repo: 'Strado' }], focus: { name: 'Strado MCP' }, focuses: [{ name: 'Strado MCP', worktrees: ['Strado_Mcp', 'Strado Website/main'] }], repos: [{ name: 'Strado' }, { name: 'Strado Website' }] }, expect: plan('tab.open', { mode: 'shell', worktree: 'Strado Website/main' }) },
  { text: 'did claude 1 finish the migration', expect: plan('agent.recap', { agent: 'claude-1' }) },
  { text: 'ask claude 1 to talk with codex about the migration', context: { ...ctx, agents: [...ctx.agents, { name: 'codex-1', mode: 'codex', lifecycle: 'idle' }], tabs: [...ctx.tabs, { name: 'codex-1', mode: 'codex', busy: false, worktree: 'master' }] }, expect: (r) => plan('agent.message', { to: 'claude-1', text: /codex-1/ })(r) ?? (steps(r).length === 1 ? null : 'messaged more than the first agent') },
  { text: 'tell codex yes go ahead and delete it', expect: plan('call.answer', { caller: 'codex-1' }) },
  { text: 'ignore the codex call', expect: plan('call.dismiss', { caller: 'codex-1' }) },
  { text: 'open claude and ask it to write tests', expect: plan('tab.open', { mode: 'claude', prompt: /test/i }) },
  // several at once
  { text: 'open a shell on the right and run git status', expect: plan('tab.open', { mode: 'shell', command: 'git status' }) },
  { text: 'open usage then open the appearance settings', expect: seq('nav.page', 'settings.open') },
  { text: 'close shell 1 and focus claude', expect: seq('tab.close', 'tab.focus') },
  // home screen: must name or ask for a worktree
  { text: 'open claude', context: home, expect: (r) => (r.kind === 'answer' ? null : (first(r)?.args.worktree ? null : 'opened with no worktree on the home screen')) },
  { text: 'in master: open a shell', context: home, expect: plan('tab.open', { mode: 'shell', worktree: 'master' }) },
  // questions and refusals
  { text: 'which shells are busy?', expect: answers },
  { text: 'delete everything in my home folder', expect: all(not('shell.run'), not('tab.open')) },
  { text: 'what is the weather', expect: answers },
];

const ms = (t0: number) => Date.now() - t0;
async function main() {
  const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
  const repeat = process.argv.includes('--repeat') ? Math.max(1, Number(process.argv[process.argv.indexOf('--repeat') + 1]) || 1) : 1;
  // --repeat N: each sentence N times — Haiku is not deterministic, a single pass proves little.
  const cases = CASES.filter((c) => !only || c.text.includes(only)).flatMap((c) => Array.from({ length: repeat }, () => c));
  const haiku = createJarvisModel({ log: (m) => console.error(m) });
  const jev = createJevRouter({});
  const rows: Record<string, unknown>[] = [];
  let haikuPass = 0; let jevHit = 0; let jevWrong = 0; let jevExpected = 0; let racePass = 0;
  for (const c of cases) {
    const input = { text: c.text, context: c.context ?? ctx, thread: [] };
    const t0 = Date.now();
    const [h, j] = await Promise.all([
      haiku.plan(input).then((r) => ({ r, ms: ms(t0) }), (e: Error) => ({ r: { kind: 'error', message: e.message } as unknown as JarvisResult, ms: ms(t0) })),
      jev.route(input).then((r) => ({ r, ms: ms(t0) }), () => ({ r: null, ms: ms(t0) })),
    ]);
    const hWhy = c.expect(h.r);
    const jWhy = j.r ? c.expect(j.r) : 'declined';
    // What the user gets: Jev when it answers, else Haiku (the route's race).
    const final = j.r ?? h.r;
    const fWhy = c.expect(final);
    if (!hWhy) haikuPass++;
    if (j.r) { jevHit++; if (jWhy) jevWrong++; }
    if (c.jev) jevExpected++;
    if (!fWhy) racePass++;
    const mark = fWhy ? 'FAIL' : 'ok  ';
    const via = j.r ? `jev ${j.ms}ms` : `haiku ${h.ms}ms`;
    console.log(`${mark} ${c.text.padEnd(52)} ${via.padEnd(13)} ${fWhy ?? ''}${hWhy && !j.r ? '' : hWhy ? `  [haiku alone: ${hWhy}]` : ''}${j.r && jWhy ? `  [JEV WRONG: ${jWhy}]` : ''}${c.jev && !j.r ? '  (jev declined)' : ''}`);
    rows.push({ text: c.text, final: fWhy ?? 'ok', haiku: hWhy ?? 'ok', haikuMs: h.ms, haikuResult: h.r, jev: j.r ? (jWhy ?? 'ok') : 'declined', jevMs: j.ms, jevResult: j.r });
  }
  console.log(`\nwhat the user gets: ${racePass}/${cases.length} right`);
  console.log(`haiku alone: ${haikuPass}/${cases.length} right`);
  console.log(`jev answered ${jevHit} (${jevWrong} wrong); ${jevExpected} were expected to be fast`);
  const out = join(process.env.STRADO_HOME || join(homedir(), '.strado'), 'logs', 'jarvis-eval-report.json');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(rows, null, 2));
  console.log(`report: ${out}`);
}
void main();
