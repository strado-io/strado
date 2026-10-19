'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { createVoice, cleanContextual } = require('./voice.cjs');

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.written = [];
  child.stdin = { write: (s) => child.written.push(JSON.parse(s)), end: () => {} };
  return child;
}
function fakeSender() {
  return { sent: [], destroyed: false, isDestroyed() { return this.destroyed; }, send(ch, evt) { this.sent.push([ch, evt]); } };
}

test('start spawns the helper once, sends start with cleaned names, forwards events to the starting window only', () => {
  const child = fakeChild();
  let spawns = 0;
  const v = createVoice({ platform: 'darwin', resolve: () => '/bin/strado-speech', spawn: () => { spawns++; return child; } });
  const a = fakeSender(); const b = fakeSender();
  assert.deepStrictEqual(v.start(a, { contextual: [' shell-1 ', 'shell-1', 3, 'claude-1'], locale: 'en-US' }), { ok: true });
  assert.deepStrictEqual(child.written[0], { cmd: 'start', contextual: ['shell-1', 'claude-1'], locale: 'en-US' });
  child.stdout.emit('data', Buffer.from('{"type":"ready"}\n{"type":"partial","text":"open a"}\n{"type":"final","text":"open a shell"}\n'));
  assert.deepStrictEqual(a.sent.map(([, e]) => e.type), ['partial', 'final']);
  assert.strictEqual(b.sent.length, 0);
  v.start(b, {});
  assert.strictEqual(spawns, 1); // kept warm
});

test('stop/cancel only act for the owning window; cancel ends the session', () => {
  const child = fakeChild();
  const v = createVoice({ platform: 'darwin', resolve: () => '/x', spawn: () => child });
  const a = fakeSender(); const b = fakeSender();
  v.start(a, {});
  v.stop(b); v.cancel(b);
  assert.deepStrictEqual(child.written.map((c) => c.cmd), ['start']);
  v.stop(a);
  v.cancel(a);
  assert.deepStrictEqual(child.written.map((c) => c.cmd), ['start', 'stop', 'cancel']);
  child.stdout.emit('data', Buffer.from('{"type":"partial","text":"late"}\n'));
  assert.strictEqual(a.sent.length, 0); // nobody owns the session any more
});

test('a second window taking over tells the first; a helper crash reports an error', () => {
  const child = fakeChild();
  const v = createVoice({ platform: 'darwin', resolve: () => '/x', spawn: () => child });
  const a = fakeSender(); const b = fakeSender();
  v.start(a, {});
  v.start(b, {});
  assert.strictEqual(a.sent[0][1].code, 'replaced');
  child.emit('exit', 1);
  assert.strictEqual(b.sent.at(-1)[1].code, 'helper_exit');
});

test('unavailable off macOS or without a helper, and never spawns', () => {
  let spawned = false;
  const off = createVoice({ platform: 'linux', resolve: () => '/x', spawn: () => { spawned = true; } });
  assert.strictEqual(off.available(), false);
  assert.deepStrictEqual(off.start(fakeSender(), {}), { ok: false, code: 'unavailable' });
  const none = createVoice({ platform: 'darwin', resolve: () => null, spawn: () => { spawned = true; } });
  assert.deepStrictEqual(none.start(fakeSender(), {}), { ok: false, code: 'unavailable' });
  assert.strictEqual(spawned, false);
});

test('cleanContextual caps at 100 and 80 chars', () => {
  const many = Array.from({ length: 150 }, (_, i) => `n${i}`);
  assert.strictEqual(cleanContextual(many).length, 100);
  assert.strictEqual(cleanContextual(['x'.repeat(200)])[0].length, 80);
  assert.deepStrictEqual(cleanContextual('nope'), []);
});
