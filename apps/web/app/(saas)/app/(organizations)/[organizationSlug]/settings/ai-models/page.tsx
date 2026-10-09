import { isOrganizationAdmin } from "@repo/auth/lib/helper";
import { getActiveOrganization, getSession } from "@saas/auth/lib/server";
import { OrgAiModelsSettings } from "@saas/settings/components/ai-models-routing/OrgAiModelsSettings";
import { SettingsHero } from "@saas/settings/components/SettingsHero";
import { SettingsList } from "@saas/shared/components/SettingsList";
import { redirect } from "next/navigation";

export async function generateMetadata() {
	return {
		title: "Organization AI Model Preferences",
	};
}

export default async function OrgAiModelPreferencesPage({
	params,
}: {
	params: Promise<{ organizationSlug: string }>;
}) {
	const session = await getSession();
	const { organizationSlug } = await params;
	const organization = await getActiveOrganization(organizationSlug);

	if (!organization) {
		redirect("/app");
	}

	const isAdmin = isOrganizationAdmin(organization, session?.user);
	// The organization's own admins and owners choose its ChatGPT plan models;
	// a platform admin who is no member has nothing to choose there.
	const memberRole = organization.members.find(
		(member) => member.userId === session?.user.id,
	)?.role;

	return (
		<>
			<SettingsHero
				title="AI Models"
				label="Configuration"
				description="Choose which models power each task type for your organization."
			/>
			<SettingsList>
				<OrgAiModelsSettings
					canManagePlanModels={
						memberRole === "admin" || memberRole === "owner"
					}
					readOnly={!isAdmin}
				/>
			</SettingsList>
		</>
	);
}
