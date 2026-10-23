import { describe, expect, it } from 'vitest';
import { BREATHE, TAB_TONE, fitCount, urgentState } from './agentTone';

describe('agentTone', () => {
  it('urgentState: needs you > failed > working > limited > idle > offline; none → null', () => {
    expect(urgentState(['idle', 'working', 'needs_you'])).toBe('needs_you');
    expect(urgentState(['working', 'failed'])).toBe('failed');
    expect(urgentState(['offline', 'idle'])).toBe('idle');
    expect(urgentState([null, undefined])).toBeNull();
  });
  it('only states that want a look are tinted; working and needs you breathe; needs you is amber', () => {
    expect(TAB_TONE.idle).toBeUndefined();
    expect(TAB_TONE.offline).toBeUndefined();
    expect(TAB_TONE.needs_you).toMatch(/amber/);
    expect(TAB_TONE.working).toMatch(/sky/);
    expect(TAB_TONE.failed).toMatch(/red/);
    expect(BREATHE.working).toBe('pill-breathe-working');
    expect(BREATHE.needs_you).toBe('pill-breathe-needs');
    expect(BREATHE.failed).toBeUndefined();
  });
  it('fitCount: all fit; else as many as leave room for +N (at least one); unknown width → all', () => {
    expect(fitCount([50, 100, 150], 200, 40)).toBe(3);
    expect(fitCount([50, 100, 150, 200], 170, 40)).toBe(2);
    expect(fitCount([300], 100, 40)).toBe(1);
    expect(fitCount([50, 100], 0, 40)).toBe(2);
  });
});
