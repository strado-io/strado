// Bundle the daemon: single CJS file, node-pty external (native module,
// vendored next to the bundle in packaged builds; hoisted node_modules in dev).
import { build } from 'esbuild';
import fs from 'node:fs';

const pkg = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const main = fs.readFileSync(new URL('./src/main.ts', import.meta.url), 'utf8');
const m = main.match(/const DAEMON_VERSION = '([^']+)'/);
if (!m || m[1] !== pkg.version) {
  console.error(`[ptyd] DAEMON_VERSION in src/main.ts (${m?.[1]}) must match package.json version (${pkg.version})`);
  process.exit(1);
}

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/ptyd.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['node-pty'],
});
// The supervisor reads this file (next to the bundle) as the EXPECTED
// daemon version for upgrade-drift detection.
fs.writeFileSync(new URL('./dist/ptyd.version', import.meta.url), pkg.version);
console.log(`[ptyd] built dist/ptyd.cjs (v${pkg.version})`);
