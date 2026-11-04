import {
	getAccessibleFrameById,
	getOrganizationBySlug,
	getWorkspaceAccessContext,
} from "@repo/database";
import { getSession } from "@saas/auth/lib/server";
import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";
import { TopRightControls } from "@saas/shared/components/TopRightControls";
import { WorkspaceDetail } from "@saas/workspaces/components/WorkspaceDetail";
import { notFound, redirect } from "next/navigation";

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

	const workspace = await getWorkspaceAccessContext(id, session.user.id);
	if (!workspace || workspace.organizationId !== organization.id) {
		// Generated pages briefly occupied this route. Preserve their saved links
		// only after checking the viewer's access within the current organization.
		const frame = await getAccessibleFrameById({
			id,
			userId: session.user.id,
			userEmail: session.user.email,
			organizationId: organization.id,
		});
		if (frame) {
			redirect(
				`/app/${organizationSlug}/${frame.surface === "workspace" ? "pages" : "frames"}/${id}`,
			);
		}
		notFound();
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
