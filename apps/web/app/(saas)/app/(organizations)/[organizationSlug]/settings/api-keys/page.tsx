import { OrganizationApiKeysSettings } from "@saas/organizations/components/OrganizationApiKeysSettings";
import { SettingsHero } from "@saas/settings/components/SettingsHero";
import { SettingsList } from "@saas/shared/components/SettingsList";

export const metadata = {
	title: "Organization API Keys",
	description: "Manage API keys for external agents and integrations",
};

export default function OrganizationApiKeysSettingsPage() {
	return (
		<>
			<SettingsHero
				title="API Keys"
				label="Organization"
				description="Create and manage API keys for programmatic access to your organization."
			/>
			<SettingsList>
				<OrganizationApiKeysSettings />
			</SettingsList>
		</>
	);
}
