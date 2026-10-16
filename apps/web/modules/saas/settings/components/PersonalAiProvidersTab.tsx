"use client";

import { SettingsList } from "@saas/shared/components/SettingsList";
import { useTranslations } from "next-intl";
import { AccountAiProvidersSettings } from "./chatgpt-plan/AccountAiProvidersSettings";
import { ChatgptPlanSettings } from "./chatgpt-plan/ChatgptPlanSettings";

/**
 * The Personal tab of AI Providers (Fizzy #3082): the member's own keys and
 * their own ChatGPT plan, formerly a page of its own under `account/`.
 *
 * Every member reaches it, admin or not — it is where a member who cannot
 * edit the organization's keys adds one of theirs. Nothing here is scoped to
 * the organization: the form posts `organizationId: null`, which is what makes
 * the key the caller's, and the ChatGPT plan section resolves its organization
 * from the session, not from the URL.
 */
export function PersonalAiProvidersTab() {
	const t = useTranslations("settings.aiProviders.personal");
	return (
		<>
			<p className="mt-4 max-w-2xl text-muted-foreground text-sm leading-6">
				{t("intro")}
			</p>
			<SettingsList>
				<AccountAiProvidersSettings />
			</SettingsList>
			<ChatgptPlanSettings />
		</>
	);
}
