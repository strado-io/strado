/**
 * Loading states for the Usage page.
 *
 * A cold read walks months of session logs, so this is the one place in the app
 * where waiting is normal. The skeletons hold the real layout's shape — cards
 * where cards land, a chart block where the chart lands — so nothing jumps when
 * the numbers arrive, and each carries the braille spinner the rest of the app
 * uses for work in flight.
 */

const Block = ({ className }: { className: string }) => (
  <span aria-hidden className={`block animate-pulse rounded bg-zinc-900 ${className}`} />
);

const Spinner = ({ label }: { label: string }) => (
  <span className="flex items-center gap-2 text-[11px] text-zinc-500">
    <span aria-hidden className="braille-spinner font-mono leading-none text-zinc-400" />
    {label}
  </span>
);

/** One placeholder card per agent we might find signed in. */
export function AccountsLoading() {
  return (
    <div role="status" aria-label="Reading agent credentials" className="grid gap-2 lg:grid-cols-2">
      {[0, 1].map((index) => (
        <div key={index} className="rounded-lg border border-zinc-800 bg-zinc-950">
          <div className="flex items-center gap-2 border-b border-zinc-900 px-3 py-2">
            <Block className="h-1.5 w-1.5 rounded-full" />
            <Block className="h-3 w-40" />
            <Block className="ml-auto h-3 w-16" />
          </div>
          <div className="flex flex-col gap-2.5 px-3 py-3">
            {[0, 1].map((row) => (
              <div key={row} className="flex items-center gap-2.5">
                <Block className="h-2.5 w-[88px]" />
                <Block className="h-[3px] flex-1 rounded-full" />
                <Block className="h-2.5 w-8" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** The cost figure, its legend and the chart, before the logs are read. */
export function ChartLoading() {
  return (
    <div
      role="status"
      aria-label="Reading session logs"
      className="grid gap-4 lg:grid-cols-[minmax(0,13rem)_minmax(0,1fr)]"
    >
      <div className="flex flex-col gap-2">
        <Block className="h-8 w-32" />
        <Block className="h-2.5 w-40" />
        <div className="mt-3 flex flex-col gap-2">
          <Block className="h-2.5 w-full" />
          <Block className="h-2.5 w-4/5" />
        </div>
        <div className="mt-2">
          <Spinner label="Reading session logs…" />
        </div>
      </div>
      {/* A chart-shaped block: same height as the real plot, so the page does
          not resize under the reader when it lands. */}
      <div className="relative h-[320px] overflow-hidden rounded-md border border-zinc-900 bg-zinc-950">
        {/* A mound where the area chart will sit, so the block reads as a chart
            rather than an empty panel. */}
        <span
          aria-hidden
          className="absolute inset-x-0 bottom-0 h-1/2 animate-pulse rounded-t-[40%] bg-gradient-to-t from-zinc-800/70 to-transparent"
        />
        {[0.25, 0.5, 0.75].map((fraction) => (
          <span
            key={fraction}
            aria-hidden
            className="absolute inset-x-0 h-px bg-zinc-900"
            style={{ bottom: `${fraction * 100}%` }}
          />
        ))}
      </div>
    </div>
  );
}

/** The machine tab's three meters, before the sample returns. */
export function MachineLoading() {
  return (
    <div role="status" aria-label="Reading machine resources" className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-3">
        {[0, 1, 2].map((index) => (
          <div key={index} className="rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2.5">
            <div className="flex items-baseline justify-between">
              <Block className="h-2.5 w-12" />
              <Block className="h-3.5 w-10" />
            </div>
            <Block className="mt-2 h-[3px] w-full rounded-full" />
            <Block className="mt-2 h-2.5 w-32" />
          </div>
        ))}
      </div>
      <Spinner label="Sampling this machine…" />
    </div>
  );
}
