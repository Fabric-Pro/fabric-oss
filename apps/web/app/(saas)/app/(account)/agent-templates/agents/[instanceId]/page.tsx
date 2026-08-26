import { AgentInstanceDetail } from "@saas/agent-templates/components/AgentInstanceDetail";
import { getSession } from "@saas/auth/lib/server";
import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";
import { TopRightControls } from "@saas/shared/components/TopRightControls";
import { redirect } from "next/navigation";

type Props = {
	params: Promise<{
		instanceId: string;
	}>;
};

export const metadata = {
	title: "Agent Details - Fabric",
	description: "View and manage your agent configuration",
};

export default async function AgentInstanceDetailPage({ params }: Props) {
	const session = await getSession();
	const { instanceId } = await params;

	if (!session) {
		redirect("/auth/login");
	}

	return (
		<div className="w-full py-6 space-y-6">
			<TopRightControls />
			<PageBreadcrumbs
				items={[
					{ label: "Agent Templates", href: "/app/agent-templates" },
					{
						label: "My Agents",
						href: "/app/agent-templates?tab=agents",
					},
					{ label: "Agent Details" },
				]}
			/>
			<AgentInstanceDetail
				instanceId={instanceId}
				basePath="/app/agent-templates"
			/>
		</div>
	);
}
