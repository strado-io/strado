export function ConnectionStatus({
  connected,
  loading = false,
}: {
  connected: boolean;
  loading?: boolean;
}) {
  const label = loading ? 'Checking…' : connected ? 'Connected' : 'Not connected';
  const tone = loading
    ? 'bg-zinc-800 text-zinc-500'
    : connected
      ? 'bg-emerald-500/10 text-emerald-400 ring-1 ring-inset ring-emerald-500/20'
      : 'bg-zinc-800 text-zinc-400';

  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${tone}`}>{label}</span>
  );
}
