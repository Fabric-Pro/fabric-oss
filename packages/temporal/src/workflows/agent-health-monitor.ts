import { log, proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";

const { getAgentsNeedingHealthCheckActivity, markStaleAgents } =
	proxyActivities<typeof activities>({
		// Both are quick Postgres reads/writes. The previous 10s ceiling with
		// zero retries turned every transient DB blip into a hard workflow
		// failure: on staging a momentary Prisma connection/auth saturation
		// ("DriverAdapterError: Authentication timed out", same shape as #1750)
		// makes a connect take tens of seconds, so the single attempt timed out
		// (StartToClose) with no chance to recover. Give it a wider ceiling and
		// a small bounded retry so a brief blip self-heals — the weave watchdog
		// already rides out the same blip this way (2 min timeout + 3 retries).
		startToCloseTimeout: "30 seconds",
		retry: {
			initialInterval: "2s",
			backoffCoefficient: 2,
			maximumInterval: "10s",
			maximumAttempts: 3,
		},
	});

const { checkAgentHealth } = proxyActivities<typeof activities>({
	// 2 minutes covers worst-case: slow HTTP probe + embedding API call + DB write
	startToCloseTimeout: "2 minutes",
	retry: { maximumAttempts: 1 },
});

export interface AgentHealthMonitorWorkflowInput {
	maxAgeMinutes?: number;
	staleThresholdMinutes?: number;
	/** If provided, only check these specific agents (by agentId) — used for immediate post-registration health checks */
	targetAgentIds?: string[];
}

export interface AgentHealthMonitorWorkflowOutput {
	agentsChecked: number;
	healthyCount: number;
	unhealthyCount: number;
	staleAgentsMarked: number;
}

export async function agentHealthMonitorWorkflow(
	input: AgentHealthMonitorWorkflowInput = {},
): Promise<AgentHealthMonitorWorkflowOutput> {
	const {
		maxAgeMinutes = 5,
		staleThresholdMinutes = 10,
		targetAgentIds,
	} = input;

	const agents = await getAgentsNeedingHealthCheckActivity({
		maxAgeMinutes,
		targetAgentIds,
	});

	log.info("Agent health monitor: checking agents", {
		count: agents.length,
	});

	const results = await Promise.all(
		agents.map((agent) =>
			checkAgentHealth({
				agentId: agent.agentId,
				deploymentUrl: agent.deploymentUrl,
				userId: agent.userId,
				organizationId: agent.organizationId,
				agentSearchText: agent.agentSearchText,
			}),
		),
	);

	const healthyCount = results.filter((r) => r.healthy).length;
	const unhealthyCount = results.length - healthyCount;

	const { updatedCount: staleAgentsMarked } = await markStaleAgents({
		staleThresholdMinutes,
	});

	log.info("Agent health monitor: completed", {
		agentsChecked: agents.length,
		healthyCount,
		unhealthyCount,
		staleAgentsMarked,
	});

	return {
		agentsChecked: agents.length,
		healthyCount,
		unhealthyCount,
		staleAgentsMarked,
	};
}
