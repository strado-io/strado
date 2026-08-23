import { useEffect, useState } from 'react';
import { AccountSection } from './AccountSection';
import { AppearanceSection } from './AppearanceSection';
import { GithubSection } from './GithubSection';
import { GitlabSection } from './GitlabSection';
import { JiraSection } from './JiraSection';
import { LinearSection } from './LinearSection';
import { OrganizationSection } from './OrganizationSection';
import { PrivacySection } from './PrivacySection';
import { ProfileSection } from './ProfileSection';
import { WorkspaceGeneralSection } from './WorkspaceGeneralSection';
import { useEntitlements } from '../../hooks/entitlements';
import type { Feature } from '../../api';

export type SettingsSection = 'profile' | 'organization' | 'appearance' | 'general' | 'jira' | 'linear' | 'gitlab' | 'github' | 'privacy';

type NavItem = { id: SettingsSection; label: string };
type NavGroup = { title: string; items: NavItem[] };

const GROUPS: NavGroup[] = [
  {
    title: 'You',
    items: [
      { id: 'profile', label: 'Profile' },
      { id: 'organization', label: 'Organization' },
      { id: 'appearance', label: 'Appearance' },
    ],
  },
  { title: 'Workspace', items: [{ id: 'general', label: 'General' }] },
  { title: 'Connections', items: [{ id: 'jira', label: 'Jira' }, { id: 'linear', label: 'Linear' }, { id: 'gitlab', label: 'GitLab' }, { id: 'github', label: 'GitHub' }] },
  { title: 'System', items: [{ id: 'privacy', label: 'Privacy' }] },
];

// Which settings sections are Pro (cloud) features. Jira and Linear run on the
// local server but are gated to Pro; GitHub/GitLab stay free.
const SECTION_FEATURE: Partial<Record<SettingsSection, Feature>> = { jira: 'jira', linear: 'linear' };

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
  const [active, setActive] = useState<SettingsSection>(section);
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
        className="flex h-[560px] w-full max-w-3xl overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <nav className="w-52 shrink-0 overflow-y-auto border-r border-zinc-900 bg-zinc-950 p-3">
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
                  <span>{item.label}</span>
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
              Send feedback
            </button>
          )}
        </nav>
        <div className="relative flex-1 overflow-y-auto p-6">
          <button
            aria-label="Close settings"
            onClick={onClose}
            className="absolute right-4 top-4 rounded p-1 text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200"
          >
            ✕
          </button>
          <div data-testid="settings-pane" data-section={active}>
            {active === 'profile' && (
              <div className="flex flex-col gap-6">
                <AccountSection />
                <ProfileSection />
              </div>
            )}
            {active === 'organization' && <OrganizationSection />}
            {active === 'appearance' && <AppearanceSection />}
            {active === 'general' && <WorkspaceGeneralSection />}
            {active === 'jira' && (locked('jira') ? <ProUpsell name="Jira" /> : <JiraSection onConnected={onJiraConnected} />)}
            {active === 'linear' && (locked('linear') ? <ProUpsell name="Linear" /> : <LinearSection />)}
            {active === 'gitlab' && <GitlabSection />}
            {active === 'github' && <GithubSection />}
            {active === 'privacy' && <PrivacySection />}
          </div>
        </div>
      </div>
    </div>
  );
}
