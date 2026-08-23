// Builds the distributable macOS (arm64) app: bundled+minified JS, a pinned
// Node runtime for the server child, prebuilt node-pty, compiled cmdwatch,
// then electron-builder → DMG. Run from the repo root: node scripts/package-mac.mjs
//
// Testers get a DMG with NO source layout — main/preload live minified in an
// asar, server/web live minified under Resources/.
//
// SIGNING (opt-in via env; all-or-nothing):
//   STRADO_MAC_SIGNING_IDENTITY  "Developer ID Application: <Name> (<TEAMID>)"
//   APPLE_API_KEY                path to the App Store Connect .p8 key
//   APPLE_API_KEY_ID             the key's ID
//   APPLE_API_ISSUER             the issuer UUID
// All four set → signed (hardened runtime + entitlements), notarized, and
// stapled; the script then verifies with codesign/spctl/stapler and fails the
// build on any miss. None set → the historical ad-hoc build (first launch
// needs `xattr -cr /Applications/Strado.app`). A partial set fails fast: a
// half-signed artifact looks shippable and dies on testers' machines.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const PACK = path.join(ROOT, 'build', 'pack');
const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: 'inherit', cwd: ROOT, ...opts });

const step = (name) => console.log(`\n\x1b[36m▸ ${name}\x1b[0m`);

/**
 * Refuse to ship a Node the tester's machine cannot run.
 *
 * We bundle `process.execPath`, which is only safe when it is a self-contained
 * binary. Homebrew's Node is not: it is a ~70 KB stub against
 * `@rpath/libnode.<abi>.dylib` plus Cellar dylibs, none of which are copied. A
 * build that happens to resolve `node` to Homebrew therefore produces an app
 * whose server child dies at launch with `Library not loaded: libnode…` and
 * SIGABRT — which is exactly what 0.1.24 shipped, because nothing here looked.
 *
 * Two cheap checks, either of which would have caught it: the binary must
 * actually execute, and it must not link anything outside /usr/lib and
 * /System. nvm and nodejs.org builds pass both; Homebrew's fails both.
 */
function assertSelfContainedNode(binary) {
  const size = fs.statSync(binary).size;
  let version;
  try {
    version = execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim();
  } catch (err) {
    throw new Error(
      `bundled Node at ${binary} does not run (${(err.message || '').split('\n')[0]}).\n` +
        `  source: ${process.execPath} (${(size / 1e6).toFixed(1)} MB)\n` +
        `  This is almost always Homebrew's Node, which needs libnode.dylib.\n` +
        `  Re-run the build with a self-contained Node, e.g.\n` +
        `    PATH="$HOME/.nvm/versions/node/$(cat "$HOME/.nvm/alias/default" 2>/dev/null || echo v20.19.4)/bin:$PATH" node scripts/package-mac.mjs`,
    );
  }
  const foreign = execFileSync('otool', ['-L', binary], { encoding: 'utf8' })
    .split('\n')
    .slice(1)
    .map((l) => l.trim().split(' ')[0])
    .filter(Boolean)
    .filter((lib) => !lib.startsWith('/usr/lib/') && !lib.startsWith('/System/'));
  if (foreign.length) {
    throw new Error(
      `bundled Node links libraries that will not exist on a tester's machine:\n` +
        foreign.map((l) => `    ${l}`).join('\n') +
        `\n  source: ${process.execPath}\n  Use a self-contained Node (nvm or nodejs.org), not Homebrew's.`,
    );
  }
  console.log(`  node ${version}, ${(size / 1e6).toFixed(1)} MB, no foreign dylibs`);
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
  // CJS externals under an ESM bundle need a require shim
  `--banner:js=import{createRequire}from'node:module';const require=createRequire(import.meta.url);`,
  `--outfile=${path.join(PACK, 'server', 'server.js')}`,
]);
fs.writeFileSync(
  path.join(PACK, 'server', 'package.json'),
  JSON.stringify({ name: 'strado-server', private: true, type: 'module', version: '0.0.0' }),
);
fs.cpSync(path.join(ROOT, 'packages/server/hooks'), path.join(PACK, 'server', 'hooks'), { recursive: true });

step('bundle strado-forward (port forwarding child)');
run('npx', [
  'esbuild', 'packages/server/dist/forwardMain.js',
  '--bundle', '--minify', '--platform=node', '--format=esm', '--target=node20',
  `--banner:js=import{createRequire}from'node:module';const require=createRequire(import.meta.url);`,
  `--outfile=${path.join(PACK, 'server', 'forward.js')}`,
]);

step('bundle ptyd daemon');
run('npx', ['esbuild', 'packages/ptyd/src/main.ts',
  '--bundle', '--minify', '--platform=node', '--format=cjs', '--target=node20',
  '--external:node-pty',
  `--outfile=${path.join(PACK, 'server', 'ptyd.cjs')}`,
]);
const ptydPkg = JSON.parse(fs.readFileSync('packages/ptyd/package.json', 'utf8'));
fs.writeFileSync(path.join(PACK, 'server', 'ptyd.version'), ptydPkg.version);

step('vendor node-pty (prebuilt, N-API) + node-addon-api');
for (const mod of ['node-pty', 'node-addon-api']) {
  fs.cpSync(path.join(ROOT, 'node_modules', mod), path.join(PACK, 'server', 'node_modules', mod), {
    recursive: true,
    dereference: true,
  });
}
const spawnHelper = path.join(PACK, 'server', 'node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper');
if (fs.existsSync(spawnHelper)) fs.chmodSync(spawnHelper, 0o755);

step('copy web dist');
fs.cpSync(path.join(ROOT, 'packages/web/dist'), path.join(PACK, 'web'), { recursive: true });

step('pin the Node runtime');
const bundledNode = path.join(PACK, 'bin', 'node');
fs.cpSync(process.execPath, bundledNode);
fs.chmodSync(bundledNode, 0o755);
assertSelfContainedNode(bundledNode);

step('compile cmdwatch');
run('cc', ['-O2', '-framework', 'ApplicationServices', 'packages/desktop/cmdwatch.c', '-o', path.join(PACK, 'bin', 'strado-cmdwatch')]);

step('bundle desktop main/preload + preview MCP (minified)');
run('npx', ['esbuild', 'packages/desktop/main.cjs', '--bundle', '--minify', '--platform=node', '--format=cjs', '--external:electron', `--outfile=${path.join(PACK, 'app', 'main.cjs')}`]);
run('npx', ['esbuild', 'packages/desktop/preload.cjs', '--bundle', '--minify', '--platform=node', '--format=cjs', '--external:electron', `--outfile=${path.join(PACK, 'app', 'preload.cjs')}`]);
run('npx', ['esbuild', 'packages/desktop/preview-mcp.cjs', '--bundle', '--minify', '--platform=node', '--format=cjs', `--outfile=${path.join(PACK, 'bin', 'preview-mcp.cjs')}`]);
const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
fs.writeFileSync(
  path.join(PACK, 'app', 'package.json'),
  JSON.stringify({ name: 'strado', productName: 'Strado', private: true, version: rootPkg.version, main: 'main.cjs' }),
);

// --- signing env contract (see header) ---
const SIGN_ENV = ['STRADO_MAC_SIGNING_IDENTITY', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'];
const signEnvSet = SIGN_ENV.filter((k) => process.env[k]);
if (signEnvSet.length > 0 && signEnvSet.length < SIGN_ENV.length) {
  const missing = SIGN_ENV.filter((k) => !process.env[k]);
  console.error(`signing env is partial — set all of ${SIGN_ENV.join(', ')} or none (missing: ${missing.join(', ')})`);
  process.exit(1);
}
const SIGNING = signEnvSet.length === SIGN_ENV.length;
if (SIGNING && !fs.existsSync(process.env.APPLE_API_KEY)) {
  console.error(`APPLE_API_KEY does not exist: ${process.env.APPLE_API_KEY}`);
  process.exit(1);
}

step(SIGNING ? 'electron-builder → DMG (arm64, signed + notarized)' : 'electron-builder → DMG (arm64, unsigned)');
// --publish never: on CI machines electron-builder otherwise auto-enters
// publish mode and demands GH_TOKEN. Releases go through the private runbook.
const builderArgs = ['electron-builder', '--config', 'electron-builder.yml', '--mac', 'dmg', '--arm64', '--publish', 'never'];
if (SIGNING) {
  // The yml pins identity: null for the ad-hoc default; override it and turn
  // notarization on here. electron-builder picks up the APPLE_API_* env vars
  // for notarytool on its own. after-pack.cjs reads the identity env to sign
  // the nested Resources binaries before the outer bundle is sealed.
  // electron-builder rejects the "Developer ID Application:" prefix (it picks
  // the cert type itself); codesign in after-pack.cjs wants the full string —
  // so the env var stays canonical and the prefix is stripped only here.
  const builderIdentity = process.env.STRADO_MAC_SIGNING_IDENTITY
    .replace(/^Developer ID Application:\s*/, '');
  builderArgs.push(
    `-c.mac.identity=${builderIdentity}`,
    '-c.mac.notarize=true',
  );
}
run('npx', builderArgs);

if (SIGNING) {
  // Trust nothing about the pipeline above: prove the artifact on disk is
  // what a stranger's Gatekeeper will accept, and kill the build if not.
  const appPath = path.join(ROOT, 'release', 'mac-arm64', 'Strado.app');
  step('verify signature, Gatekeeper assessment, and stapled ticket');
  run('codesign', ['--verify', '--deep', '--strict', appPath]);
  run('spctl', ['-a', '-vv', '--type', 'exec', appPath]);
  run('xcrun', ['stapler', 'validate', appPath]);
}

console.log(`\n\x1b[32m✓ DMG in release/ (${SIGNING ? 'signed + notarized' : 'unsigned ad-hoc'})\x1b[0m`);

const dmgPath = path.join(ROOT, 'release', `Strado-${rootPkg.version}-arm64.dmg`);
if (fs.existsSync(dmgPath)) {
  const buf = fs.readFileSync(dmgPath);
  console.log(`sha256: ${crypto.createHash('sha256').update(buf).digest('hex')}`);
  console.log(`size:   ${(buf.length / 1e6).toFixed(1)} MB`);
}
