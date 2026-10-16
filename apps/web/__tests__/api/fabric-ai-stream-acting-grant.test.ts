/**
 * The Direct chat route vouches for the turn it starts.
 *
 * Fabric's tools reach the person's data through the Fabric MCP gateway as the
 * worker, which holds a secret every internal service holds. What says "this
 * turn acts for this user in this organization" is the acting grant the route
 * mints from the session it just authenticated and puts in the workflow input.
 * If the route stopped minting it, every Fabric tool in a turn would be refused
 * at the gateway while every activity test, which sets the field by hand,
 * stayed green.
 *
 * Runs the real route with its Temporal, database, auth and rate-limit
 * modules mocked; the grant is signed and checked for real.
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
const hasOrganizationTieMock = vi.fn();
const startWorkflowMock = vi.fn();
const findConversationMock = vi.fn();

vi.mock("@saas/auth/lib/server", () => ({
	getSession: () => getSessionMock(),
}));

vi.mock("@repo/api/lib/rate-limit", () => ({
	checkRateLimit: vi.fn(async () => ({
		allowed: true,
		remaining: 19,
		resetInSeconds: 60,
	})),
	RATE_LIMIT_PRESETS: { ai: { limit: 20, windowMs: 60_000 } },
}));

vi.mock("@repo/ai", () => ({
	getAIModelWithMetadata: (...args: unknown[]) =>
		getAIModelWithMetadataMock(...args),
	getCurrentDateContext: () => "Today is 2026-10-05.",
}));

vi.mock("@repo/agent-core/backend", () => ({
	getDefaultEnabledMcpConfigIds: vi.fn(async () => []),
}));

vi.mock("@repo/payments", () => ({
	AiUsageLimitExceededError: class AiUsageLimitExceededError extends Error {},
}));

vi.mock("@repo/temporal", () => ({
	decodeHeartbeatDetails: vi.fn(() => undefined),
	getTemporalClient: vi.fn(async () => ({
		workflow: { start: startWorkflowMock },
	})),
	isTemporalAvailable: vi.fn(async () => true),
}));

vi.mock("@repo/database", () => ({
	db: {
		agentConversation: {
			findFirst: (...args: unknown[]) => findConversationMock(...args),
		},
	},
	hasOrganizationTie: (...args: unknown[]) => hasOrganizationTieMock(...args),
	getConversationWorkspaces: vi.fn(async () => []),
	getConversationProject: vi.fn(async () => null),
	getProjectAccessContext: vi.fn(async () => null),
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

const loadRoute = () => import("../../app/api/agents/fabric-ai/stream/route");

async function post(body: Record<string, unknown>) {
	const { POST } = await loadRoute();
	const response = await POST(postBody(body));
	await response.text();
	return response;
}

function startedInput(): Record<string, unknown> {
	const [, options] = startWorkflowMock.mock.calls[0] ?? [];
	return options?.args?.[0] as Record<string, unknown>;
}

describe("POST fabric-ai/stream — the acting grant", () => {
	// The route's module graph is large; load it once, outside any test's timeout.
	beforeAll(async () => {
		await loadRoute();
	}, 120_000);

	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, "log").mockImplementation(() => undefined);
		vi.spyOn(console, "warn").mockImplementation(() => undefined);

		getSessionMock.mockResolvedValue({
			user: { id: SESSION_USER_ID },
			session: { activeOrganizationId: ORGANIZATION_ID },
		});
		hasOrganizationTieMock.mockResolvedValue(true);
		findConversationMock.mockResolvedValue({
			id: CONVERSATION_ID,
			organizationId: ORGANIZATION_ID,
		});
		getAIModelWithMetadataMock.mockResolvedValue({ trackUsage: vi.fn() });
		startWorkflowMock.mockImplementation(
			async (_type: string, options: { workflowId: string }) => ({
				workflowId: options.workflowId,
				describe: async () => ({ status: { name: "COMPLETED" } }),
				result: async () => ({
					success: true,
					responseText: "ok",
					toolCalls: [],
				}),
			}),
		);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("starts the turn with a grant minted for this user and organization", async () => {
		const { checkActingGrant } = await import(
			"@repo/api/lib/agent-service-auth"
		);

		const response = await post({
			message: "Make me a weekly status page",
			organizationId: ORGANIZATION_ID,
		});

		expect(response.status).toBe(200);
		const input = startedInput();
		expect(typeof input.actingGrant).toBe("string");
		expect(
			checkActingGrant(input.actingGrant as string, {
				userId: SESSION_USER_ID,
				organizationId: ORGANIZATION_ID,
			}),
		).toEqual({ ok: true });
	});

	it("binds the grant to the person and the organization of this turn alone", async () => {
		const { checkActingGrant } = await import(
			"@repo/api/lib/agent-service-auth"
		);

		await post({
			message: "Make me a weekly status page",
			organizationId: ORGANIZATION_ID,
		});

		const grant = startedInput().actingGrant as string;
		expect(
			checkActingGrant(grant, {
				userId: "someone-else",
				organizationId: ORGANIZATION_ID,
			}),
		).toEqual({ ok: false, reason: "mismatch" });
		expect(
			checkActingGrant(grant, {
				userId: SESSION_USER_ID,
				organizationId: "another-org",
			}),
		).toEqual({ ok: false, reason: "mismatch" });
	});

	it("binds the grant to the conversation the turn belongs to", async () => {
		const { checkActingGrant } = await import(
			"@repo/api/lib/agent-service-auth"
		);

		await post({
			message: "Make me a weekly status page",
			organizationId: ORGANIZATION_ID,
			conversationId: CONVERSATION_ID,
		});

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
});
