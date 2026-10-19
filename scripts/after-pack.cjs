// electron-builder's FileSet copier silently drops node_modules directories
// from extraResources, which strips the server's vendored node-pty out of the
// shipped app (ERR_MODULE_NOT_FOUND on tester machines — invisible when the
// app is tested inside the repo, where Node resolution walks up into the
// repo's own node_modules). Copy it in explicitly after packing.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// macOS privacy (TCC) judges a process by its "responsible process". The
// terminal daemon (ptyd) runs as a launchd job, so it is its own: before this,
// a bare Resources/bin/node with no bundle, no name and no usage strings —
// macOS silently refused it (and every agent in a Strado terminal) the
// microphone, without a prompt. So the Node runtime lives in a helper app with
// its own identity and microphone string; Resources/bin/node links to it (no
// second ~100 MB copy). Node reports its real path as process.execPath, so the
// daemon's launchd job runs the binary inside the helper bundle.
const TERMINALS_APP = 'Strado Terminals.app';
const TERMINALS_ID = 'io.strado.terminals';

function terminalsInfoPlist(version) {
  const entries = {
    CFBundleIdentifier: TERMINALS_ID,
    CFBundleName: 'Strado Terminals',
    CFBundleDisplayName: 'Strado Terminals',
    CFBundleExecutable: 'node',
    CFBundlePackageType: 'APPL',
    CFBundleShortVersionString: version,
    CFBundleVersion: version,
    CFBundleInfoDictionaryVersion: '6.0',
    LSMinimumSystemVersion: '12.0',
    NSMicrophoneUsageDescription: 'Agents in Strado terminals (like Claude Code dictation) use the microphone when you ask them to.',
  };
  const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    ...Object.entries(entries).map(([k, v]) => `  <key>${k}</key><string>${esc(v)}</string>`),
    // Background only: never a Dock icon or a menu bar.
    '  <key>LSUIElement</key><true/>',
    '  <key>LSBackgroundOnly</key><true/>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

/** Move Resources/bin/node into Contents/Helpers/Strado Terminals.app and link it back. Returns the helper's path. */
function makeTerminalsHelper(contentsDir, version) {
  const helper = path.join(contentsDir, 'Helpers', TERMINALS_APP);
  const exe = path.join(helper, 'Contents', 'MacOS', 'node');
  const binNode = path.join(contentsDir, 'Resources', 'bin', 'node');
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  fs.writeFileSync(path.join(helper, 'Contents', 'Info.plist'), terminalsInfoPlist(version));
  fs.renameSync(binNode, exe);
  fs.chmodSync(exe, 0o755);
  // ptyd looks for strado-disclaim beside the runtime's real path.
  const disclaim = path.join(contentsDir, 'Resources', 'bin', 'strado-disclaim');
  if (fs.existsSync(disclaim)) {
    fs.renameSync(disclaim, path.join(path.dirname(exe), 'strado-disclaim'));
    fs.chmodSync(path.join(path.dirname(exe), 'strado-disclaim'), 0o755);
  }
  // Relative, inside the bundle: the seal accepts it and a moved app keeps it.
  fs.symlinkSync(path.join('..', '..', 'Helpers', TERMINALS_APP, 'Contents', 'MacOS', 'node'), binNode);
  console.log(`  • after-pack: Node runtime moved into Helpers/${TERMINALS_APP} (${TERMINALS_ID})`);
  return helper;
}

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
    // the voice helper opens the mic: without device.audio-input the hardened
    // runtime blocks it before macOS ever shows the permission prompt
    { file: path.join(resourcesDir, 'bin', 'strado-speech'), entitle: true },
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
    // bin/node is a link into the Terminals helper, signed as its own bundle.
    if (!fs.existsSync(file) || fs.lstatSync(file).isSymbolicLink()) continue;
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

  let terminalsHelper = null;
  if (context.electronPlatformName === 'darwin') {
    terminalsHelper = makeTerminalsHelper(path.dirname(resourcesDir), context.packager.appInfo.version);
  }

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
    // The helper bundle (its main executable: the Node runtime) with the app's
    // entitlements: JIT for Node, audio-input for the microphone.
    if (terminalsHelper) {
      // Nested code first: the launcher (runtime only, it opens nothing), then the bundle.
      const disclaim = path.join(terminalsHelper, 'Contents', 'MacOS', 'strado-disclaim');
      if (fs.existsSync(disclaim)) {
        execFileSync('codesign', ['--force', '--sign', identity, '--options', 'runtime', '--timestamp', disclaim], { stdio: 'inherit' });
      }
      execFileSync('codesign', ['--force', '--sign', identity, '--options', 'runtime', '--timestamp',
        '--entitlements', entitlements, terminalsHelper], { stdio: 'inherit' });
      console.log(`  • after-pack: signed ${TERMINALS_APP}`);
    }
  }
};

module.exports.terminalsInfoPlist = terminalsInfoPlist;
module.exports.makeTerminalsHelper = makeTerminalsHelper;
