import { OrganizationApiKeysSettings } from "@saas/organizations/components/OrganizationApiKeysSettings";
import { PersonalApiKeysSettings } from "@saas/settings/components/PersonalApiKeysSettings";
import { SettingsHero } from "@saas/settings/components/SettingsHero";
import { SettingsList } from "@saas/shared/components/SettingsList";

export const metadata = {
	title: "API Keys",
	description: "Manage your API keys for this organization",
};

export default function OrganizationApiKeysSettingsPage() {
	return (
		<>
			<SettingsHero
				title="API Keys"
				label="Organization"
				description="Create and manage the keys you use to reach this organization from outside the app."
			/>
			<SettingsList>
				<OrganizationApiKeysSettings />
				{/*
				 * Renders only for people who actually hold a personal key —
				 * chiefly anyone who has authorized the Fabric Code extension.
				 * Keys live in one place even though only one kind is issued
				 * here, so nobody has to learn that Fabric has two.
				 */}
				<PersonalApiKeysSettings />
			</SettingsList>
		</>
	);
}
