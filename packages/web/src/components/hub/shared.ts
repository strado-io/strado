// Shared bits for the terminal hub (TerminalView and its popover menus).

export type ProcState = { status: string; port?: number | null; detectedUrl?: string | null };

export const PROC_COLOR: Record<string, string> = {
  idle: 'bg-zinc-600',
  starting: 'bg-amber-500',
  running: 'bg-emerald-500',
  stopped: 'bg-zinc-500',
  crashed: 'bg-red-500',
};
