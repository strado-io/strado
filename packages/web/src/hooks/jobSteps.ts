// Follow a job's named steps.
//
// The server declares the whole ordered list on its first progress event, so the
// plan is drawn up front rather than growing a line at a time — a list that
// appears one item at a time can't tell you how much is left.
import { useEffect, useRef, useState } from 'react';
import { subscribeJob } from '../eventStream';

export type Step = { id: string; label: string };

export type JobProgress = {
  steps: Step[];
  /** Index of the step in flight; -1 before the first event. */
  currentIndex: number;
  /** Sub-status under the current step (e.g. "already on this runner"). */
  detail: string | null;
  /** Seconds since we started watching — makes a hang legible. */
  elapsed: number;
  done: boolean;
  error: string | null;
};

export function useJobSteps(jobId: string | null): JobProgress {
  const [steps, setSteps] = useState<Step[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const startedAt = useRef<number>(0);

  useEffect(() => {
    if (!jobId) return;
    setSteps([]);
    setCurrentId(null);
    setDetail(null);
    setDone(false);
    setError(null);
    setElapsed(0);
    startedAt.current = Date.now();
    const timer = window.setInterval(
      () => setElapsed(Math.floor((Date.now() - startedAt.current) / 1000)),
      1000,
    );
    const off = subscribeJob(jobId, (evt) => {
      if (evt.type === 'progress') {
        const payload = (evt.data ?? {}) as { message?: string; data?: { step?: string; steps?: Step[]; detail?: string } };
        const inner = payload.data ?? {};
        if (Array.isArray(inner.steps)) setSteps(inner.steps);
        if (inner.detail) {
          setDetail(inner.detail);
        } else if (inner.step) {
          // Advancing clears the previous step's detail; leaving it would
          // attribute stale text to the wrong line.
          setCurrentId(inner.step);
          setDetail(null);
        }
        return;
      }
      if (evt.type === 'done') {
        setDone(true);
        return;
      }
      const d = (evt.data ?? {}) as { message?: string; error?: string };
      setError(d.message || d.error || 'Job failed');
    });
    return () => {
      off();
      window.clearInterval(timer);
    };
  }, [jobId]);

  const currentIndex = currentId ? steps.findIndex((s) => s.id === currentId) : -1;
  return { steps, currentIndex, detail, elapsed, done, error };
}
