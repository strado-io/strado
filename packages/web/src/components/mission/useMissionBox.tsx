import { useEffect, useState, type ReactNode } from 'react';
import type { StationDto } from '../../api';
import type { CardKey } from './AgentCard';
import { AgentLine } from './AgentLine';
import { ApprovalPanel } from './ApprovalPanel';
import { cardAgent, decideApproval, pendingApprovals } from './mission';

export type MissionBoxDeps = {
  wsId: string;
  /** In scope (the strip's), so the approvals shown match the pills. */
  stations: StationDto[];
  selectedAgentId: string | null;
  onSelect: (agentId: string | null) => void;
  openAgent: (agentId: string) => void;
  message: (agentId: string, text: string) => Promise<unknown>;
  interrupt: (agentId: string) => Promise<unknown>;
  recap?: (agentIds: string[]) => Promise<{ text: string }>;
  answerApproval: (wsId: string, id: string, decision: 'allow' | 'deny') => Promise<unknown>;
  /** The escalation route's dismiss: a stale call cleared by a human click. */
  dismissCall: (wsId: string, callId: string) => Promise<unknown>;
  /** The escalation route's resolve: typing to an agent with an open call answers it (the call clears). */
  answerCall: (wsId: string, callId: string, text: string) => Promise<unknown>;
  /** A selected shell: run a line in it (the box's shell.run step), its confirm reason, and Ctrl-C. */
  shell: {
    /** Why this line needs a second ↵ (a destructive command), else null. */
    risk: (agentId: string, command: string) => string | null;
    run: (agentId: string, command: string) => Promise<unknown>;
    interrupt: (agentId: string) => Promise<unknown>;
  };
};

/** Mission Control: the selected agent's line (in the strip's row), the
 * approvals waiting for you (above the strip, by MissionStack), and the keys
 * that act on the agent whose chip leads the box (↵ queue, ⌘↵ steer, ⌃C
 * interrupt, ⌘O open its tab). Selecting never opens a box. */
export function useMissionBox(d: MissionBoxDeps): { line: ReactNode; approvals: ReactNode; agentKey?: (key: CardKey, text: string) => boolean } {
  // One piece of news on the line ("queued: …", an error, a recap), until the selection changes.
  const [note, setNote] = useState<string | null>(null);
  // A destructive line waiting for its second ↵ (the same text).
  const [confirming, setConfirming] = useState<string | null>(null);
  useEffect(() => { setNote(null); setConfirming(null); }, [d.selectedAgentId]);

  const selected = d.selectedAgentId ? d.stations.find((s) => s.agentId === d.selectedAgentId) ?? null : null;
  const approvals = pendingApprovals(d.stations);

  const act = (what: string, run: () => Promise<string | null>) => {
    void run().then((n) => { if (n !== null) setNote(n); }, (err) => setNote(`Couldn't ${what}: ${err instanceof Error ? err.message : String(err)}`));
  };
  const agentKey = selected ? (key: CardKey, text: string): boolean => {
    const id = selected.agentId;
    const t = text.trim();
    if (selected.mode === 'shell') {
      if (key === 'send') {
        if (!t) return false;
        const why = confirming === t ? null : d.shell.risk(id, t);
        if (why) { setConfirming(t); setNote(`${t} ${why} — ↵ again to run it`); return false; }
        setConfirming(null);
        act('run', async () => { await d.shell.run(id, t); return `ran: ${t}`; });
        return true;
      }
      if (key === 'interrupt') { act('interrupt', async () => { await d.shell.interrupt(id); return 'sent Ctrl-C'; }); return true; }
      if (key === 'open') { d.openAgent(id); return true; }
      return false;
    }
    // An open call is a question waiting on you: ↵ or ⌘↵ answers it, nothing to interrupt.
    const call = selected.calls[0];
    if (call && (key === 'send' || key === 'steer')) {
      if (!t) return false;
      act('reply', async () => { await d.answerCall(d.wsId, call.id, t); return `replied: ${t}`; });
      return true;
    }
    switch (key) {
      case 'send':
        if (!t) return false;
        act('send', async () => {
          const r = await d.message(id, t) as { delivered?: string } | null;
          return r?.delivered === 'queued' ? `queued: ${t}` : `sent: ${t}`;
        });
        return true;
      case 'steer':
        if (!t) return false;
        act('steer', async () => { await d.interrupt(id); await d.message(id, t); return `sent now: ${t}`; });
        return true;
      case 'interrupt':
        act('interrupt', async () => { await d.interrupt(id); return 'interrupted'; });
        return true;
      case 'open':
        d.openAgent(id);
        return true;
    }
  } : undefined;

  const line = selected ? (
      <AgentLine
        agent={cardAgent(selected)}
        note={note}
        onInterrupt={() => agentKey?.('interrupt', '')}
        onOpen={d.openAgent}
        onRecap={(id) => { if (d.recap) act('recap', async () => (await d.recap!([id])).text.trim() || 'Nothing to report.'); }}
        onDismissCalls={(_id, callIds) => act('dismiss', async () => { for (const c of callIds) await d.dismissCall(d.wsId, c); return 'call dismissed'; })}
      />
  ) : null;
  const panel = approvals.length > 0
    ? <ApprovalPanel approvals={approvals} onOpen={d.openAgent} onDecide={(id, decision) => decideApproval(d.answerApproval, d.wsId, id, decision)} />
    : null;
  return { line, approvals: panel, agentKey };
}
