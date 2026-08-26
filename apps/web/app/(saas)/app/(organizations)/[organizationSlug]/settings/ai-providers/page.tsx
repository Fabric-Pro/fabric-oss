import { isOrganizationAdmin } from "@repo/auth/lib/helper";
import { getActiveOrganization, getSession } from "@saas/auth/lib/server";
import { AIGatewayHero } from "@saas/settings/components/AIGatewayHero";
import { OrgAiProvidersSettingsForm } from "@saas/settings/components/OrgAiProvidersSettingsForm";
import { SettingsList } from "@saas/shared/components/SettingsList";
import { redirect } from "next/navigation";

export async function generateMetadata() {
	return {
		title: "AI Providers",
	};
}

export default async function OrgAiProvidersSettingsPage({
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
			<AIGatewayHero />
			<SettingsList>
				<OrgAiProvidersSettingsForm readOnly={!isAdmin} />
			</SettingsList>
		</>
	);
}
