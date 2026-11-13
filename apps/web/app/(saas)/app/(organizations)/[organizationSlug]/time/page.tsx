import { getOrganizationBySlug } from "@repo/database";
import { getSession } from "@saas/auth/lib/server";
import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";
import { TopRightControls } from "@saas/shared/components/TopRightControls";
import { MyTimePage } from "@saas/time-tracking/components/MyTimePage";
import { redirect } from "next/navigation";

export const metadata = {
	title: "My time",
	description: "The time you have logged on your projects",
};

interface OrganizationTimePageProps {
	params: Promise<{ organizationSlug: string }>;
}

/**
 * My time: the signed-in member's own time entries in the organization named
 * in the URL. The same thin shape as the To Do page: resolve the session and
 * the organization, then hand its id to the client component.
 */
export default async function OrganizationTimePage({
	params,
}: OrganizationTimePageProps) {
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
			<PageBreadcrumbs items={[{ label: "My time" }]} />

			<MyTimePage organizationId={organization.id} />
		</div>
	);
}
