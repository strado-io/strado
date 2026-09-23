/** Per-session clocks for "is anyone touching this PTY right now": the last
 * user keystroke (WebSocket input) and the last byte the process printed.
 * Consumers gate on quiet time; nothing here decides anything. */
export type PtyActivity = {
  noteInput(key: string): void;
  noteOutput(key: string): void;
  forget(key: string): void;
  /** ms since the last input / output for the key; Infinity when never seen. */
  quiet(key: string): { input: number; output: number };
};

export function createPtyActivity(now: () => number = Date.now): PtyActivity {
  const input = new Map<string, number>();
  const output = new Map<string, number>();
  const since = (m: Map<string, number>, key: string, t: number): number => {
    const v = m.get(key);
    return v === undefined ? Infinity : t - v;
  };
  return {
    noteInput: (key) => { input.set(key, now()); },
    noteOutput: (key) => { output.set(key, now()); },
    forget: (key) => { input.delete(key); output.delete(key); },
    quiet: (key) => {
      const t = now();
      return { input: since(input, key, t), output: since(output, key, t) };
    },
  };
}
