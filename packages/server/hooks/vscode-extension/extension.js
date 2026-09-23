// Strado's window reporter. Runs in each serve-web window's extension host
// (extensionKind: workspace) and tells the Strado server which workspace
// folder this host belongs to. Strado then rolls this process tree up under
// that worktree in Settings → Sessions — without it, every window is one
// anonymous lump under "VS Code".
//
// STRADO_SERVER is inherited from the serve-web spawn (Strado sets it for
// every child). No build step: plain CommonJS, loaded straight from the
// extensions dir Strado installs it into.
'use strict';

const HEARTBEAT_MS = 30_000;

function createReporter(deps) {
  const setI = deps.setInterval || setInterval;
  const clearI = deps.clearInterval || clearInterval;
  const base = String(deps.server || '').replace(/\/+$/, '');
  const url = `${base}/api/vscode/window`;
  let timer = null;
  let announced = false;

  const send = async (method, body) => {
    try {
      await deps.fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return true;
    } catch {
      return false; // Strado not up yet, or restarting — the next beat retries
    }
  };
  const announce = async () => {
    const folder = deps.folder();
    if (!folder || !base) return;
    announced = (await send('POST', { pid: deps.pid, folder })) || announced;
  };

  return {
    async start() {
      await announce();
      timer = setI(() => { void announce(); }, deps.intervalMs || HEARTBEAT_MS);
      if (timer && typeof timer.unref === 'function') timer.unref();
    },
    async stop() {
      if (timer) clearI(timer);
      timer = null;
      if (announced) await send('DELETE', { pid: deps.pid });
    },
  };
}

// Every Strado worktree comes from a repo the user added themselves, so
// VS Code's Restricted Mode only adds a "trust this folder?" step to every
// new worktree. serve-web keeps User settings in the browser and passes no
// extra server flags, so the one place to turn it off is from in here. Only
// when the user never set it; returns whether it changed anything.
async function disableWorkspaceTrust(cfg) {
  try {
    const current = cfg.inspect();
    if (current && typeof current.globalValue === 'boolean') return false; // the user chose
    await cfg.update(false);
    return true;
  } catch {
    return false;
  }
}

let reporter = null;

function activate(context) {
  const vscode = require('vscode');
  const folder = () => {
    const f = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
    return f && f.uri && f.uri.scheme === 'file' ? f.uri.fsPath : null;
  };
  reporter = createReporter({ fetch: globalThis.fetch, pid: process.pid, folder, server: process.env.STRADO_SERVER || '' });
  const trust = vscode.workspace.getConfiguration('security.workspace.trust');
  void disableWorkspaceTrust({
    inspect: () => trust.inspect('enabled'),
    update: (value) => trust.update('enabled', value, vscode.ConfigurationTarget.Global),
  }).then((changed) => {
    // The setting applies on reload. Only reload a window that is actually
    // restricted right now — a trusted one loses nothing by waiting.
    if (changed && !vscode.workspace.isTrusted) void vscode.commands.executeCommand('workbench.action.reloadWindow');
  });
  void reporter.start();
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => { void reporter.start(); }));
}

function deactivate() {
  return reporter ? reporter.stop() : undefined;
}

module.exports = { activate, deactivate, createReporter, disableWorkspaceTrust };
