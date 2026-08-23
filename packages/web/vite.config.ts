import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Which Strado server should the dev proxy talk to?
 *
 * Hardcoding 7777 meant `npm run dev` served a dev frontend that drove the
 * STABLE instance. The port arrives as an env var rather than by importing the
 * server's profile resolver, so packages/web gains no dependency on
 * packages/server and running vite bare behaves exactly as before.
 *
 * An empty or non-numeric value falls back to 7777 — `Number('')` is 0, which
 * would otherwise proxy to port 0.
 */
export function proxyTarget(env: NodeJS.ProcessEnv = process.env): { http: string; ws: string } {
  const raw = env.STRADO_SERVER_PORT?.trim();
  const parsed = raw ? Number(raw) : NaN;
  const port = Number.isInteger(parsed) && parsed > 0 ? parsed : 7777;
  return { http: `http://127.0.0.1:${port}`, ws: `ws://127.0.0.1:${port}` };
}

export default defineConfig({
  plugins: [react()],
  server: {
    port: 7778,
    proxy: {
      '/api': proxyTarget().http,
      '/events': {
        target: proxyTarget().http,
        changeOrigin: true,
      },
      '/ws': {
        target: proxyTarget().ws,
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
