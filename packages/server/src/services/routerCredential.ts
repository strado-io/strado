import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

// The user's own OpenRouter API key, used only by the command box's fast
// decision step (Jev, services/jevRouter.ts). Kept apart from the Anthropic
// key on purpose: that one is threaded into sandboxes, this one never leaves
// the server process. Same storage rules: ~/.strado JSON, mode 600, honours
// STRADO_HOME, never returned to the renderer.
const Schema = z.object({ openrouterApiKey: z.string().min(1) });

export function routerCredentialPath(): string {
  const home = process.env.STRADO_HOME || path.join(os.homedir(), '.strado');
  return path.join(home, 'router-credential.json');
}

export async function readRouterCredential(): Promise<string | null> {
  try {
    return Schema.parse(JSON.parse(await fsp.readFile(routerCredentialPath(), 'utf8'))).openrouterApiKey;
  } catch {
    return null;
  }
}

/** Passing null (or a blank string) clears the credential. */
export async function writeRouterCredential(key: string | null): Promise<void> {
  const trimmed = key?.trim() ?? '';
  const file = routerCredentialPath();
  if (!trimmed) {
    await fsp.rm(file, { force: true });
    return;
  }
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify({ openrouterApiKey: trimmed }, null, 2), { mode: 0o600 });
}
