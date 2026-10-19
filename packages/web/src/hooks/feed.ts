import { useEffect, useState } from 'react';
import { api } from '../api';
import { subscribeIntercom } from '../eventStream';
import type { FeedItem } from '../components/dock/StationCard';

/** A burst of messages collapses into one refetch per window. */
export const FEED_THROTTLE_MS = 500;

/** The line's recent messages (one station's when `agentId` is set), first
 * line of each body. Fetched only while something shows it (`enabled`), and
 * refetched on the server's `feed.changed` / `message.queued` signal. */
export function useFeed(wsId: string, agentId: string | null, enabled: boolean): FeedItem[] {
  const [items, setItems] = useState<FeedItem[]>([]);
  useEffect(() => {
    if (!enabled) { setItems([]); return; }
    let alive = true;
    const load = () => {
      Promise.resolve().then(() => api.intercom.feed(wsId, { agent: agentId, limit: 50 }))
        .then((messages) => {
          if (!alive) return;
          setItems(messages.map((m) => ({ id: m.id, from: m.from.agentId, to: m.to, body: (m.body ?? '').split('\n')[0]!.trim(), at: m.createdAt })));
        })
        .catch(() => { /* keep what we had */ });
    };
    load();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = subscribeIntercom(wsId, (evt) => {
      // A new message (an agent's answer to you included) is on the line.
      if ((evt.type !== 'feed.changed' && evt.type !== 'message.queued') || timer) return;
      timer = setTimeout(() => { timer = null; load(); }, FEED_THROTTLE_MS);
    });
    return () => { alive = false; if (timer) clearTimeout(timer); off(); };
  }, [wsId, agentId, enabled]);
  return items;
}
