// Settings shell — tab subnav for tenant/account configuration.
//
// API keys, Billing, and the GitHub integration used to sit as siblings in
// the primary sidebar's "Platform" group. They are settings, so we surface
// them under one /settings space reachable via the avatar menu. The existing
// URLs (/settings/api-keys, /settings/billing, /settings/github-integration)
// are unchanged — direct links and bookmarks keep working.

import { SettingsTabs } from "./tabs";

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col">
      <SettingsTabs />
      {children}
    </div>
  );
}
