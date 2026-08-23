// Sidebar org chip's data source. Fetches once on mount, like AccountSection
// and OrganizationSection do for their own state. The local server answers
// 400 "no Strado account on this machine — sign in first" when there's no
// signed-in license — treat ANY failure that way: render nothing rather than
// surface an error in the sidebar, since the chip is decoration, not a gate.
import { useCallback, useEffect, useState } from 'react';
import { api, type OrgView } from '../api';

export function useOrg() {
  const [view, setView] = useState<OrgView | null>(null);

  const refresh = useCallback(() => {
    api.org
      .get()
      .then(setView)
      .catch(() => setView(null));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const switchTo = useCallback(async (orgId: string) => {
    const next = await api.org.switch(orgId);
    setView(next);
  }, []);

  return { view, refresh, switchTo };
}
