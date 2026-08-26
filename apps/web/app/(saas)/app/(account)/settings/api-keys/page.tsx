import { getSession } from "@saas/auth/lib/server";
import { SettingsHero } from "@saas/settings/components/SettingsHero";
import { UserApiKeysSettings } from "@saas/settings/components/UserApiKeysSettings";
import { SettingsList } from "@saas/shared/components/SettingsList";
import { redirect } from "next/navigation";

export const metadata = {
	title: "API Keys",
	description: "Manage API keys for external integrations",
};

export default async function ApiKeysSettingsPage() {
	const session = await getSession();

	if (!session) {
		redirect("/auth/login");
	}

	return (
		<>
			<SettingsHero
				title="API Keys"
				label="Configuration"
				description="Manage API keys for external integrations like MCP Server, Claude Desktop, and other third-party applications."
			/>
			<SettingsList>
				<UserApiKeysSettings />
			</SettingsList>
		</>
	);
}
