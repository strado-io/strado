import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentSpawnSpec } from './agentSpawn.js';
import { hooksDir } from './claudeHooks.js';
import { OPENCODE_RECHECK_MS, opencodeConfigContent, opencodeStandaloneKnown, probeOpencodeStandalone, resetOpencodeProbe } from './opencodeLaunch.js';
import { sessionEnv } from './terminalManager.js';

const strado = { type: 'local', command: ['node', path.join(hooksDir(), 'strado-mcp.mjs')], enabled: true };

afterEach(() => resetOpencodeProbe());

describe('opencodeConfigContent', () => {
  it('registers this server\'s strado MCP', () => {
    expect(JSON.parse(opencodeConfigContent(undefined))).toEqual({ mcp: { strado } });
  });

  it('keeps what the user exported and replaces only mcp.strado', () => {
    const mine = JSON.stringify({ model: 'x/y', mcp: { figma: { type: 'remote', url: 'u' }, strado: { type: 'local', command: ['node', '/old/strado-mcp.mjs'] } } });
    expect(JSON.parse(opencodeConfigContent(mine))).toEqual({ model: 'x/y', mcp: { figma: { type: 'remote', url: 'u' }, strado } });
  });

  it('a non-JSON or non-object value is replaced, never thrown on', () => {
    expect(JSON.parse(opencodeConfigContent('nope'))).toEqual({ mcp: { strado } });
    expect(JSON.parse(opencodeConfigContent('[1]'))).toEqual({ mcp: { strado } });
  });

  it('every session env carries it', () => {
    expect(JSON.parse(sessionEnv('/w\0shell:2', '/w').OPENCODE_CONFIG_CONTENT!)).toMatchObject({ mcp: { strado } });
  });
});

describe('opencode --standalone', () => {
  it('is added only when the installed opencode lists it; probed once', async () => {
    const run = vi.fn(async () => 'FLAGS\n  --standalone            Run with a private server\n');
    expect(agentSpawnSpec('opencode', '1', '/w')!.args[2]).toBe('opencode --continue || opencode');
    expect(await probeOpencodeStandalone(run)).toBe(true);
    await probeOpencodeStandalone(run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(opencodeStandaloneKnown()).toBe(true);
    expect(agentSpawnSpec('opencode', '1', '/w')!.args[2]).toBe('opencode --standalone --continue || opencode --standalone');
    expect(agentSpawnSpec('opencode', '2', '/w')!.args[2]).toBe('opencode --standalone');
  });

  it('an old opencode or a failed probe launches without it', async () => {
    expect(await probeOpencodeStandalone(async () => 'Usage: opencode [project]\n  --continue')).toBe(false);
    resetOpencodeProbe();
    expect(await probeOpencodeStandalone(async () => { throw new Error('not installed'); })).toBe(false);
    expect(agentSpawnSpec('opencode', '2', '/w')!.args[2]).toBe('opencode');
  });
});

describe('probeOpencodeStandalone: a "no" is not forever', () => {
  it('a failed probe is not remembered; a "no" is asked again after the recheck window; a "yes" is kept', async () => {
    resetOpencodeProbe();
    let t = 0;
    const now = () => t;
    expect(await probeOpencodeStandalone(async () => { throw new Error('slow login shell'); }, now)).toBe(false);
    expect(await probeOpencodeStandalone(async () => 'opencode [--standalone]', now)).toBe(true); // asked again at once
    resetOpencodeProbe();
    expect(await probeOpencodeStandalone(async () => 'opencode 1.x', now)).toBe(false);
    const upgraded = vi.fn(async () => 'opencode [--standalone]');
    expect(await probeOpencodeStandalone(upgraded, now)).toBe(false); // within the window: cached
    t += OPENCODE_RECHECK_MS;
    expect(await probeOpencodeStandalone(upgraded, now)).toBe(true); // upgraded meanwhile
    const never = vi.fn(async () => '');
    t += OPENCODE_RECHECK_MS * 10;
    expect(await probeOpencodeStandalone(never, now)).toBe(true);
    expect(never).not.toHaveBeenCalled();
    resetOpencodeProbe();
  });
});
