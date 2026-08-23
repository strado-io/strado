// The active org's cloud-feature flags, as seen by the LOCAL server.
//
// Most Pro features (runners/remote) are enforced at the cloud API, which holds
// org identity. But Jira and Linear run HERE, on the local server, so this is
// where they must be gated. We resolve the flags by asking the cloud for the
// account's org view (the same /v1/org the sidebar reads) and cache them
// briefly — a ticket board can fan out many calls, and the plan changes rarely.
//
// No account / cloud unreachable ⇒ Free ⇒ no cloud features. That is the safe
// default: a local-only user has no org and therefore no Pro grant.
import { createCloudApi } from './cloudApi.js';

type Features = Record<string, boolean>;

const TTL_MS = 60_000;
const { token, cloud } = createCloudApi();
let cache: { at: number; features: Features } | null = null;

export async function orgFeatures(): Promise<Features> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.features;
  let features: Features = {};
  try {
    const t = await token();
    const view = await cloud<{ entitlements?: { features?: Features } }>(
      `/v1/org?token=${encodeURIComponent(t)}`,
    );
    features = view?.entitlements?.features ?? {};
  } catch {
    // no account / cloud down → Free
    features = {};
  }
  cache = { at: Date.now(), features };
  return features;
}

export async function hasFeature(feature: string): Promise<boolean> {
  return (await orgFeatures()) [feature] === true;
}

/** Test/seam hook — drop the cache so the next call re-resolves. */
export function resetEntitlementsCache(): void {
  cache = null;
}
