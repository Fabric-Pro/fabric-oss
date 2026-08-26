import { getSession } from "@saas/auth/lib/server";
import { ProjectDetails } from "@saas/projects/components/ProjectDetails";
import { TopRightControls } from "@saas/shared/components/TopRightControls";
import { redirect } from "next/navigation";

type Props = {
	params: Promise<{ id: string }>;
};

export default async function ProjectDetailsPage({ params }: Props) {
	const session = await getSession();

	if (!session) {
		redirect("/auth/login");
	}

	const { id } = await params;

	return (
		<div className="w-full py-8">
			<TopRightControls />
			<ProjectDetails projectId={id} />
		</div>
	);
}
