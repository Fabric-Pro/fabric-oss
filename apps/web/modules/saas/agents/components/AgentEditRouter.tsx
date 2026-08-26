"use client";

import { AgentInstanceEdit } from "@saas/agent-templates/components/AgentInstanceEdit";
import { Spinner } from "@shared/components/Spinner";
import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { EditRegisteredAgentPage } from "./EditRegisteredAgentPage";

type Props = {
	agentId: string;
	organizationId?: string | null;
	basePath: string;
};

export function AgentEditRouter({ agentId, organizationId, basePath }: Props) {
	const { data: agent, isLoading } = useQuery({
		queryKey: ["agent", "registry", "edit-router", agentId, organizationId],
		queryFn: async () => {
			try {
				return await orpcClient.agents.registry.get({
					id: agentId,
					organizationId: organizationId ?? null,
				});
			} catch {
				return null;
			}
		},
		retry: false,
	});

	if (isLoading) {
		return (
			<div className="flex justify-center py-12">
				<Spinner className="h-8 w-8" />
			</div>
		);
	}

	const metadata =
		agent?.metadata && typeof agent.metadata === "object"
			? (agent.metadata as Record<string, unknown>)
			: null;
	const linkedInstanceId =
		metadata && typeof metadata.instanceId === "string"
			? metadata.instanceId
			: null;

	if (linkedInstanceId) {
		return (
			<AgentInstanceEdit
				instanceId={linkedInstanceId}
				organizationId={organizationId}
				basePath={basePath}
			/>
		);
	}

	if (agent) {
		return (
			<EditRegisteredAgentPage
				agentId={agentId}
				organizationId={organizationId}
				basePath={basePath}
			/>
		);
	}

	return (
		<AgentInstanceEdit
			instanceId={agentId}
			organizationId={organizationId}
			basePath={basePath}
		/>
	);
}
