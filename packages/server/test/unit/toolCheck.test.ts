import { describe, expect, it } from 'vitest';
import { checkTools } from '../../src/services/toolCheck';

describe('checkTools', () => {
  it('includes an optional opencode entry', async () => {
    const tools = await checkTools();
    const oc = tools.find((t) => t.id === 'opencode');
    expect(oc).toBeDefined();
    expect(oc!.optional).toBe(true);
    expect(oc!.label).toBe('OpenCode');
  });
});
