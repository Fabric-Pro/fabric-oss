import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";

export function registeredAgentChatQueryOptions(
	agentId: string,
	organizationId: string | null,
) {
	return orpc.agents.registry.get.queryOptions({
		input: { id: agentId, organizationId: organizationId ?? undefined },
	});
}

export function agentChatAiConfigQueryOptions(organizationId: string | null) {
	return {
		queryKey: ["aiConfigStatus", organizationId],
		queryFn: () =>
			orpcClient.aiConfig.resolution.getStatus({ organizationId }),
	};
}
