import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM module without types
import { renderInbox } from '../../hooks/mcp/intercom.mjs';

type Msg = Record<string, unknown>;

const msg = (id: string, body: string): Msg => ({
  id,
  kind: 'message',
  body,
  createdAt: 1_700_000_000_000,
  from: { agentId: 'claude-1@repo', alias: null },
});

describe('renderInbox', () => {
  it('renders every message and acknowledges each one', async () => {
    const acked: string[] = [];
    const out: string = await renderInbox([msg('A', 'first'), msg('B', 'second')], async (id: string) => { acked.push(id); });
    expect(acked).toEqual(['A', 'B']);
    expect(out).toContain('── claude-1@repo · message · A · 2023-11-14T22:13:20.000Z\nfirst\n');
    expect(out).toContain('── claude-1@repo · message · B · 2023-11-14T22:13:20.000Z\nsecond\n');
    expect(out).not.toContain('[warning:');
  });

  it('keeps every message in the text when one ack fails, and warns once', async () => {
    const acked: string[] = [];
    const out: string = await renderInbox([msg('A', 'first'), msg('B', 'second'), msg('C', 'third')], async (id: string) => {
      if (id === 'B') throw new Error('boom');
      acked.push(id);
    });
    // The ack after the failure still runs: a failure must not abandon the rest.
    expect(acked).toEqual(['A', 'C']);
    expect(out).toContain('first');
    expect(out).toContain('second');
    expect(out).toContain('third');
    const warnings = out.split('\n').filter((l) => l.startsWith('[warning:'));
    expect(warnings).toEqual(['[warning: could not acknowledge B: boom]']);
  });

  it('never acknowledges and never warns when ack is null (keep=true)', async () => {
    const out: string = await renderInbox([msg('A', 'first')], null);
    expect(out).toContain('first');
    expect(out).not.toContain('[warning:');
  });

  it('renders an unknown sender and prefers an alias', async () => {
    const out: string = await renderInbox(
      [{ id: 'A', kind: 'request', body: 'x', createdAt: 0, from: { agentId: 'shell-1@repo', alias: 'buddy' } }, { id: 'B', kind: 'message', body: 'y', createdAt: 0 }],
      null,
    );
    expect(out).toContain('── buddy · request · A · ');
    expect(out).toContain('── unknown · message · B · ');
  });

  it('renders an ask request with a reply hint and a human resolution with its escalation id', async () => {
    const out = await renderInbox([
      { id: 'M1', kind: 'request', escalationId: 'E1', from: { agentId: 'claude-1@repo', alias: null }, body: 'which db?', createdAt: 0 },
      { id: 'M2', kind: 'message', escalationId: 'E2', from: { agentId: 'human', alias: null }, body: 'sqlite', createdAt: 0 },
      { id: 'M3', kind: 'message', escalationId: null, from: { agentId: 'claude-2@repo', alias: 'bob' }, body: 'plain', createdAt: 0 },
    ], null);
    expect(out).toContain('── claude-1@repo · ask · M1 · 1970-01-01T00:00:00.000Z\nwhich db?\n[reply with intercom_send kind=reply replyTo=M1]\n');
    expect(out).toContain('── human · resolution · M2 · 1970-01-01T00:00:00.000Z · re: escalation E2\nsqlite\n');
    expect(out).toContain('── bob · message · M3 · 1970-01-01T00:00:00.000Z\nplain\n');
  });

  it('renders a fork hand-over, a fork summary ask, and a fork acceptance notice from strado', async () => {
    const out = await renderInbox([
      { id: 'F1', kind: 'request', forkId: 'FRK1', from: { agentId: 'strado', alias: null }, body: 'FORK HAND-OVER fix the parser\nmore', createdAt: 0 },
      { id: 'F2', kind: 'request', forkId: 'FRK1', from: { agentId: 'strado', alias: null }, body: 'Strado is forking your work...', createdAt: 0 },
      { id: 'F3', kind: 'message', forkId: 'FRK1', from: { agentId: 'strado', alias: null }, body: 'fork FRK1 accepted by claude-2@repo', createdAt: 0 },
    ], null);
    expect(out).toContain(
      '── strado · fork · F1 · 1970-01-01T00:00:00.000Z\nFORK HAND-OVER fix the parser\nmore\n[reply with intercom_send to=strado kind=reply replyTo=F1 when you have taken over]\n',
    );
    // The summary ask carries its own reply instruction in the body, so no
    // hint is appended after it; the hand-over above still gets one.
    expect(out).toContain('── strado · fork-summary · F2 · 1970-01-01T00:00:00.000Z\nStrado is forking your work...\n');
    expect(out).not.toContain('replyTo=F2');
    expect(out).toContain('── strado · fork · F3 · 1970-01-01T00:00:00.000Z · accepted\nfork FRK1 accepted by claude-2@repo\n');
  });
});
