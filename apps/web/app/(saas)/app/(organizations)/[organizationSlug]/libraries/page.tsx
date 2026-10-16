import { getOrganizationBySlug } from "@repo/database";
import { getSession } from "@saas/auth/lib/server";
import { LibrariesList } from "@saas/libraries/components/LibrariesList";
import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";
import { TopRightControls } from "@saas/shared/components/TopRightControls";
import { redirect } from "next/navigation";

interface OrganizationLibrariesPageProps {
	params: Promise<{ organizationSlug: string }>;
}

export default async function OrganizationLibrariesPage({
	params,
}: OrganizationLibrariesPageProps) {
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
			<PageBreadcrumbs items={[{ label: "Libraries" }]} />

			<LibrariesList organizationId={organization.id} />
		</div>
	);
}
