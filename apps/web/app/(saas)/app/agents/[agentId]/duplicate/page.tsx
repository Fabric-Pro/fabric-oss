import { AgentDuplicateRouter } from "@saas/agents/components/AgentDuplicateRouter";
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
	title: "Duplicate Agent - Fabric",
	description: "Create a new agent from an existing configuration",
};

export default async function AgentDuplicatePage({ params }: Props) {
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
					{ label: "Duplicate Agent" },
				]}
			/>
			<AgentDuplicateRouter agentId={agentId} basePath="/app" />
		</div>
	);
}
