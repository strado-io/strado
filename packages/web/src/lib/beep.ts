// Short two-tone "agent done" chime via WebAudio — no asset file, no
// notification permission involved. Shared lazy AudioContext; every call is
// fire-and-forget and must never break the dashboard.
let ctx: AudioContext | null = null;

export function playDoneBeep(): void {
  try {
    const AC = window.AudioContext
      ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    ctx ??= new AC();
    if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
    const t0 = ctx.currentTime;
    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    // loud, clear chime — peaks near full scale, short decay
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.85, t0 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.4);
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1046.5, t0); // C6
    osc.frequency.setValueAtTime(1568, t0 + 0.12); // → G6
    osc.connect(gain);
    osc.start(t0);
    osc.stop(t0 + 0.45);
  } catch {
    /* audio unavailable — silently skip */
  }
}
