import type { ReactNode } from 'react';
import { StradoMark } from './StradoMark';

// The chrome every pre-app screen shares: sign-in, and the environment gate
// that follows it. One card, one brand row, the same orange dawn glow over a
// blueprint grid (.firstrun-* — see index.css). These are the only screens a
// new user sees before the shell exists, so they read as one arrival rather
// than three unrelated pages.
export function FirstRunCard({
  title,
  lede,
  children,
  footer,
  // Sign-in is a single field and a button, so it stays narrow. The
  // environment gate carries a list of tool rows — versions, hints, buttons —
  // and at 27rem those wrapped into a cramped column.
  width = 'narrow',
}: {
  title: ReactNode;
  lede?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: 'narrow' | 'wide';
}) {
  return (
    <div className="firstrun-bg flex h-screen items-center justify-center overflow-y-auto bg-zinc-950 p-6">
      <div
        className={`firstrun-card w-full rounded-2xl border border-zinc-700 px-7 pb-7 pt-8 ${
          width === 'wide' ? 'max-w-[34rem]' : 'max-w-[27rem]'
        }`}
      >
        <div className="mb-6 flex items-center gap-3">
          <StradoMark size={40} className="flex-none rounded-[11px]" />
          <span className="text-[1.1rem] font-bold tracking-[0.01em] text-zinc-100">
            strado<b className="text-sky-500">.</b>
          </span>
        </div>
        <h1 className="text-base text-zinc-100">{title}</h1>
        {lede && <p className="mt-1.5 text-sm leading-relaxed text-zinc-400">{lede}</p>}
        <div className="mt-5">{children}</div>
        {footer && (
          <div className="mt-5 flex items-center justify-center gap-1.5 border-t border-zinc-700 pt-3.5 text-[0.68rem] text-zinc-500">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

// The orange gradient primary, shared by both screens so "the button that
// moves you forward" looks the same before and after sign-in.
export const primaryButtonClass =
  'w-full rounded-[10px] border border-sky-400/20 bg-gradient-to-b from-[#c4550a] to-sky-700 px-3 py-[0.72rem] text-[0.95rem] font-semibold text-[#fbf3ea] shadow-[inset_0_1px_0_rgba(255,255,255,0.10)] transition hover:from-sky-600 hover:to-[#c4550a] hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.14),0_6px_18px_-12px_rgba(226,103,10,0.55)] active:translate-y-px disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.10)]';

// A bordered secondary — used for Retry and Re-check, which must look pressable
// without competing with the primary above.
export const ghostButtonClass =
  'rounded-[10px] border border-zinc-700 bg-zinc-800 text-zinc-100 transition hover:border-zinc-600 hover:bg-[#23262e] active:translate-y-px disabled:opacity-50';
