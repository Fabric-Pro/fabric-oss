/**
 * Read-only mode reply gate for postToTeams: a project-BOUND
 * agent posts nothing to Teams while its project is in Read-only mode
 * (product decision 2026-07-23) — the mention goes unanswered, returned as a
 * non-throwing "skipped" result. Agents with no project binding (and the
 * newsletter path, which gates upstream and passes no projectId) still post.
 */

import { beforeEach, expect, it, vi } from "vitest";

const isProjectReadOnly = vi.fn(async () => false);
vi.mock("@repo/database", () => ({
	isProjectReadOnly: (...a: unknown[]) => isProjectReadOnly(...(a as [])),
	db: {},
}));

const executeMicrosoftTeamsTool = vi.fn();
vi.mock("@repo/integrations/microsoft", () => ({
	executeMicrosoftTeamsTool: (...a: unknown[]) =>
		executeMicrosoftTeamsTool(...a),
}));

import { postToTeams } from "../teams-mention";

beforeEach(() => {
	vi.clearAllMocks();
	isProjectReadOnly.mockResolvedValue(false);
	executeMicrosoftTeamsTool.mockResolvedValue({
		success: true,
		messageId: "m1",
	});
});

it("bound project in read-only mode → reply suppressed, Graph API never called", async () => {
	isProjectReadOnly.mockResolvedValue(true);

	const result = await postToTeams({
		teamId: "team1",
		channelId: "chan1",
		message: "reply",
		userId: "u1",
		organizationId: "org1",
		projectId: "proj-ro",
	});

	expect(result).toEqual({ success: true, skipped: true });
	expect(isProjectReadOnly).toHaveBeenCalledWith("proj-ro");
	expect(executeMicrosoftTeamsTool).not.toHaveBeenCalled();
});

it("no project binding → posts normally without a read-only lookup", async () => {
	const result = await postToTeams({
		teamId: "team1",
		channelId: "chan1",
		message: "reply",
		userId: "u1",
	});

	expect(result.success).toBe(true);
	expect(result.skipped).toBeUndefined();
	expect(isProjectReadOnly).not.toHaveBeenCalled();
	expect(executeMicrosoftTeamsTool).toHaveBeenCalledWith(
		"send_message",
		expect.objectContaining({ text: "reply" }),
		"u1",
		undefined,
	);
});

it("bound project writable → posts normally", async () => {
	const result = await postToTeams({
		teamId: "team1",
		channelId: "chan1",
		message: "reply",
		userId: "u1",
		projectId: "proj-rw",
	});

	expect(result.success).toBe(true);
	expect(result.skipped).toBeUndefined();
	expect(isProjectReadOnly).toHaveBeenCalledWith("proj-rw");
	expect(executeMicrosoftTeamsTool).toHaveBeenCalledTimes(1);
});
