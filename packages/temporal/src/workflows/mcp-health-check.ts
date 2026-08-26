import { log, proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";

const { checkAndUpdateMcpHealth } = proxyActivities<typeof activities>({
	startToCloseTimeout: "15s",
	heartbeatTimeout: "30 seconds",
	retry: {
		initialInterval: "1s",
		backoffCoefficient: 2,
		maximumAttempts: 3,
	},
});

export interface McpHealthCheckInput {
	configId: string;
}

export async function mcpHealthCheckWorkflow(
	input: McpHealthCheckInput,
): Promise<{ success: boolean }> {
	log.info("Starting MCP health check", { configId: input.configId });
	await checkAndUpdateMcpHealth(input.configId);
	return { success: true };
}
