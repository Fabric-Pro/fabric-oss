/**
 * MCP OAuth State Cleanup Workflow
 *
 * Hourly Temporal schedule (`mcp-oauth-state-cleanup`, registered in
 * packages/temporal/src/schedules.ts) that purges expired MCP OAuth state and
 * client session rows. It replaces the Vercel cron route that only ran on
 * Vercel deployments.
 */

import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities/mcp-oauth-state-cleanup";

const { cleanupExpiredMcpOAuthStatesActivity } = proxyActivities<
	typeof activities
>({
	startToCloseTimeout: "2 minutes",
	scheduleToCloseTimeout: "10 minutes",
	retry: {
		maximumAttempts: 3,
	},
});

export type McpOAuthStateCleanupOutput = activities.McpOAuthStateCleanupResult;

export async function mcpOAuthStateCleanupWorkflow(): Promise<McpOAuthStateCleanupOutput> {
	return await cleanupExpiredMcpOAuthStatesActivity();
}
