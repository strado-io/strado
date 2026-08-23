import { FastifyInstance } from 'fastify';
import { isNewer } from '../services/version.js';

// Local copy of the strado-api release wire shape (the cloud service is
// import-isolated).
export type ReleaseInfo = {
  version: string;
  // top-level url/sha256 = the macOS DMG (legacy clients read these)
  url: string;
  sha256: string;
  notes?: string;
  mandatory?: boolean;
  // linux.url/sha256 = the AppImage (self-update); debUrl = manual .deb link
  linux?: {
    url: string;
    sha256: string;
    debUrl?: string;
    version?: string;
  };
};

// Pick this platform's downloadable asset from the feed. Linux without a
// complete linux block returns null — the caller reports "no update" (fail
// closed) rather than offering a mac DMG to a Linux client.
//
// The asset carries its OWN version, which is what the caller must compare
// against — never the feed's top-level version. The publish CLI rewrites only
// the block for the artifact kind being published, so a mac-only release
// bumps the top-level version while the linux block keeps the previous
// AppImage. Comparing linux clients against the top-level version sent them
// into an infinite update loop: "0.1.40 available" → download the 0.1.39
// AppImage → relaunch as 0.1.39 → "0.1.40 available" (live on 2026-08-19).
// The feed doesn't carry linux.version yet, so it is recovered from the
// AppImage filename — the /v1/download allowlist pins that naming.
export function selectReleaseAsset(
  rel: ReleaseInfo,
  platform: NodeJS.Platform,
): { url: string; sha256: string; version: string; debUrl?: string } | null {
  if (platform === 'linux') {
    if (!rel.linux?.url || !rel.linux?.sha256) return null;
    const { url, sha256, debUrl } = rel.linux;
    const fromName = /\/Strado-([0-9][^/]*?)\.AppImage$/.exec(url)?.[1];
    const version = rel.linux.version ?? fromName ?? rel.version;
    return debUrl ? { url, sha256, version, debUrl } : { url, sha256, version };
  }
  return { url: rel.url, sha256: rel.sha256, version: rel.version };
}

export async function registerUpdateCheckRoutes(app: FastifyInstance) {
  const apiUrl = (process.env.STRADO_LICENSE_API ?? 'https://api.strado.io').replace(/\/$/, '');

  app.get('/api/update-check', async () => {
    const current = process.env.STRADO_APP_VERSION;
    if (!current) return { updateAvailable: false }; // dev run — nothing to swap

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(`${apiUrl}/v1/release`, { signal: controller.signal });
      if (res.status !== 200) return { updateAvailable: false };
      const rel = (await res.json()) as ReleaseInfo;
      if (!rel?.version) return { updateAvailable: false };
      const asset = selectReleaseAsset(rel, process.platform);
      // Compare against the asset's version, not the feed's top-level one —
      // see selectReleaseAsset. The offered version must always be the one
      // the download actually installs.
      if (!asset || !isNewer(current, asset.version)) return { updateAvailable: false };
      return {
        updateAvailable: true,
        current,
        version: asset.version,
        url: asset.url,
        sha256: asset.sha256,
        ...(asset.debUrl ? { debUrl: asset.debUrl } : {}),
        notes: rel.notes,
        mandatory: !!rel.mandatory,
      };
    } catch {
      return { updateAvailable: false }; // fail closed on any error
    } finally {
      clearTimeout(timer);
    }
  });
}
