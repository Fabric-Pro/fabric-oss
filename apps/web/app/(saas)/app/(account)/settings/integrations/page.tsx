import { getSession } from "@saas/auth/lib/server";
import { ConnectionsPageContent } from "@saas/data-connections/components/ConnectionsPageContent";
import { SettingsHero } from "@saas/settings/components/SettingsHero";
import { SettingsList } from "@saas/shared/components/SettingsList";
import { redirect } from "next/navigation";

export const metadata = {
	title: "Integrations - Settings",
	description: "Configure your third-party integrations",
};

export default async function IntegrationsSettingsPage() {
	const session = await getSession();

	if (!session) {
		redirect("/auth/login");
	}

	return (
		<>
			<SettingsHero
				title="Integrations"
				label="Integrations"
				getStartedPageId="integrations"
				description="Connect external systems Fabric can search, cite, and call at runtime."
			/>
			<SettingsList>
				<div className="w-full py-6">
					<ConnectionsPageContent
						addHref="/app/settings/integrations/add"
						settingsBasePath="/app/settings/integrations"
					/>
				</div>
			</SettingsList>
		</>
	);
}
