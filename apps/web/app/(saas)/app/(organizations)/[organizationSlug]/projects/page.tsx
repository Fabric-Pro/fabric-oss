import { getActiveOrganization, getSession } from "@saas/auth/lib/server";
import { ProjectsList } from "@saas/projects/components/ProjectsList";
import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";
import { TopRightControls } from "@saas/shared/components/TopRightControls";
import { redirect } from "next/navigation";

export default async function ProjectsPage({
	params,
}: {
	params: Promise<{ organizationSlug: string }>;
}) {
	const session = await getSession();
	const { organizationSlug } = await params;

	if (!session) {
		redirect("/auth/login");
	}

	const organization = await getActiveOrganization(organizationSlug);

	if (!organization) {
		redirect("/app");
	}

	// The org crumb used to be dropped here, by hand, for project-only guests.
	// `PageBreadcrumbs` now drops it for every page at once — this one was the
	// only one of twenty-three that had remembered to — so the trail is passed
	// unconditionally and the membership probe this page made for it is gone.
	return (
		<div className="w-full py-6 space-y-6">
			<TopRightControls />
			<PageBreadcrumbs
				items={[
					{
						label: organization.name,
						href: `/app/${organizationSlug}`,
					},
					{ label: "Projects" },
				]}
			/>

			<ProjectsList />
		</div>
	);
}
