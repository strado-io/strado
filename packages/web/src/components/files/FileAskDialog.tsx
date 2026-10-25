import { useEffect, useRef, useState } from 'react';
import type { PeerDto } from '../../api';
import type { FileAskContext } from '../../types';
import type { IntercomContextItem } from '../../lib/jarvis/execute';

// "Ask an agent about these lines": pick a running agent (this worktree's
// first) and type the question. It goes over the intercom as an ask, with the
// file, its lines and the selected text as context, so the answer comes back
// to the command box like any other question.

/** The lines as intercom context: absolute path (an agent in another worktree
 * can open it), the worktree-relative one as the label, then the text. */
export function askContextItems(ctx: FileAskContext): IntercomContextItem[] {
  const lines = ctx.to > ctx.from ? `${ctx.from}-${ctx.to}` : `${ctx.from}`;
  const root = ctx.worktreePath.replace(/\/+$/, '');
  return [
    { kind: 'file', value: `${root}/${ctx.path}:${lines}`, label: `${ctx.path}:${lines}` },
    { kind: 'text', value: ctx.snippet, label: 'selected lines' },
  ];
}

const name = (p: PeerDto) => p.alias ?? p.agentId;

export function FileAskDialog({ ctx, peers, send, onClose }: {
  ctx: FileAskContext;
  peers: PeerDto[];
  send: (agentId: string, question: string, context: IntercomContextItem[]) => Promise<void>;
  onClose: () => void;
}) {
  const agents = peers
    .filter((p) => p.live && p.mode !== 'shell')
    .sort((a, b) => Number(b.worktreePath === ctx.worktreePath) - Number(a.worktreePath === ctx.worktreePath));
  const [agentId, setAgentId] = useState(agents[0]?.agentId ?? null);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { textRef.current?.focus(); }, []);

  const items = askContextItems(ctx);
  const canSend = !!agentId && !!question.trim() && !busy;
  const submit = async () => {
    if (!canSend) return;
    setBusy(true);
    setFailed(false);
    try {
      await send(agentId!, question.trim(), items);
      onClose();
    } catch {
      setFailed(true);
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/30 pt-[14vh]" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        role="dialog"
        aria-label="Ask an agent about these lines"
        onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } }}
        className="surface-pop flex w-[min(480px,calc(100vw-32px))] flex-col gap-3 rounded-xl p-4"
      >
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="text-[14px] font-medium text-zinc-100">Ask about these lines</h2>
          <span className="truncate font-mono text-[11px] text-zinc-500" title={items[0]!.value}>{items[0]!.label}</span>
        </div>
        <pre className="max-h-28 overflow-hidden whitespace-pre-wrap rounded-md bg-zinc-900 px-2 py-1.5 font-mono text-[11px] leading-4 text-zinc-400">{ctx.snippet.split('\n').slice(0, 6).join('\n')}</pre>
        {agents.length === 0 ? (
          <p className="text-[13px] text-zinc-400">No agent is running in this workspace. Start one, then ask again.</p>
        ) : (
          <>
            <div role="radiogroup" aria-label="Agent" className="flex flex-wrap gap-1.5">
              {agents.map((p) => (
                <label key={p.agentId} className={`flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-[12px] ${agentId === p.agentId ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-900'}`}>
                  <input type="radio" name="ask-agent" aria-label={name(p)} className="sr-only" checked={agentId === p.agentId} onChange={() => setAgentId(p.agentId)} />
                  {name(p)}
                  {p.worktreePath === ctx.worktreePath && <span className="text-[11px] text-zinc-500">this worktree</span>}
                </label>
              ))}
            </div>
            <textarea
              ref={textRef}
              aria-label="Question"
              rows={3}
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit(); } }}
              placeholder="What do you want to know? (⌘Enter to send)"
              className="resize-none rounded-md border border-zinc-800 px-2 py-1.5 text-[13px] text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-zinc-600"
            />
            {failed && <p role="alert" className="text-[12px] text-red-300">Couldn&apos;t send — is the agent still running?</p>}
          </>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1 text-[12px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100">Cancel</button>
          {agents.length > 0 && (
            <button type="button" disabled={!canSend} onClick={() => void submit()} className="rounded-md bg-zinc-800 px-3 py-1 text-[12px] text-zinc-100 hover:bg-zinc-700 disabled:opacity-40">Ask</button>
          )}
        </div>
      </div>
    </div>
  );
}
