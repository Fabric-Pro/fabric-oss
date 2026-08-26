import { getActiveOrganization, getSession } from "@saas/auth/lib/server";
import { ProjectKanbanRouteView } from "@saas/projects/components/kanban/ProjectKanbanRouteView";
import { redirect } from "next/navigation";

interface Props {
	params: Promise<{ id: string; organizationSlug: string }>;
	searchParams: Promise<{ storyId?: string }>;
}

export default async function OrganizationProjectKanbanPage({
	params,
	searchParams,
}: Props) {
	const session = await getSession();
	if (!session?.user) {
		redirect("/auth/login");
	}

	const { id, organizationSlug } = await params;
	const { storyId } = await searchParams;
	const activeOrganization = await getActiveOrganization(organizationSlug);
	if (!activeOrganization || activeOrganization.slug !== organizationSlug) {
		redirect(`/app/${organizationSlug}`);
	}

	return (
		<ProjectKanbanRouteView
			projectId={id}
			storyId={storyId}
			organizationSlug={organizationSlug}
		/>
	);
}
