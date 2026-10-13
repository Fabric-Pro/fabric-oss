/**
 * MCP OAuth State Cleanup Activity
 *
 * Deletes expired MCP OAuth state rows and expired MCP client session rows.
 * Called hourly by mcpOAuthStateCleanupWorkflow. Idempotent: each call is a
 * `deleteMany` on `expiresAt < now`, so a retry or rerun only removes rows
 * that are still expired.
 */

import {
	cleanupExpiredMcpSessions,
	cleanupExpiredOAuthStates,
} from "@repo/database";

export interface McpOAuthStateCleanupResult {
	deletedOAuthStates: number;
	deletedClientSessions: number;
}

export async function cleanupExpiredMcpOAuthStatesActivity(): Promise<McpOAuthStateCleanupResult> {
	const deletedOAuthStates = await cleanupExpiredOAuthStates();
	const deletedClientSessions = await cleanupExpiredMcpSessions();

	console.log(
		`[McpOAuthStateCleanup] Deleted ${deletedOAuthStates} expired OAuth states and ${deletedClientSessions} expired client sessions`,
	);

	return { deletedOAuthStates, deletedClientSessions };
}
