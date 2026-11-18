import { afterEach, expect, it, vi } from "vitest";
import { MicrosoftRequestTimeoutError } from "../../../../../integrations/src/microsoft/request";

const { findMany, execute } = vi.hoisted(() => ({
	findMany: vi.fn(),
	execute: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	db: { projectContext: { findMany } },
	hasProjectAccess: vi.fn().mockResolvedValue(true),
}));
vi.mock("@repo/integrations/microsoft", async () => ({
	...(await import(
		"../../../../../integrations/src/microsoft/connection-errors"
	)),
	executeMicrosoftTeamsTool: execute,
}));
vi.mock("../../../../orpc/procedures", () => {
	const chain = {
		route: () => chain,
		input: () => chain,
		use: () => chain,
		handler: (handler: unknown) => ({ handler }),
	};
	return {
		tenantProtectedProcedure: chain,
		requirePermission: vi.fn(),
		Permissions: { INTEGRATION_READ: "integration:read" },
		resolveOrganizationId: () => "example-org",
	};
});

import { getRecentTeamsMessagesProcedure } from "../../procedures/get-recent-teams-messages";

afterEach(() => vi.restoreAllMocks());
it("keeps successful messages and reports the timed-out context as an error", async () => {
	findMany.mockResolvedValue(
		["slow", "fast"].map((id) => ({
			id,
			metadata: {
				provider: "MICROSOFT_TEAMS",
				chatType: "chat",
				chatId: id,
				chatTopic: id,
			},
		})),
	);
	const message =
		"Microsoft Graph request timed out: GET /v1.0/me/chats/slow/messages";
	execute
		.mockRejectedValueOnce(new MicrosoftRequestTimeoutError(message))
		.mockResolvedValueOnce({
			messages: [
				{ id: "example-message", content: "Hello", from: "Example" },
			],
			count: 1,
		});
	const log = vi.spyOn(console, "error").mockImplementation(() => {});
	const handler = (
		getRecentTeamsMessagesProcedure as unknown as {
			handler: (
				args: unknown,
			) => Promise<{ messages: unknown[]; error: string | null }>;
		}
	).handler;
	const result = await handler({
		input: { projectId: "example-project", limit: 10 },
		context: {
			user: { id: "example-user" },
			session: { activeOrganizationId: "example-org" },
		},
	});
	expect(result.messages).toEqual([
		expect.objectContaining({ id: "example-message", chatName: "fast" }),
	]);
	expect(result.error).toBe(`Failed to fetch from slow: ${message}`);
	expect(log).toHaveBeenCalledWith(
		"[getRecentTeamsMessages] Error fetching from slow:",
		message,
	);
});
