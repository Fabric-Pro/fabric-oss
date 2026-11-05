import { getActiveOrganization, getSession } from "@saas/auth/lib/server";
import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";
import { TopRightControls } from "@saas/shared/components/TopRightControls";
import { SkillNewLoader } from "@saas/skills/components/SkillNewLoader";
import { redirect } from "next/navigation";

type Props = {
	params: Promise<{ organizationSlug: string }>;
	searchParams: Promise<{ mode?: string; source?: string }>;
};

export default async function OrganizationNewSkillPage({
	params,
	searchParams,
}: Props) {
	const session = await getSession();
	const { organizationSlug } = await params;
	const query = await searchParams;

	if (!session) {
		redirect("/auth/login");
	}

	const organization = await getActiveOrganization(organizationSlug);

	if (!organization) {
		redirect("/app");
	}

	return (
		<div className="min-h-screen">
			<div className="w-full py-6 px-6 space-y-6">
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
						{ label: "New Skill" },
					]}
				/>
			</div>
			<SkillNewLoader
				mode={
					query.mode === "conversation" ? "conversation" : "scratch"
				}
				sourceSkillId={
					query.source && query.source.length <= 200
						? query.source
						: undefined
				}
			/>
		</div>
	);
}
