import { api, type UiClientState, type UiCommandAck } from '../api';
import { subscribeUi, type UiCommand } from '../eventStream';

export const UI_STATE_HEARTBEAT_MS = 15_000;

// Per page load rather than sessionStorage: duplicating a browser tab clones
// sessionStorage, which would register two windows under one id. A reload
// closes the old stream anyway, so nothing is lost by minting a fresh id.
let clientId: string | null = null;
export function uiClientId(): string {
  clientId ??= typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID().replace(/-/g, '')
    : `ui${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  return clientId;
}

export type UiControlOptions = {
  wsId: string;
  getState: () => UiClientState;
  onCommand: (cmd: UiCommand) => Promise<UiCommandAck>;
};
export type UiControlHandle = (() => void) & { notify(): void };

/** Registers this window for server→window layout commands: holds the ui
 * stream open, reports what the window shows (on connect, focus/blur,
 * visibility change, `notify()`, and every 15 s), and acks every command with
 * the handler's outcome. */
export function startUiControl({ wsId, getState, onCommand }: UiControlOptions): UiControlHandle {
  const id = uiClientId();
  let stopped = false;
  // Reports wait for the stream's `ui.ready`: one sent before the server has
  // registered this window 404s, and the reconnect it triggers would kill the
  // handshake still in flight.
  let ready = false;
  const handleCommand = (cmd: UiCommand) => {
    void (async () => {
      let ack: UiCommandAck;
      try {
        ack = await onCommand(cmd);
      } catch (err) {
        // The server's ack schema caps a reason at 200 chars; longer is a 400.
        ack = { applied: false, reason: String((err as Error)?.message ?? err).slice(0, 200) };
      }
      if (stopped) return;
      try { await api.ui.ack(wsId, id, cmd.id, ack); } catch { /* the server times the command out on its own */ }
      report();
    })();
  };
  const connect = () => {
    ready = false;
    return subscribeUi(wsId, id, { onCommand: handleCommand, onReady: () => { ready = true; report(); } });
  };
  let unsub = connect();
  const report = () => {
    if (stopped || !ready) return;
    // Best effort: a report that can't even be built or sent must never break
    // the window (the heartbeat retries).
    let sent: Promise<void>;
    try {
      const state = getState();
      sent = api.ui.reportState(wsId, id, { ...state, visible: state.visible.slice(0, 200) });
    } catch { return; }
    sent.catch((err: { code?: string }) => {
      if (stopped) return;
      // Only the local hub may drive app control (loopback Host/Origin): a
      // window opened over the LAN or relay just goes without, silently. Its
      // event stream already got the same 403, which EventSource never retries.
      if (err?.code === 'FORBIDDEN') { stop(); return; }
      // The server forgot this window (restart, dropped stream): re-register;
      // its `ui.ready` triggers the resend.
      if (err?.code !== 'NOT_FOUND') return;
      unsub();
      unsub = connect();
    });
  };
  const timer = setInterval(report, UI_STATE_HEARTBEAT_MS);
  window.addEventListener('focus', report);
  window.addEventListener('blur', report);
  document.addEventListener('visibilitychange', report);
  const stop = (() => {
    stopped = true;
    clearInterval(timer);
    window.removeEventListener('focus', report);
    window.removeEventListener('blur', report);
    document.removeEventListener('visibilitychange', report);
    unsub();
  }) as UiControlHandle;
  stop.notify = report;
  return stop;
}
