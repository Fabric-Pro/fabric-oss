import { isOrganizationAdmin } from "@repo/auth/lib/helper";
import { AgentsHero } from "@saas/agents/components/AgentsHero";
import { OrgAgentRegistryView } from "@saas/agents/components/OrgAgentRegistryView";
import { getActiveOrganization, getSession } from "@saas/auth/lib/server";
import { redirect } from "next/navigation";

export async function generateMetadata() {
	return {
		title: "Organization Agent Registry",
	};
}

/**
 * Organization Agent Registry Settings Page
 *
 * Allows organization admins to manage agents available to all members.
 * Non-admins can view but not modify.
 *
 * TENANT ISOLATION:
 * - Only shows ORGANIZATION scope agents (not USER scope)
 * - Does not show personal agents from any user
 */
export default async function OrgAgentRegistrySettingsPage({
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
		<div className="space-y-8">
			<AgentsHero />
			<OrgAgentRegistryView readOnly={!isAdmin} />
		</div>
	);
}
