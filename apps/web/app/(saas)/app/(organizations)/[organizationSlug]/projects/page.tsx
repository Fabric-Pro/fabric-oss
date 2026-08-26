import {
	getActiveOrganization,
	getSession,
	isGuestInOrg,
} from "@saas/auth/lib/server";
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

	// Project-only guests must not see the host org named in the
	// breadcrumb trail — drop the org crumb and keep just "Projects".
	const guest = await isGuestInOrg(session.user.id, organization.id);

	return (
		<div className="w-full py-6 space-y-6">
			<TopRightControls />
			<PageBreadcrumbs
				items={
					guest
						? [{ label: "Projects" }]
						: [
								{
									label: organization.name,
									href: `/app/${organizationSlug}`,
								},
								{ label: "Projects" },
							]
				}
			/>

			<ProjectsList />
		</div>
	);
}
