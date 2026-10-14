// Builds the self-hosted runner tarball: bundled server+tunnel+CLI, a pinned
// Node runtime, prebuilt node-pty, the ptyd daemon, and the web SPA.
//
// This is package-linux.mjs up to (but not including) electron-builder — no
// Electron, so no VS Code embed and no preview browser on a runner.
//
// MUST run on a Linux x64 host: it vendors that host's native node-pty
// prebuild and its `node` binary. Run from the repo root:
//   node scripts/package-runner.mjs
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const PACK = path.join(ROOT, 'build', 'runner-pack');
const OUT = path.join(ROOT, 'release');
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', cwd: ROOT, ...opts });
const step = (name) => console.log(`\n\x1b[36m▸ ${name}\x1b[0m`);

if (process.platform !== 'linux' || process.arch !== 'x64') {
  console.error(
    `package-runner.mjs must run on Linux x64 (vendors this host's node-pty prebuild + node binary); this is ${process.platform}-${process.arch}.`,
  );
  process.exit(1);
}

// The runner versions INDEPENDENTLY of the desktop app: publishing a runner
// build must never imply a desktop release, so this reads
// packages/runner/package.json, not the repo root.
const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'packages/runner/package.json'), 'utf8')).version;
const stage = path.join(PACK, `strado-runner-${version}`);

fs.rmSync(PACK, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
fs.mkdirSync(path.join(stage, 'bin'));
fs.mkdirSync(OUT, { recursive: true });

step('build web + server (tsc/vite)');
run('npm', ['run', 'build']);

step('build runner');
// Relay is built by the root `build` above — it has to be, because the server
// imports @strado/relay/protocol for the port-forwarding wire constants. Leaving
// it out of the root build meant a clean box compiled the server against a STALE
// relay dist and failed with "has no exported member TCP_FORWARD_PATH".
run('npm', ['run', 'build', '-w', 'packages/runner']);

step('bundle runner (server + tunnel + CLI) → single file');
// The runner entry pulls in @strado/server and @strado/relay, so one bundle
// covers the whole daemon. node-pty stays external (native).
run('npx', [
  'esbuild', 'packages/runner/dist/index.js',
  '--bundle', '--minify', '--platform=node', '--format=esm', '--target=node20',
  '--external:node-pty',
  // Same trap package-mac.mjs hit in 0.1.53: jsonc-parser's CJS entry is a UMD
  // wrapper that calls require() through a factory parameter, so esbuild
  // cannot follow its './impl/*' requires and the daemon dies with
  // MODULE_NOT_FOUND the first time agent config is touched. Runner 0.1.30
  // shipped that way; point esbuild at the package's ESM build instead.
  '--alias:jsonc-parser=jsonc-parser/lib/esm/main.js',
  `--banner:js=import{createRequire}from'node:module';const require=createRequire(import.meta.url);`,
  `--outfile=${path.join(stage, 'runner.mjs')}`,
]);
fs.writeFileSync(
  path.join(stage, 'package.json'),
  `${JSON.stringify({ name: 'strado-runner', private: true, type: 'module', version }, null, 2)}\n`,
);
fs.writeFileSync(path.join(stage, 'version'), version);

step('copy agent status hooks');
fs.cpSync(path.join(ROOT, 'packages/server/hooks'), path.join(stage, 'hooks'), { recursive: true });

step('copy sandbox base-image assets (Dockerfile)');
// image.ts self-locates the base-image Dockerfile from assets/sandbox; without
// it a packaged runner's `podman build` throws and every sandboxed worktree
// silently degrades to unsandboxed host execution. paths.ts points
// STRADO_SANDBOX_ASSETS here.
fs.cpSync(path.join(ROOT, 'packages/server/assets/sandbox'), path.join(stage, 'assets', 'sandbox'), {
  recursive: true,
});

step('vendor node-pty (prebuilt, N-API) + node-addon-api');
for (const mod of ['node-pty', 'node-addon-api']) {
  fs.cpSync(path.join(ROOT, 'node_modules', mod), path.join(stage, 'node_modules', mod), {
    recursive: true,
    dereference: true,
  });
}
// node-pty 1.2.x ships prebuilds/linux-x64/pty.node; 1.1.x compiled to
// build/Release/pty.node. Either satisfies the runtime loader.
const ptyCandidates = [
  path.join(stage, 'node_modules/node-pty/prebuilds/linux-x64/pty.node'),
  path.join(stage, 'node_modules/node-pty/build/Release/pty.node'),
];
if (!ptyCandidates.some((p) => fs.existsSync(p))) {
  console.error(
    `missing node-pty binding (looked at ${ptyCandidates.join(', ')}) — run npm install on this Linux x64 box first.`,
  );
  process.exit(1);
}

step('bundle ptyd daemon');
run('npx', [
  'esbuild', 'packages/ptyd/src/main.ts',
  '--bundle', '--minify', '--platform=node', '--format=cjs', '--target=node20',
  '--external:node-pty',
  `--outfile=${path.join(stage, 'ptyd.cjs')}`,
]);
fs.writeFileSync(
  path.join(stage, 'ptyd.version'),
  JSON.parse(fs.readFileSync(path.join(ROOT, 'packages/ptyd/package.json'), 'utf8')).version,
);

step('copy web dist');
fs.cpSync(path.join(ROOT, 'packages/web/dist'), path.join(stage, 'web'), { recursive: true });

step('pin the Node runtime');
fs.cpSync(process.execPath, path.join(stage, 'bin', 'node'));
fs.chmodSync(path.join(stage, 'bin', 'node'), 0o755);

step('smoke-test the bundle');
// Catch a bundle that can't even start (bad externals, missing native module)
// here rather than on a tester's box. `version` exercises the CLI path only.
const smoke = execFileSync(path.join(stage, 'bin', 'node'), [path.join(stage, 'runner.mjs'), 'version'], {
  encoding: 'utf8',
  env: { ...process.env, STRADO_HOME: path.join(PACK, 'smoke-home') },
}).trim();
if (smoke !== version) {
  console.error(`smoke test failed: expected "${version}", got "${smoke}"`);
  process.exit(1);
}
console.log(`  bundle reports version ${smoke}`);

// `version` never initialises the server, so a bundle can pass it and still
// crash the daemon on boot (0.1.30: jsonc-parser's UMD require). Boot the real
// daemon against a dead relay with a throwaway identity and require
// /api/health to answer. No network leaves the box: the relay URL is a closed
// loopback port and auto-update is off.
step('smoke-test the daemon boots');
await smokeBootDaemon();

async function smokeBootDaemon() {
  const home = path.join(PACK, 'smoke-daemon-home');
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(
    path.join(home, 'runner.json'),
    JSON.stringify({
      runnerId: 'smoke-test',
      runnerToken: 'b'.repeat(64),
      accessKey: 'a'.repeat(32),
      apiUrl: 'http://127.0.0.1:9',
      relayUrl: 'ws://127.0.0.1:9',
    }),
  );
  const port = 7000 + Math.floor(Math.random() * 1000);
  const env = {
    ...process.env,
    STRADO_HOME: home,
    STRADO_RUNNER_AUTOUPDATE: '0',
    STRADO_SANDBOX: '0',
    PORT: String(port),
    RELAY_URL: 'ws://127.0.0.1:9',
  };
  // /api/health must report the BUNDLE's version, not one inherited from the
  // build shell.
  delete env.STRADO_APP_VERSION;
  const child = spawn(path.join(stage, 'bin', 'node'), [path.join(stage, 'runner.mjs'), 'run'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  let exited = null;
  child.on('exit', (code, signal) => { exited = { code, signal }; });
  const deadline = Date.now() + 30_000;
  let healthy = false;
  while (Date.now() < deadline && !exited) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      const body = await res.json();
      if (res.ok && body.version === version) { healthy = true; break; }
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill('SIGTERM');
  await new Promise((r) => { if (exited) r(); else child.on('exit', r); });
  fs.rmSync(home, { recursive: true, force: true });
  if (!healthy) {
    console.error(`daemon smoke test failed: /api/health never reported ${version}\n--- daemon output ---\n${output.slice(-4000)}`);
    process.exit(1);
  }
  console.log(`  daemon booted and /api/health reports ${version}`);
}

step('tar.gz');
const artifact = path.join(OUT, `strado-runner-${version}-linux-x64.tar.gz`);
fs.rmSync(artifact, { force: true });
run('tar', ['-czf', artifact, '-C', PACK, `strado-runner-${version}`]);

const buf = fs.readFileSync(artifact);
const sha = crypto.createHash('sha256').update(buf).digest('hex');
console.log('\n\x1b[32m✓ runner artifact in release/\x1b[0m');
console.log(path.basename(artifact));
console.log(`  sha256: ${sha}`);
console.log(`  size:   ${(buf.length / 1e6).toFixed(1)} MB`);
console.log('\nrelease.json block to merge on the api box:');
console.log(
  JSON.stringify(
    { runner: { version, url: `https://api.strado.io/v1/download/${path.basename(artifact)}`, sha256: sha } },
    null,
    2,
  ),
);
