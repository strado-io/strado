import {
  useAppearance,
  type DiffFont,
  type TerminalFont,
  type ThemePreset,
  type UiFont,
} from '../../hooks/useAppearance';
import { useHubDisplayPreferences } from '../../hooks/useHubDisplayPreferences';

function Toggle({ label, checked, onChange }: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 shrink-0 rounded-full border transition ${
        checked ? 'border-sky-500 bg-sky-500' : 'border-zinc-700 bg-zinc-900'
      }`}
    >
      <span
        aria-hidden
        className={`absolute left-0.5 top-0.5 h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${
          checked ? 'translate-x-4' : 'translate-x-0'
        }`}
      />
    </button>
  );
}

export function AppearanceSection() {
  const {
    preset, setPreset, font, setFont,
    diffFont, setDiffFont, terminalFont, setTerminalFont,
  } = useAppearance();
  const { showTime, setShowTime, showStatus, setShowStatus } = useHubDisplayPreferences();
  const themeOptions: { value: ThemePreset; label: string; swatches: string[] }[] = [
    { value: 'true-black', label: 'True Black', swatches: ['#000000', '#0a0a0a', '#f97f1b'] },
    { value: 'graphite', label: 'Graphite', swatches: ['#0b0c0f', '#1e2128', '#f97f1b'] },
    { value: 'ayu-dark', label: 'Ayu Dark', swatches: ['#0f1419', '#1f292e', '#e6b450'] },
    { value: 'dracula', label: 'Dracula', swatches: ['#191a21', '#282a36', '#bd93f9'] },
    { value: 'nord', label: 'Nord', swatches: ['#242933', '#2e3440', '#88c0d0'] },
    { value: 'github-light', label: 'GitHub Light', swatches: ['#ffffff', '#f6f8fa', '#0969da'] },
  ];
  const fonts: { value: UiFont; label: string }[] = [
    { value: 'jetbrains', label: 'JetBrains Mono' },
    { value: 'inter', label: 'Inter' },
    { value: 'system', label: 'System' },
  ];
  const diffFonts: { value: DiffFont; label: string }[] = [
    { value: 'jetbrains', label: 'JetBrains Mono' },
    { value: 'system-mono', label: 'System Mono' },
  ];
  const terminalFonts: { value: TerminalFont; label: string }[] = [
    { value: 'nerd', label: 'Nerd Font' },
    { value: 'jetbrains', label: 'JetBrains Mono' },
    { value: 'system-mono', label: 'System Mono' },
  ];

  return (
    <div className="max-w-2xl">
      <h2 className="text-base font-semibold text-zinc-100">Appearance</h2>
      <p className="mb-6 mt-1 text-xs text-zinc-500">Choose how Strado looks on this device.</p>

      <div className="divide-y divide-zinc-900 rounded-lg border border-zinc-800 bg-zinc-900/40 px-4">
        <div className="py-4">
          <div className="text-sm text-zinc-200">Theme preset</div>
          <div className="mb-3 mt-0.5 text-xs text-zinc-500">One coordinated palette for the app, diffs, and terminals.</div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" aria-label="Theme preset">
            {themeOptions.map((option) => (
              <button
                key={option.value}
                onClick={() => setPreset(option.value)}
                aria-pressed={preset === option.value}
                className={`flex items-center gap-2 rounded-md border px-2.5 py-2 text-left text-xs transition ${
                  preset === option.value
                    ? 'border-sky-500 bg-sky-500/10 text-zinc-100'
                    : 'border-zinc-800 bg-zinc-950 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200'
                }`}
              >
                <span className="flex overflow-hidden rounded-full border border-zinc-700" aria-hidden>
                  {option.swatches.map((color) => <span key={color} className="h-4 w-3" style={{ background: color }} />)}
                </span>
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center justify-between gap-6 py-4">
          <div>
            <div className="text-sm text-zinc-200">UI font</div>
            <div className="mt-0.5 text-xs text-zinc-500">Set the typeface used throughout the interface.</div>
          </div>
          <label className="flex shrink-0 items-center gap-2">
            <span aria-hidden className="flex h-8 w-8 items-center justify-center rounded-md border border-zinc-800 bg-zinc-950 text-sm text-sky-400">Aa</span>
            <select
              aria-label="UI font"
              value={font}
              onChange={(event) => setFont(event.target.value as UiFont)}
              className="h-8 w-44 rounded-md border border-zinc-800 bg-zinc-950 px-2 text-xs text-zinc-200 outline-none focus:border-sky-500"
            >
              {fonts.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
        </div>

      </div>

      <h3 className="mb-1 mt-7 text-sm font-medium text-zinc-200">Hub</h3>
      <p className="mb-3 text-xs text-zinc-500">Choose which details appear in the worktree hub header.</p>
      <div className="divide-y divide-zinc-900 rounded-lg border border-zinc-800 bg-zinc-900/40 px-4">
        <div className="flex items-center justify-between gap-6 py-3">
          <div>
            <div className="text-sm text-zinc-200">Show elapsed time</div>
            <div className="mt-0.5 text-xs text-zinc-500">Display active time and the original estimate.</div>
          </div>
          <Toggle label="Show elapsed time" checked={showTime} onChange={setShowTime} />
        </div>
        <div className="flex items-center justify-between gap-6 py-3">
          <div>
            <div className="text-sm text-zinc-200">Show status</div>
            <div className="mt-0.5 text-xs text-zinc-500">Display the workflow or ticket status control.</div>
          </div>
          <Toggle label="Show status" checked={showStatus} onChange={setShowStatus} />
        </div>
      </div>

      <h3 className="mb-1 mt-7 text-sm font-medium text-zinc-200">Diff viewer</h3>
      <p className="mb-3 text-xs text-zinc-500">The selected preset supplies diff colors; choose the code font separately.</p>
      <div className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/40">
        <div className="flex items-center justify-between gap-6 px-4 py-3">
          <span className="text-sm text-zinc-200">Code font</span>
          <select
            aria-label="Diff font"
            value={diffFont}
            onChange={(event) => setDiffFont(event.target.value as DiffFont)}
            className="h-8 w-44 rounded-md border border-zinc-800 bg-zinc-950 px-2 text-xs text-zinc-200 outline-none focus:border-sky-500"
          >
            {diffFonts.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </div>
        <div className="diff-surface diff-code-font border-t border-zinc-800 py-2 text-xs">
          <div className="diff-line diff-line-context grid grid-cols-[2rem_1fr]"><span className="diff-line-number px-2 text-right">1</span><span className="px-2">const themePreview = {'{'}</span></div>
          <div className="diff-line diff-line-del grid grid-cols-[2rem_1fr]"><span className="diff-line-number px-2 text-right">2</span><span className="px-2">-  contrast: 42,</span></div>
          <div className="diff-line diff-line-add grid grid-cols-[2rem_1fr]"><span className="diff-line-number px-2 text-right">2</span><span className="px-2">+  contrast: 68,</span></div>
          <div className="diff-line diff-line-context grid grid-cols-[2rem_1fr]"><span className="diff-line-number px-2 text-right">3</span><span className="px-2">{'};'}</span></div>
        </div>
      </div>

      <h3 className="mb-1 mt-7 text-sm font-medium text-zinc-200">Terminal</h3>
      <p className="mb-3 text-xs text-zinc-500">The selected preset supplies terminal colors; choose its font separately.</p>
      <div className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/40">
        <div className="flex items-center justify-between gap-6 px-4 py-3">
          <span className="text-sm text-zinc-200">Terminal font</span>
          <select
            aria-label="Terminal font"
            value={terminalFont}
            onChange={(event) => setTerminalFont(event.target.value as TerminalFont)}
            className="h-8 w-44 rounded-md border border-zinc-800 bg-zinc-950 px-2 text-xs text-zinc-200 outline-none focus:border-sky-500"
          >
            {terminalFonts.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </div>
        <div className="terminal-preview border-t border-zinc-800 px-4 py-3 text-xs">
          <div><span className="terminal-preview-prompt">➜</span> <span className="terminal-preview-path">~/strado</span> git status</div>
          <div className="terminal-preview-muted mt-1">On branch ux_improvements</div>
        </div>
      </div>
    </div>
  );
}
