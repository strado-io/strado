import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as jsoncParse } from 'jsonc-parser';
import { jsonDriver } from './json.js';

const FIXTURE = path.resolve(
  __dirname, '../../../../test/fixtures/agentConfig/claude-large.json',
);

function measureChangedRegion(before: string, after: string): number {
  let head = 0;
  while (head < before.length && before[head] === after[head]) head++;
  let tail = 0;
  const maxTail = Math.min(before.length - head, after.length - head);
  while (
    tail < maxTail &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) tail++;
  const regionSize = Math.max(
    after.length - head - tail,
    Math.abs(before.length - after.length),
  );
  return regionSize;
}

const reserializingSet = (text: string, path: (string | number)[], value: unknown): string => {
  const doc = JSON.parse(text);
  let node: any = doc;
  for (const k of path.slice(0, -1)) node = node[k];
  node[path[path.length - 1]!] = value;
  return JSON.stringify(doc, null, 2) + '\n';
};

const tolerantReserializingSet = (text: string, path: (string | number)[], value: unknown): string => {
  const doc = jsoncParse(text);
  let node: any = doc;
  for (const k of path.slice(0, -1)) node = node[k];
  node[path[path.length - 1]!] = value;
  return JSON.stringify(doc, null, 2) + '\n';
};

describe('surgical write safety', () => {
  it('adds an MCP server without touching any sibling byte', () => {
    const before = readFileSync(FIXTURE, 'utf8');
    const after = jsonDriver.set(before, ['mcpServers', 'strado-preview'], {
      command: 'node',
      args: ['/Applications/Strado.app/preview-mcp.cjs'],
    });

    // The new server landed.
    expect(jsonDriver.get(after, ['mcpServers', 'strado-preview', 'command'])).toBe('node');

    // Every telemetry key in every project entry is untouched.
    const beforeDoc = jsoncParse(before);
    const afterDoc = jsoncParse(after);
    expect(afterDoc.projects).toEqual(beforeDoc.projects);
    expect(afterDoc.numStartups).toBe(beforeDoc.numStartups);
    expect(afterDoc.userID).toBe(beforeDoc.userID);
    expect(afterDoc.mcpServers.figma).toEqual(beforeDoc.mcpServers.figma);
  });

  it('changes only a bounded region of the file text', () => {
    const before = readFileSync(FIXTURE, 'utf8');
    const after = jsonDriver.set(before, ['mcpServers', 'strado-preview'], { command: 'node' });

    // Find the first and last differing character; the edit window must be
    // small relative to the file. A parse-and-reserialize rewrite would make
    // this span the whole document.
    const changed = measureChangedRegion(before, after);
    expect(changed).toBeLessThan(400);
    expect(before.length).toBeGreaterThan(10_000);
  });

  it('reserializing driver fails the surgical-write guarantee', () => {
    const before = readFileSync(FIXTURE, 'utf8');

    // The reserializing driver cannot parse comments, so it throws on the
    // JSONC fixture. This proves the fixture has discriminating power.
    let reserializingThrows = false;
    try {
      reserializingSet(before, ['mcpServers', 'strado-preview'], { command: 'node' });
    } catch {
      reserializingThrows = true;
    }

    // If reserializing does not throw (e.g., on a future all-JSON fixture),
    // it would reserialize the whole document, blowing past the 400-char bound.
    if (!reserializingThrows) {
      const after = reserializingSet(before, ['mcpServers', 'strado-preview'], { command: 'node' });
      const changed = measureChangedRegion(before, after);
      expect(changed).toBeGreaterThan(400);
    } else {
      expect(reserializingThrows).toBe(true);
    }
  });

  it('tail-bound fix prevents under-reporting large deletions', () => {
    const before = readFileSync(FIXTURE, 'utf8');
    // Remove an entire project entry — a substantial deletion
    const after = jsonDriver.remove(before, ['projects', '/Users/x/repo0']);

    // The changed region must reflect the size of the deleted content.
    // Without the maxTail bound fix, the buggy scan `tail < before.length - head`
    // could walk past the end and report changed near 0.
    const changed = measureChangedRegion(before, after);
    expect(changed).toBeGreaterThan(100);
  });

  it('tolerant-reserializing driver fails by stripping comments', () => {
    const before = readFileSync(FIXTURE, 'utf8');

    // A jsonc-tolerant reserializer parses successfully but silently strips
    // comments when it round-trips through JSON.stringify.
    const after = tolerantReserializingSet(before, ['mcpServers', 'strado-preview'], { command: 'node' });

    // Assert the changed region blows past the 400-char bound — the whole
    // document is rewritten, not surgically edited.
    const changed = measureChangedRegion(before, after);
    expect(changed).toBeGreaterThan(400);

    // Assert the specific user-visible damage: comments are gone.
    // The original has "// Configuration for MCP servers" and
    // "/* User tracking and project workspace */" — verify they are lost.
    expect(before).toContain('// Configuration for MCP servers');
    expect(before).toContain('/* User tracking and project workspace */');
    expect(after).not.toContain('// Configuration for MCP servers');
    expect(after).not.toContain('/* User tracking and project workspace */');
  });
});
