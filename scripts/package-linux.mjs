// Builds the distributable Linux (x64) app: bundled+minified JS, a pinned
// Node runtime for the server child, prebuilt node-pty, then electron-builder
// → AppImage + .deb. MUST run on a Linux x64 host (native node-pty prebuild +
// a Linux `node` for the pinned runtime). Run from the repo root:
//   node scripts/package-linux.mjs
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const PACK = path.join(ROOT, 'build', 'pack');
const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: 'inherit', cwd: ROOT, ...opts });

const step = (name) => console.log(`\n\x1b[36m▸ ${name}\x1b[0m`);

if (process.platform !== 'linux') {
  console.error('package-linux.mjs must run on Linux x64 (native node-pty + pinned node).');
  process.exit(1);
}

fs.rmSync(PACK, { recursive: true, force: true });
fs.mkdirSync(PACK, { recursive: true });
for (const dir of ['app', 'server', 'web', 'bin']) fs.mkdirSync(path.join(PACK, dir));

step('build web + server (tsc/vite)');
run('npm', ['run', 'build']);

step('bundle server → single minified file');
run('npx', [
  'esbuild', 'packages/server/dist/index.js',
  '--bundle', '--minify', '--platform=node', '--format=esm',
  '--external:node-pty',
  `--banner:js=import{createRequire}from'node:module';const require=createRequire(import.meta.url);`,
  `--outfile=${path.join(PACK, 'server', 'server.js')}`,
]);
fs.writeFileSync(
  path.join(PACK, 'server', 'package.json'),
  JSON.stringify({ name: 'strado-server', private: true, type: 'module', version: '0.0.0' }),
);
fs.cpSync(path.join(ROOT, 'packages/server/hooks'), path.join(PACK, 'server', 'hooks'), { recursive: true });

step('vendor node-pty (prebuilt, N-API) + node-addon-api');
for (const mod of ['node-pty', 'node-addon-api']) {
  fs.cpSync(path.join(ROOT, 'node_modules', mod), path.join(PACK, 'server', 'node_modules', mod), {
    recursive: true,
    dereference: true,
  });
}
// node-pty 1.2.x ships a linux-x64 prebuild (prebuilds/linux-x64/pty.node);
// 1.1.x compiled from source to build/Release/pty.node. Accept either — the
// runtime loads build/Release first, then prebuilds/<platform>-<arch>.
// (spawn-helper is macOS-only; Linux uses forkpty directly.)
const ptyCandidates = [
  path.join(PACK, 'server', 'node_modules/node-pty/prebuilds/linux-x64/pty.node'),
  path.join(PACK, 'server', 'node_modules/node-pty/build/Release/pty.node'),
];
if (!ptyCandidates.some((p) => fs.existsSync(p))) {
  console.error(`missing node-pty binding (looked at ${ptyCandidates.join(', ')}) — run npm install on this Linux x64 box first.`);
  process.exit(1);
}

step('bundle ptyd daemon');
run('npx', ['esbuild', 'packages/ptyd/src/main.ts',
  '--bundle', '--minify', '--platform=node', '--format=cjs', '--target=node20',
  '--external:node-pty',
  `--outfile=${path.join(PACK, 'server', 'ptyd.cjs')}`,
]);
const ptydPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'packages/ptyd/package.json'), 'utf8'));
fs.writeFileSync(path.join(PACK, 'server', 'ptyd.version'), ptydPkg.version);

step('copy web dist');
fs.cpSync(path.join(ROOT, 'packages/web/dist'), path.join(PACK, 'web'), { recursive: true });

step('pin the Node runtime');
const bundledNode = path.join(PACK, 'bin', 'node');
fs.cpSync(process.execPath, bundledNode);
fs.chmodSync(bundledNode, 0o755);
// The macOS build shipped 0.1.24 with Homebrew's ~70 KB stub Node instead of a
// real one, and nothing noticed until the app failed to start on a tester's
// machine. Same trap here: only bundle a Node that actually runs, and refuse
// anything linking a library that will not exist on the target box (`ldd`
// prints "not found" for those; system libs under /lib and /usr/lib are fine).
{
  let version;
  try {
    version = execFileSync(bundledNode, ['--version'], { encoding: 'utf8' }).trim();
  } catch (err) {
    throw new Error(
      `bundled Node at ${bundledNode} does not run (${(err.message || '').split('\n')[0]}).\n` +
        `  source: ${process.execPath}\n  Build with a self-contained Node (nvm or nodejs.org).`,
    );
  }
  const missing = execFileSync('ldd', [bundledNode], { encoding: 'utf8' })
    .split('\n')
    .filter((l) => l.includes('not found'));
  if (missing.length) {
    throw new Error(`bundled Node has unresolved libraries:\n${missing.join('\n')}`);
  }
  console.log(`  node ${version}, ${(fs.statSync(bundledNode).size / 1e6).toFixed(1)} MB, all libraries resolve`);
}

// NOTE: cmdwatch is macOS-only (CGEventSourceFlagsState) and is intentionally
// NOT compiled or shipped on Linux — main.cjs guards startCmdWatch to darwin.

step('bundle desktop main/preload + preview MCP (minified)');
run('npx', ['esbuild', 'packages/desktop/main.cjs', '--bundle', '--minify', '--platform=node', '--format=cjs', '--external:electron', `--outfile=${path.join(PACK, 'app', 'main.cjs')}`]);
run('npx', ['esbuild', 'packages/desktop/preload.cjs', '--bundle', '--minify', '--platform=node', '--format=cjs', '--external:electron', `--outfile=${path.join(PACK, 'app', 'preload.cjs')}`]);
run('npx', ['esbuild', 'packages/desktop/preview-mcp.cjs', '--bundle', '--minify', '--platform=node', '--format=cjs', `--outfile=${path.join(PACK, 'bin', 'preview-mcp.cjs')}`]);
const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
fs.writeFileSync(
  path.join(PACK, 'app', 'package.json'),
  JSON.stringify({ name: 'strado', productName: 'Strado', private: true, version: rootPkg.version, main: 'main.cjs', homepage: 'https://strado.io' }),
);

step('electron-builder → AppImage + .deb (x64, unsigned)');
// --publish never: on CI machines electron-builder otherwise auto-enters
// publish mode and demands GH_TOKEN. Releases go through the private runbook.
run('npx', ['electron-builder', '--config', 'electron-builder.yml', '--linux', 'AppImage', 'deb', '--x64', '--publish', 'never']);

console.log('\n\x1b[32m✓ artifacts in release/\x1b[0m');

for (const f of fs.readdirSync(path.join(ROOT, 'release'))) {
  if (!/\.(AppImage|deb)$/.test(f)) continue;
  const buf = fs.readFileSync(path.join(ROOT, 'release', f));
  console.log(`${f}`);
  console.log(`  sha256: ${crypto.createHash('sha256').update(buf).digest('hex')}`);
  console.log(`  size:   ${(buf.length / 1e6).toFixed(1)} MB`);
}
