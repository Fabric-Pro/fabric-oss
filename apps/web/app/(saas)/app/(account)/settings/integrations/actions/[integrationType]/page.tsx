import { getSession } from "@saas/auth/lib/server";
import { SettingsHero } from "@saas/settings/components/SettingsHero";
import { SettingsList } from "@saas/shared/components/SettingsList";
import { WorkflowIntegrationSettingsPageContent } from "@saas/workflows/components/integrations/WorkflowIntegrationSettingsPageContent";
import type { IntegrationType } from "@saas/workflows/lib/plugins";
import { redirect } from "next/navigation";

type Props = {
	params: Promise<{ integrationType: IntegrationType }>;
};

export default async function WorkflowActionIntegrationDetailPage({
	params,
}: Props) {
	const session = await getSession();
	const { integrationType } = await params;
	if (!session) {
		redirect("/auth/login");
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
					organizationId={null}
					settingsBasePath="/app/settings/integrations"
					initialIntegration={integrationType}
				/>
			</SettingsList>
		</>
	);
}
