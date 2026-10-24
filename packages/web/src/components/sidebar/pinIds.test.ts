import { describe, expect, it } from 'vitest';
import { createdPinId } from './pinIds';

describe('createdPinId', () => {
  it('a local create: local:<path>', () => {
    expect(createdPinId({ path: '/wt/FD-1', warnings: [] })).toBe('local:/wt/FD-1');
  });
  it('a create on a runner: remote:<runnerId>:<path>', () => {
    expect(createdPinId({ runnerId: 'r1', remoteWsId: 'w', clonedTo: '/c', path: '/r/wt' })).toBe('remote:r1:/r/wt');
  });
  it('no path in the result: nothing to file', () => {
    expect(createdPinId({ runnerId: 'r1', clonedTo: '/c' })).toBeNull();
    expect(createdPinId(undefined)).toBeNull();
    expect(createdPinId('x')).toBeNull();
  });
});
