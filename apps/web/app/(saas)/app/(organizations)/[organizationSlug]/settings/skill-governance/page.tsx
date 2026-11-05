import { getActiveOrganization, getSession } from "@saas/auth/lib/server";
import { SkillGovernanceSettings } from "@saas/skills/components/SkillGovernanceSettings";
import { redirect } from "next/navigation";
export default async function SkillGovernancePage({
	params,
}: {
	params: Promise<{ organizationSlug: string }>;
}) {
	const session = await getSession();
	if (!session) {
		redirect("/auth/login");
	}
	const { organizationSlug } = await params;
	const organization = await getActiveOrganization(organizationSlug);
	if (!organization) {
		redirect("/app");
	}
	return <SkillGovernanceSettings organizationId={organization.id} />;
}
