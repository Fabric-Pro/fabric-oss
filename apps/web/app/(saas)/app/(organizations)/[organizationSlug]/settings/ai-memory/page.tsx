import { getActiveOrganization } from "@saas/auth/lib/server";
import { OrchestratorMemoryForm } from "@saas/settings/components/OrchestratorMemoryForm";
import { SettingsHero } from "@saas/settings/components/SettingsHero";
import { SettingsList } from "@saas/shared/components/SettingsList";
import { notFound } from "next/navigation";

export const metadata = {
	title: "AI Memory",
};

export default async function OrgAiMemorySettingsPage({
	params,
}: {
	params: Promise<{ organizationSlug: string }>;
}) {
	const { organizationSlug } = await params;

	// Resolve the org from the URL slug — the per-tab source of truth. Reading
	// session.activeOrganizationId here was a multi-tab bug: it could redirect
	// this tab out of the org (when another tab cleared the active org) and, worse,
	// hand the form a DIFFERENT tab's org id, writing memory to the wrong tenant.
	const organization = await getActiveOrganization(organizationSlug);

	if (!organization) {
		notFound();
	}

	return (
		<>
			<SettingsHero
				title="AI Memory"
				label="Configuration"
				description="Configure how the AI retains context across your organization's conversations."
			/>
			<SettingsList>
				<OrchestratorMemoryForm organizationId={organization.id} />
			</SettingsList>
		</>
	);
}
