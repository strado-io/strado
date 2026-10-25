// The exact args of each pending approval, in memory only. The chat log keeps
// a redacted copy for the card; Approve must run what Jarvis asked for, not
// that copy (`max_tokens=4096` or a real key would come out as [redacted]).
// Lost on restart: an approval whose stored args were redacted then refuses.

export type ApprovalArgs = {
  hold(entryId: string, args: Record<string, unknown>): void;
  /** The raw args, once (an approval is decided once). */
  take(entryId: string): Record<string, unknown> | undefined;
};

export function createApprovalArgs(max = 500): ApprovalArgs {
  const held = new Map<string, Record<string, unknown>>();
  return {
    hold(entryId, args) {
      held.set(entryId, args);
      // Never answered ones go first: approvals are rare, the cap only bounds memory.
      while (held.size > max) held.delete(held.keys().next().value!);
    },
    take(entryId) {
      const args = held.get(entryId);
      held.delete(entryId);
      return args;
    },
  };
}
