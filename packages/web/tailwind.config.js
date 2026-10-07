/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      // Tailwind's stock pulse eases opacity every frame. On an indicator
      // that stays up for as long as an agent works (hours), that repaints
      // and recomposites the whole window ~60x/s: measured ~25% WindowServer
      // CPU and ~5% GPU for one pulsing tab icon. Stepped, Chromium only
      // wakes up when the value changes (8x per 2s cycle) and the cost drops
      // to near zero while it still visibly pulses.
      animation: {
        pulse: 'pulse 2s steps(4, jump-none) infinite',
      },
      fontFamily: {
        // Appearance settings swap --font-ui at runtime. `mono` deliberately
        // does NOT follow it: shas, branches and line numbers must stay
        // monospaced even when the interface font is proportional.
        sans: ['var(--font-ui)'],
        mono: ['var(--font-mono)'],
      },
      colors: {
        // The whole app is written in zinc-* classes; remapping the scale
        // rethemes every component at once. This scale is a cooler graphite:
        // near-black canvas, barely-lighter panels, low-contrast borders.
        // Primary accent: the app is written in sky-* classes; remapping the
        // scale to Strado orange rebrands every accent at once. Jira's
        // blue-* category tints are deliberately untouched (Jira semantics).
        sky: Object.fromEntries([50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]
          .map((shade) => [shade, `rgb(var(--sky-${shade}) / <alpha-value>)`])),
        zinc: Object.fromEntries([50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]
          .map((shade) => [shade, `rgb(var(--zinc-${shade}) / <alpha-value>)`])),
      },
    },
  },
  plugins: [],
};
