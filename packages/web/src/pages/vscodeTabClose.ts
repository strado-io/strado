import { api } from '../api';
import { rememberVscodeTab } from '../hooks/vscodeTabs';

// Closing a VS Code tab: forget it locally and notify the server. The server
// keeps ONE shared serve-web daemon for all folders (stable origin = stable
// user settings), so the close call is informational — the daemon is reaped
// at app shutdown, never per-tab.
export function closeVscodeTab(path: string): void {
  rememberVscodeTab(path, false);
  void api.vscode.close(path).catch(() => { /* reaped on shutdown anyway */ });
}
