/**
 * PM State Poll — Parent Workflow
 *
 * System-level scheduled workflow that fans out per-project child workflows
 * to poll PM tool work item states. Runs hourly via Temporal schedule.
 */

import {
	executeChild,
	log,
	proxyActivities,
	sleep,
	uuid4,
} from "@temporalio/workflow";

import type { getAdoActiveProjects as GetAdoActiveProjectsFn } from "../activities/pm-integration/pm-state-poll";
import {
	type AdoStatePollProjectOutput,
	adoStatePollProjectWorkflow,
} from "./pm-state-poll-project-workflow";

// =============================================================================
// Types
// =============================================================================

export interface AdoStatePollWorkflowOutput {
	projectCount: number;
	results: AdoStatePollProjectOutput[];
}

// =============================================================================
// Activity Proxies
// =============================================================================

const { getAdoActiveProjects } = proxyActivities<{
	getAdoActiveProjects: typeof GetAdoActiveProjectsFn;
}>({
	startToCloseTimeout: "30 seconds",
	retry: {
		initialInterval: "2s",
		backoffCoefficient: 2,
		maximumAttempts: 3,
	},
});

// =============================================================================
// Constants
// =============================================================================

const BATCH_SIZE = 10;

// =============================================================================
// Workflow
// =============================================================================

export async function adoStatePollWorkflow(): Promise<AdoStatePollWorkflowOutput> {
	log.info("Starting ADO state poll workflow");

	const projects = await getAdoActiveProjects();

	if (projects.length === 0) {
		log.info("No active ADO projects to poll");
		return { projectCount: 0, results: [] };
	}

	log.info("Found active ADO projects", { count: projects.length });

	const allResults: AdoStatePollProjectOutput[] = [];

	// Fan out in batches of BATCH_SIZE
	for (let i = 0; i < projects.length; i += BATCH_SIZE) {
		const batch = projects.slice(i, i + BATCH_SIZE);

		const batchPromises = batch.map((project) =>
			executeChild(adoStatePollProjectWorkflow, {
				workflowId: `ado-state-poll-${project.id}-${uuid4()}`,
				args: [
					{
						projectId: project.id,
						mcpConfigId: project.mcpConfigId,
						mcpServerId: project.mcpServerId,
						sourceKind: project.sourceKind,
						pmTool: project.pmTool,
						containerId: project.containerId,
						containerName: project.containerName,
						lastAdoStatePollAt: project.lastAdoStatePollAt,
						userId: project.userId,
						organizationId: project.organizationId ?? undefined,
					},
				],
			}),
		);

		const settled = await Promise.allSettled(batchPromises);

		for (const result of settled) {
			if (result.status === "fulfilled") {
				allResults.push(result.value);
			} else {
				log.warn("Child workflow rejected", {
					reason: String(result.reason),
				});
			}
		}

		// Sleep between batches (except after the last one)
		if (i + BATCH_SIZE < projects.length) {
			await sleep("5s");
		}
	}

	log.info("ADO state poll workflow completed", {
		projectCount: projects.length,
		successCount: allResults.filter((r) => r.success).length,
		failureCount: allResults.filter((r) => !r.success).length,
	});

	return {
		projectCount: projects.length,
		results: allResults,
	};
}
