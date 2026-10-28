// Which adapter runs a Jarvis turn: one per agent CLI, all with the same
// contract (claudeHeadless.ts), picked by the Focus's agent.
import { runClaudeHeadless, type HeadlessEvent, type HeadlessOpts } from './claudeHeadless.js';
import { CODEX_AUTH_ENV, runCodexHeadless } from './codexHeadless.js';
import { PI_AUTH_ENV, runPiHeadless } from './piHeadless.js';
import type { JarvisAgent } from './types.js';

/** The env names each CLI logs in with, let through the runner's scrub for
 *  that agent only (Claude's are in runner.ts, with its cloud rules). */
export const AGENT_AUTH_ENV: Partial<Record<JarvisAgent, RegExp>> = {
  codex: CODEX_AUTH_ENV,
  pi: PI_AUTH_ENV,
};

export function runHeadless(o: HeadlessOpts): AsyncIterable<HeadlessEvent> {
  switch (o.agent) {
    case 'codex': return runCodexHeadless(o);
    case 'pi': return runPiHeadless(o);
    case 'claude': return runClaudeHeadless(o);
    default: return notYet(o.agent);
  }
}

async function* notYet(agent: string): AsyncIterable<HeadlessEvent> {
  yield { type: 'error', message: `Jarvis can't run on ${agent} yet`, fix: 'Pick another agent' };
}
