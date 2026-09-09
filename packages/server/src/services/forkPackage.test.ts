import { describe, expect, it } from 'vitest';
import { FORK_PACKAGE_MAX, FORK_TURNS } from './intercomSchema.js';
import { renderDiarySummary, renderForkPackage, type ForkPackageInput } from './forkPackage.js';

const bytes = (s: string): number => Buffer.byteLength(s, 'utf8');

function baseInput(over: Partial<ForkPackageInput> = {}): ForkPackageInput {
  return {
    label: 'add retries',
    sourceAgent: 'claude-1@repo',
    sourceMode: 'claude',
    targetLabel: 'claude-2@repo',
    notes: '',
    taskId: null,
    summary: { source: 'diary', text: 'did the thing' },
    turns: [],
    repository: { worktreePath: '/repo', branch: 'main', head: 'abc123', status: [], diffStat: '' },
    references: [{ kind: 'reference', value: 'worktree /repo', label: 'worktree' }],
    ...over,
  };
}

describe('renderForkPackage', () => {
  it('renders fixed headings in order', () => {
    const { text } = renderForkPackage(baseInput());
    const headingOrder = ['FORK HAND-OVER', 'FROM ', 'NOTES', 'SUMMARY (', 'RECENT TURNS', 'REPOSITORY', 'REFERENCES', 'WHAT TO DO'];
    let cursor = -1;
    for (const heading of headingOrder) {
      const idx = text.indexOf(heading);
      expect(idx, `expected to find "${heading}" after position ${cursor}`).toBeGreaterThan(cursor);
      cursor = idx;
    }
  });

  it('renders the label and from/target line', () => {
    const { text } = renderForkPackage(baseInput());
    expect(text).toContain('FORK HAND-OVER add retries');
    expect(text).toContain('FROM claude-1@repo (claude) → claude-2@repo');
  });

  it('renders NOTES as (none) when empty', () => {
    const { text } = renderForkPackage(baseInput({ notes: '' }));
    expect(text).toMatch(/NOTES\n\(none\)/);
  });

  it('renders NOTES verbatim when present', () => {
    const { text } = renderForkPackage(baseInput({ notes: 'watch the flaky test' }));
    expect(text).toMatch(/NOTES\nwatch the flaky test/);
  });

  it('labels SUMMARY with its source', () => {
    const { text: agentText } = renderForkPackage(baseInput({ summary: { source: 'agent', text: 'x' } }));
    expect(agentText).toContain('SUMMARY (agent)');
    const { text: noneText } = renderForkPackage(baseInput({ summary: { source: 'none', text: '' } }));
    expect(noneText).toContain('SUMMARY (none)');
    expect(noneText).toMatch(/SUMMARY \(none\)\n\(none\)/);
  });

  it('renders turns oldest first with a `── <iso>` marker, prompt and reply', () => {
    const t0 = Date.UTC(2026, 8, 6, 12, 0, 0);
    const t1 = Date.UTC(2026, 8, 6, 12, 5, 0);
    const { text } = renderForkPackage(baseInput({
      turns: [
        { endedAt: t0, prompt: 'first prompt', reply: 'first reply' },
        { endedAt: t1, prompt: 'second prompt', reply: 'second reply' },
      ],
    }));
    const firstIso = new Date(t0).toISOString();
    const secondIso = new Date(t1).toISOString();
    expect(text.indexOf(`── ${firstIso}`)).toBeGreaterThan(-1);
    expect(text.indexOf(`── ${firstIso}`)).toBeLessThan(text.indexOf(`── ${secondIso}`));
    expect(text).toContain('> first prompt');
    expect(text).toContain('first reply');
  });

  it('keeps the NEWEST FORK_TURNS turns when handed more than the cap', () => {
    const turns = Array.from({ length: FORK_TURNS + 1 }, (_, i) => ({
      endedAt: Date.UTC(2026, 8, 6, 12, i, 0),
      prompt: `prompt ${i}`,
      reply: `reply ${i}`,
    }));
    const { text } = renderForkPackage(baseInput({ turns }));
    // The oldest turn is the one that goes: a hand-over is about the latest work.
    expect(text).not.toContain('> prompt 0');
    for (let i = 1; i <= FORK_TURNS; i += 1) expect(text).toContain(`> prompt ${i}`);
  });

  it('renders REPOSITORY with (clean) status and (no diff) when empty', () => {
    const { text } = renderForkPackage(baseInput({
      repository: { worktreePath: '/repo/a', branch: 'main', head: 'deadbeef', status: [], diffStat: '' },
    }));
    expect(text).toContain('/repo/a');
    expect(text).toContain('branch main');
    expect(text).toContain('head deadbeef');
    expect(text).toMatch(/\(clean\)/);
    expect(text).toMatch(/\(no diff\)/);
  });

  it('renders REPOSITORY status lines and diff stat when present', () => {
    const { text } = renderForkPackage(baseInput({
      repository: { worktreePath: '/repo/a', branch: 'main', head: 'deadbeef', status: [' M file.ts'], diffStat: '1 file changed' },
    }));
    expect(text).toContain(' M file.ts');
    expect(text).toContain('1 file changed');
    expect(text).not.toContain('(clean)');
    expect(text).not.toContain('(no diff)');
  });

  it('renders REFERENCES lines as `<label>: <value>`', () => {
    const { text } = renderForkPackage(baseInput({
      references: [
        { kind: 'file', value: '/tmp/transcript.jsonl', label: 'source transcript' },
        { kind: 'reference', value: 'intercom_diary agent=claude-1@repo', label: 'turn diary' },
      ],
    }));
    expect(text).toContain('source transcript: /tmp/transcript.jsonl');
    expect(text).toContain('turn diary: intercom_diary agent=claude-1@repo');
  });

  it('WHAT TO DO omits task_claim when taskId is null, and always carries the reply hint', () => {
    const { text } = renderForkPackage(baseInput({ taskId: null }));
    expect(text).not.toContain('task_claim');
    expect(text).toContain('replyTo=<this message id>');
  });

  it('WHAT TO DO mentions task_claim <id> when taskId is set', () => {
    const { text } = renderForkPackage(baseInput({ taskId: '01J8ZK3ABCDEFGHJKMNPQRSTVW' }));
    expect(text).toContain('task_claim');
    expect(text).toContain('01J8ZK3ABCDEFGHJKMNPQRSTVW');
    expect(text).toContain('replyTo=<this message id>');
  });

  it('trims oldest turns before truncating the summary, keeping references intact and bytes under the cap', () => {
    const bigReply = 'r'.repeat(4 * 1024);
    const bigPrompt = 'p'.repeat(1024);
    const turns = Array.from({ length: 6 }, (_, i) => ({
      endedAt: Date.UTC(2026, 8, 6, 12, i, 0),
      prompt: bigPrompt,
      reply: bigReply,
    }));
    const bigSummary = 's'.repeat(4 * 1024);
    const references = [{ kind: 'reference' as const, value: 'worktree /repo', label: 'worktree' }];
    const { text, bytes: size, trimmed } = renderForkPackage(baseInput({
      turns,
      summary: { source: 'diary', text: bigSummary },
      references,
    }));
    expect(size).toBeLessThanOrEqual(FORK_PACKAGE_MAX);
    expect(bytes(text)).toBe(size);
    expect(trimmed.turnsDropped).toBeGreaterThan(0);
    expect(text).toContain('worktree /repo');
  });

  it('truncates a summary alone bigger than the cap, marking it with …[truncated]', () => {
    const hugeSummary = 's'.repeat(FORK_PACKAGE_MAX * 2);
    const { text, bytes: size, trimmed } = renderForkPackage(baseInput({
      summary: { source: 'diary', text: hugeSummary },
      turns: [],
    }));
    expect(size).toBeLessThanOrEqual(FORK_PACKAGE_MAX);
    expect(trimmed.summaryTruncated).toBe(true);
    expect(trimmed.turnsDropped).toBe(0);
    expect(text).toContain('…[truncated]');
    expect(text).toContain('worktree /repo');
  });

  it('drops turns before truncating the summary (turnsDropped precedes summaryTruncated)', () => {
    const bigReply = 'r'.repeat(4 * 1024);
    const turns = Array.from({ length: 6 }, (_, i) => ({
      endedAt: Date.UTC(2026, 8, 6, 12, i, 0),
      prompt: 'p',
      reply: bigReply,
    }));
    const hugeSummary = 's'.repeat(FORK_PACKAGE_MAX * 2);
    const { trimmed } = renderForkPackage(baseInput({ turns, summary: { source: 'diary', text: hugeSummary } }));
    expect(trimmed.turnsDropped).toBeGreaterThan(0);
    expect(trimmed.summaryTruncated).toBe(true);
  });
});

describe('renderDiarySummary', () => {
  it('renders oldest first as `[<iso>] > <prompt> → <reply>`', () => {
    const t0 = Date.UTC(2026, 8, 6, 12, 0, 0);
    const t1 = Date.UTC(2026, 8, 6, 12, 5, 0);
    const out = renderDiarySummary([
      { endedAt: t1, prompt: 'second', reply: 'second reply' },
      { endedAt: t0, prompt: 'first', reply: 'first reply' },
    ]);
    const iso0 = new Date(t0).toISOString();
    const iso1 = new Date(t1).toISOString();
    expect(out.indexOf(`[${iso0}]`)).toBeGreaterThan(-1);
    expect(out.indexOf(`[${iso0}]`)).toBeLessThan(out.indexOf(`[${iso1}]`));
    expect(out).toContain('[' + iso0 + '] > first → first reply');
  });

  it('truncates prompt to 300 chars and reply to 600 chars', () => {
    const prompt = 'p'.repeat(500);
    const reply = 'r'.repeat(900);
    const out = renderDiarySummary([{ endedAt: Date.now(), prompt, reply }]);
    const line = out.split('\n')[0]!;
    const promptPart = line.split('> ')[1]!.split(' → ')[0]!;
    const replyPart = line.split(' → ')[1]!;
    expect(promptPart.length).toBeLessThanOrEqual(300);
    expect(replyPart.length).toBeLessThanOrEqual(600);
  });

  it('returns empty string for no turns', () => {
    expect(renderDiarySummary([])).toBe('');
  });
});
