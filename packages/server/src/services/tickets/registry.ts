import { createJiraTicketProvider } from './jira.js';
import { createLinearTicketProvider } from './linear.js';
import type { TicketProvider, TicketProviderId } from './types.js';

const providers: Record<TicketProviderId, TicketProvider> = {
  jira: createJiraTicketProvider(),
  linear: createLinearTicketProvider(),
};

export function getTicketProvider(id: TicketProviderId): TicketProvider {
  return providers[id];
}

export async function listTicketProviders(): Promise<Array<{ provider: TicketProviderId; configured: boolean; label: string }>> {
  return Promise.all(
    (Object.keys(providers) as TicketProviderId[]).map(async (id) => ({
      provider: id,
      configured: await providers[id].configured(),
      label: providers[id].label,
    })),
  );
}
