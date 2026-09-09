import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  loadTranscript,
  parseClaudeConversation,
  parseClaudeMessages,
  parseCodexConversation,
  parseCodexMessages,
  parseOpenCodeConversation,
  parseOpenCodeMessages,
  parsePiConversation,
  parsePiMessages,
} from './agentConversation';

describe('provider conversation extraction', () => {
  it('keeps only semantic Claude user/assistant text', () => {
    const raw = [
      { type: 'system', message: { role: 'system', content: 'hidden setup' } },
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Fix login' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [
        { type: 'thinking', thinking: 'private reasoning' },
        { type: 'tool_use', name: 'Read' },
        { type: 'text', text: 'The redirect is fixed.' },
      ] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'terminal output' }] } },
    ].map((entry) => JSON.stringify(entry)).join('\n');

    expect(parseClaudeConversation(raw)).toEqual([
      { role: 'user', content: 'Fix login' },
      { role: 'assistant', content: 'The redirect is fixed.' },
    ]);
  });

  it('filters Codex developer messages and tool events', () => {
    const raw = [
      { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'instructions' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>generated cwd</environment_context>' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Add tests' }] } },
      { type: 'response_item', payload: { type: 'function_call', name: 'exec_command' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Added two tests.' }] } },
    ].map((entry) => JSON.stringify(entry)).join('\n');

    expect(parseCodexConversation(raw)).toEqual([
      { role: 'user', content: 'Add tests' },
      { role: 'assistant', content: 'Added two tests.' },
    ]);
  });

  it('reads OpenCode export messages without reasoning and tool parts', () => {
    const raw = JSON.stringify({ messages: [
      { info: { role: 'user' }, parts: [{ type: 'text', text: 'Build handoff' }] },
      { info: { role: 'assistant' }, parts: [
        { type: 'reasoning', text: 'private reasoning' },
        { type: 'tool', state: { output: 'terminal bytes' } },
        { type: 'text', text: 'The API is ready.' },
      ] },
    ] });

    expect(parseOpenCodeConversation(raw)).toEqual([
      { role: 'user', content: 'Build handoff' },
      { role: 'assistant', content: 'The API is ready.' },
    ]);
  });

  it('reads Pi session entries without tool calls and session metadata', () => {
    const raw = [
      { type: 'session', version: 3, id: '01a049cc', cwd: '/repo' },
      { type: 'model_change', provider: 'openrouter', modelId: 'glm' },
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'Ship the migration' }] } },
      { type: 'message', message: { role: 'assistant', content: [
        { type: 'thinking', thinking: 'private reasoning' },
        { type: 'toolCall', name: 'bash' },
        { type: 'text', text: 'Migration written, tests still pending.' },
      ] } },
      { type: 'message', message: { role: 'toolResult', content: [{ type: 'text', text: 'terminal bytes' }] } },
    ].map((entry) => JSON.stringify(entry)).join('\n');

    expect(parsePiConversation(raw)).toEqual([
      { role: 'user', content: 'Ship the migration' },
      { role: 'assistant', content: 'Migration written, tests still pending.' },
    ]);
  });
});

describe('uncompacted messages for the turn diary', () => {
  const claudeRaw = [
    { type: 'user', timestamp: '2026-09-06T10:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'Fix login' }] } },
    { type: 'user', isMeta: true, timestamp: '2026-09-06T10:00:00.100Z', message: { role: 'user', content: '<command-name>/clear</command-name>' } },
    { type: 'assistant', timestamp: '2026-09-06T10:00:05.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read' }] } },
    { type: 'user', toolUseResult: { ok: true }, timestamp: '2026-09-06T10:00:06.000Z', message: { role: 'user', content: [{ type: 'text', text: 'tool text that is not a prompt' }] } },
    { type: 'user', isSidechain: true, timestamp: '2026-09-06T10:00:07.000Z', message: { role: 'user', content: [{ type: 'text', text: 'subagent prompt' }] } },
    { type: 'assistant', isSidechain: true, timestamp: '2026-09-06T10:00:08.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'subagent answer' }] } },
    { type: 'assistant', timestamp: '2026-09-06T10:00:09.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Looking.' }, { type: 'text', text: 'The redirect is fixed.' }] } },
  ].map((e) => JSON.stringify(e)).join('\n');

  it('keeps every text message with timestamps and marks injected entries as meta', () => {
    expect(parseClaudeMessages(claudeRaw)).toEqual([
      { role: 'user', content: 'Fix login', timestamp: Date.parse('2026-09-06T10:00:00.000Z'), meta: false },
      { role: 'user', content: '<command-name>/clear</command-name>', timestamp: Date.parse('2026-09-06T10:00:00.100Z'), meta: true },
      { role: 'user', content: 'tool text that is not a prompt', timestamp: Date.parse('2026-09-06T10:00:06.000Z'), meta: true },
      { role: 'user', content: 'subagent prompt', timestamp: Date.parse('2026-09-06T10:00:07.000Z'), meta: true },
      { role: 'assistant', content: 'subagent answer', timestamp: Date.parse('2026-09-06T10:00:08.000Z'), meta: true },
      { role: 'assistant', content: 'Looking.\nThe redirect is fixed.', timestamp: Date.parse('2026-09-06T10:00:09.000Z'), meta: false },
    ]);
  });

  it('leaves the handoff wrapper unchanged: same messages, meta entries kept, no timestamps', () => {
    expect(parseClaudeConversation(claudeRaw)).toEqual(
      parseClaudeMessages(claudeRaw).map(({ role, content }) => ({ role, content })),
    );
  });

  it('never compacts: 40 messages stay 40', () => {
    const raw = Array.from({ length: 40 }, (_, i) => JSON.stringify({
      type: i % 2 ? 'assistant' : 'user', message: { role: i % 2 ? 'assistant' : 'user', content: [{ type: 'text', text: `m${i}` }] },
    })).join('\n');
    expect(parseClaudeMessages(raw)).toHaveLength(40);
    expect(parseClaudeConversation(raw)).toHaveLength(20);
  });

  it('gives Codex, OpenCode and Pi messages a timestamp when the entry has one, else null', () => {
    const codex = JSON.stringify({ timestamp: '2026-09-06T10:00:00.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] } });
    expect(parseCodexMessages(codex)).toEqual([{ role: 'user', content: 'hi', timestamp: Date.parse('2026-09-06T10:00:00.000Z'), meta: false }]);
    const opencode = JSON.stringify({ messages: [{ info: { role: 'assistant', time: { created: 1_757_152_800_000 } }, parts: [{ type: 'text', text: 'yo' }] }] });
    expect(parseOpenCodeMessages(opencode)).toEqual([{ role: 'assistant', content: 'yo', timestamp: 1_757_152_800_000, meta: false }]);
    const pi = JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'pi' }] } });
    expect(parsePiMessages(pi)).toEqual([{ role: 'user', content: 'pi', timestamp: null, meta: false }]);
  });
});

describe('loadTranscript', () => {
  let home: string;
  const cwd = '/Users/x/proj';
  const slug = cwd.replace(/[^A-Za-z0-9]/g, '-');
  beforeEach(async () => { home = await fs.mkdtemp(path.join(os.tmpdir(), 'conv-home-')); });
  afterEach(async () => { await fs.rm(home, { recursive: true, force: true }); });

  it('reads the Claude transcript by transcriptPath, falls back to providerSessionId, refuses paths outside the root', async () => {
    const dir = path.join(home, '.claude', 'projects', slug);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'sid.jsonl'), 'A');
    const ref = { mode: 'claude' as const, worktreePath: cwd, sessionId: '1', providerSessionId: 'sid', updatedAt: 'x' };
    expect(await loadTranscript('claude', cwd, { ...ref, transcriptPath: path.join(dir, 'sid.jsonl') }, { homeDir: home })).toBe('A');
    expect(await loadTranscript('claude', cwd, ref, { homeDir: home })).toBe('A');
    const outside = path.join(home, 'elsewhere.jsonl');
    await fs.writeFile(outside, 'B');
    // Outside the root: refused, and with no file for this other cwd the fallbacks find nothing either.
    expect(await loadTranscript('claude', '/Users/x/other', { ...ref, providerSessionId: 'nope', transcriptPath: outside }, { homeDir: home })).toBeNull();
    // Same refusal, but this cwd's project dir has a file: the newest-file fallback returns it, never the outside path.
    expect(await loadTranscript('claude', cwd, { ...ref, providerSessionId: 'nope', transcriptPath: outside }, { homeDir: home })).toBe('A');
  });

  it('returns null for OpenCode when the export command fails', async () => {
    const ref = { mode: 'opencode' as const, worktreePath: cwd, sessionId: '1', providerSessionId: 'oc', updatedAt: 'x' };
    expect(await loadTranscript('opencode', cwd, ref, { homeDir: home, runOpenCode: async () => { throw new Error('no opencode'); } })).toBeNull();
    expect(await loadTranscript('opencode', cwd, ref, { homeDir: home, runOpenCode: async () => '{"messages":[]}' })).toBe('{"messages":[]}');
  });
});
