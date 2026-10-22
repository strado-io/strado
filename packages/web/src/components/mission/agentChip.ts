// The box's destination, made visible: a leading @agent chip means "this text
// goes to that agent"; without one the box is a plain command box.
import type { Chip } from '../../lib/mention/chips';

export type AgentChip = { agentId: string; label: string };
const isAgent = (c: Chip): c is AgentChip & Chip => 'agentId' in c;

/** The agent whose chip starts the text (only whitespace before it), and the rest. */
export function leadingAgent(text: string, chips: Chip[]): (AgentChip & { rest: string }) | null {
  const t = text.trimStart();
  for (const c of chips) {
    if (!isAgent(c)) continue;
    const token = `@${c.label}`;
    if (!t.startsWith(token)) continue;
    const after = t.slice(token.length);
    if (after && !/^\s/.test(after)) continue;
    return { agentId: c.agentId, label: c.label, rest: after.trim() };
  }
  return null;
}

/** Puts `next`'s chip at the start (replacing any leading agent chip), or removes it (null). */
export function setLeadingAgent(text: string, chips: Chip[], next: AgentChip | null): { text: string; chips: Chip[] } {
  const lead = leadingAgent(text, chips);
  let body = text;
  let rest = chips;
  if (lead) {
    const t = text.trimStart();
    body = t.slice(lead.label.length + 1).replace(/^\s/, '');
    const i = chips.findIndex((c) => isAgent(c) && c.agentId === lead.agentId && c.label === lead.label);
    rest = chips.filter((_, j) => j !== i);
  }
  if (!next) return { text: body, chips: rest };
  return { text: `@${next.label} ${body}`, chips: [...rest, { label: next.label, agentId: next.agentId }] };
}
