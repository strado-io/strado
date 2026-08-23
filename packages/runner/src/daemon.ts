// The long-running process systemd invokes: the Strado server plus the relay
// tunnel client in ONE process.
//
// Splitting them buys nothing: ptyd owns the PTYs out of process, so a restart
// here (upgrade, crash, reboot) leaves agents running and reattaches them.
import { buildApp, buildDeps } from '@strado/server/app';
import { isForwardablePort } from '@strado/server/forwardable-ports';
import { TunnelClient } from '@strado/relay';
import { readIdentity } from './identity.js';
import { applyBundleEnv, bundleVersion, loadEnvFile, runnerPaths } from './paths.js';
import { startSelfUpdate } from './selfUpdate.js';

export async function runDaemon(): Promise<void> {
  const paths = runnerPaths();
  loadEnvFile(paths.envFile);
  applyBundleEnv(paths);
  const version = bundleVersion(paths);

  const identity = readIdentity(paths.identity);
  if (!identity) {
    console.error(
      'no runner identity — pair this machine first:\n' +
        '  strado-runner pair --code PAIR-XXXX-XXXX\n' +
        '(mint a code from the Strado app on your own machine)',
    );
    process.exit(2);
  }

  const port = Number(process.env.PORT ?? 7777);
  const relayUrl = process.env.RELAY_URL ?? 'wss://api.strado.io';
  const clientDomain = process.env.RELAY_DOMAIN ?? 'r.strado.io';

  // Tell the server what it's running inside, so /api/capabilities can warn
  // clients that the Electron-only surfaces (VS Code embed, preview browser)
  // are absent here. Also surfaces the version on /api/health.
  process.env.STRADO_RUNNER = '1';
  if (!process.env.STRADO_APP_VERSION && version !== 'dev') process.env.STRADO_APP_VERSION = version;

  const deps = await buildDeps({
    configDir: process.env.STRADO_CONFIG_DIR || undefined,
    homeStateDir: process.env.STRADO_HOME || undefined,
  });
  const app = await buildApp(deps);

  // Loopback only. The tunnel is the sole ingress; nothing about the runner
  // opens a network-reachable port, which is what makes corp/VPN adoption
  // possible at all.
  await app.listen({ host: '127.0.0.1', port });
  console.log(`[runner] strado ${version} listening on http://127.0.0.1:${port}`);

  const tunnel = new TunnelClient({
    relayUrl,
    runnerId: identity.runnerId,
    token: identity.runnerToken,
    accessKey: identity.accessKey,
    localPort: port,
    runnerVersion: version,
    // Port forwarding: reads the same stores the API does, in this process, so
    // a worktree created a moment ago is immediately forwardable. Refusing the
    // runner's own strado port too — it already has a route through the tunnel,
    // and a second one would only be a way to loop traffic back on itself.
    isPortAllowed: async (p) => p !== port && (await isForwardablePort(deps, p)),
    onStatusChange: (status) => {
      console.log(
        status === 'connected'
          ? `[runner] online as "${identity.runnerId}" — reachable at https://${identity.runnerId}.${clientDomain}`
          : '[runner] tunnel offline — reconnecting',
      );
    },
  });
  tunnel.start();

  const stopUpdater =
    process.env.STRADO_RUNNER_AUTOUPDATE === '0'
      ? () => {}
      : startSelfUpdate({ apiUrl: identity.apiUrl, currentVersion: version, paths });

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('[runner] shutting down (agent sessions stay alive in ptyd)');
    stopUpdater();
    tunnel.stop();
    void app.close().finally(() => process.exit(0));
  };
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.once(sig, shutdown);

  // A crashed tunnel or a bad request must never take the runner down and
  // orphan the user's agents.
  process.on('uncaughtException', (err) => console.error('[runner] uncaughtException (suppressed)', err));
  process.on('unhandledRejection', (reason) => console.error('[runner] unhandledRejection (suppressed)', reason));
}
