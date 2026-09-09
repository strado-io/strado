// Boots the PACKAGED server exactly the way the desktop app does — the bundled
// Node runtime running the minified server.js out of the assembled Resources
// tree — and fails unless GET /api/health answers ok within 20s.
//
//   node scripts/smoke-packaged-server.mjs <resourcesDir>
//
// <resourcesDir> is the tree that ends up as Strado.app/Contents/Resources
// (mac) or resources/ (linux): bin/node, server/server.js, server/ptyd.cjs,
// web/. Both packagers call this on the electron-builder output, and
// release.yml calls it again on the mounted DMG / extracted AppImage.
//
// Why this exists: 0.1.53 shipped a server.js whose bundle still contained
// jsonc-parser's UMD `require('./impl/format')` calls. Dev and tests run
// unbundled, CI packaged but never launched, and the feed was live before
// anyone saw "server did not come up on :7777". This is the launch nobody did.
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

const HEALTH_TIMEOUT_MS = 20_000;

const resources = path.resolve(process.argv[2] ?? path.join('build', 'pack'));
const nodeBin = path.join(resources, 'bin', process.platform === 'win32' ? 'node.exe' : 'node');
const serverDir = path.join(resources, 'server');
const required = [nodeBin, path.join(serverDir, 'server.js'), path.join(serverDir, 'ptyd.cjs'), path.join(resources, 'web', 'index.html')];
for (const f of required) {
  if (!fs.existsSync(f)) fail(`missing ${path.relative(resources, f)} under ${resources}`);
}

// ptyd listens on a unix socket under STRADO_HOME; macOS caps socket paths at
// 104 bytes, so the scratch home must be short. os.tmpdir() is /tmp on Linux
// and ~50 chars on macOS runners — both fine; a long custom TMPDIR is not.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'strado-smoke-'));
if (path.join(home, 'ptyd', 'ptyd.sock').length > 100) fail(`scratch home too long for a unix socket: ${home}`);
fs.mkdirSync(path.join(home, 'config'));
const port = await freePort();

const env = {
  ...process.env,
  PORT: String(port),
  STRADO_HOME: home,
  STRADO_CONFIG_DIR: path.join(home, 'config'),
  STRADO_WEB_DIST: path.join(resources, 'web'),
  STRADO_HOOKS_DIR: path.join(serverDir, 'hooks'),
};
// The app sets this in shipped builds; /api/health is exempt from the gate,
// so keep it on to boot the same code path a user's install runs.
env.STRADO_LICENSE_REQUIRED = '1';

let output = '';
let exited = null;
const child = spawn(nodeBin, ['server.js'], { cwd: serverDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', (d) => { output += d; });
child.stderr.on('data', (d) => { output += d; });
child.on('exit', (code, signal) => { exited = { code, signal }; });

const started = Date.now();
let healthy = null;
while (Date.now() - started < HEALTH_TIMEOUT_MS) {
  if (exited) break;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`);
    const body = await r.json().catch(() => null);
    if (r.ok && body && body.ok === true) { healthy = body; break; }
  } catch { /* not listening yet */ }
  await sleep(250);
}

await stopServer();
cleanupHome();

if (healthy) {
  const nodeVersion = execFileSync(nodeBin, ['--version'], { encoding: 'utf8' }).trim();
  console.log(`✓ packaged server booted: bundled node ${nodeVersion} ran server/server.js, GET /api/health → ${JSON.stringify(healthy)} after ${Date.now() - started}ms`);
  process.exit(0);
}
if (exited) fail(`server exited (code ${exited.code}, signal ${exited.signal}) before answering /api/health`);
fail(`server did not answer /api/health on :${port} within ${HEALTH_TIMEOUT_MS}ms`);

function fail(msg) {
  console.error(`\n✗ smoke-packaged-server: ${msg}`);
  if (output) {
    // Minified stack lines can be a megabyte long; keep the readable ones.
    const lines = output.split('\n').filter((l) => l.length < 400);
    console.error('--- server output ---\n' + lines.slice(-40).join('\n'));
  }
  process.exit(1);
}

async function stopServer() {
  if (!exited) {
    child.kill('SIGTERM');
    const deadline = Date.now() + 3000;
    while (!exited && Date.now() < deadline) await sleep(50);
    if (!exited) child.kill('SIGKILL');
  }
  // ptyd is a detached daemon and outlives the server on purpose; it must not
  // outlive the smoke test.
  try {
    const m = JSON.parse(fs.readFileSync(path.join(home, 'ptyd', 'manifest.json'), 'utf8'));
    if (typeof m.pid === 'number') process.kill(m.pid, 'SIGTERM');
  } catch { /* no daemon came up, or it is already gone */ }
}

function cleanupHome() {
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best-effort */ }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
