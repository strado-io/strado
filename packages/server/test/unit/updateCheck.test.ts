import { describe, expect, it } from 'vitest';
import { selectReleaseAsset, type ReleaseInfo } from '../../src/routes/updateCheck.js';

const rel: ReleaseInfo = {
  version: '0.2.0',
  url: 'https://api.strado.io/v1/download/Strado-0.2.0-arm64.dmg',
  sha256: 'dmg-sha',
  linux: {
    url: 'https://api.strado.io/v1/download/Strado-0.2.0.AppImage',
    sha256: 'appimage-sha',
    debUrl: 'https://api.strado.io/v1/download/strado_0.2.0_amd64.deb',
  },
};

describe('selectReleaseAsset', () => {
  it('darwin picks the top-level DMG fields', () => {
    expect(selectReleaseAsset(rel, 'darwin')).toEqual({
      url: rel.url,
      sha256: 'dmg-sha',
      version: '0.2.0',
    });
  });

  it('linux picks the linux block and passes debUrl through', () => {
    expect(selectReleaseAsset(rel, 'linux')).toEqual({
      url: rel.linux!.url,
      sha256: 'appimage-sha',
      version: '0.2.0',
      debUrl: rel.linux!.debUrl,
    });
  });

  it('linux without a debUrl omits the field', () => {
    const noDeb = { ...rel, linux: { url: 'u', sha256: 's' } };
    expect(selectReleaseAsset(noDeb, 'linux')).toEqual({ url: 'u', sha256: 's', version: '0.2.0' });
  });

  it('linux with no linux block fails closed', () => {
    const macOnly = { version: '0.2.0', url: 'u', sha256: 's' };
    expect(selectReleaseAsset(macOnly, 'linux')).toBeNull();
  });

  it('linux with a partial linux block fails closed', () => {
    const partial = { version: '0.2.0', url: 'u', sha256: 's', linux: { url: 'only-url' } } as ReleaseInfo;
    expect(selectReleaseAsset(partial, 'linux')).toBeNull();
  });

  it('unknown platforms fall back to the darwin fields', () => {
    // win32 has no channel; selection alone does not gate support — the shell
    // and renderer do. Returning darwin fields keeps the function total.
    expect(selectReleaseAsset(rel, 'win32')).toEqual(
      expect.objectContaining({ url: rel.url, sha256: 'dmg-sha' }),
    );
  });
});

describe('per-platform asset version', () => {
  it('darwin assets carry the top-level version', () => {
    expect(selectReleaseAsset(rel, 'darwin')?.version).toBe('0.2.0');
  });

  it('linux version comes from the AppImage filename, not the top-level version', () => {
    // A mac-only release bumps the top-level version but leaves the linux
    // block pointing at the previous AppImage. Comparing against the
    // top-level version made linux clients "update" to the build they
    // already run, forever (found live on 0.1.39→"0.1.40").
    const macOnlyBump: ReleaseInfo = {
      version: '0.1.40',
      url: 'https://api.strado.io/v1/download/Strado-0.1.40-arm64.dmg',
      sha256: 'dmg-sha',
      linux: {
        url: 'https://api.strado.io/v1/download/Strado-0.1.39.AppImage',
        sha256: 'appimage-sha',
      },
    };
    expect(selectReleaseAsset(macOnlyBump, 'linux')?.version).toBe('0.1.39');
  });

  it('an explicit linux.version field wins over the filename', () => {
    const explicit: ReleaseInfo = {
      ...rel,
      linux: { ...rel.linux!, version: '0.3.1' },
    };
    expect(selectReleaseAsset(explicit, 'linux')?.version).toBe('0.3.1');
  });

  it('an unparseable linux url falls back to the top-level version', () => {
    const odd: ReleaseInfo = {
      ...rel,
      linux: { url: 'https://api.strado.io/v1/download/strado-nightly.bin', sha256: 's' },
    };
    expect(selectReleaseAsset(odd, 'linux')?.version).toBe('0.2.0');
  });
});
