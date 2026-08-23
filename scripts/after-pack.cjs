// electron-builder's FileSet copier silently drops node_modules directories
// from extraResources, which strips the server's vendored node-pty out of the
// shipped app (ERR_MODULE_NOT_FOUND on tester machines — invisible when the
// app is tested inside the repo, where Node resolution walks up into the
// repo's own node_modules). Copy it in explicitly after packing.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Sign the Mach-O binaries that live under Resources/. electron-builder only
// signs the bundle's standard executable locations (MacOS/, Frameworks/,
// asar-unpacked modules) — our bundled Node, cmdwatch, and node-pty prebuilds
// are extraResources it never visits, and ONE unsigned executable anywhere in
// the bundle fails notarization. Must run in afterPack: electron-builder signs
// the outer bundle (sealing Resources/) right after this hook, so nested
// signatures have to exist first.
function signNestedBinaries(resourcesDir, identity, entitlements) {
  const targets = [
    // executables: get the hardened runtime + the same entitlements as the
    // app (bin/node runs the server and JITs; spawn-helper just needs runtime)
    { file: path.join(resourcesDir, 'bin', 'node'), entitle: true },
    { file: path.join(resourcesDir, 'bin', 'strado-cmdwatch'), entitle: false },
    {
      file: path.join(resourcesDir, 'server', 'node_modules', 'node-pty',
        'prebuilds', 'darwin-arm64', 'spawn-helper'),
      entitle: false,
    },
  ];
  // dylibs: every .node under the vendored modules (pty.node today; the walk
  // keeps a future prebuild rename from shipping unsigned)
  const modRoot = path.join(resourcesDir, 'server', 'node_modules');
  const stack = [modRoot];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(p);
      else if (entry.name.endsWith('.node')) targets.push({ file: p, entitle: false });
    }
  }

  let signed = 0;
  for (const { file, entitle } of targets) {
    if (!fs.existsSync(file)) continue;
    const args = ['--force', '--sign', identity, '--options', 'runtime', '--timestamp'];
    if (entitle) args.push('--entitlements', entitlements);
    args.push(file);
    execFileSync('codesign', args, { stdio: 'inherit' });
    signed += 1;
  }
  console.log(`  • after-pack: signed ${signed} nested Resources binaries as "${identity}"`);
}

module.exports = async function afterPack(context) {
  const src = path.join(context.packager.projectDir, 'build', 'pack', 'server', 'node_modules');

  // Resolve the packed app's Resources dir per platform. macOS nests it in the
  // .app bundle; Linux uses <appOutDir>/resources directly.
  let resourcesDir;
  if (context.electronPlatformName === 'darwin') {
    const appName = `${context.packager.appInfo.productFilename}.app`;
    resourcesDir = path.join(context.appOutDir, appName, 'Contents', 'Resources');
  } else if (context.electronPlatformName === 'linux') {
    resourcesDir = path.join(context.appOutDir, 'resources');
  } else {
    return; // unsupported platform; nothing to graft
  }

  const dst = path.join(resourcesDir, 'server', 'node_modules');
  fs.cpSync(src, dst, { recursive: true, dereference: true });

  // spawn-helper is a macOS-only executable node-pty execs; chmod it so the
  // packaged app can run it. Linux has no spawn-helper (build/Release/pty.node
  // is loaded via dlopen and needs no exec bit).
  if (context.electronPlatformName === 'darwin') {
    const spawnHelper = path.join(dst, 'node-pty', 'prebuilds', 'darwin-arm64', 'spawn-helper');
    if (fs.existsSync(spawnHelper)) fs.chmodSync(spawnHelper, 0o755);
  }

  console.log(`  • after-pack: vendored server node_modules into the ${context.electronPlatformName} app`);

  // Signed build (package-mac.mjs sets this when the signing env is present).
  // Runs AFTER the node_modules graft above so the freshly copied .node files
  // are what gets signed.
  const identity = process.env.STRADO_MAC_SIGNING_IDENTITY;
  if (identity && context.electronPlatformName === 'darwin') {
    const entitlements = path.join(
      context.packager.projectDir, 'packages', 'desktop', 'assets', 'entitlements.mac.plist',
    );
    signNestedBinaries(resourcesDir, identity, entitlements);
  }
};
