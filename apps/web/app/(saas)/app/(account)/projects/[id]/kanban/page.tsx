import { getSession } from "@saas/auth/lib/server";
import { ProjectKanbanRouteView } from "@saas/projects/components/kanban/ProjectKanbanRouteView";
import { redirect } from "next/navigation";

interface Props {
	params: Promise<{ id: string }>;
	searchParams: Promise<{ storyId?: string }>;
}

export default async function ProjectKanbanPage({
	params,
	searchParams,
}: Props) {
	const session = await getSession();
	if (!session?.user) {
		redirect("/auth/login");
	}

	const { id } = await params;
	const { storyId } = await searchParams;

	return <ProjectKanbanRouteView projectId={id} storyId={storyId} />;
}
