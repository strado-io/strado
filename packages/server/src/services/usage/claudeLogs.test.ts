import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeProjectDirs, claudeTranscripts, encodeProjectDir, matchProjectDir, readClaudeEvents } from './claudeLogs.js';

let dir = '';

const line = (over: Record<string, unknown> = {}) => JSON.stringify({
  type: 'assistant',
  timestamp: '2026-08-30T10:00:00.000Z',
  requestId: 'req_1',
  cwd: '/repo/wt',
  message: {
    id: 'msg_1',
    model: 'claude-opus-5',
    usage: {
      input_tokens: 10,
      cache_creation_input_tokens: 20,
      cache_read_input_tokens: 30,
      output_tokens: 40,
    },
  },
  ...over,
});

const write = async (name: string, lines: string[]) => {
  const file = path.join(dir, name);
  await fsp.writeFile(file, lines.map((l) => `${l}\n`).join(''), 'utf8');
  return file;
};

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'usage-claude-'));
});

afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

describe('readClaudeEvents', () => {
  it('maps every token class from an assistant line', async () => {
    const file = await write('a.jsonl', [line()]);
    const { events } = await readClaudeEvents(file, 0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      agent: 'claude',
      model: 'claude-opus-5',
      cwd: '/repo/wt',
      tokens: { input: 10, cacheWrite: 20, cacheRead: 30, output: 40 },
    });
    expect(events[0]!.ts).toBe(Date.parse('2026-08-30T10:00:00.000Z'));
  });

  it('counts a repeated requestId and message id once', async () => {
    const file = await write('a.jsonl', [line(), line()]);
    const { events } = await readClaudeEvents(file, 0);
    expect(events).toHaveLength(1);
  });

  it('keeps distinct messages that share a requestId', async () => {
    const file = await write('a.jsonl', [
      line(),
      line({ message: { id: 'msg_2', model: 'claude-opus-5', usage: { input_tokens: 1, output_tokens: 2 } } }),
    ]);
    const { events } = await readClaudeEvents(file, 0);
    expect(events).toHaveLength(2);
    expect(events[1]!.tokens).toEqual({ input: 1, cacheWrite: 0, cacheRead: 0, output: 2 });
  });

  it('ignores lines without usage', async () => {
    const file = await write('a.jsonl', [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
      JSON.stringify({ type: 'summary', leafUuid: 'x' }),
    ]);
    const { events } = await readClaudeEvents(file, 0);
    expect(events).toHaveLength(0);
  });

  it('counts malformed lines as skipped without throwing', async () => {
    const file = await write('a.jsonl', ['{not json', line()]);
    const { events, skipped } = await readClaudeEvents(file, 0);
    expect(events).toHaveLength(1);
    expect(skipped).toBe(1);
  });

  it('returns an offset that yields no repeats on the next read', async () => {
    const file = await write('a.jsonl', [line()]);
    const first = await readClaudeEvents(file, 0);
    expect(first.offset).toBe((await fsp.stat(file)).size);
    const second = await readClaudeEvents(file, first.offset);
    expect(second.events).toHaveLength(0);
    expect(second.offset).toBe(first.offset);
  });

  it('reads only appended lines from a prior offset', async () => {
    const file = await write('a.jsonl', [line()]);
    const first = await readClaudeEvents(file, 0);
    await fsp.appendFile(file, `${line({ requestId: 'req_2', message: { id: 'msg_9', model: 'claude-sonnet-5', usage: { output_tokens: 7 } } })}\n`);
    const second = await readClaudeEvents(file, first.offset);
    expect(second.events).toHaveLength(1);
    expect(second.events[0]!.model).toBe('claude-sonnet-5');
  });

  it('stops the offset before a partially written trailing line', async () => {
    const file = path.join(dir, 'partial.jsonl');
    await fsp.writeFile(file, `${line()}\n{"type":"assistant","mess`, 'utf8');
    const { events, offset } = await readClaudeEvents(file, 0);
    expect(events).toHaveLength(1);
    expect(offset).toBe(`${line()}\n`.length);
  });

  it('returns nothing for a missing file', async () => {
    const { events, offset } = await readClaudeEvents(path.join(dir, 'nope.jsonl'), 0);
    expect(events).toHaveLength(0);
    expect(offset).toBe(0);
  });
});

describe('claudeTranscripts', () => {
  it('includes nested subagent transcripts, not just the session files', async () => {
    const project = path.join(dir, '-repo-wt');
    await fsp.mkdir(path.join(project, 'session-1', 'subagents'), { recursive: true });
    await fsp.writeFile(path.join(project, 'session-1.jsonl'), `${line()}\n`, 'utf8');
    await fsp.writeFile(path.join(project, 'session-1', 'subagents', 'agent-a.jsonl'), `${line()}\n`, 'utf8');
    await fsp.writeFile(path.join(project, 'notes.md'), 'x', 'utf8');

    const files = await claudeTranscripts(project);

    expect(files.map((file) => path.relative(project, file)).sort()).toEqual([
      'session-1.jsonl',
      path.join('session-1', 'subagents', 'agent-a.jsonl'),
    ]);
  });

  it('returns nothing for a directory that is not there', async () => {
    expect(await claudeTranscripts(path.join(dir, 'missing'))).toEqual([]);
  });
});

describe('project directory mapping', () => {
  it('encodes a path the way Claude Code does', () => {
    expect(encodeProjectDir('/Users/me/.strado/worktrees/app/add_usage')).toBe(
      '-Users-me--strado-worktrees-app-add-usage',
    );
  });

  it('matches an encoded directory back to a known path', () => {
    const known = ['/Users/me/code/app', '/Users/me/.strado/worktrees/app/feature_x'];
    expect(matchProjectDir('-Users-me--strado-worktrees-app-feature-x', known))
      .toBe('/Users/me/.strado/worktrees/app/feature_x');
    expect(matchProjectDir('-Users-me-elsewhere', known)).toBeNull();
  });

  it('lists project directories, skipping files', async () => {
    await fsp.mkdir(path.join(dir, '-repo-a'));
    await fsp.writeFile(path.join(dir, 'loose.txt'), 'x', 'utf8');
    expect(await claudeProjectDirs(dir)).toEqual([path.join(dir, '-repo-a')]);
  });

  it('returns no directories when the root is missing', async () => {
    expect(await claudeProjectDirs(path.join(dir, 'missing'))).toEqual([]);
  });
});
