import { getSession } from "@saas/auth/lib/server";
import { InvitationsList } from "@saas/projects/components/InvitationsList";
import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";
import { TopRightControls } from "@saas/shared/components/TopRightControls";
import { redirect } from "next/navigation";

export default async function InvitationsPage() {
	const session = await getSession();

	if (!session) {
		redirect("/auth/login");
	}

	return (
		<div className="w-full py-6 space-y-6">
			<TopRightControls />
			<PageBreadcrumbs items={[{ label: "Invitations" }]} />

			<InvitationsList />
		</div>
	);
}
