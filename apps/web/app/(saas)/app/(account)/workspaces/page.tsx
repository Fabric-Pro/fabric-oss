import { getSession } from "@saas/auth/lib/server";
import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";
import { TopRightControls } from "@saas/shared/components/TopRightControls";
import { WorkspacesList } from "@saas/workspaces/components/WorkspacesList";
import { redirect } from "next/navigation";

export default async function WorkspacesPage() {
	const session = await getSession();

	if (!session) {
		redirect("/auth/login");
	}

	return (
		<div className="w-full py-6 space-y-6">
			<TopRightControls />
			<PageBreadcrumbs items={[{ label: "Workspaces" }]} />

			<WorkspacesList />
		</div>
	);
}
