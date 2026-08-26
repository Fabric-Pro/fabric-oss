import { getOrganizationBySlug } from "@repo/database";
import { getSession } from "@saas/auth/lib/server";
import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";
import { TopRightControls } from "@saas/shared/components/TopRightControls";
import { WorkspacesList } from "@saas/workspaces/components/WorkspacesList";
import { redirect } from "next/navigation";

interface OrganizationWorkspacesPageProps {
	params: Promise<{ organizationSlug: string }>;
}

export default async function OrganizationWorkspacesPage({
	params,
}: OrganizationWorkspacesPageProps) {
	const session = await getSession();

	if (!session) {
		redirect("/auth/login");
	}

	const { organizationSlug } = await params;

	const organization = await getOrganizationBySlug(organizationSlug);

	if (!organization) {
		redirect("/app");
	}

	return (
		<div className="w-full py-6 space-y-6">
			<TopRightControls />
			<PageBreadcrumbs items={[{ label: "Workspaces" }]} />

			<WorkspacesList organizationId={organization.id} />
		</div>
	);
}
