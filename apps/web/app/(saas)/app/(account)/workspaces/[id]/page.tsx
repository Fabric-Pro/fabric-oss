import { getSession } from "@saas/auth/lib/server";
import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";
import { TopRightControls } from "@saas/shared/components/TopRightControls";
import { WorkspaceDetail } from "@saas/workspaces/components/WorkspaceDetail";
import { redirect } from "next/navigation";

interface WorkspaceDetailPageProps {
	params: Promise<{ id: string }>;
}

export default async function WorkspaceDetailPage({
	params,
}: WorkspaceDetailPageProps) {
	const session = await getSession();

	if (!session) {
		redirect("/auth/login");
	}

	const { id } = await params;

	return (
		<div className="w-full py-6 space-y-6">
			<TopRightControls />
			<PageBreadcrumbs
				items={[
					{ label: "Workspaces", href: "/app/workspaces" },
					{ label: "Workspace Details" },
				]}
			/>

			<WorkspaceDetail workspaceId={id} />
		</div>
	);
}
