import { CreateTemplatePage } from "@saas/agent-templates/components/CreateTemplatePage";
import { getSession } from "@saas/auth/lib/server";
import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";
import { TopRightControls } from "@saas/shared/components/TopRightControls";
import { redirect } from "next/navigation";

export const metadata = {
	title: "Create Custom Template - Fabric",
	description: "Create a custom agent template",
};

export default async function NewAgentTemplatePage() {
	const session = await getSession();

	if (!session) {
		redirect("/auth/login");
	}

	if (session.user?.role !== "admin") {
		redirect("/app/agent-templates");
	}

	return (
		<div className="min-h-screen">
			<div className="w-full py-6 space-y-6">
				<TopRightControls />
				<PageBreadcrumbs
					items={[
						{
							label: "Agent Templates",
							href: "/app/agent-templates",
						},
						{ label: "Create Custom Template" },
					]}
				/>
			</div>
			<CreateTemplatePage basePath="/app/agent-templates" />
		</div>
	);
}
