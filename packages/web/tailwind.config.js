/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        // Appearance settings swap this variable at runtime. Keep both aliases
        // on it because the existing interface deliberately uses mono classes
        // for labels as well as the default sans stack.
        sans: ['var(--font-ui)'],
        mono: ['var(--font-ui)'],
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
