import { getActiveOrganization, getSession } from "@saas/auth/lib/server";
import { ConnectionsPageContent } from "@saas/data-connections/components/ConnectionsPageContent";
import { SettingsHero } from "@saas/settings/components/SettingsHero";
import { SettingsList } from "@saas/shared/components/SettingsList";
import { redirect } from "next/navigation";

type Props = {
	params: Promise<{ organizationSlug: string }>;
};

export const metadata = {
	title: "Integrations - Settings",
	description: "Configure your organization's third-party integrations",
};

export default async function IntegrationsSettingsPage({ params }: Props) {
	const session = await getSession();
	const { organizationSlug } = await params;

	if (!session) {
		redirect("/auth/login");
	}

	const organization = await getActiveOrganization(organizationSlug);

	if (!organization) {
		redirect("/app");
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
						addHref={`/app/${organizationSlug}/settings/integrations/add`}
						settingsBasePath={`/app/${organizationSlug}/settings/integrations`}
					/>
				</div>
			</SettingsList>
		</>
	);
}
