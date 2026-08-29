import { describe, expect, it } from 'vitest';
import {
  parseClaudeConversation,
  parseCodexConversation,
  parseOpenCodeConversation,
  parsePiConversation,
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
