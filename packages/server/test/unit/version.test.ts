import { describe, expect, it } from 'vitest';
import { isNewer } from '../../src/services/version';

describe('isNewer', () => {
  it('compares dotted numeric versions', () => {
    expect(isNewer('0.1.0', '0.2.0')).toBe(true);
    expect(isNewer('0.2.0', '0.1.0')).toBe(false);
    expect(isNewer('0.1.0', '0.1.0')).toBe(false);
    expect(isNewer('0.1.9', '0.2.0')).toBe(true);
  });
  it('handles differing segment counts and non-numeric input', () => {
    expect(isNewer('0.1.9', '0.2')).toBe(true);
    expect(isNewer('0.2', '0.1.9')).toBe(false);
    expect(isNewer('0.1.0', 'garbage')).toBe(false);
  });
});
