import type { PeerDto } from '../api';

// The intercom's peer registry (every agent tab that can be messaged). Calls
// to the human ride on the stations (hooks/stations.ts), not here.
export type IntercomState = { peers: PeerDto[]; loaded: boolean; error: string | null };
export const INITIAL_INTERCOM: IntercomState = { peers: [], loaded: false, error: null };
export type IntercomAction =
  | { type: 'peers'; peers: PeerDto[] }
  | { type: 'error'; message: string }
  | { type: 'reset' };

export function intercomReducer(state: IntercomState, action: IntercomAction): IntercomState {
  switch (action.type) {
    // Any successful fetch means the server is reachable again, so a stale
    // error from an earlier failed fetch stops shouting.
    case 'peers': return { peers: action.peers, loaded: true, error: null };
    case 'error': return { ...state, error: action.message };
    // A workspace switch: blank the list instead of leaving the previous
    // workspace's peers on screen while the new fetch is in flight.
    case 'reset': return INITIAL_INTERCOM;
  }
}
