// Usage telemetry → strado-api /v1/events. Counters and enum props ONLY —
// never paths, branch names, tickets, URLs, or anything from a terminal.
// Active only in gated (packaged) builds with a license; dev runs and
// STRADO_TELEMETRY=0 make every track() a no-op.

type Props = Record<string, string | number | boolean>;

type Config = { apiUrl: string; token: string };

let config: Config | null = null;
let queue: { name: string; ts: string; props?: Props }[] = [];
let timer: number | null = null;

const BATCH_LIMIT = 20;
const FLUSH_MS = 30_000;

async function flush(useBeacon = false): Promise<void> {
  if (!config || queue.length === 0) return;
  const events = queue.splice(0, 100);
  const body = JSON.stringify({ token: config.token, events });
  const url = `${config.apiUrl}/v1/events`;
  try {
    if (useBeacon && navigator.sendBeacon) {
      navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
      return;
    }
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      keepalive: true,
    });
  } catch {
    // offline — drop rather than grow an unbounded buffer
  }
}

export function initTelemetry(opts: { apiUrl: string; token: string; enabled: boolean }): void {
  if (!opts.enabled || config) return;
  config = { apiUrl: opts.apiUrl.replace(/\/$/, ''), token: opts.token };
  timer = window.setInterval(() => void flush(), FLUSH_MS);
  window.addEventListener('pagehide', () => void flush(true));
}

export function track(name: string, props?: Props): void {
  if (!config) return;
  queue.push({ name, ts: new Date().toISOString(), ...(props ? { props } : {}) });
  if (queue.length >= BATCH_LIMIT) void flush();
}

// test hook
export function _resetTelemetry(): void {
  if (timer !== null) window.clearInterval(timer);
  timer = null;
  config = null;
  queue = [];
}
