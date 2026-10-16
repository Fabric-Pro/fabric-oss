/**
 * The Orchestrator route vouches for the turn it starts, and says where the
 * chat was opened.
 *
 * The Orchestrator calls Fabric's workflow and frame tools through the Fabric
 * MCP gateway as the worker, which holds a secret every internal service holds.
 * The acting grant the route mints from the session it just authenticated is
 * what says "this turn acts for this user in this organization"; the workflow
 * only carries it. The page the chat was opened on (`launchWorkspaceId`,
 * `launchSurface`) travels the same way so a page the agent creates is placed
 * where the person is looking. Both are read from a body parsed by hand, so a
 * value of the wrong shape must not reach the workflow input.
 *
 * Harness mirrors orchestrator-company-context-origin.test.ts.
 */

import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

process.env.BETTER_AUTH_SECRET = "test-secret-that-is-at-least-32-chars-long";

const getSessionMock = vi.fn();
const getAIModelWithMetadataMock = vi.fn();
const getTemporalClientMock = vi.fn();
const startWorkflowMock = vi.fn();
const memberFindFirstMock = vi.fn();
const projectFindUniqueMock = vi.fn();
const conversationFindFirstMock = vi.fn();

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

vi.mock("@repo/database", async () => ({
	...(
		await import("./_helpers/conversation-turn-db-mocks")
	).conversationTurnDbMocks(),
	CARRIED_OVER_MARKER_PREFIX: "[carried-over]",
	db: {
		agentConversation: {
			findFirst: (...args: unknown[]) =>
				conversationFindFirstMock(...args),
		},
		member: {
			findFirst: (...args: unknown[]) => memberFindFirstMock(...args),
		},
		project: {
			findUnique: (...args: unknown[]) => projectFindUniqueMock(...args),
		},
		aiChat: { findFirst: vi.fn(async () => null) },
	},
	getConversationWorkspaces: vi.fn(async () => []),
	getConversationProject: vi.fn(async () => null),
	hasProjectAccess: vi.fn(async () => true),
	filterAccessibleWorkspaceIds: vi.fn(async () => ({
		allowed: [],
		dropped: [],
	})),
}));

const SESSION_USER_ID = "user-1";
const ORGANIZATION_ID = "example-org";
const CONVERSATION_ID = "conversation-1";

function postBody(b: Record<string, unknown>) {
	return { json: async () => b } as never;
}

const loadRoute = () =>
	import("../../app/api/agents/fabric-ai/orchestrator-temporal/stream/route");

async function post(body: Record<string, unknown>) {
	const { POST } = await loadRoute();
	const response = await POST(postBody(body));
	await response.text();
	return response;
}

function startedInput(): Record<string, unknown> {
	return startWorkflowMock.mock.calls[0]?.[1]?.args?.[0] as Record<
		string,
		unknown
	>;
}

const CHAT_BODY = {
	message: "Make me a weekly status page",
	organizationId: ORGANIZATION_ID,
	surface: "loom-orchestrator",
};

describe("POST orchestrator-temporal/stream — the acting grant and the launch page", () => {
	const originalCacheHost = process.env.CACHE_HOST;
	const originalRedisUrl = process.env.REDIS_URL;

	// The route's module graph is large; load it once, outside any test's timeout.
	beforeAll(async () => {
		await loadRoute();
	}, 120_000);

	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		vi.spyOn(console, "log").mockImplementation(() => undefined);
		delete process.env.CACHE_HOST;
		delete process.env.REDIS_URL;

		getSessionMock.mockResolvedValue({
			user: { id: SESSION_USER_ID },
			session: {},
		});
		getAIModelWithMetadataMock.mockResolvedValue({ trackUsage: vi.fn() });
		memberFindFirstMock.mockResolvedValue({ id: "member-1" });
		conversationFindFirstMock.mockResolvedValue({ id: CONVERSATION_ID });
		projectFindUniqueMock.mockResolvedValue({
			organizationId: ORGANIZATION_ID,
		});
		startWorkflowMock.mockResolvedValue({
			workflowId: "wf-acting-grant",
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
			workflow: { getHandle: vi.fn(), start: startWorkflowMock },
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

	it("starts the turn with a grant minted for this user and organization", async () => {
		const { checkActingGrant } = await import(
			"@repo/api/lib/agent-service-auth"
		);

		const response = await post(CHAT_BODY);

		expect(response.status).toBe(200);
		const input = startedInput();
		expect(typeof input.actingGrant).toBe("string");
		expect(
			checkActingGrant(input.actingGrant as string, {
				userId: SESSION_USER_ID,
				organizationId: ORGANIZATION_ID,
			}),
		).toEqual({ ok: true });
		expect(
			checkActingGrant(input.actingGrant as string, {
				userId: "someone-else",
				organizationId: ORGANIZATION_ID,
			}),
		).toEqual({ ok: false, reason: "mismatch" });
		expect(
			checkActingGrant(input.actingGrant as string, {
				userId: SESSION_USER_ID,
				organizationId: "another-org",
			}),
		).toEqual({ ok: false, reason: "mismatch" });
	});

	it("binds the grant to the conversation the turn runs in", async () => {
		const { checkActingGrant } = await import(
			"@repo/api/lib/agent-service-auth"
		);

		await post({ ...CHAT_BODY, conversationId: CONVERSATION_ID });

		const input = startedInput();
		expect(input.conversationId).toBe(CONVERSATION_ID);
		expect(
			checkActingGrant(input.actingGrant as string, {
				userId: SESSION_USER_ID,
				organizationId: ORGANIZATION_ID,
				conversationId: CONVERSATION_ID,
			}),
		).toEqual({ ok: true });
		expect(
			checkActingGrant(input.actingGrant as string, {
				userId: SESSION_USER_ID,
				organizationId: ORGANIZATION_ID,
				conversationId: "a-different-conversation",
			}),
		).toEqual({ ok: false, reason: "mismatch" });
	});

	it("carries the page the chat was opened on into the workflow", async () => {
		await post({
			...CHAT_BODY,
			launchWorkspaceId: "workspace-frame-1",
			launchSurface: "workspace",
		});

		expect(startedInput()).toMatchObject({
			launchWorkspaceId: "workspace-frame-1",
			launchSurface: "workspace",
		});
	});

	it.each([
		["an object", { $ne: "x" }],
		["a number", 7],
		["an empty string", ""],
		["a very long string", "x".repeat(201)],
	])("drops a launch workspace that is %s", async (_, launchWorkspaceId) => {
		await post({
			...CHAT_BODY,
			launchWorkspaceId,
			launchSurface: "artifact",
		});

		expect(startedInput().launchWorkspaceId).toBeUndefined();
		expect(startedInput().launchSurface).toBe("artifact");
	});

	it.each([
		["a made-up surface", "dashboard"],
		["a number", 3],
		["null", null],
	])("drops a launch surface that is %s", async (_, launchSurface) => {
		await post({ ...CHAT_BODY, launchSurface });

		expect(startedInput().launchSurface).toBeUndefined();
	});
});
