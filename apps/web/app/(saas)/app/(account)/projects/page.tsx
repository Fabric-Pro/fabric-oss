import { getSession } from "@saas/auth/lib/server";
import { ProjectsList } from "@saas/projects/components/ProjectsList";
import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";
import { TopRightControls } from "@saas/shared/components/TopRightControls";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";

export default async function ProjectsPage() {
	const session = await getSession();

	if (!session) {
		redirect("/auth/login");
	}

	const _t = await getTranslations();

	return (
		<div className="w-full py-6 space-y-6">
			<TopRightControls />
			<PageBreadcrumbs items={[{ label: "Projects" }]} />

			<ProjectsList />
		</div>
	);
}
