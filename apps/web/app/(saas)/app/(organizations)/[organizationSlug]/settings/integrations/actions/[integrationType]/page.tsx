import { getActiveOrganization, getSession } from "@saas/auth/lib/server";
import { SettingsHero } from "@saas/settings/components/SettingsHero";
import { SettingsList } from "@saas/shared/components/SettingsList";
import { WorkflowIntegrationSettingsPageContent } from "@saas/workflows/components/integrations/WorkflowIntegrationSettingsPageContent";
import type { IntegrationType } from "@saas/workflows/lib/plugins";
import { redirect } from "next/navigation";

type Props = {
	params: Promise<{
		organizationSlug: string;
		integrationType: IntegrationType;
	}>;
};

export default async function OrgWorkflowActionIntegrationDetailPage({
	params,
}: Props) {
	const session = await getSession();
	const { organizationSlug, integrationType } = await params;
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
				title="Integration Provider"
				label="Integrations"
				description="Review this connected system, manage its credentials, and see which actions Fabric can run through it."
			/>
			<SettingsList>
				<WorkflowIntegrationSettingsPageContent
					organizationId={organization.id}
					settingsBasePath={`/app/${organizationSlug}/settings/integrations`}
					initialIntegration={integrationType}
				/>
			</SettingsList>
		</>
	);
}
