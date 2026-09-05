import fsp from 'node:fs/promises';
import path from 'node:path';

/**
 * A small dotenv reader: `KEY=VALUE` per line, optional `export `, single or
 * double quotes, `#` comments (a `#` inside quotes is kept). Enough for the
 * files dev servers ship with; anything fancier belongs in the app's own
 * loader, which a {ENV_FILE} command can still hand the file to.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2]!.trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1);
    } else {
      // unquoted: a ` #` starts a comment
      const hash = value.search(/\s#/);
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    out[m[1]!] = value;
  }
  return out;
}

export type StartEnvInput = {
  cwd: string;
  envFile: string | null;
  interpolated: boolean;
  worktreeEnv: Record<string, string>;
};

/**
 * The extra environment a dev server starts with: the selected profile's
 * file when the command did not take the file itself, then the worktree's
 * own variables on top (they are the more specific setting).
 */
export async function resolveStartEnv({ cwd, envFile, interpolated, worktreeEnv }: StartEnvInput): Promise<Record<string, string>> {
  if (!envFile || interpolated) return { ...worktreeEnv };
  let text: string;
  try {
    text = await fsp.readFile(path.resolve(cwd, envFile), 'utf8');
  } catch {
    // A profile pointing at a file that is not there yet (gitignored, not
    // pulled) is not a reason to refuse to start.
    return { ...worktreeEnv };
  }
  return { ...parseEnvFile(text), ...worktreeEnv };
}
