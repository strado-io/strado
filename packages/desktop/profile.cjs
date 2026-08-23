// Profile resolution for the Electron shell.
//
// MUST stay byte-for-byte equivalent in behaviour to
// packages/server/src/profile.ts — the shell is CommonJS and cannot import the
// server's ESM bundle, so the rules exist twice.
// packages/server/src/profileParity.test.ts pins them together; change one and
// you must change the other.
//
// No Electron dependency on purpose, so the parity test can load it directly.
const os = require('node:os');
const path = require('node:path');

const DEFAULTS = {
  stable: { dirName: '.strado', port: 7777, cdpPort: 9222 },
  dev: { dirName: '.strado-dev', port: 7877, cdpPort: 9322 },
};

function resolveProfile(env, homedir) {
  const e = env ?? process.env;
  const home = homedir ?? os.homedir();
  const raw = e.STRADO_PROFILE === undefined ? undefined : String(e.STRADO_PROFILE).trim();
  if (raw !== undefined && raw !== '' && raw !== 'stable' && raw !== 'dev') {
    throw new Error(`STRADO_PROFILE must be "stable" or "dev" (got "${raw}")`);
  }
  const name = raw === 'dev' ? 'dev' : 'stable';
  const base = DEFAULTS[name];
  const dir = path.join(home, base.dirName);
  const portStr = e.PORT?.trim();
  const cdpPortStr = e.STRADO_CDP_PORT?.trim();
  return {
    name,
    homeDir: e.STRADO_HOME || dir,
    configDir: e.STRADO_CONFIG_DIR || (name === 'dev' ? path.join(dir, 'config') : null),
    port: Number(portStr || base.port),
    cdpPort: Number(cdpPortStr || base.cdpPort),
  };
}

module.exports = { resolveProfile };
