import { getActiveOrganization, getSession } from "@saas/auth/lib/server";
import { InvitationsList } from "@saas/projects/components/InvitationsList";
import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";
import { TopRightControls } from "@saas/shared/components/TopRightControls";
import { notFound, redirect } from "next/navigation";

export default async function OrganizationInvitationsPage({
	params,
}: {
	params: Promise<{ organizationSlug: string }>;
}) {
	const session = await getSession();

	if (!session) {
		redirect("/auth/login");
	}

	const { organizationSlug } = await params;
	const activeOrganization = await getActiveOrganization(organizationSlug);

	if (!activeOrganization) {
		return notFound();
	}

	return (
		<div className="w-full py-6 space-y-6">
			<TopRightControls />
			<PageBreadcrumbs
				items={[
					{
						label: activeOrganization.name,
						href: `/app/${organizationSlug}`,
					},
					{ label: "Invitations" },
				]}
			/>

			<InvitationsList />
		</div>
	);
}
