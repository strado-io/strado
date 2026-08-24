// The Strado mark, as a pixel grid spelling the wordmark's glyph. Inlined
// rather than shipped as an asset so the sign-in gate — the one screen that
// renders before anything else is trusted — needs no network or bundler round
// trip to draw it.
export function StradoMark({ size = 40, className }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 1024 1024" width={size} height={size} className={className} aria-hidden="true">
      <rect x="100" y="100" width="824" height="824" rx="186" fill="#0B0B0D" />
      <g transform="translate(286.4 281.9) scale(1.41)" fill="#F97F1B">
        {[
          [92.8, 0], [140.8, 0], [188.8, 0], [236.8, 0],
          [44.8, 48], [92.8, 48],
          [44.8, 96], [92.8, 96],
          [92.8, 144], [140.8, 144], [188.8, 144],
          [188.8, 192], [236.8, 192],
          [188.8, 240], [236.8, 240],
          [44.8, 288], [92.8, 288], [140.8, 288], [188.8, 288],
        ].map(([x, y]) => (
          <rect key={`${x}-${y}`} x={x} y={y} width="38.4" height="38.4" />
        ))}
      </g>
    </svg>
  );
}
