import {
	getAccessibleFrameById,
	getOrganizationBySlug,
	getWorkspaceAccessContext,
} from "@repo/database";
import { getSession } from "@saas/auth/lib/server";
import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";
import { TopRightControls } from "@saas/shared/components/TopRightControls";
import { WorkspacePage } from "@saas/workspaces/components/WorkspacePage";
import { notFound, redirect } from "next/navigation";

interface OrganizationWorkspacePageProps {
	params: Promise<{ organizationSlug: string; frameId: string }>;
}

/**
 * `/workspaces/<id>` used to be a document library. A saved link to one still
 * arrives here, so an id that is not a page the viewer may open but is a library
 * of this organization goes on to the library; any other id is not found.
 */
export default async function OrganizationWorkspacePage({
	params,
}: OrganizationWorkspacePageProps) {
	const session = await getSession();

	if (!session) {
		redirect("/auth/login");
	}

	const { organizationSlug, frameId } = await params;

	const organization = await getOrganizationBySlug(organizationSlug);

	if (!organization) {
		redirect("/app");
	}

	const frame = await getAccessibleFrameById({
		id: frameId,
		userId: session.user.id,
		userEmail: session.user.email,
		organizationId: organization.id,
	});

	if (!frame) {
		const library = await getWorkspaceAccessContext(
			frameId,
			session.user.id,
		);
		if (library?.organizationId === organization.id) {
			redirect(`/app/${organizationSlug}/libraries/${frameId}`);
		}
		notFound();
	}

	if (frame.surface !== "workspace") {
		redirect(`/app/${organizationSlug}/frames/${frameId}`);
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
					{ label: frame.title },
				]}
			/>

			<WorkspacePage
				frameId={frame.id}
				organizationId={organization.id}
				organizationSlug={organizationSlug}
			/>
		</div>
	);
}
