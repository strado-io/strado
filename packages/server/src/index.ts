import { resolveProfile, listenErrorMessage } from './profile.js';
import { applyProfileEnv } from './profileEnv.js';

// Which instance is this — the installed release or a repo build? See
// ./profile.ts. STRADO_HOME / STRADO_CONFIG_DIR / PORT still override.
//
// This MUST happen before ./app.js is evaluated: modules that capture
// STRADO_HOME at load would otherwise pin ~/.strado even for the dev profile.
// Static ESM imports are hoisted above all statements, hence the dynamic ones.
const profile = resolveProfile();
applyProfileEnv(profile);

const { buildApp, buildDeps } = await import('./app.js');
const { cleanupServeWeb } = await import('./services/editors/serveWebCleanup.js');

const PORT = profile.port;
const HOST = '127.0.0.1';

const deps = await buildDeps({
  configDir: profile.configDir ?? undefined,
  homeStateDir: profile.homeDir,
});
const app = await buildApp(deps);

// The embedded VS Code is gone: stop any serve-web a previous version left
// running, and drop its records.
const leftover = await cleanupServeWeb();
if (leftover.stopped.length) app.log.info(`stopped ${leftover.stopped.length} serve-web left by the embedded VS Code`);

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
// Git hosts behind a VPN that's off: known before the first page asks.
void import('./routes/gitProvider.js').then((m) => m.warmProviderHosts(deps)).catch(() => {});
deps.debugLog.log(
  'server',
  `listening on http://${HOST}:${PORT} (profile ${profile.name}, home ${profile.homeDir}) — logs at ${deps.debugLog.path}`,
);
