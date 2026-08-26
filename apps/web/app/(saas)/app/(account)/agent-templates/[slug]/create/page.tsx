import { getAgentTemplate } from "@repo/database";
import { CreateAgentFromTemplate } from "@saas/agent-templates/components/CreateAgentFromTemplate";
import { getSession } from "@saas/auth/lib/server";
import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";
import { TopRightControls } from "@saas/shared/components/TopRightControls";
import { redirect } from "next/navigation";

type Props = {
	params: Promise<{
		slug: string;
	}>;
};

export const metadata = {
	title: "Create Agent From Template - Fabric",
	description: "Create a new agent from an existing template",
};

export default async function CreateAgentPage({ params }: Props) {
	const session = await getSession();
	const { slug } = await params;

	if (!session) {
		redirect("/auth/login");
	}

	// Fetch template to get the display name for breadcrumb
	const template = await getAgentTemplate(slug);
	const templateName = template?.displayName || "Template";

	return (
		<div className="min-h-screen">
			<div className="w-full py-6 px-6 space-y-6">
				<TopRightControls />
				<PageBreadcrumbs
					items={[
						{
							label: "Agent Templates",
							href: "/app/agent-templates",
						},
						{
							label: templateName,
							href: `/app/agent-templates/${slug}`,
						},
						{ label: "Create Agent From Template" },
					]}
				/>
			</div>
			<CreateAgentFromTemplate
				slug={slug}
				basePath="/app/agent-templates"
			/>
		</div>
	);
}
