import { useEffect, useState } from 'react';
import { AccountSection } from './AccountSection';
import { AppearanceSection } from './AppearanceSection';
import { IntegrationsSection, type IntegrationId } from './IntegrationsSection';
import { OrganizationSection } from './OrganizationSection';
import { PrivacySection } from './PrivacySection';
import { ProfileSection } from './ProfileSection';
import { WorkspaceManagementSection } from '../../pages/WorkspacesPage';
import { RunnersPanel } from '../RunnersPanel';
import { useEntitlements } from '../../hooks/entitlements';
import type { Feature } from '../../api';

export type SettingsSection = 'profile' | 'organization' | 'appearance' | 'workspaces' | 'runners' | 'integrations' | IntegrationId | 'privacy';

type NavItem = { id: SettingsSection; label: string };
type NavGroup = { title: string; items: NavItem[] };

function SettingsNavIcon({ id }: { id: SettingsSection | 'feedback' }) {
  const props = {
    width: 16,
    height: 16,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    className: 'shrink-0',
    'data-testid': `settings-icon-${id}`,
  };

  if (id === 'profile') {
    return (
      <svg {...props}>
        <path d="M4 21.817C4.603 22 5.416 22 6.8 22h10.4c1.384 0 2.197 0 2.8-.183M4 21.817c-.129-.039-.249-.086-.362-.144A3 3 0 0 1 2.327 20.362C2 19.72 2 18.88 2 17.2V6.8c0-1.68 0-2.52.327-3.162a3 3 0 0 1 1.311-1.311C4.28 2 5.12 2 6.8 2h10.4c1.68 0 2.52 0 3.162.327a3 3 0 0 1 1.311 1.311C22 4.28 22 5.12 22 6.8v10.4c0 1.68 0 2.52-.327 3.162a3 3 0 0 1-1.311 1.311c-.113.058-.233.105-.362.144M4 21.817c0-.809.005-1.237.077-1.597a4 4 0 0 1 3.143-3.143C7.606 17 8.071 17 9 17h6c.929 0 1.394 0 1.78.077a4 4 0 0 1 3.143 3.143c.072.36.077.788.077 1.597M16 9.5a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z" />
      </svg>
    );
  }
  if (id === 'organization') {
    return (
      <svg {...props}>
        <path d="M5 21V5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v16M16 9h3a2 2 0 0 1 2 2v10M3 21h19M8 7h2M8 11h2M8 15h2" />
      </svg>
    );
  }
  if (id === 'appearance') {
    return (
      <svg {...props}>
        <path d="M12 2v2M12 20v2M4 12H2M6.314 6.314 4.9 4.9M17.686 6.314 19.1 4.9M6.314 17.69 4.9 19.104M17.686 17.69l1.414 1.414M22 12h-2M17 12a5 5 0 1 1-10 0 5 5 0 0 1 10 0Z" />
      </svg>
    );
  }
  if (id === 'workspaces') {
    return (
      <svg {...props}>
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <path d="M3 9h18M9 9v12" />
      </svg>
    );
  }
  if (id === 'runners') {
    return (
      <svg {...props}>
        <path d="M5 5.5A1.5 1.5 0 0 1 6.5 4h11A1.5 1.5 0 0 1 19 5.5V16H5V5.5ZM3 20h18M8.5 20h7" />
      </svg>
    );
  }
  if (id === 'integrations') {
    return (
      <svg {...props}>
        <path d="M7.5 4.5a2.5 2.5 0 0 1 5 0V6h1c1.398 0 2.097 0 2.648.228a3 3 0 0 1 1.624 1.624C18 8.403 18 9.102 18 10.5h1.5a2.5 2.5 0 0 1 0 5H18v1.7c0 1.68 0 2.52-.327 3.162a3 3 0 0 1-1.311 1.311C15.72 22 14.88 22 13.2 22h-.7v-1.75a2.25 2.25 0 0 0-4.5 0V22H6.8c-1.68 0-2.52 0-3.162-.327a3 3 0 0 1-1.311-1.311C2 19.72 2 18.88 2 17.2v-1.7h1.5a2.5 2.5 0 0 0 0-5H2c0-1.398 0-2.097.228-2.648a3 3 0 0 1 1.624-1.624C4.403 6 5.102 6 6.5 6h1V4.5Z" />
      </svg>
    );
  }
  if (id === 'privacy') {
    return (
      <svg {...props}>
        <path d="M12 3 19 6v5c0 4.6-2.8 8.1-7 10-4.2-1.9-7-5.4-7-10V6l7-3Z" />
        <path d="m9.5 12 1.7 1.7 3.6-4" />
      </svg>
    );
  }
  return (
    <svg {...props}>
      <path d="M4 5h16v11H9l-5 4v-4H4V5Z" />
    </svg>
  );
}

const GROUPS: NavGroup[] = [
  {
    title: 'You',
    items: [
      { id: 'profile', label: 'Profile' },
      { id: 'organization', label: 'Organization' },
      { id: 'appearance', label: 'Appearance' },
    ],
  },
  {
    title: 'Workspace',
    items: [{ id: 'workspaces', label: 'Workspaces' }],
  },
  { title: 'Infrastructure', items: [{ id: 'runners', label: 'Runners' }] },
  { title: 'Connections', items: [{ id: 'integrations', label: 'Integrations' }] },
  { title: 'System', items: [{ id: 'privacy', label: 'Privacy' }] },
];

// Which settings sections are Pro (cloud) features. Jira and Linear run on the
// local server but are gated to Pro; GitHub/GitLab stay free.
const SECTION_FEATURE: Partial<Record<SettingsSection, Feature>> = { runners: 'runners', jira: 'jira', linear: 'linear' };

const INTEGRATION_IDS: IntegrationId[] = ['jira', 'linear', 'gitlab', 'github'];

function isIntegration(id: SettingsSection): id is IntegrationId {
  return INTEGRATION_IDS.includes(id as IntegrationId);
}

function ProUpsell({ name }: { name: string }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <h2 className="text-lg font-medium text-zinc-100">{name}</h2>
        <span className="rounded bg-sky-500/15 px-1.5 py-0.5 text-[11px] font-medium text-sky-300 ring-1 ring-inset ring-sky-500/30">
          Pro
        </span>
      </div>
      <p className="max-w-md text-sm text-zinc-400">
        {name} is part of Strado Pro. It isn’t available on the free plan yet — reach out if you’d
        like early access.
      </p>
    </div>
  );
}

export function SettingsModal({
  section = 'profile',
  onClose,
  onJiraConnected,
  onOpenFeedback,
}: {
  section?: SettingsSection;
  onClose: () => void;
  onJiraConnected?: () => void;
  onOpenFeedback?: () => void;
}) {
  const initialIntegration = isIntegration(section) ? section : 'github';
  const [active, setActive] = useState<SettingsSection>(isIntegration(section) ? 'integrations' : section);
  const { features } = useEntitlements();
  const locked = (id: SettingsSection): boolean => {
    const f = SECTION_FEATURE[id];
    return f != null && !features[f];
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="flex h-[640px] max-h-[calc(100vh-2rem)] w-full max-w-4xl overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <nav aria-label="Settings" className="w-52 shrink-0 overflow-y-auto border-r border-zinc-800 bg-zinc-950/80 p-3">
          <div className="mb-4 px-2 pt-1 text-sm font-semibold text-zinc-200">Settings</div>
          {GROUPS.map((group) => (
            <div key={group.title} className="mb-4">
              <div className="px-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-zinc-600">
                {group.title}
              </div>
              {group.items.map((item) => (
                <button
                  key={item.id}
                  onClick={() => setActive(item.id)}
                  className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm transition ${
                    active === item.id
                      ? 'bg-zinc-800 text-zinc-100'
                      : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'
                  }`}
                >
                  <span className="flex items-center gap-2.5">
                    <SettingsNavIcon id={item.id} />
                    <span>{item.label}</span>
                  </span>
                  {locked(item.id) && (
                    <span className="rounded bg-sky-500/15 px-1 text-[10px] font-medium text-sky-300 ring-1 ring-inset ring-sky-500/30">
                      Pro
                    </span>
                  )}
                </button>
              ))}
            </div>
          ))}
          {onOpenFeedback && (
            <button
              onClick={() => { onClose(); onOpenFeedback(); }}
              className="block w-full rounded-md px-2 py-1.5 text-left text-sm text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
            >
              <span className="flex items-center gap-2.5">
                <SettingsNavIcon id="feedback" />
                <span>Send feedback</span>
              </span>
            </button>
          )}
        </nav>
        <div className="relative flex-1 overflow-y-auto px-7 py-6">
          <button
            aria-label="Close settings"
            onClick={onClose}
            className="absolute right-4 top-4 rounded p-1 text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200"
          >
            ✕
          </button>
          <div data-testid="settings-pane" data-section={active}>
            {active === 'profile' && (
              <div className="max-w-2xl">
                <div className="mb-6 pr-10">
                  <h1 className="text-lg font-semibold text-zinc-100">Profile</h1>
                </div>
                <div className="space-y-8">
                  <ProfileSection />
                  <AccountSection />
                </div>
              </div>
            )}
            {active === 'organization' && <OrganizationSection />}
            {active === 'appearance' && <AppearanceSection />}
            {active === 'workspaces' && <WorkspaceManagementSection />}
            {active === 'runners' && (locked('runners') ? <ProUpsell name="Runners" /> : <RunnersPanel />)}
            {active === 'integrations' && (
              <IntegrationsSection
                initial={initialIntegration}
                locked={(id) => locked(id)}
                onJiraConnected={onJiraConnected}
              />
            )}
            {active === 'privacy' && <PrivacySection />}
          </div>
        </div>
      </div>
    </div>
  );
}
