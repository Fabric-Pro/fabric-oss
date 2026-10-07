import { isOrganizationAdmin } from "@repo/auth/lib/helper";
import { getActiveOrganization, getSession } from "@saas/auth/lib/server";
import { AIGatewayHero } from "@saas/settings/components/AIGatewayHero";
import { OrgChatgptPlanPoolSettings } from "@saas/settings/components/chatgpt-plan-pool/OrgChatgptPlanPoolSettings";
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
	// The shared ChatGPT plans are managed by the organization's own admins and
	// owners; a platform admin who is no member has nothing to manage there.
	const memberRole = organization.members.find(
		(member) => member.userId === session?.user.id,
	)?.role;

	return (
		<>
			<AIGatewayHero />
			<SettingsList>
				<OrgAiProvidersSettingsForm readOnly={!isAdmin} />
			</SettingsList>
			<OrgChatgptPlanPoolSettings
				canManage={memberRole === "admin" || memberRole === "owner"}
				organizationSlug={organizationSlug}
			/>
		</>
	);
}
