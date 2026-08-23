import { chmodSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const prebuilds = path.join(scriptDir, '..', 'node_modules', 'node-pty', 'prebuilds');

if (existsSync(prebuilds)) {
  for (const dir of readdirSync(prebuilds)) {
    const helper = path.join(prebuilds, dir, 'spawn-helper');
    if (existsSync(helper)) {
      try {
        chmodSync(helper, 0o755);
        console.log(`[ensure-node-pty-exec] chmod +x ${path.relative(process.cwd(), helper)}`);
      } catch (err) {
        // non-fatal (e.g. Windows has no spawn-helper)
        console.warn(`[ensure-node-pty-exec] skip ${dir}: ${err.message}`);
      }
    }
  }
}
