import { getAccessibleFrameById, getOrganizationBySlug } from "@repo/database";
import { getSession } from "@saas/auth/lib/server";
import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";
import { TopRightControls } from "@saas/shared/components/TopRightControls";
import { PageView } from "@saas/pages/components/PageView";
import { notFound, redirect } from "next/navigation";

interface OrganizationPageViewProps {
	params: Promise<{ organizationSlug: string; frameId: string }>;
}

/** Generated pages are separate from document Workspaces. */
export default async function OrganizationPageView({
	params,
}: OrganizationPageViewProps) {
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
						label: "Pages",
						href: `/app/${organizationSlug}/pages`,
					},
					{ label: frame.title },
				]}
			/>

			<PageView
				frameId={frame.id}
				organizationId={organization.id}
				organizationSlug={organizationSlug}
			/>
		</div>
	);
}
