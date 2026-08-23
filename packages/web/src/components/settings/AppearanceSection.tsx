import { useDensity } from '../../hooks/useDensity';
import type { Density } from '../FilterBar';

export function AppearanceSection() {
  const [density, setDensity] = useDensity();
  const options: Density[] = ['comfy', 'compact'];

  return (
    <div className="max-w-lg">
      <h2 className="mb-4 text-base font-semibold text-zinc-100">Appearance</h2>

      <div className="mb-6">
        <div className="text-sm text-zinc-200">Row density</div>
        <div className="mb-2 text-xs text-zinc-500">How tightly worktree rows are packed on the board.</div>
        <div className="inline-flex rounded-md border border-zinc-800 p-0.5">
          {options.map((opt) => (
            <button
              key={opt}
              onClick={() => setDensity(opt)}
              className={`rounded px-3 py-1 text-xs capitalize transition ${
                density === opt ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {opt.charAt(0).toUpperCase() + opt.slice(1)}
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="text-sm text-zinc-200">Theme</div>
        <div className="mb-2 text-xs text-zinc-500">Theme options coming soon.</div>
        <div className="inline-flex rounded-md border border-zinc-800 px-3 py-1 text-xs text-zinc-300">Dark</div>
      </div>
    </div>
  );
}
