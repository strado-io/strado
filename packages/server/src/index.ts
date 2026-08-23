import { resolveProfile, listenErrorMessage } from './profile.js';
import { applyProfileEnv } from './profileEnv.js';

// Which instance is this — the installed release or a repo build? See
// ./profile.ts. STRADO_HOME / STRADO_CONFIG_DIR / PORT still override.
//
// This MUST happen before ./app.js and ./services/vscodeWeb.js are evaluated.
// vscodeWeb builds a manager at module load that captures daemonFilePath()
// immediately, so a static import here would pin ~/.strado even for the dev
// profile — verified by a real dev launch writing into the stable state dir.
// Static ESM imports are hoisted above all statements, hence the dynamic ones.
const profile = resolveProfile();
applyProfileEnv(profile);

const { buildApp, buildDeps } = await import('./app.js');
const { reapOrphans } = await import('./services/vscodeWeb.js');

const PORT = profile.port;
const HOST = '127.0.0.1';

const deps = await buildDeps({
  configDir: profile.configDir ?? undefined,
  homeStateDir: profile.homeDir,
});
const app = await buildApp(deps);

await reapOrphans(); // kill serve-web daemons orphaned by a prior crash/quit

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.once(sig, () => {
    void app.close().finally(() => process.exit(0));
  });
}

try {
  await app.listen({ host: HOST, port: PORT });
} catch (err) {
  const message = listenErrorMessage(err as NodeJS.ErrnoException, profile);
  app.log.error(message);
  deps.debugLog.log('server', `listen failed: ${message}`);
  process.exit(1);
}
app.log.info(`strado [${profile.name}] listening on http://${HOST}:${PORT}`);
deps.debugLog.log(
  'server',
  `listening on http://${HOST}:${PORT} (profile ${profile.name}, home ${profile.homeDir}) — logs at ${deps.debugLog.path}`,
);
