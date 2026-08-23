// What the server we're talking to can actually do.
//
// A headless runner has no Electron, so the VS Code embed and the preview
// browser genuinely do not exist there. The UI asks instead of inferring from
// "am I in Electron": the desktop shell could one day be pointed at a remote
// server, and a tab that renders nothing is worse than no tab at all.
import { useEffect, useState } from 'react';

export interface Capabilities {
  /** VS Code embed + preview browser (Electron WebContentsView features). */
  embeds: boolean;
  notifications: boolean;
  /** True when served by a self-hosted runner rather than the desktop app. */
  runner: boolean;
  /** Which instance this is — a dev build announces itself in the title. */
  profile: 'stable' | 'dev';
}

// Optimistic default: an older server has no /api/capabilities, and hiding
// tabs from every existing install during the upgrade window would be a
// far worse failure than briefly showing a tab a runner can't honour.
export const DEFAULT_CAPABILITIES: Capabilities = {
  embeds: true,
  notifications: true,
  runner: false,
  profile: 'stable',
};

export async function fetchCapabilities(): Promise<Capabilities> {
  try {
    const res = await fetch('/api/capabilities');
    if (!res.ok) return DEFAULT_CAPABILITIES;
    const body = (await res.json()) as Partial<Capabilities>;
    return {
      embeds: body.embeds ?? DEFAULT_CAPABILITIES.embeds,
      notifications: body.notifications ?? DEFAULT_CAPABILITIES.notifications,
      runner: body.runner ?? DEFAULT_CAPABILITIES.runner,
      // An unexpected value must never produce a bogus title.
      profile: body.profile === 'dev' ? 'dev' : 'stable',
    };
  } catch {
    return DEFAULT_CAPABILITIES;
  }
}

/** Server capabilities, fetched once per mount. */
export function useCapabilities(): Capabilities {
  const [caps, setCaps] = useState<Capabilities>(DEFAULT_CAPABILITIES);
  useEffect(() => {
    let live = true;
    void fetchCapabilities().then((c) => {
      if (live) setCaps(c);
    });
    return () => {
      live = false;
    };
  }, []);
  return caps;
}
