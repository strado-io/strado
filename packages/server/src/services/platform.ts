// Default interactive shell for spawned processes / tool checks. Honors the
// user's $SHELL; otherwise picks a sane per-OS default (zsh is the macOS
// default login shell; bash is universally present on Linux, zsh often is not).
export function defaultShell(): string {
  return process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
}
