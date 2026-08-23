#!/usr/bin/env node
// strado-relay — single-instance relay service.
//
// Auth modes:
// - cloud (production): runner tokens + one-time attach codes validated
//   against strado-api on this box. Env: CLOUD_INTERNAL_URL
//   (http://127.0.0.1:8790), INTERNAL_RELAY_SECRET.
// - static (dev/spike): one shared runner secret. Env: RELAY_RUNNER_TOKEN.
//
// Common env: RELAY_PORT (8791), RELAY_DOMAIN (r.strado.io),
// RELAY_COOKIE_SECRET.
import type { Socket } from 'node:net';
import { cloudAuth, cloudPresenceReporter } from './cloudAuth.js';
import { buildRelayApp, staticAuth, type RelayAuth } from './server.js';

const PORT = Number(process.env.RELAY_PORT ?? 8791);
const DOMAIN = process.env.RELAY_DOMAIN ?? 'r.strado.io';
const COOKIE_SECRET = process.env.RELAY_COOKIE_SECRET;
const INTERNAL_SECRET = process.env.INTERNAL_RELAY_SECRET;
const CLOUD_URL = process.env.CLOUD_INTERNAL_URL ?? 'http://127.0.0.1:8790';
const STATIC_TOKEN = process.env.RELAY_RUNNER_TOKEN;

if (!COOKIE_SECRET) {
  console.error('[relay] RELAY_COOKIE_SECRET is required');
  process.exit(1);
}

let auth: RelayAuth;
let onRunnerOnline: ((runnerId: string) => void) | undefined;
if (INTERNAL_SECRET) {
  auth = cloudAuth({ apiUrl: CLOUD_URL, internalSecret: INTERNAL_SECRET, log: (l) => console.log(`[relay] ${l}`) });
  onRunnerOnline = cloudPresenceReporter({ apiUrl: CLOUD_URL, internalSecret: INTERNAL_SECRET });
  console.log(`[relay] auth mode: cloud (${CLOUD_URL})`);
} else if (STATIC_TOKEN) {
  auth = staticAuth(STATIC_TOKEN);
  console.log('[relay] auth mode: static');
} else {
  console.error('[relay] set INTERNAL_RELAY_SECRET (cloud auth) or RELAY_RUNNER_TOKEN (static auth)');
  process.exit(1);
}

const { app, tunnels } = buildRelayApp({
  domain: DOMAIN,
  auth,
  cookieSecret: COOKIE_SECRET,
  onRunnerOnline,
});

let draining = false;
const drain = async (signal: string) => {
  if (draining) return;
  draining = true;
  console.log(`[relay] ${signal} received, draining`);
  try {
    await tunnels.drain();
    await app.close();
  } catch (err) {
    console.error('[relay] drain failed', err);
  }
  process.exit(0);
};
process.on('SIGINT', () => void drain('SIGINT'));
process.on('SIGTERM', () => void drain('SIGTERM'));

// One bad tunnel must not take down every other tunnel on the box.
process.on('uncaughtException', (err) => console.error('[relay] uncaughtException (suppressed)', err));
process.on('unhandledRejection', (reason) => console.error('[relay] unhandledRejection (suppressed)', reason));

await app.listen({ host: '0.0.0.0', port: PORT });
app.server.on('connection', (socket: Socket) => socket.setNoDelay(true));
console.log(`[relay] listening on :${PORT} for *.${DOMAIN}`);
