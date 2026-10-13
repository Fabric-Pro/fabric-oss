/**
 * The hourly schedule starts `mcpOAuthStateCleanupWorkflow`, so the workflow
 * body is what actually purges. It must run the cleanup activity once and
 * return its counts; a failure must propagate so the run is marked failed.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const { cleanupExpiredMcpOAuthStatesActivity } = vi.hoisted(() => ({
	cleanupExpiredMcpOAuthStatesActivity: vi.fn(),
}));

vi.mock("@temporalio/workflow", () => ({
	proxyActivities: vi.fn(() => ({ cleanupExpiredMcpOAuthStatesActivity })),
}));

import { mcpOAuthStateCleanupWorkflow } from "../src/workflows/mcp-oauth-state-cleanup";

afterEach(() => {
	cleanupExpiredMcpOAuthStatesActivity.mockReset();
});

describe("mcpOAuthStateCleanupWorkflow", () => {
	it("runs the cleanup activity once and returns its counts", async () => {
		cleanupExpiredMcpOAuthStatesActivity.mockResolvedValue({
			deletedOAuthStates: 2,
			deletedClientSessions: 7,
		});

		await expect(mcpOAuthStateCleanupWorkflow()).resolves.toEqual({
			deletedOAuthStates: 2,
			deletedClientSessions: 7,
		});
		expect(cleanupExpiredMcpOAuthStatesActivity).toHaveBeenCalledTimes(1);
	});

	it("propagates an activity failure", async () => {
		cleanupExpiredMcpOAuthStatesActivity.mockRejectedValue(
			new Error("retries exhausted"),
		);

		await expect(mcpOAuthStateCleanupWorkflow()).rejects.toThrow(
			"retries exhausted",
		);
	});
});
