import { getSession } from "@saas/auth/lib/server";
import { SettingsHero } from "@saas/settings/components/SettingsHero";
import { SettingsList } from "@saas/shared/components/SettingsList";
import { WorkflowIntegrationSettingsPageContent } from "@saas/workflows/components/integrations/WorkflowIntegrationSettingsPageContent";
import { redirect } from "next/navigation";

export default async function WorkflowActionsSettingsPage() {
	const session = await getSession();
	if (!session) {
		redirect("/auth/login");
	}

	return (
		<>
			<SettingsHero
				title="Integration Providers"
				label="Integrations"
				description="Review the connected systems Fabric can call at runtime, then open any provider to configure credentials and available actions."
			/>
			<SettingsList>
				<WorkflowIntegrationSettingsPageContent
					organizationId={null}
					settingsBasePath="/app/settings/integrations"
				/>
			</SettingsList>
		</>
	);
}
