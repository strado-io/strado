import { describe, it, expect, vi } from 'vitest';
import { api } from '../api';

// Focused contract test: closing a vscode tab tells the server to drop it.
// (If TerminalView is not unit-mountable in isolation, assert the handler that
//  closeTab invokes calls api.vscode.close — extract that call into a tiny
//  helper `closeVscodeTab(path)` in TerminalView and test the helper.)
describe('vscode tab close', () => {
  it('calls api.vscode.close with the folder', async () => {
    const spy = vi.spyOn(api.vscode, 'close').mockResolvedValue({ ok: true });
    const { closeVscodeTab } = await import('./vscodeTabClose');
    closeVscodeTab('/wt/a');
    expect(spy).toHaveBeenCalledWith('/wt/a');
    spy.mockRestore();
  });
});
