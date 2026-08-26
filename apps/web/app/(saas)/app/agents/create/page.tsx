import { CreateCustomAgent } from "@saas/agent-templates";
import { getSession } from "@saas/auth/lib/server";
import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";
import { TopRightControls } from "@saas/shared/components/TopRightControls";
import { redirect } from "next/navigation";

export const metadata = {
	title: "Create Custom Agent - Fabric",
	description: "Create a custom AI agent from scratch",
};

export default async function CreateAgentPage() {
	const session = await getSession();

	if (!session) {
		redirect("/auth/login");
	}

	const basePath = "/app/agents";

	return (
		<div className="min-h-screen">
			<div className="w-full space-y-6 px-6 py-6">
				<TopRightControls />
				<PageBreadcrumbs
					items={[
						{ label: "Agents", href: basePath },
						{ label: "Create Custom Agent" },
					]}
				/>
			</div>
			<CreateCustomAgent basePath={basePath} />
		</div>
	);
}
