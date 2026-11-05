import { getActiveOrganization, getSession } from "@saas/auth/lib/server";
import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";
import { TopRightControls } from "@saas/shared/components/TopRightControls";
import { SkillEditLoader } from "@saas/skills/components/SkillEditLoader";
import { redirect } from "next/navigation";

type Props = {
	params: Promise<{ organizationSlug: string; id: string }>;
	searchParams: Promise<{ returnTo?: string | string[] }>;
};

export default async function OrganizationEditSkillPage({
	params,
	searchParams,
}: Props) {
	const session = await getSession();
	const { organizationSlug, id } = await params;
	const query = await searchParams;

	if (!session) {
		redirect("/auth/login");
	}

	const organization = await getActiveOrganization(organizationSlug);

	if (!organization) {
		redirect("/app");
	}

	return (
		<div className="w-full py-6 space-y-6">
			<TopRightControls />
			<PageBreadcrumbs
				items={[
					{
						label: organization.name,
						href: `/app/${organizationSlug}`,
					},
					{
						label: "Skills",
						href: `/app/${organizationSlug}/skills`,
					},
					{ label: "Edit Skill" },
				]}
			/>
			<SkillEditLoader
				skillId={id}
				returnTo={
					typeof query.returnTo === "string"
						? query.returnTo
						: undefined
				}
			/>
		</div>
	);
}
