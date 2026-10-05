import { orpcClient } from "@shared/lib/orpc-client";
import { buildInstanceAgentConfig } from "../components/FabricChat/shared/agent-selection";

/** Read current authorized config rather than a persisted picker's incomplete snapshot. */
export async function loadInstanceAgentConfig(
	instanceId: string,
	organizationId?: string | null,
) {
	const { instance } = await orpcClient.agentTemplates.instances.get({
		id: instanceId,
	});
	if (!organizationId || instance.organizationId !== organizationId) {
		throw new Error("The agent is not available in this organization.");
	}
	return buildInstanceAgentConfig(instance);
}
