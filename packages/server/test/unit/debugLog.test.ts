import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDebugLog } from '../../src/services/debugLog';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strado-debuglog-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('createDebugLog', () => {
  it('appends tagged, timestamped, single-line records to strado.log', () => {
    const logDir = path.join(dir, 'logs');
    const log = createDebugLog(logDir);
    log.log('server', 'listening on http://127.0.0.1:7777');
    log.log('FD-9 dev', 'line one\nline two'); // embedded newline collapses

    const contents = fs.readFileSync(path.join(logDir, 'strado.log'), 'utf8');
    const lines = contents.trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\S+ \[server] listening on http:\/\/127\.0\.0\.1:7777$/);
    expect(lines[1]).toMatch(/^\S+ \[FD-9 dev] line one line two$/);
    expect(log.path).toBe(path.join(logDir, 'strado.log'));
  });

  it('rotates to strado.log.1 once the size cap is exceeded', () => {
    const log = createDebugLog(dir, { maxBytes: 200 });
    for (let i = 0; i < 20; i++) log.log('t', `message number ${i} padded to force rotation soon`);

    expect(fs.existsSync(path.join(dir, 'strado.log'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'strado.log.1'))).toBe(true);
    // the live file was reset on rotation, so it stays under the cap-ish size
    expect(fs.statSync(path.join(dir, 'strado.log')).size).toBeLessThan(400);
  });

  it('never throws when the log directory cannot be created', () => {
    // point the "dir" at a path under an existing FILE so mkdir/append fail
    const filePath = path.join(dir, 'not-a-dir');
    fs.writeFileSync(filePath, 'x');
    const log = createDebugLog(path.join(filePath, 'logs'));
    expect(() => log.log('server', 'should not throw')).not.toThrow();
  });
});
