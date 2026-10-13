/**
 * The hourly MCP cleanup activity must call both purge queries and report each
 * count. Either query failing must fail the activity so Temporal retries it,
 * rather than reporting a partial purge as success.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const { cleanupExpiredOAuthStates, cleanupExpiredMcpSessions } = vi.hoisted(
	() => ({
		cleanupExpiredOAuthStates: vi.fn(),
		cleanupExpiredMcpSessions: vi.fn(),
	}),
);

vi.mock("@repo/database", () => ({
	cleanupExpiredOAuthStates,
	cleanupExpiredMcpSessions,
}));

import { cleanupExpiredMcpOAuthStatesActivity } from "../src/activities/mcp-oauth-state-cleanup";

afterEach(() => {
	vi.restoreAllMocks();
	cleanupExpiredOAuthStates.mockReset();
	cleanupExpiredMcpSessions.mockReset();
});

describe("cleanupExpiredMcpOAuthStatesActivity", () => {
	it("calls both purges, returns both counts and logs them", async () => {
		cleanupExpiredOAuthStates.mockResolvedValue(3);
		cleanupExpiredMcpSessions.mockResolvedValue(5);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		const result = await cleanupExpiredMcpOAuthStatesActivity();

		expect(cleanupExpiredOAuthStates).toHaveBeenCalledTimes(1);
		expect(cleanupExpiredMcpSessions).toHaveBeenCalledTimes(1);
		expect(result).toEqual({
			deletedOAuthStates: 3,
			deletedClientSessions: 5,
		});
		expect(log).toHaveBeenCalledWith(
			expect.stringContaining("3 expired OAuth"),
		);
		expect(log).toHaveBeenCalledWith(
			expect.stringContaining("5 expired client"),
		);
	});

	it("reports zero counts when nothing has expired", async () => {
		cleanupExpiredOAuthStates.mockResolvedValue(0);
		cleanupExpiredMcpSessions.mockResolvedValue(0);
		vi.spyOn(console, "log").mockImplementation(() => {});

		await expect(cleanupExpiredMcpOAuthStatesActivity()).resolves.toEqual({
			deletedOAuthStates: 0,
			deletedClientSessions: 0,
		});
	});

	it("fails when a purge throws, so Temporal retries", async () => {
		cleanupExpiredOAuthStates.mockResolvedValue(1);
		cleanupExpiredMcpSessions.mockRejectedValue(new Error("db down"));

		await expect(cleanupExpiredMcpOAuthStatesActivity()).rejects.toThrow(
			"db down",
		);
	});
});
