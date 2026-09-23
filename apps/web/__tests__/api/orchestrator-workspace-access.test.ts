/**
 * The orchestrator stream must hand the workflow only the workspaces the caller
 * can open inside the organization the turn runs in.
 *
 * Workspace ids reach this route from the request body, or from the
 * conversation's attachments when the body carries none, and the workflow's
 * workspace retrieval reads every id in its input. The route used to forward
 * them unchanged, so any workspace id a client named was read on its word. The
 * filter's rule is unit-tested in `@repo/database`; these tests pin what the
 * route does with it: what it passes in, when it runs, and that the workflow
 * receives only what it allowed.
 *
 * Harness mirrors orchestrator-execution-timeout.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getSessionMock = vi.fn();
const getAIModelWithMetadataMock = vi.fn();
const trackUsageMock = vi.fn();
const getTemporalClientMock = vi.fn();
const getHandleMock = vi.fn();
const startWorkflowMock = vi.fn();
const memberFindFirstMock = vi.fn();
const getConversationWorkspacesMock = vi.fn();
const filterAccessibleWorkspaceIdsMock = vi.fn();
const conversationFindFirstMock = vi.fn();
const getConversationProjectMock = vi.fn();

vi.mock("@saas/auth/lib/server", () => ({
	getSession: () => getSessionMock(),
}));

vi.mock("@repo/ai", () => ({
	getAIModelWithMetadata: (...args: unknown[]) =>
		getAIModelWithMetadataMock(...args),
}));

vi.mock("@repo/agent-core/backend", () => ({
	getDefaultEnabledMcpConfigIds: vi.fn(async () => []),
}));

vi.mock("@repo/observability", () => ({
	metricsTracker: { trackAiLimitSignal: vi.fn() },
}));

vi.mock("@repo/payments", () => ({
	AiUsageLimitExceededError: class AiUsageLimitExceededError extends Error {},
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: () => getTemporalClientMock(),
}));

vi.mock("@repo/database", () => ({
	CARRIED_OVER_MARKER_PREFIX: "[carried-over]",
	db: {
		agentConversation: {
			findFirst: (...args: unknown[]) =>
				conversationFindFirstMock(...args),
		},
		member: {
			findFirst: (...args: unknown[]) => memberFindFirstMock(...args),
		},
		aiChat: { findFirst: vi.fn(async () => null) },
	},
	getConversationWorkspaces: (...args: unknown[]) =>
		getConversationWorkspacesMock(...args),
	getConversationProject: (...args: unknown[]) =>
		getConversationProjectMock(...args),
	hasProjectAccess: vi.fn(async () => true),
	filterAccessibleWorkspaceIds: (...args: unknown[]) =>
		filterAccessibleWorkspaceIdsMock(...args),
}));

const SESSION_USER_ID = "user-1";
const ORGANIZATION_ID = "example-org";

function postBody(b: Record<string, unknown>) {
	return { json: async () => b } as never;
}

async function post(body: Record<string, unknown>) {
	const { POST } = await import(
		"../../app/api/agents/fabric-ai/orchestrator-temporal/stream/route"
	);
	const response = await POST(postBody(body));
	await response.text();
	return response;
}

function startedInput(): Record<string, unknown> | undefined {
	return startWorkflowMock.mock.calls[0]?.[1]?.args?.[0] as
		| Record<string, unknown>
		| undefined;
}

function startedWorkspaceIds(): unknown {
	const input = startWorkflowMock.mock.calls[0]?.[1]?.args?.[0] as
		| { workspaceIds?: unknown }
		| undefined;
	return input?.workspaceIds;
}

describe("POST orchestrator-temporal/stream — workspace access", () => {
	const originalCacheHost = process.env.CACHE_HOST;
	const originalRedisUrl = process.env.REDIS_URL;

	beforeEach(() => {
		vi.clearAllMocks();
		// Keep `getRedisUrl()` at null so the route never reaches for ioredis.
		delete process.env.CACHE_HOST;
		delete process.env.REDIS_URL;

		getSessionMock.mockResolvedValue({ user: { id: SESSION_USER_ID } });
		getAIModelWithMetadataMock.mockResolvedValue({
			trackUsage: trackUsageMock,
		});
		memberFindFirstMock.mockResolvedValue({ id: "member-1" });
		getConversationWorkspacesMock.mockResolvedValue([]);
		getConversationProjectMock.mockResolvedValue(null);
		// The caller owns "conversation-1" in ORGANIZATION_ID; nothing else.
		conversationFindFirstMock.mockImplementation(
			async (query: { where: { id: string; userId: string } }) =>
				query.where.id === "conversation-1" &&
				query.where.userId === SESSION_USER_ID
					? {
							id: "conversation-1",
							organizationId: ORGANIZATION_ID,
							parentConversationId: null,
							carriedOverSummary: null,
						}
					: null,
		);
		filterAccessibleWorkspaceIdsMock.mockImplementation(
			async (params: { workspaceIds: string[] }) => ({
				allowed: params.workspaceIds.filter((id) =>
					id.startsWith("ws-ok"),
				),
				dropped: params.workspaceIds.filter(
					(id) => !id.startsWith("ws-ok"),
				),
			}),
		);
		startWorkflowMock.mockResolvedValue({
			workflowId: "wf-workspace-access",
			describe: async () => ({
				status: { name: "COMPLETED" },
				memo: { userId: SESSION_USER_ID },
			}),
			query: async () => {
				throw new Error("workflow closed");
			},
			result: async () => ({ status: "completed", response: "ok" }),
		});
		getTemporalClientMock.mockResolvedValue({
			workflow: { getHandle: getHandleMock, start: startWorkflowMock },
		});
	});

	afterEach(() => {
		if (originalCacheHost === undefined) {
			delete process.env.CACHE_HOST;
		} else {
			process.env.CACHE_HOST = originalCacheHost;
		}
		if (originalRedisUrl === undefined) {
			delete process.env.REDIS_URL;
		} else {
			process.env.REDIS_URL = originalRedisUrl;
		}
	});

	it("starts the workflow with only the body's workspace ids the filter allowed", async () => {
		await post({
			message: "hello",
			organizationId: ORGANIZATION_ID,
			workspaceIds: ["ws-ok-1", "ws-foreign", "ws-ok-2"],
		});

		expect(filterAccessibleWorkspaceIdsMock).toHaveBeenCalledWith({
			workspaceIds: ["ws-ok-1", "ws-foreign", "ws-ok-2"],
			userId: SESSION_USER_ID,
			organizationId: ORGANIZATION_ID,
		});
		expect(startedWorkspaceIds()).toEqual(["ws-ok-1", "ws-ok-2"]);
	});

	it("filters a conversation's attached workspaces the same way when the body names none", async () => {
		getConversationWorkspacesMock.mockResolvedValue([
			{ workspace: { id: "ws-foreign" } },
			{ workspace: { id: "ws-ok-attached" } },
		]);

		await post({
			message: "hello",
			organizationId: ORGANIZATION_ID,
			conversationId: "conversation-1",
		});

		expect(filterAccessibleWorkspaceIdsMock).toHaveBeenCalledWith({
			workspaceIds: ["ws-foreign", "ws-ok-attached"],
			userId: SESSION_USER_ID,
			organizationId: ORGANIZATION_ID,
		});
		expect(startedWorkspaceIds()).toEqual(["ws-ok-attached"]);
	});

	it("ignores a conversation the caller does not own: nothing adopted, nothing forwarded", async () => {
		getConversationWorkspacesMock.mockResolvedValue([
			{ workspace: { id: "ws-ok-theirs" } },
		]);
		getConversationProjectMock.mockResolvedValue({
			project: { id: "project-theirs" },
		});

		await post({
			message: "hello",
			organizationId: ORGANIZATION_ID,
			conversationId: "conversation-of-someone-else",
		});

		expect(conversationFindFirstMock).toHaveBeenCalledWith({
			where: {
				id: "conversation-of-someone-else",
				userId: SESSION_USER_ID,
			},
			select: { id: true, organizationId: true },
		});
		expect(getConversationWorkspacesMock).not.toHaveBeenCalled();
		expect(getConversationProjectMock).not.toHaveBeenCalled();
		expect(startedInput()?.conversationId).toBeUndefined();
		expect(startedInput()?.projectId).toBeUndefined();
		expect(startedWorkspaceIds()).toEqual([]);
	});

	it("ignores the caller's own conversation from another organization", async () => {
		conversationFindFirstMock.mockResolvedValue({
			id: "conversation-1",
			organizationId: "another-org",
		});
		getConversationWorkspacesMock.mockResolvedValue([
			{ workspace: { id: "ws-ok-other-org" } },
		]);

		await post({
			message: "hello",
			organizationId: ORGANIZATION_ID,
			conversationId: "conversation-1",
		});

		expect(getConversationWorkspacesMock).not.toHaveBeenCalled();
		expect(startedInput()?.conversationId).toBeUndefined();
	});

	it("forwards an owned conversation to the workflow", async () => {
		await post({
			message: "hello",
			organizationId: ORGANIZATION_ID,
			conversationId: "conversation-1",
		});
		expect(startedInput()?.conversationId).toBe("conversation-1");
	});

	it("drops non-string entries before filtering and treats a non-array value as none", async () => {
		await post({
			message: "hello",
			organizationId: ORGANIZATION_ID,
			workspaceIds: ["ws-ok-1", 42, null, { in: ["ws-ok-2"] }],
		});
		expect(filterAccessibleWorkspaceIdsMock).toHaveBeenCalledWith(
			expect.objectContaining({ workspaceIds: ["ws-ok-1"] }),
		);
		expect(startedWorkspaceIds()).toEqual(["ws-ok-1"]);

		vi.clearAllMocks();
		await post({
			message: "hello",
			organizationId: ORGANIZATION_ID,
			workspaceIds: "ws-ok-1",
		});
		expect(filterAccessibleWorkspaceIdsMock).not.toHaveBeenCalled();
		expect(startedWorkspaceIds()).toEqual([]);
	});

	it("rejects a workspace list over the direct-chat schema's bounds before any lookup", async () => {
		const tooMany = await post({
			message: "hello",
			organizationId: ORGANIZATION_ID,
			workspaceIds: Array.from({ length: 21 }, (_, i) => `ws-ok-${i}`),
		});
		expect(tooMany.status).toBe(400);

		const tooLong = await post({
			message: "hello",
			organizationId: ORGANIZATION_ID,
			workspaceIds: ["ws-ok-1", `ws-ok-${"x".repeat(200)}`],
		});
		expect(tooLong.status).toBe(400);

		expect(memberFindFirstMock).not.toHaveBeenCalled();
		expect(filterAccessibleWorkspaceIdsMock).not.toHaveBeenCalled();
		expect(startWorkflowMock).not.toHaveBeenCalled();
	});

	it("refuses a non-member before any workspace is looked at", async () => {
		memberFindFirstMock.mockResolvedValue(null);

		const response = await post({
			message: "hello",
			organizationId: ORGANIZATION_ID,
			workspaceIds: ["ws-ok-1"],
		});

		expect(response.status).toBe(403);
		expect(filterAccessibleWorkspaceIdsMock).not.toHaveBeenCalled();
		expect(startWorkflowMock).not.toHaveBeenCalled();
	});
});
