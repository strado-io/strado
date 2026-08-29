import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { exec } from '../shell.js';
import { defaultShell } from './platform.js';
import type { AgentSessionReference } from './agentSessionRegistry.js';
import type { AgentMode, HandoffConversationMessage, HandoffContextSource } from './handoffStore.js';

type JsonRecord = Record<string, unknown>;

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

export function parseClaudeConversation(raw: string): HandoffConversationMessage[] {
  const messages = parseJsonLines(raw).flatMap((entry): HandoffConversationMessage[] => {
    if (entry.type !== 'user' && entry.type !== 'assistant') return [];
    const message = isRecord(entry.message) ? entry.message : null;
    if (!message) return [];
    const role = message.role;
    if (role !== 'user' && role !== 'assistant') return [];
    const content = textContent(message.content);
    if (role === 'user' && isInjectedUserContext(content)) return [];
    return content ? [{ role, content }] : [];
  });
  return compact(messages);
}

export function parseCodexConversation(raw: string): HandoffConversationMessage[] {
  const messages = parseJsonLines(raw).flatMap((entry): HandoffConversationMessage[] => {
    if (entry.type !== 'response_item' || !isRecord(entry.payload) || entry.payload.type !== 'message') return [];
    const role = entry.payload.role;
    if (role !== 'user' && role !== 'assistant') return [];
    const content = textContent(entry.payload.content);
    if (role === 'user' && isInjectedUserContext(content)) return [];
    return content ? [{ role, content }] : [];
  });
  return compact(messages);
}

export function parseOpenCodeConversation(raw: string): HandoffConversationMessage[] {
  let exported: unknown;
  try {
    exported = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isRecord(exported) || !Array.isArray(exported.messages)) return [];
  const messages = exported.messages.flatMap((entry): HandoffConversationMessage[] => {
    if (!isRecord(entry)) return [];
    const info = isRecord(entry.info) ? entry.info : entry;
    const role = info.role;
    if (role !== 'user' && role !== 'assistant') return [];
    const content = textContent(entry.parts);
    if (role === 'user' && isInjectedUserContext(content)) return [];
    return content ? [{ role, content }] : [];
  });
  return compact(messages);
}

export function parsePiConversation(raw: string): HandoffConversationMessage[] {
  const messages = parseJsonLines(raw).flatMap((entry): HandoffConversationMessage[] => {
    if (entry.type !== 'message' || !isRecord(entry.message)) return [];
    const role = entry.message.role;
    // Pi writes tool results as their own `toolResult` role, so dropping
    // everything but user/assistant leaves the semantic conversation.
    if (role !== 'user' && role !== 'assistant') return [];
    const content = textContent(entry.message.content);
    if (role === 'user' && isInjectedUserContext(content)) return [];
    return content ? [{ role, content }] : [];
  });
  return compact(messages);
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

async function claudeConversation(
  cwd: string,
  reference: AgentSessionReference | null,
  homeDir: string,
): Promise<AgentConversation> {
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
  const messages = transcript ? parseClaudeConversation(transcript) : [];
  return { messages, source: messages.length ? 'claude-history' : 'none' };
}

async function codexConversation(
  cwd: string,
  reference: AgentSessionReference | null,
  homeDir: string,
): Promise<AgentConversation> {
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
  const raw = candidates[0] ? await safeRead(candidates[0], root) : null;
  const messages = raw ? parseCodexConversation(raw) : [];
  return { messages, source: messages.length ? 'codex-history' : 'none' };
}

async function opencodeConversation(
  cwd: string,
  reference: AgentSessionReference | null,
  runOpenCode: (args: string[], cwd: string) => Promise<string>,
): Promise<AgentConversation> {
  let providerSessionId = reference?.providerSessionId;
  try {
    if (!providerSessionId) {
      const listing = JSON.parse(await runOpenCode(['session', 'list', '--format', 'json', '-n', '100'], cwd));
      if (Array.isArray(listing)) {
        const match = listing.find((entry) => isRecord(entry) && path.resolve(String(entry.directory ?? '')) === path.resolve(cwd));
        if (isRecord(match) && typeof match.id === 'string') providerSessionId = match.id;
      }
    }
    if (!providerSessionId) return { messages: [], source: 'none' };
    const messages = parseOpenCodeConversation(await runOpenCode(['export', providerSessionId], cwd));
    return { messages, source: messages.length ? 'opencode-history' : 'none' };
  } catch {
    return { messages: [], source: 'none' };
  }
}

async function piConversation(
  cwd: string,
  reference: AgentSessionReference | null,
  homeDir: string,
): Promise<AgentConversation> {
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
  const messages = raw ? parsePiConversation(raw) : [];
  return { messages, source: messages.length ? 'pi-history' : 'none' };
}

export async function collectAgentConversation(
  mode: AgentMode,
  cwd: string,
  reference: AgentSessionReference | null,
  options: AgentConversationOptions = {},
): Promise<AgentConversation> {
  const homeDir = options.homeDir ?? os.homedir();
  const runOpenCode = options.runOpenCode ?? (async (args, worktree) =>
    // Match terminal/tool detection behavior: GUI-launched desktop builds do
    // not necessarily inherit Homebrew/npm PATH, so resolve opencode through
    // the user's login shell. Arguments stay positional, never interpolated.
    (await exec(defaultShell(), ['-l', '-c', 'exec opencode "$@"', 'opencode', ...args], {
      cwd: worktree,
      timeoutMs: 5_000,
    })).stdout);
  if (mode === 'claude') return claudeConversation(cwd, reference, homeDir);
  if (mode === 'codex') return codexConversation(cwd, reference, homeDir);
  if (mode === 'pi') return piConversation(cwd, reference, homeDir);
  return opencodeConversation(cwd, reference, runOpenCode);
}
