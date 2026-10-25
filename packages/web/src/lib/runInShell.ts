// "Install" buttons outside the hub (Settings › Language servers): ask the hub
// showing `worktreePath` to open a new Shell tab and type `command` into it,
// visibly, as if the person had. Nothing runs in the background.

export const RUN_IN_SHELL_EVENT = 'strado:run-in-shell';

export type RunInShellRequest = { worktreePath: string; command: string };

export function requestRunInShell(req: RunInShellRequest): void {
  window.dispatchEvent(new CustomEvent<RunInShellRequest>(RUN_IN_SHELL_EVENT, { detail: req }));
}
