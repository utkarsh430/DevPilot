// /settings — landing redirect. The page itself has no content; we send
// straight to the first tab. Avatar-menu "Settings" hits this route.
// Setup (not Appearance) is first because it's what the onboarding checklist
// and credential-repair flows point operators at.

import { redirect } from "next/navigation";

export default function SettingsLanding() {
  redirect("/settings/setup");
}
