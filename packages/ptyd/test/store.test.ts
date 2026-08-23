import { describe, it, expect } from 'vitest';
import { SessionStore } from '../src/store.js';
import type { PtyLike } from '../src/store.js';

const fakePty = (): PtyLike => ({ pid: 123, cols: 80, rows: 24 });

describe('SessionStore', () => {
  it('adds, gets, deletes', () => {
    const store = new SessionStore();
    const s = store.add('k1', fakePty());
    expect(store.get('k1')).toBe(s);
    expect([...store.all()]).toHaveLength(1);
    store.delete('k1');
    expect(store.get('k1')).toBeUndefined();
  });

  it('rejects duplicate live ids', () => {
    const store = new SessionStore();
    store.add('k1', fakePty());
    expect(() => store.add('k1', fakePty())).toThrow(/exists/);
  });

  it('ring buffer keeps only the last cap bytes', () => {
    const store = new SessionStore({ bufferCap: 10 });
    const s = store.add('k1', fakePty());
    store.appendOutput(s, Buffer.from('0123456789'));
    store.appendOutput(s, Buffer.from('ABCDE'));
    expect(store.replay(s).toString()).toBe('56789ABCDE');
    expect(s.bufferBytes).toBe(10);
  });

  it('replay on empty buffer is empty', () => {
    const store = new SessionStore();
    const s = store.add('k1', fakePty());
    expect(store.replay(s).byteLength).toBe(0);
  });

  it('allows re-add after the session exited (daemon respawn under same key)', () => {
    const store = new SessionStore();
    const s = store.add('k1', fakePty());
    s.exited = true;
    expect(() => store.add('k1', fakePty())).not.toThrow();
    expect(store.get('k1')).not.toBe(s); // fresh session replaced the exited one
  });
});
