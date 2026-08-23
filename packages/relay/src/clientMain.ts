#!/usr/bin/env node
// strado-tunnel — runner-side tunnel client (M1/M2 standalone; folds into the
// runner daemon in M3).
//
// First time on a runner box (pairing code minted from your account):
//   strado-tunnel pair --code PAIR-XXXX-XXXX [--name my-box] [--api https://api.strado.io]
//
// Then (identity persisted in $STRADO_HOME/runner.json, default ~/.strado):
//   strado-tunnel [--port 7777] [--relay wss://api.strado.io]
//
// Dev/static mode (no pairing, shared secret):
//   strado-tunnel --runner dev --relay ws://127.0.0.1:8791 --token <secret> [--key <accessKey>]
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TunnelClient } from './client.js';
import { runnerConfigPath } from './configPath.js';

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

const CONFIG_PATH = arg('config') ?? runnerConfigPath();

interface RunnerConfig {
  runnerId: string;
  runnerToken: string;
  accessKey: string;
  apiUrl: string;
}

function loadConfig(): RunnerConfig | null {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as RunnerConfig;
  } catch {
    return null;
  }
}

async function pair(): Promise<void> {
  const code = arg('code');
  const apiUrl = arg('api') ?? process.env.STRADO_API_URL ?? 'https://api.strado.io';
  const name = arg('name') ?? os.hostname().split('.')[0] ?? 'runner';
  if (!code) {
    console.error('usage: strado-tunnel pair --code PAIR-XXXX-XXXX [--name <name>] [--api <url>]');
    process.exit(1);
  }
  const res = await fetch(`${apiUrl}/v1/runners/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, name, runnerVersion: process.env.STRADO_APP_VERSION }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`pairing failed (${res.status}): ${body}`);
    process.exit(1);
  }
  const { runnerId, runnerToken } = (await res.json()) as { runnerId: string; runnerToken: string };
  const config: RunnerConfig = {
    runnerId,
    runnerToken,
    // Stable per runner: it seeds the browser cookie, so restarts must not
    // invalidate existing sessions.
    accessKey: randomBytes(16).toString('hex'),
    apiUrl,
  };
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
  console.log(`paired as "${runnerId}" — identity saved to ${CONFIG_PATH}`);
  console.log('start the tunnel with: strado-tunnel');
}

function run(): void {
  const config = loadConfig();
  const runnerId = arg('runner') ?? process.env.STRADO_RUNNER_ID ?? config?.runnerId;
  const relayUrl = arg('relay') ?? process.env.RELAY_URL ?? 'wss://api.strado.io';
  const token = arg('token') ?? process.env.RELAY_RUNNER_TOKEN ?? config?.runnerToken;
  const localPort = Number(arg('port') ?? process.env.STRADO_LOCAL_PORT ?? 7777);
  const accessKey =
    arg('key') ?? process.env.STRADO_ACCESS_KEY ?? config?.accessKey ?? randomBytes(16).toString('hex');
  // Where browsers reach this runner (<runnerId>.<domain>); the /tunnel
  // registration endpoint may live on a different hostname (api.strado.io).
  const clientDomain = arg('domain') ?? process.env.RELAY_DOMAIN ?? 'r.strado.io';

  if (!runnerId || !token) {
    console.error('no runner identity — pair first: strado-tunnel pair --code PAIR-XXXX-XXXX');
    process.exit(1);
  }

  const client = new TunnelClient({
    relayUrl,
    runnerId,
    token,
    accessKey,
    localPort,
    runnerVersion: process.env.STRADO_APP_VERSION,
    onStatusChange: (status) => {
      if (status === 'connected') {
        console.log(`[tunnel] online — browsers attach at https://${runnerId}.${clientDomain} (mint an attach link from your account)`);
      }
    },
  });

  process.on('SIGINT', () => {
    client.stop();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    client.stop();
    process.exit(0);
  });

  client.start();
  console.log(`[tunnel] fronting 127.0.0.1:${localPort} as "${runnerId}" via ${relayUrl}`);
}

if (process.argv[2] === 'pair') {
  await pair();
} else {
  run();
}
