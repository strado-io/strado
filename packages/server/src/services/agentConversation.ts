import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { exec } from '../shell.js';
import { defaultShell } from './platform.js';
import type { AgentSessionReference } from './agentSessionRegistry.js';
import type { AgentMode, HandoffConversationMessage, HandoffContextSource } from './handoffStore.js';

type JsonRecord = Record<string, unknown>;

/** One text-bearing message with what the diary needs and the handoff never did.
 * `meta` marks entries the transcript itself flags as not part of the visible
 * conversation (Claude: isMeta, isSidechain, tool results). The handoff
 * wrappers below keep them, exactly as before; the turn diary drops them. */
export type ConversationMessage = {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number | null;
  meta: boolean;
};

export type AgentConversation = {
  messages: HandoffConversationMessage[];
  source: HandoffContextSource;
};

export type AgentConversationOptions = {
  homeDir?: string;
  runOpenCode?: (args: string[], cwd: string) => Promise<string>;
};

const MAX_MESSAGES = 20;
const MAX_CHARS = 24_000;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function textContent(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (!Array.isArray(value)) return '';
  return value
    .filter(isRecord)
    .filter((part) => ['text', 'input_text', 'output_text'].includes(String(part.type ?? '')))
    .map((part) => typeof part.text === 'string' ? part.text.trim() : '')
    .filter(Boolean)
    .join('\n')
    .trim();
}

function isInjectedUserContext(content: string): boolean {
  const trimmed = content.trim();
  return trimmed.startsWith('<environment_context>') && trimmed.endsWith('</environment_context>');
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const t = Date.parse(value);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

const toHandoff = (messages: ConversationMessage[]): HandoffConversationMessage[] =>
  messages.map(({ role, content }) => ({ role, content }));

function compact(messages: HandoffConversationMessage[]): HandoffConversationMessage[] {
  const useful = messages
    .map((message) => ({ ...message, content: message.content.trim() }))
    .filter((message) => message.content.length > 0)
    .slice(-MAX_MESSAGES);
  let remaining = MAX_CHARS;
  const kept: HandoffConversationMessage[] = [];
  for (let i = useful.length - 1; i >= 0 && remaining > 0; i -= 1) {
    const message = useful[i]!;
    const content = message.content.length > remaining
      ? `[earlier content truncated]\n${message.content.slice(message.content.length - remaining)}`
      : message.content;
    kept.unshift({ ...message, content });
    remaining -= content.length;
  }
  return kept;
}

function parseJsonLines(raw: string): JsonRecord[] {
  return raw.split('\n').flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const parsed = JSON.parse(line);
      return isRecord(parsed) ? [parsed] : [];
    } catch {
      return [];
    }
  });
}

export function parseClaudeMessages(raw: string): ConversationMessage[] {
  return parseJsonLines(raw).flatMap((entry): ConversationMessage[] => {
    if (entry.type !== 'user' && entry.type !== 'assistant') return [];
    const message = isRecord(entry.message) ? entry.message : null;
    if (!message) return [];
    const role = message.role;
    if (role !== 'user' && role !== 'assistant') return [];
    const content = textContent(message.content);
    if (role === 'user' && isInjectedUserContext(content)) return [];
    if (!content) return [];
    const meta = entry.isMeta === true || entry.isSidechain === true || 'toolUseResult' in entry;
    return [{ role, content, timestamp: parseTimestamp(entry.timestamp), meta }];
  });
}

export function parseClaudeConversation(raw: string): HandoffConversationMessage[] {
  return compact(toHandoff(parseClaudeMessages(raw)));
}

export function parseCodexMessages(raw: string): ConversationMessage[] {
  return parseJsonLines(raw).flatMap((entry): ConversationMessage[] => {
    if (entry.type !== 'response_item' || !isRecord(entry.payload) || entry.payload.type !== 'message') return [];
    const role = entry.payload.role;
    if (role !== 'user' && role !== 'assistant') return [];
    const content = textContent(entry.payload.content);
    if (role === 'user' && isInjectedUserContext(content)) return [];
    return content ? [{ role, content, timestamp: parseTimestamp(entry.timestamp), meta: false }] : [];
  });
}

export function parseCodexConversation(raw: string): HandoffConversationMessage[] {
  return compact(toHandoff(parseCodexMessages(raw)));
}

export function parseOpenCodeMessages(raw: string): ConversationMessage[] {
  let exported: unknown;
  try {
    exported = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isRecord(exported) || !Array.isArray(exported.messages)) return [];
  return exported.messages.flatMap((entry): ConversationMessage[] => {
    if (!isRecord(entry)) return [];
    const info = isRecord(entry.info) ? entry.info : entry;
    const role = info.role;
    if (role !== 'user' && role !== 'assistant') return [];
    const content = textContent(entry.parts);
    if (role === 'user' && isInjectedUserContext(content)) return [];
    const timestamp = parseTimestamp(isRecord(info.time) ? info.time.created : undefined);
    return content ? [{ role, content, timestamp, meta: false }] : [];
  });
}

export function parseOpenCodeConversation(raw: string): HandoffConversationMessage[] {
  return compact(toHandoff(parseOpenCodeMessages(raw)));
}

export function parsePiMessages(raw: string): ConversationMessage[] {
  return parseJsonLines(raw).flatMap((entry): ConversationMessage[] => {
    if (entry.type !== 'message' || !isRecord(entry.message)) return [];
    const role = entry.message.role;
    // Pi writes tool results as their own `toolResult` role, so dropping
    // everything but user/assistant leaves the semantic conversation.
    if (role !== 'user' && role !== 'assistant') return [];
    const content = textContent(entry.message.content);
    if (role === 'user' && isInjectedUserContext(content)) return [];
    return content ? [{ role, content, timestamp: parseTimestamp(entry.timestamp), meta: false }] : [];
  });
}

export function parsePiConversation(raw: string): HandoffConversationMessage[] {
  return compact(toHandoff(parsePiMessages(raw)));
}

async function safeRead(filePath: string, root: string): Promise<string | null> {
  const resolved = path.resolve(filePath);
  const relative = path.relative(path.resolve(root), resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  try {
    return await fsp.readFile(resolved, 'utf8');
  } catch {
    return null;
  }
}

async function filesUnder(root: string, accept: (fileName: string) => boolean): Promise<string[]> {
  const files: string[] = [];
  async function visit(dir: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(entries.map(async (entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile() && accept(entry.name)) files.push(full);
    }));
  }
  await visit(root);
  return files;
}

async function newest(files: string[]): Promise<string[]> {
  const stamped = await Promise.all(files.map(async (file) => {
    try {
      return { file, mtime: (await fsp.stat(file)).mtimeMs };
    } catch {
      return { file, mtime: 0 };
    }
  }));
  return stamped.sort((a, b) => b.mtime - a.mtime).map(({ file }) => file);
}

async function loadClaudeTranscript(cwd: string, reference: AgentSessionReference | null, homeDir: string): Promise<string | null> {
  const root = path.join(homeDir, '.claude', 'projects');
  const projectDir = path.join(root, cwd.replace(/[^A-Za-z0-9]/g, '-'));
  let transcript: string | null = null;
  if (reference?.transcriptPath) transcript = await safeRead(reference.transcriptPath, root);
  if (!transcript && reference?.providerSessionId) {
    transcript = await safeRead(path.join(projectDir, `${reference.providerSessionId}.jsonl`), root);
  }
  if (!transcript) {
    const candidates = await newest(await filesUnder(projectDir, (name) => name.endsWith('.jsonl')));
    if (candidates[0]) transcript = await safeRead(candidates[0], root);
  }
  return transcript;
}

async function loadCodexTranscript(cwd: string, reference: AgentSessionReference | null, homeDir: string): Promise<string | null> {
  const root = path.join(homeDir, '.codex', 'sessions');
  const files = await filesUnder(root, (name) => name.endsWith('.jsonl'));
  let candidates = reference?.providerSessionId
    ? files.filter((file) => path.basename(file).includes(reference.providerSessionId))
    : [];
  if (!candidates.length) {
    const recent = (await newest(files)).slice(0, 50);
    candidates = [];
    for (const file of recent) {
      const raw = await safeRead(file, root);
      const meta = raw && parseJsonLines(raw).find((entry) => entry.type === 'session_meta');
      if (meta && isRecord(meta.payload) && path.resolve(String(meta.payload.cwd ?? '')) === path.resolve(cwd)) {
        candidates = [file];
        break;
      }
    }
  }
  return candidates[0] ? safeRead(candidates[0], root) : null;
}

async function loadOpenCodeTranscript(
  cwd: string,
  reference: AgentSessionReference | null,
  runOpenCode: (args: string[], cwd: string) => Promise<string>,
): Promise<string | null> {
  let providerSessionId = reference?.providerSessionId;
  try {
    if (!providerSessionId) {
      const listing = JSON.parse(await runOpenCode(['session', 'list', '--format', 'json', '-n', '100'], cwd));
      if (Array.isArray(listing)) {
        const match = listing.find((entry) => isRecord(entry) && path.resolve(String(entry.directory ?? '')) === path.resolve(cwd));
        if (isRecord(match) && typeof match.id === 'string') providerSessionId = match.id;
      }
    }
    if (!providerSessionId) return null;
    return await runOpenCode(['export', providerSessionId], cwd);
  } catch {
    return null;
  }
}

async function loadPiTranscript(cwd: string, reference: AgentSessionReference | null, homeDir: string): Promise<string | null> {
  const root = path.join(homeDir, '.pi', 'agent', 'sessions');
  let raw = reference?.transcriptPath ? await safeRead(reference.transcriptPath, root) : null;
  if (!raw) {
    const files = await filesUnder(root, (name) => name.endsWith('.jsonl'));
    if (reference?.providerSessionId) {
      const id = reference.providerSessionId;
      const match = files.find((file) => path.basename(file).includes(id));
      if (match) raw = await safeRead(match, root);
    }
    // Pi groups sessions into a directory named after the working directory,
    // but the `session` header carries the authoritative cwd — match on that
    // rather than reproducing pi's slug, the same way Codex is resolved.
    for (const file of raw ? [] : (await newest(files)).slice(0, 50)) {
      const candidate = await safeRead(file, root);
      const header = candidate && parseJsonLines(candidate).find((entry) => entry.type === 'session');
      if (header && path.resolve(String(header.cwd ?? '')) === path.resolve(cwd)) {
        raw = candidate;
        break;
      }
    }
  }
  return raw;
}

const defaultRunOpenCode = (): NonNullable<AgentConversationOptions['runOpenCode']> => async (args, worktree) =>
  // Match terminal/tool detection behavior: GUI-launched desktop builds do
  // not necessarily inherit Homebrew/npm PATH, so resolve opencode through
  // the user's login shell. Arguments stay positional, never interpolated.
  (await exec(defaultShell(), ['-l', '-c', 'exec opencode "$@"', 'opencode', ...args], {
    cwd: worktree,
    timeoutMs: 5_000,
  })).stdout;

/** The raw transcript text for a tab, located the way the handoff always has, or null. Never throws. */
export async function loadTranscript(
  mode: AgentMode,
  cwd: string,
  reference: AgentSessionReference | null,
  options: AgentConversationOptions = {},
): Promise<string | null> {
  const homeDir = options.homeDir ?? os.homedir();
  if (mode === 'claude') return loadClaudeTranscript(cwd, reference, homeDir);
  if (mode === 'codex') return loadCodexTranscript(cwd, reference, homeDir);
  if (mode === 'pi') return loadPiTranscript(cwd, reference, homeDir);
  return loadOpenCodeTranscript(cwd, reference, options.runOpenCode ?? defaultRunOpenCode());
}

const SOURCE: Record<AgentMode, HandoffContextSource> = {
  claude: 'claude-history', codex: 'codex-history', opencode: 'opencode-history', pi: 'pi-history',
};
const PARSE: Record<AgentMode, (raw: string) => HandoffConversationMessage[]> = {
  claude: parseClaudeConversation, codex: parseCodexConversation, opencode: parseOpenCodeConversation, pi: parsePiConversation,
};

export async function collectAgentConversation(
  mode: AgentMode,
  cwd: string,
  reference: AgentSessionReference | null,
  options: AgentConversationOptions = {},
): Promise<AgentConversation> {
  const raw = await loadTranscript(mode, cwd, reference, options);
  const messages = raw ? PARSE[mode](raw) : [];
  return { messages, source: messages.length ? SOURCE[mode] : 'none' };
}
