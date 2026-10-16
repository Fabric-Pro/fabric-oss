import { getOrganizationBySlug } from "@repo/database";
import { getSession } from "@saas/auth/lib/server";
import { LibraryDetail } from "@saas/libraries/components/LibraryDetail";
import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";
import { TopRightControls } from "@saas/shared/components/TopRightControls";
import { redirect } from "next/navigation";

interface OrganizationLibraryDetailPageProps {
	params: Promise<{ organizationSlug: string; id: string }>;
}

export default async function OrganizationLibraryDetailPage({
	params,
}: OrganizationLibraryDetailPageProps) {
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
						label: "Libraries",
						href: `/app/${organizationSlug}/libraries`,
					},
					{ label: "Library Details" },
				]}
			/>

			<LibraryDetail workspaceId={id} organizationId={organization.id} />
		</div>
	);
}
