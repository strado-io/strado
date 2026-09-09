import { HOOK_CONTEXT_BUDGET } from './intercomSchema.js';
import type { MessageWithAlias } from './intercomStore.js';

// What a Claude tab sees when the hook injects its inbox. Pure text rendering:
// no I/O, no token input, so nothing secret can reach the model's context.
export const HOOK_BODY_EXCERPT_MAX = 8 * 1024;
export const HOOK_CONTEXT_ITEMS_SHOWN = 8;
export const HOOK_CONTEXT_VALUE_MAX = 256;

export type Transport = 'port' | 'socket';

const OPEN = '<strado-intercom>';
const CLOSE = '</strado-intercom>';
const bytes = (s: string): number => Buffer.byteLength(s, 'utf8');

/** Cut to at most `maxBytes` UTF-8 bytes without splitting a character. */
export function cutUtf8(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= maxBytes) return s;
  let end = maxBytes;
  // Step back while the first excluded byte is a continuation byte (10xxxxxx):
  // the cut would otherwise land inside a multi-byte sequence.
  while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf8');
}

function stamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function renderMessage(m: MessageWithAlias, index: number): string {
  const head = [
    `[${index}] from ${m.from.agentId}${m.from.alias ? ` (${m.from.alias})` : ''}`,
    m.kind,
    stamp(m.createdAt),
  ];
  if (m.kind === 'request') head.push(`id ${m.id}`);
  const line = head.join(' · ') + (m.redelivery ? ' (redelivered)' : '');
  const total = bytes(m.body);
  const body = total > HOOK_BODY_EXCERPT_MAX
    ? `${cutUtf8(m.body, HOOK_BODY_EXCERPT_MAX)} [truncated, ${total} bytes total]`
    : m.body;
  const items = m.context.slice(0, HOOK_CONTEXT_ITEMS_SHOWN).map((c) => {
    const value = bytes(c.value) > HOOK_CONTEXT_VALUE_MAX ? `${cutUtf8(c.value, HOOK_CONTEXT_VALUE_MAX)}…` : c.value;
    return `  context: ${c.kind} ${value}${c.label ? ` (${c.label})` : ''}`;
  });
  const more = m.context.length - HOOK_CONTEXT_ITEMS_SHOWN;
  if (more > 0) items.push(`  … ${more} more context items`);
  return [line, body, ...items].join('\n');
}

export function renderHint(messages: MessageWithAlias[], transport: Transport): string {
  const lastRequest = [...messages].reverse().find((x) => x.kind === 'request');
  const last = messages[messages.length - 1];
  const payload = lastRequest
    ? `{"to":"${lastRequest.from.agentId}","kind":"reply","replyTo":"${lastRequest.id}","body":"..."}`
    : `{"to":"${last?.from.agentId ?? '<agentId>'}","body":"..."}`;
  const curl = transport === 'socket'
    ? 'curl -s --unix-socket $STRADO_SERVER_SOCKET -X POST http://localhost/api/intercom/messages'
    : 'curl -s -X POST http://127.0.0.1:$STRADO_STATUS_PORT/api/intercom/messages';
  const tail = lastRequest
    ? 'For a plain message drop "kind" and "replyTo". Never paste the token into a message.'
    : 'To answer a request add "kind":"reply" and "replyTo":"<its id>". Never paste the token into a message.';
  return [
    `To reply: ${curl} \\`,
    `  -H "Authorization: Bearer $STRADO_AGENT_TOKEN" -H 'content-type: application/json' \\`,
    `  -d '${payload}'`,
    tail,
  ].join('\n');
}

function header(n: number): string {
  return `${n} new message${n === 1 ? '' : 's'} from agents in this workspace. Read them before acting on the prompt, and mention them in your reply so the person at this tab sees they arrived.`;
}

/** Render the given messages in full. The caller has already chosen what fits. */
export function formatInboxContext(messages: MessageWithAlias[], opts: { transport: Transport }): string | null {
  if (messages.length === 0) return null;
  const rendered = messages.flatMap((x, i) => [renderMessage(x, i + 1), '']);
  return [OPEN, header(messages.length), '', ...rendered, renderHint(messages, opts.transport), CLOSE].join('\n');
}

/** The longest prefix of `candidates` whose full render fits the budget. A single message renders well under 32 KiB, so a non-empty input always yields at least one. */
export function selectUnderBudget(
  candidates: MessageWithAlias[],
  opts: { transport: Transport; budget?: number },
): MessageWithAlias[] {
  const budget = opts.budget ?? HOOK_CONTEXT_BUDGET;
  let chosen: MessageWithAlias[] = [];
  for (let n = 1; n <= candidates.length; n++) {
    const prefix = candidates.slice(0, n);
    const text = formatInboxContext(prefix, { transport: opts.transport });
    if (text !== null && bytes(text) > budget) break;
    chosen = prefix;
  }
  return chosen;
}
