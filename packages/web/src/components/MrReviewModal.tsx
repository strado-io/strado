import { useEffect } from 'react';
import type { MergeRequest, Worktree } from '../types';
import { MrReview } from './MrReview';

// MR review in a centered modal — same shell as DiffView (backdrop click or
// Esc closes). MrReview renders `absolute inset-0`, so the card is `relative`
// to make it fill the card rather than the window.
export function MrReviewModal({ worktree, mr, onClose }: {
  worktree: Worktree;
  mr: MergeRequest;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="relative h-[85vh] w-full max-w-6xl overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <MrReview worktree={worktree} mr={mr} onClose={onClose} />
      </div>
    </div>
  );
}
