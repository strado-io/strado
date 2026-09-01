import { useState } from 'react';
import { GithubSection } from './GithubSection';
import { GitlabSection } from './GitlabSection';
import { JiraSection } from './JiraSection';
import { LinearSection } from './LinearSection';

export type IntegrationId = 'jira' | 'linear' | 'gitlab' | 'github';

const INTEGRATIONS: { id: IntegrationId; label: string }[] = [
  { id: 'github', label: 'GitHub' },
  { id: 'gitlab', label: 'GitLab' },
  { id: 'jira', label: 'Jira' },
  { id: 'linear', label: 'Linear' },
];

function LockedIntegration({ name }: { name: string }) {
  return (
    <div className="py-2">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-medium text-zinc-200">{name}</h2>
        <span className="rounded bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-medium text-sky-300 ring-1 ring-inset ring-sky-500/30">
          Pro
        </span>
      </div>
      <p className="mt-2 text-sm text-zinc-500">Available with Strado Pro.</p>
    </div>
  );
}

export function IntegrationsSection({
  initial = 'github',
  locked,
  onJiraConnected,
}: {
  initial?: IntegrationId;
  locked: (id: IntegrationId) => boolean;
  onJiraConnected?: () => void;
}) {
  const [selected, setSelected] = useState<IntegrationId>(initial);
  const active = INTEGRATIONS.find((integration) => integration.id === selected)!;

  return (
    <div className="max-w-2xl">
      <h1 className="mb-5 text-lg font-semibold text-zinc-100">Integrations</h1>

      <div role="tablist" aria-label="Integrations" className="mb-6 flex w-fit gap-1 rounded-lg bg-zinc-900/60 p-1">
        {INTEGRATIONS.map((integration) => (
          <button
            key={integration.id}
            type="button"
            role="tab"
            aria-selected={selected === integration.id}
            onClick={() => setSelected(integration.id)}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition ${
              selected === integration.id
                ? 'bg-zinc-800 text-zinc-100 shadow-sm'
                : 'text-zinc-500 hover:text-zinc-300'
            }`}
          >
            {integration.label}
            {locked(integration.id) && <span className="text-[9px] text-sky-400">Pro</span>}
          </button>
        ))}
      </div>

      <div role="tabpanel" data-testid="integration-pane" data-integration={selected}>
        {locked(selected) ? (
          <LockedIntegration name={active.label} />
        ) : (
          <>
            {selected === 'github' && <GithubSection />}
            {selected === 'gitlab' && <GitlabSection />}
            {selected === 'jira' && <JiraSection onConnected={onJiraConnected} />}
            {selected === 'linear' && <LinearSection />}
          </>
        )}
      </div>
    </div>
  );
}
