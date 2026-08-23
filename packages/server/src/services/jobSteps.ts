// Named steps for a job, so the UI can show where it is instead of a spinner.
//
// A spinner for a three-minute clone is indistinguishable from a hang, and when
// it fails the user gets "failed to create worktree" with no idea which part
// broke. Steps fix both: progress is legible, and a failure lands on a line.
//
// Protocol: every progress event carries `{ step }`, and the FIRST one also
// carries the whole ordered `steps` list, so the UI can draw the plan before it
// happens rather than growing a list one line at a time.
import type { JobContext } from './jobs.js';

export type JobStep = { id: string; label: string };

export type StepReporter = {
  /** Advance to a declared step. */
  (id: string): void;
  /** Extra text under the current step (e.g. git's "Receiving objects: 45%"). */
  detail(text: string): void;
};

export function stepReporter(ctx: JobContext, steps: JobStep[]): StepReporter {
  let announced = false;
  let current = steps[0]?.id ?? '';

  const advance = (id: string) => {
    current = id;
    const label = steps.find((s) => s.id === id)?.label ?? id;
    // The list rides along once. Re-sending it on every event would be harmless
    // but wasteful on a chatty job (clone percentages).
    ctx.progress(label, announced ? { step: id } : { step: id, steps });
    announced = true;
  };

  const reporter = advance as StepReporter;
  reporter.detail = (text: string) => {
    ctx.progress(text, { step: current, detail: text });
  };
  return reporter;
}
