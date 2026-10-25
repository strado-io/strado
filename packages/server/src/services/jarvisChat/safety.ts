// Which shell lines are destructive: a Focus Jarvis approval card names the
// reason in red. Mirrors the ⌘K box's check (packages/web/src/lib/jarvis/
// safety.ts, which must stay byte-for-byte the same rules; a web parity test
// runs both over one corpus).

/** One shell segment's words, with leading `sudo`, `env X=y`, `nice` etc. dropped. */
function commandWords(segment: string): string[] {
  const words = segment.trim().split(/\s+/).filter(Boolean);
  while (words.length > 0 && (/^(sudo|doas|nice|nohup|time|command|exec|env)$/.test(words[0]!) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!))) words.shift();
  return words;
}

/** Short flags of a word list merged into one set: `-r -f` and `-rf` both give {r,f}. */
const shortFlags = (words: string[]): Set<string> =>
  new Set(words.filter((w) => /^-[A-Za-z]+$/.test(w)).flatMap((w) => [...w.slice(1)]));

type Rule = (words: string[], segment: string) => string | null;

const RULES: Rule[] = [
  (w) => {
    if (w[0] !== 'rm') return null;
    const f = shortFlags(w);
    const recursive = f.has('r') || f.has('R') || w.includes('--recursive');
    const force = f.has('f') || w.includes('--force');
    return recursive && force ? 'recursive delete (rm -rf)' : null;
  },
  (w) => {
    if (w[0] !== 'git') return null;
    const sub = w[1];
    const f = shortFlags(w);
    if (sub === 'push' && (w.some((x) => x.startsWith('--force')) || f.has('f') || w.slice(2).some((x) => /^\+[^\s]/.test(x)))) return 'force push';
    if (sub === 'reset' && w.includes('--hard')) return 'hard reset (discards changes)';
    if (sub === 'clean' && (f.has('f') || w.includes('--force'))) return 'git clean (deletes untracked files)';
    if (sub === 'branch' && (f.has('D') || (w.includes('--delete') && w.includes('--force')))) return 'force-delete a branch';
    if ((sub === 'checkout' && w.includes('--') && w.includes('.')) || (sub === 'restore' && w.includes('.'))) return 'discard all working-tree changes';
    return null;
  },
  (_w, s) => (/\bdrop\s+(table|database|schema|index|view|keyspace)\b/i.test(s) ? 'SQL DROP' : null),
  (w) => (['kill', 'killall', 'pkill'].includes(w[0] ?? '') ? 'kills processes' : null),
  (w) => (/^mkfs(\.|$)/.test(w[0] ?? '') ? 'formats a disk' : null),
  (w) => (w[0] === 'dd' && w.some((x) => x.startsWith('of=')) ? 'raw disk write (dd)' : null),
  (w) => {
    if (w[0] !== 'chmod' && w[0] !== 'chown') return null;
    return shortFlags(w).has('R') || w.includes('--recursive') ? `recursive ${w[0]}` : null;
  },
  (w) => (w[0] === 'truncate' ? 'truncates a file' : null),
  (w) => (w[0] === 'docker' && w.includes('prune') ? 'docker prune' : null),
  (w) => (w[0] === 'kubectl' && w[1] === 'delete' ? 'kubectl delete' : null),
  (_w, s) => (/>\s*\/dev\/(sd|disk|nvme|hd)/.test(s) ? 'writes to a raw disk' : null),
];

/** The first destructive pattern in a shell command line, or null. Checked
 * per `;`/`&&`/`||`/`|` segment, so `cd x && rm -rf y` is caught. */
export function destructiveCommand(command: string): string | null {
  for (const segment of command.split(/;|&&|\|\||\|/)) {
    const words = commandWords(segment);
    for (const rule of RULES) {
      const hit = rule(words, segment);
      if (hit) return hit;
    }
  }
  return null;
}
