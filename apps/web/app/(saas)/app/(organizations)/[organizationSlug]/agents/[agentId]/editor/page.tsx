/**
 * Organization Custom Agent Editor Page
 *
 * Provides a CopilotKit-powered editor for interacting with custom AI agents
 * with real-time predictive state updates within an organization context.
 */

import { CustomAgentEditor } from "@saas/agents/components/CustomAgentEditor";
import { PageBreadcrumbs } from "@saas/shared/components/PageBreadcrumbs";
import { TopRightControls } from "@saas/shared/components/TopRightControls";
import { orpcClient } from "@shared/lib/orpc-client";
import { notFound } from "next/navigation";

interface PageProps {
	params: Promise<{
		organizationSlug: string;
		agentId: string;
	}>;
}

export default async function OrganizationAgentEditorPage({
	params,
}: PageProps) {
	const { organizationSlug, agentId } = await params;

	// Organization-aware paths
	const basePath = `/app/${organizationSlug}`;
	const agentsPath = `${basePath}/agents`;

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
					{ label: "Agents", href: agentsPath },
					{
						label: agent.name || agent.agentId,
						href: `${agentsPath}/${agentId}`,
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
