import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';

export type UpdateInfo = Awaited<ReturnType<typeof api.update.check>>;
export type UpdatePhase = 'idle' | 'available' | 'downloading' | 'ready' | 'error';
export type UpdateMode = 'swap' | 'link';

const CHECK_INTERVAL_MS = 15 * 60 * 1000; // every 15 min

// What this install can do about an update:
//   swap — in-app download + restart (mac .app, linux AppImage)
//   link — open the download URL externally (.deb installs)
//   none — no channel; don't poll or render update UI
// New shells report window.strado.updateMode. Legacy shells (≤0.1.7) predate
// it: darwin had the swap updater, everything else had nothing. A plain
// browser (no window.strado) keeps polling as before.
function shellMode(): UpdateMode | 'none' {
  const s = window.strado;
  if (!s) return 'swap';
  if (s.updateMode) return s.updateMode;
  return s.platform === 'darwin' ? 'swap' : 'none';
}

export function useUpdate() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [phase, setPhase] = useState<UpdatePhase>('idle');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const dismissed = useRef(false);
  const rawMode = shellMode();
  const mode: UpdateMode = rawMode === 'link' ? 'link' : 'swap';

  const check = useCallback(async () => {
    try {
      const r = await api.update.check();
      if (!r.updateAvailable) return;
      setInfo(r);
      // don't clobber an in-flight download/ready with a re-poll
      setPhase((p) => (p === 'idle' && !dismissed.current ? 'available' : p));
    } catch {
      // routine poll — ignore
    }
  }, []);

  useEffect(() => {
    if (rawMode === 'none') return;
    void check();
    const iv = window.setInterval(check, CHECK_INTERVAL_MS);
    return () => window.clearInterval(iv);
  }, [check, rawMode]);

  // subscribe to native download/stage events
  useEffect(() => {
    if (rawMode === 'none') return;
    const off = window.strado?.onUpdateEvent?.((e) => {
      if (e.type === 'progress') { setPhase('downloading'); setProgress(e.pct); }
      else if (e.type === 'ready') setPhase('ready');
      else if (e.type === 'error') { setPhase('error'); setError(e.message); }
    });
    return off;
  }, [rawMode]);

  const startDownload = useCallback(() => {
    if (!info?.url) return;
    if (mode === 'link') {
      // .deb: no self-swap — hand the user the file and let them reinstall
      window.open(info.debUrl ?? info.url, '_blank');
      return;
    }
    if (!info.sha256) return;
    setError(null);
    setPhase('downloading');
    void window.strado?.update?.('download', { url: info.url, sha256: info.sha256 });
  }, [info, mode]);

  const install = useCallback(() => {
    void window.strado?.update?.('install');
  }, []);

  const dismiss = useCallback(() => {
    if (info?.mandatory) return; // mandatory cannot be dismissed
    dismissed.current = true;
    setPhase('idle');
  }, [info]);

  return { info, phase, progress, error, mode, startDownload, install, dismiss };
}
