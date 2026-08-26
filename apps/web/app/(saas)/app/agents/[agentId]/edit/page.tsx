import { AgentEditRouter } from "@saas/agents/components/AgentEditRouter";
import { getSession } from "@saas/auth/lib/server";
import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";
import { TopRightControls } from "@saas/shared/components/TopRightControls";
import { redirect } from "next/navigation";

type Props = {
	params: Promise<{
		agentId: string;
	}>;
};

export const metadata = {
	title: "Edit Agent - Fabric",
	description: "Edit your agent configuration",
};

export default async function AgentInstanceEditPage({ params }: Props) {
	const session = await getSession();
	const { agentId } = await params;

	if (!session) {
		redirect("/auth/login");
	}

	return (
		<div className="w-full py-6 space-y-6">
			<TopRightControls />
			<PageBreadcrumbs
				items={[
					{ label: "Agents", href: "/app/agents" },
					{ label: "Agent Details", href: `/app/agents/${agentId}` },
					{ label: "Edit Agent" },
				]}
			/>
			<AgentEditRouter agentId={agentId} basePath="/app" />
		</div>
	);
}
