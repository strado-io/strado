import { FORK_NOTES_MAX, FORK_PACKAGE_MAX, FORK_TURNS, FORK_TURN_PROMPT_MAX, FORK_TURN_REPLY_MAX } from './intercomSchema.js';

// Step 9a: the bounded package a fork hands to its target — pure string
// building, no I/O. Every size limit it uses lives in intercomSchema.ts so the
// store, the routes and this renderer cannot drift apart.
export type ForkPackageInput = {
  label: string;
  sourceAgent: string;
  sourceMode: string;
  targetLabel: string;
  notes: string;
  taskId: string | null;
  summary: { source: 'agent' | 'diary' | 'none'; text: string };
  turns: Array<{ endedAt: number; prompt: string; reply: string }>; // oldest first, already <= FORK_TURNS
  repository: { worktreePath: string; branch: string | null; head: string; status: string[]; diffStat: string };
  references: Array<{ kind: 'file' | 'reference'; value: string; label?: string }>;
};

export type ForkPackageResult = {
  text: string;
  bytes: number;
  trimmed: { turnsDropped: number; summaryTruncated: boolean };
};

const TRUNC_MARKER = '…[truncated]';
const REPLY_HINT = 'Reply to this message with intercom_send kind=reply replyTo=<this message id> once you have taken over.';

const bytesOf = (s: string): number => Buffer.byteLength(s, 'utf8');

/** Cut to at most `maxBytes` UTF-8 bytes without splitting a character. */
function cutUtf8(s: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= maxBytes) return s;
  let end = maxBytes;
  while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf8');
}

function renderRepository(repository: ForkPackageInput['repository']): string {
  const lines = [
    repository.worktreePath,
    `branch ${repository.branch ?? '(detached)'}`,
    `head ${repository.head}`,
    repository.status.length > 0 ? repository.status.join('\n') : '(clean)',
    repository.diffStat.trim().length > 0 ? repository.diffStat : '(no diff)',
  ];
  return lines.join('\n');
}

function renderReferences(references: ForkPackageInput['references']): string {
  if (references.length === 0) return '(none)';
  return references.map((r) => `${r.label ?? r.kind}: ${r.value}`).join('\n');
}

function renderWhatToDo(taskId: string | null): string {
  const parts = ['Continue from the latest unfinished point.', 'Verify the summary against the diff before acting.'];
  if (taskId) parts.push(`Claim task ${taskId} with task_claim.`);
  return `${parts.join(' ')}\n${REPLY_HINT}`;
}

function renderTurns(turns: ForkPackageInput['turns']): string {
  if (turns.length === 0) return '(none)';
  return turns
    .map((t) => {
      const iso = new Date(t.endedAt).toISOString();
      const prompt = cutUtf8(t.prompt, FORK_TURN_PROMPT_MAX);
      const reply = cutUtf8(t.reply, FORK_TURN_REPLY_MAX);
      return `── ${iso}\n> ${prompt}\n ${reply}`;
    })
    .join('\n');
}

function build(input: ForkPackageInput, turns: ForkPackageInput['turns'], summaryText: string): string {
  const notes = cutUtf8(input.notes, FORK_NOTES_MAX);
  const sections = [
    `FORK HAND-OVER ${input.label}`,
    `FROM ${input.sourceAgent} (${input.sourceMode}) → ${input.targetLabel}`,
    ['NOTES', notes.trim().length > 0 ? notes : '(none)'].join('\n'),
    [`SUMMARY (${input.summary.source})`, summaryText.length > 0 ? summaryText : '(none)'].join('\n'),
    ['RECENT TURNS', renderTurns(turns)].join('\n'),
    ['REPOSITORY', renderRepository(input.repository)].join('\n'),
    ['REFERENCES', renderReferences(input.references)].join('\n'),
    ['WHAT TO DO', renderWhatToDo(input.taskId)].join('\n'),
  ];
  return sections.join('\n\n');
}

export function renderForkPackage(input: ForkPackageInput): ForkPackageResult {
  // Turns arrive oldest first, so the cap keeps the TAIL: a hand-over is about
  // where the work got to, and the trim loop below drops from the same end.
  let turns = input.turns.slice(-FORK_TURNS);
  let summaryText = input.summary.text;
  let turnsDropped = 0;
  let summaryTruncated = false;

  let text = build(input, turns, summaryText);

  // Trim order: drop oldest turns one at a time, then truncate the summary
  // tail. Notes, repository and references are never touched.
  while (bytesOf(text) > FORK_PACKAGE_MAX && turns.length > 0) {
    turns = turns.slice(1);
    turnsDropped += 1;
    text = build(input, turns, summaryText);
  }

  let previousLength = summaryText.length + 1; // ensures the first iteration always proceeds
  while (bytesOf(text) > FORK_PACKAGE_MAX && summaryText.length > 0 && summaryText.length < previousLength) {
    previousLength = summaryText.length;
    const overshoot = bytesOf(text) - FORK_PACKAGE_MAX;
    const targetBytes = Math.max(0, bytesOf(summaryText) - overshoot - bytesOf(TRUNC_MARKER));
    summaryText = cutUtf8(summaryText, targetBytes) + TRUNC_MARKER;
    summaryTruncated = true;
    text = build(input, turns, summaryText);
  }

  return { text, bytes: bytesOf(text), trimmed: { turnsDropped, summaryTruncated } };
}

/** Turn diary rendering for the fallback summary (spec §1.2): oldest first,
 * `[<iso>] > <prompt ≤ 300> → <reply ≤ 600>` per line. */
export function renderDiarySummary(turns: Array<{ endedAt: number; prompt: string; reply: string }>): string {
  return turns
    .slice()
    .sort((a, b) => a.endedAt - b.endedAt)
    .map((t) => {
      const iso = new Date(t.endedAt).toISOString();
      const prompt = t.prompt.slice(0, 300);
      const reply = t.reply.slice(0, 600);
      return `[${iso}] > ${prompt} → ${reply}`;
    })
    .join('\n');
}
