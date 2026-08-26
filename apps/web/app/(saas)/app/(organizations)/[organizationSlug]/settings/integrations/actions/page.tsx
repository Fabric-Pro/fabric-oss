import { getActiveOrganization, getSession } from "@saas/auth/lib/server";
import { SettingsHero } from "@saas/settings/components/SettingsHero";
import { SettingsList } from "@saas/shared/components/SettingsList";
import { WorkflowIntegrationSettingsPageContent } from "@saas/workflows/components/integrations/WorkflowIntegrationSettingsPageContent";
import { redirect } from "next/navigation";

type Props = {
	params: Promise<{ organizationSlug: string }>;
};

export default async function OrgWorkflowActionsSettingsPage({
	params,
}: Props) {
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
				title="Integration Providers"
				label="Integrations"
				description="Review the connected systems Fabric can call at runtime, then open any provider to configure credentials and available actions."
			/>
			<SettingsList>
				<WorkflowIntegrationSettingsPageContent
					organizationId={organization.id}
					settingsBasePath={`/app/${organizationSlug}/settings/integrations`}
				/>
			</SettingsList>
		</>
	);
}
