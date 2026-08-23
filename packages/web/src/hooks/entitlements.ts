// The active org's plan + cloud-feature flags, for gating cloud UI.
//
// Distinct from useCapabilities (what the SERVER can do — Electron vs runner):
// this is what the org's PLAN allows. Default is Free — cloud features hidden —
// so a local-only user with no account, or a slow/failed fetch, never briefly
// sees a Pro affordance it can't use. A Pro org flips these to true after the
// /api/org fetch resolves.
import { useEffect, useState } from 'react';
import { api, type Entitlements, type Feature } from '../api';

export const FREE_ENTITLEMENTS: Entitlements = {
  plan: 'free',
  features: {
    runners: false,
    remote_worktrees: false,
    remote_ports: false,
    sandboxes: false,
    jira: false,
    linear: false,
  },
};

export function useEntitlements(): Entitlements {
  const [ent, setEnt] = useState<Entitlements>(FREE_ENTITLEMENTS);
  useEffect(() => {
    let live = true;
    // Optional-chained: some hosts (and tests) stub `api` without `org`, and a
    // hard `api.org.get` would throw synchronously inside the effect.
    Promise.resolve(api.org?.get?.())
      .then((v) => {
        // An older cloud omits entitlements; treat that as Free, not a crash.
        if (live && v?.entitlements?.features) setEnt(v.entitlements);
      })
      .catch(() => {
        /* no account / cloud down → stay Free */
      });
    return () => {
      live = false;
    };
  }, []);
  return ent;
}

/** Convenience: is a single cloud feature available on the active plan? */
export function useFeature(feature: Feature): boolean {
  return useEntitlements().features[feature];
}
