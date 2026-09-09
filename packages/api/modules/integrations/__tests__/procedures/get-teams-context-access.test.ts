/**
 * Procedure-level tests for `integrations.teams.contextAccess` (Fizzy #2450).
 *
 * Teams contexts are read under the VIEWING user's own Microsoft Graph
 * token, so a Graph 403 for one member doesn't mean the whole context is
 * broken — it means that member specifically can't read it. This procedure
 * probes each linked Teams chat/channel with the caller's own credentials
 * (limit: 1, same Graph calls the real read makes) so the Context tab can
 * flag a row this particular viewer can't read, without touching any
 * project-wide readiness state.
 *
 * Two review findings pinned here (post-implementation review):
 *  - The organizationId used to pick Graph credentials MUST come from the
 *    project's own stored tenant (`getProjectAccessContext`), never from
 *    caller-supplied `input.organizationId` — otherwise a caller could probe
 *    (and by extension read) Teams contexts using a different tenant's
 *    Microsoft account than the one the project actually belongs to.
 *  - A transient/unknown probe failure (429, 500, timeout, ...) must not be
 *    reported as `readable: false` — that would render (and cache, at
 *    staleTime 60s) a false "Not readable by you" for something that may
 *    resolve on the very next try. Only a genuine access-denied 403 gets a
 *    row; anything else is warned and omitted.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockGetProjectAccessContext,
	mockFindMany,
	mockExecuteMicrosoftTeamsTool,
} = vi.hoisted(() => ({
	mockGetProjectAccessContext: vi.fn(),
	mockFindMany: vi.fn(),
	mockExecuteMicrosoftTeamsTool: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		projectContext: {
			findMany: mockFindMany,
		},
	},
	getProjectAccessContext: mockGetProjectAccessContext,
}));

vi.mock("@repo/integrations/microsoft", () => ({
	executeMicrosoftTeamsTool: mockExecuteMicrosoftTeamsTool,
	isMicrosoftNotConnectedError: (message: string) =>
		message.includes("Microsoft not connected") ||
		message.includes("Microsoft account in Settings"),
	// Mirrors the real classifier's shape closely enough for these tests:
	// a 403 without an auth-shaped marker is access-denied.
	isMicrosoftAccessDeniedError: (message: string) => {
		const isForbidden =
			message.includes("403 Forbidden") ||
			message.includes('"code":"Forbidden"');
		if (!isForbidden) {
			return false;
		}
		const authMarkers = [
			"No authorization information",
			"InvalidAuthenticationToken",
			"Access token has expired",
			"ExpiredToken",
			"AuthenticationError",
		];
		return !authMarkers.some((marker) => message.includes(marker));
	},
}));

vi.mock("../../../../orpc/procedures", () => {
	const chain = {
		route: () => chain,
		input: () => chain,
		output: () => chain,
		use: () => chain,
		handler: (fn: unknown) => ({ handler: fn }),
	};
	return {
		tenantProtectedProcedure: chain,
		requireProjectPermission: () => (handler: unknown) => handler,
		Permissions: { CONTEXT_READ: "context:read" },
	};
});

import { getTeamsContextAccessProcedure } from "../../procedures/get-teams-context-access";

interface ContextAccessResult {
	connected: boolean;
	contexts: Array<{
		contextId: string;
		readable: boolean;
		error: string | null;
	}>;
}

const baseCtx = {
	user: { id: "user-1" },
	session: { id: "session-1", activeOrganizationId: null },
};

function getHandler() {
	return (
		getTeamsContextAccessProcedure as unknown as {
			handler: (args: {
				input: { projectId: string; organizationId?: string | null };
				context: typeof baseCtx;
			}) => Promise<ContextAccessResult>;
		}
	).handler;
}

function teamsChatContext(id: string, chatId: string, chatTopic?: string) {
	return {
		id,
		metadata: {
			provider: "MICROSOFT_TEAMS",
			chatType: "chat",
			chatId,
			chatTopic,
		},
	};
}

function teamsChannelContext(
	id: string,
	teamId: string,
	channelId: string,
	chatTopic?: string,
) {
	return {
		id,
		metadata: {
			provider: "MICROSOFT_TEAMS",
			chatType: "channel",
			teamId,
			channelId,
			chatTopic,
		},
	};
}

describe("integrations.teams.contextAccess", () => {
	beforeEach(() => {
		mockGetProjectAccessContext.mockReset();
		mockFindMany.mockReset();
		mockExecuteMicrosoftTeamsTool.mockReset();
		mockGetProjectAccessContext.mockResolvedValue({
			organizationId: null,
		});
	});

	it("returns connected:true with no contexts when the project has no Teams contexts, without calling Graph", async () => {
		mockFindMany.mockResolvedValue([]);

		const result = await getHandler()({
			input: { projectId: "proj_1", organizationId: null },
			context: baseCtx,
		});

		expect(result).toEqual({ connected: true, contexts: [] });
		expect(mockExecuteMicrosoftTeamsTool).not.toHaveBeenCalled();
	});

	it("reports mixed readable/unreadable rows keyed by the ProjectContext row id", async () => {
		mockFindMany.mockResolvedValue([
			teamsChatContext("ctx-readable", "chat-1", "example-team"),
			teamsChannelContext(
				"ctx-unreadable",
				"team-1",
				"channel-1",
				"General",
			),
		]);
		mockExecuteMicrosoftTeamsTool.mockImplementation(
			async (method: string) => {
				if (method === "get_chat_messages") {
					return { messages: [], count: 0 };
				}
				throw new Error(
					'Microsoft Graph API error: 403 Forbidden - {"error":{"code":"Forbidden","message":"UnknownError"}}',
				);
			},
		);

		const result = await getHandler()({
			input: { projectId: "proj_1", organizationId: null },
			context: baseCtx,
		});

		expect(result.connected).toBe(true);
		expect(result.contexts).toContainEqual({
			contextId: "ctx-readable",
			readable: true,
			error: null,
		});
		const unreadable = result.contexts.find(
			(c) => c.contextId === "ctx-unreadable",
		);
		expect(unreadable?.readable).toBe(false);
		expect(unreadable?.error).toContain("403 Forbidden");

		// Probed with the same calls the real read makes, capped to 1 message.
		expect(mockExecuteMicrosoftTeamsTool).toHaveBeenCalledWith(
			"get_chat_messages",
			{ chatId: "chat-1", limit: 1 },
			"user-1",
			undefined,
		);
		expect(mockExecuteMicrosoftTeamsTool).toHaveBeenCalledWith(
			"list_messages",
			{ teamId: "team-1", channelId: "channel-1", limit: 1 },
			"user-1",
			undefined,
		);
	});

	it("returns connected:false with no per-row contexts when the account isn't connected at all", async () => {
		mockFindMany.mockResolvedValue([
			teamsChatContext("ctx-1", "chat-1"),
			teamsChatContext("ctx-2", "chat-2"),
		]);
		mockExecuteMicrosoftTeamsTool.mockRejectedValue(
			new Error(
				"Microsoft not connected. Please connect your Microsoft account in Settings > Integrations.",
			),
		);

		const result = await getHandler()({
			input: { projectId: "proj_1", organizationId: null },
			context: baseCtx,
		});

		expect(result).toEqual({ connected: false, contexts: [] });
	});

	it("truncates a long error message to ~500 chars", async () => {
		mockFindMany.mockResolvedValue([teamsChatContext("ctx-1", "chat-1")]);
		const longMessage = `Microsoft Graph API error: 403 Forbidden - ${"x".repeat(600)}`;
		mockExecuteMicrosoftTeamsTool.mockRejectedValue(new Error(longMessage));

		const result = await getHandler()({
			input: { projectId: "proj_1", organizationId: null },
			context: baseCtx,
		});

		expect(result.connected).toBe(true);
		const [row] = result.contexts;
		expect(row.readable).toBe(false);
		expect(row.error).not.toBeNull();
		// 500 chars kept + a trailing ellipsis marker.
		expect((row.error as string).length).toBeLessThanOrEqual(501);
		expect(
			row.error?.startsWith("Microsoft Graph API error: 403 Forbidden"),
		).toBe(true);
	});

	it("throws FORBIDDEN when the caller lacks project access", async () => {
		mockGetProjectAccessContext.mockResolvedValue(null);

		await expect(
			getHandler()({
				input: { projectId: "proj_1", organizationId: null },
				context: baseCtx,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mockFindMany).not.toHaveBeenCalled();
	});

	it("uses the PROJECT's stored organizationId for Graph calls, never the caller-supplied input.organizationId", async () => {
		// The project actually belongs to org A; the caller passes org B in
		// the input (e.g. stale client state, or a deliberately mismatched
		// call). Graph credentials must resolve against the project's own
		// tenant, never the input value.
		mockGetProjectAccessContext.mockResolvedValue({
			organizationId: "org-A",
		});
		mockFindMany.mockResolvedValue([teamsChatContext("ctx-1", "chat-1")]);
		mockExecuteMicrosoftTeamsTool.mockResolvedValue({
			messages: [],
			count: 0,
		});

		await getHandler()({
			input: { projectId: "proj_1", organizationId: "org-B" },
			context: baseCtx,
		});

		expect(mockExecuteMicrosoftTeamsTool).toHaveBeenCalledWith(
			"get_chat_messages",
			{ chatId: "chat-1", limit: 1 },
			"user-1",
			"org-A",
		);
	});

	it("omits a row for a transient/unknown probe failure rather than marking it unreadable", async () => {
		mockFindMany.mockResolvedValue([
			teamsChatContext("ctx-forbidden", "chat-1"),
			teamsChatContext("ctx-transient", "chat-2"),
		]);
		mockExecuteMicrosoftTeamsTool.mockImplementation(
			async (_method: string, args: { chatId: string }) => {
				if (args.chatId === "chat-1") {
					throw new Error(
						'Microsoft Graph API error: 403 Forbidden - {"error":{"code":"Forbidden","message":"UnknownError"}}',
					);
				}
				throw new Error(
					"Microsoft Graph API error: 500 Internal Server Error - {}",
				);
			},
		);
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		const result = await getHandler()({
			input: { projectId: "proj_1", organizationId: null },
			context: baseCtx,
		});

		expect(result.connected).toBe(true);
		expect(result.contexts).toHaveLength(1);
		expect(result.contexts[0]).toMatchObject({
			contextId: "ctx-forbidden",
			readable: false,
		});
		expect(
			result.contexts.some((c) => c.contextId === "ctx-transient"),
		).toBe(false);
		expect(warnSpy).toHaveBeenCalled();

		warnSpy.mockRestore();
	});
});
