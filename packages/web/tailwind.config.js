/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        // JetBrains Mono IS the app font (a deliberate choice) — remapping `sans`
        // makes every component mono at once; `font-mono` stays equivalent.
        sans: ['"JetBrains Mono Variable"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
        mono: ['"JetBrains Mono Variable"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      colors: {
        // The whole app is written in zinc-* classes; remapping the scale
        // rethemes every component at once. This scale is a cooler graphite:
        // near-black canvas, barely-lighter panels, low-contrast borders.
        // Primary accent: the app is written in sky-* classes; remapping the
        // scale to Strado orange rebrands every accent at once. Jira's
        // blue-* category tints are deliberately untouched (Jira semantics).
        sky: {
          50: '#fff8f1',
          100: '#ffeeda',
          200: '#ffd9b0',
          300: '#ffbe7d',
          400: '#ff9d47',
          500: '#f97f1b',
          600: '#e2670a',
          700: '#bb4f08',
          800: '#953e0c',
          900: '#78330f',
          950: '#411805',
        },
        zinc: {
          50: '#f7f8fa',
          100: '#eef0f3',
          200: '#dde0e6',
          300: '#c2c7d0',
          400: '#989eab',
          500: '#6b7280',
          600: '#4b505c',
          700: '#2c3039',
          800: '#1e2128',
          900: '#141519',
          950: '#0b0c0f',
        },
      },
    },
  },
  plugins: [],
};
