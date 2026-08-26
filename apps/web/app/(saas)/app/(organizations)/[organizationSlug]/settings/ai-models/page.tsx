import { isOrganizationAdmin } from "@repo/auth/lib/helper";
import { getActiveOrganization, getSession } from "@saas/auth/lib/server";
import { OrgAiModelPreferencesForm } from "@saas/settings/components/OrgAiModelPreferencesForm";
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

	return (
		<>
			<SettingsHero
				title="AI Models"
				label="Configuration"
				description="Choose which models power each task type for your organization."
			/>
			<SettingsList>
				<OrgAiModelPreferencesForm readOnly={!isAdmin} />
			</SettingsList>
		</>
	);
}
