import type { TicketProviderId } from '../api';
import { providerLabel, useTickets } from '../hooks/tickets';

const TONE: Record<TicketProviderId, string> = { jira: 'bg-blue-500', linear: 'bg-violet-500' };

// Dot only when more than one provider is connected — single-provider
// installs shouldn't grow badges out of nowhere.
export function TicketSourceBadge({ provider }: { provider: TicketProviderId }) {
  const { configured } = useTickets();
  if (configured.length < 2) return null;
  const label = providerLabel(provider);
  return <span title={label} aria-label={label} className={`h-1.5 w-1.5 shrink-0 rounded-full ${TONE[provider]}`} />;
}
