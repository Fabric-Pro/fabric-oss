/**
 * Custom Agent Editor Page
 *
 * Provides a CopilotKit-powered editor for interacting with custom AI agents
 * with real-time predictive state updates.
 */

import { CustomAgentEditor } from "@saas/agents/components/CustomAgentEditor";
import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";
import { TopRightControls } from "@saas/shared/components/TopRightControls";
import { orpcClient } from "@shared/lib/orpc-client";
import { notFound } from "next/navigation";

interface PageProps {
	params: Promise<{
		agentId: string;
	}>;
}

export default async function AgentEditorPage({ params }: PageProps) {
	const { agentId } = await params;

	// Fetch agent details
	const agent = await orpcClient.agents.registry.get({ id: agentId });

	if (!agent) {
		notFound();
	}

	// Only show editor for active agents
	if (agent.status !== "ACTIVE" || !agent.deploymentUrl) {
		return (
			<div className="flex flex-col items-center justify-center h-full gap-4">
				<h1 className="text-2xl font-bold">Agent Not Available</h1>
				<p className="text-muted-foreground">
					This agent is not currently active or has not been deployed
					yet.
				</p>
				<p className="text-sm text-muted-foreground">
					Status: <span className="font-medium">{agent.status}</span>
				</p>
			</div>
		);
	}

	return (
		<div className="w-full py-6 h-full">
			<TopRightControls />
			<PageBreadcrumbs
				items={[
					{ label: "Agents", href: "/app/agents" },
					{
						label: agent.name || agent.agentId,
						href: `/app/agents/${agentId}`,
					},
					{ label: "Editor" },
				]}
				className="mb-6"
			/>
			<CustomAgentEditor
				agentId={agent.agentId}
				deploymentUrl={agent.deploymentUrl}
				initialState={{
					status: "idle",
					messages: [],
					activeTools: [],
				}}
			/>
		</div>
	);
}
