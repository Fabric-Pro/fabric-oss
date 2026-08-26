import { getSession } from "@saas/auth/lib/server";
import { SettingsHero } from "@saas/settings/components/SettingsHero";
import { UserOpenAPISettingsForm } from "@saas/settings/components/UserOpenAPISettingsForm";
import { SettingsList } from "@saas/shared/components/SettingsList";
import { redirect } from "next/navigation";

export const metadata = {
	title: "OpenAPI Services",
	description: "Connect and manage external APIs via OpenAPI specifications",
};

export default async function OpenAPISettingsPage() {
	const session = await getSession();

	if (!session) {
		redirect("/auth/login");
	}

	return (
		<>
			<SettingsHero
				title="OpenAPI Services"
				label="Configuration"
				description="Connect external APIs by providing their OpenAPI specification URL. Your AI agents can then use these APIs as tools."
			/>
			<SettingsList>
				<UserOpenAPISettingsForm />
			</SettingsList>
		</>
	);
}
