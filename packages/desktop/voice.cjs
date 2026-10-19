// "Talk to Strado": the main-process side of voice
// (spec: docs/specs/2026-10-17-strado-voice-design.md). It owns one
// long-lived strado-speech helper (packages/desktop/speech.swift), sends it
// start/stop/cancel, and forwards its events to the window that started the
// session. macOS only; elsewhere `available` is false and nothing spawns.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** The helper binary: shipped in packaged builds; compiled once from source
 * into userData in dev (like cmdwatch). Null when it can't be had. */
function resolveHelper({ resources, userData, here, spawnSync, log }) {
  const shipped = path.join(resources, 'bin', 'strado-speech');
  if (fs.existsSync(shipped)) return shipped;
  const bin = path.join(userData, 'strado-speech');
  const src = path.join(here, 'speech.swift');
  const plist = path.join(here, 'speech-Info.plist');
  try {
    const stale = !fs.existsSync(bin)
      || fs.statSync(bin).mtimeMs < Math.max(fs.statSync(src).mtimeMs, fs.statSync(plist).mtimeMs);
    if (stale) {
      const r = spawnSync('swiftc', ['-O', src, '-o', bin,
        '-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__info_plist', '-Xlinker', plist]);
      if (r.status !== 0) throw new Error(String(r.stderr || r.error));
    }
    return bin;
  } catch (err) {
    log(`voice unavailable (could not build strado-speech): ${String(err?.message ?? err).slice(0, 300)}`);
    return null;
  }
}

/** Contextual names: strings only, trimmed, deduped, capped (the helper takes 100). */
function cleanContextual(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const v of list) {
    if (typeof v !== 'string') continue;
    const s = v.trim().slice(0, 80);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= 100) break;
  }
  return out;
}

function createVoice({ platform, resolve, spawn, log = () => {}, trace = () => {} }) {
  let child = null;
  let owner = null; // webContents of the session in progress
  let helper; // undefined = not resolved yet

  const available = () => platform === 'darwin';

  const send = (evt) => {
    if (owner && !owner.isDestroyed()) owner.send('strado:voice-event', evt);
  };

  const ensure = () => {
    if (child) return child;
    if (helper === undefined) helper = resolve();
    if (!helper) return null;
    child = spawn(helper, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    let errBuf = '';
    child.stderr?.on('data', (d) => {
      errBuf += d.toString();
      let nl;
      while ((nl = errBuf.indexOf('\n')) >= 0) { const l = errBuf.slice(0, nl).trim(); errBuf = errBuf.slice(nl + 1); if (l) trace(`helper: ${l}`); }
    });
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let evt;
        try { evt = JSON.parse(line); } catch { continue; }
        if (evt.type === 'ready') continue;
        // What happened, never what was said: types, text lengths, error codes.
        if (evt.type !== 'level') trace(`event ${evt.type}${typeof evt.text === 'string' ? ` (${evt.text.length} chars)` : ''}${evt.code ? ` ${evt.code}` : ''}${owner ? '' : ' (no window)'}`);
        send(evt);
        if (evt.type === 'final' || evt.type === 'error') owner = null;
      }
    });
    child.on('exit', () => {
      child = null;
      if (owner) { send({ type: 'error', code: 'helper_exit', message: 'speech recognition stopped unexpectedly' }); owner = null; }
    });
    child.on('error', (err) => log(`strado-speech: ${err.message}`));
    return child;
  };

  const write = (obj) => { trace(`cmd ${obj.cmd}`); try { child?.stdin.write(`${JSON.stringify(obj)}\n`); } catch { /* exited */ } };

  return {
    available,
    start(sender, opts) {
      if (!available()) return { ok: false, code: 'unavailable' };
      const c = ensure();
      if (!c) return { ok: false, code: 'unavailable' };
      // A new session replaces an old one (another window, or a stuck one).
      if (owner && owner !== sender) send({ type: 'error', code: 'replaced', message: 'listening moved to another window' });
      owner = sender;
      write({ cmd: 'start', contextual: cleanContextual(opts?.contextual), locale: typeof opts?.locale === 'string' ? opts.locale.slice(0, 20) : 'en-US' });
      return { ok: true };
    },
    stop(sender) { if (owner === sender) write({ cmd: 'stop' }); },
    cancel(sender) { if (owner === sender) { write({ cmd: 'cancel' }); owner = null; } },
    dispose() { try { child?.stdin.end(); } catch { /* gone */ } child = null; },
  };
}

module.exports = { createVoice, resolveHelper, cleanContextual };
