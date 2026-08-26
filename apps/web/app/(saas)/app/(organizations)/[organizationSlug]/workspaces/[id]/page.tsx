import { getOrganizationBySlug } from "@repo/database";
import { getSession } from "@saas/auth/lib/server";
import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";
import { TopRightControls } from "@saas/shared/components/TopRightControls";
import { WorkspaceDetail } from "@saas/workspaces/components/WorkspaceDetail";
import { redirect } from "next/navigation";

interface OrganizationWorkspaceDetailPageProps {
	params: Promise<{ organizationSlug: string; id: string }>;
}

export default async function OrganizationWorkspaceDetailPage({
	params,
}: OrganizationWorkspaceDetailPageProps) {
	const session = await getSession();

	if (!session) {
		redirect("/auth/login");
	}

	const { organizationSlug, id } = await params;

	const organization = await getOrganizationBySlug(organizationSlug);

	if (!organization) {
		redirect("/app");
	}

	return (
		<div className="w-full py-6 space-y-6">
			<TopRightControls />
			<PageBreadcrumbs
				items={[
					{
						label: "Workspaces",
						href: `/app/${organizationSlug}/workspaces`,
					},
					{ label: "Workspace Details" },
				]}
			/>

			<WorkspaceDetail
				workspaceId={id}
				organizationId={organization.id}
			/>
		</div>
	);
}
