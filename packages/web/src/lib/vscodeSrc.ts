/**
 * A worktree's VS Code web URL. With a goto, the workbench opens that file at
 * that line as it loads (its `payload` openFile + gotoLineMode); a frame that
 * is already up can't take one without a reload.
 */
export function vscodeSrc(base: string, folder: string, goto?: { path: string; line: number }): string {
  const plain = `${base}?folder=${encodeURIComponent(folder)}`;
  if (!goto || !base) return plain;
  let host: string;
  try {
    host = new URL(base).host;
  } catch {
    return plain;
  }
  const abs = `${folder.replace(/\/+$/, '')}/${goto.path}`.split('/').map(encodeURIComponent).join('/');
  const payload = [['openFile', `vscode-remote://${host}${abs}:${goto.line}`], ['gotoLineMode', 'true']];
  return `${plain}&payload=${encodeURIComponent(JSON.stringify(payload))}`;
}
