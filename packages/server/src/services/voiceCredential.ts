import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

// The user's own ElevenLabs API key, for command-box voice (Scribe v2
// Realtime). It never leaves the server process: the renderer gets a
// single-use token minted with it (routes/voice.ts), never the key. Same
// storage rules as the other keys: ~/.strado JSON, mode 600, honours STRADO_HOME.
const Schema = z.object({ elevenlabsApiKey: z.string().min(1) });

export function voiceCredentialPath(): string {
  const home = process.env.STRADO_HOME || path.join(os.homedir(), '.strado');
  return path.join(home, 'voice-credential.json');
}

export async function readVoiceCredential(): Promise<string | null> {
  try {
    return Schema.parse(JSON.parse(await fsp.readFile(voiceCredentialPath(), 'utf8'))).elevenlabsApiKey;
  } catch {
    return null;
  }
}

/** Passing null (or a blank string) clears the credential. */
export async function writeVoiceCredential(key: string | null): Promise<void> {
  const trimmed = key?.trim() ?? '';
  const file = voiceCredentialPath();
  if (!trimmed) {
    await fsp.rm(file, { force: true });
    return;
  }
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify({ elevenlabsApiKey: trimmed }, null, 2), { mode: 0o600 });
}
