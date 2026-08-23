import { beforeEach, describe, expect, it } from 'vitest';
import { applyTabOrder, readTabOrder, rememberTabOrder, tabKeyOf } from './tabOrder';

const t = (mode: string, id: string) => ({ tab: { mode, id } });

describe('tabOrder', () => {
  beforeEach(() => localStorage.clear());

  it('round-trips a saved order per path', () => {
    rememberTabOrder('/wt/a', ['shell:2', 'claude:1']);
    rememberTabOrder('/wt/b', ['vscode:1']);
    expect(readTabOrder('/wt/a')).toEqual(['shell:2', 'claude:1']);
    expect(readTabOrder('/wt/b')).toEqual(['vscode:1']);
    expect(readTabOrder('/wt/none')).toEqual([]);
  });

  it('applyTabOrder sorts saved keys first and keeps unsaved structural order', () => {
    const tabs = [t('claude', '1'), t('shell', '1'), t('shell', '2'), t('vscode', '1')];
    const out = applyTabOrder(['shell:2', 'claude:1'], tabs);
    expect(out.map((x) => tabKeyOf(x.tab))).toEqual(['shell:2', 'claude:1', 'shell:1', 'vscode:1']);
  });

  it('applyTabOrder with no saved order is identity', () => {
    const tabs = [t('claude', '1'), t('shell', '1')];
    expect(applyTabOrder([], tabs)).toEqual(tabs);
  });

  it('ignores saved keys for tabs that no longer exist', () => {
    const tabs = [t('shell', '1')];
    const out = applyTabOrder(['browser:1', 'shell:1'], tabs);
    expect(out.map((x) => tabKeyOf(x.tab))).toEqual(['shell:1']);
  });
});
