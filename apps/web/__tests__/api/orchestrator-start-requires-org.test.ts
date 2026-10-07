/**
 * POST orchestrator-temporal — a run always acts in a verified organization.
 *
 * The organization is the only tenant context (ADR-018). The starter used to
 * verify membership only when the body named an organization and otherwise
 * threaded `undefined` into the AI, Temporal and memory calls — keeping the
 * organization-less arm live for any caller that simply omitted the field.
 * The route now resolves the organization (body, else the session's active
 * organization), verifies the caller's tie to it, and fails closed without
 * one.
 *
 * Harness mirrors orchestrator-execution-timeout.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getSessionMock = vi.fn();
const getAIModelWithMetadataMock = vi.fn();
const hasOrganizationTieMock = vi.fn();
const startWorkflowMock = vi.fn();
const describeWorkflowMock = vi.fn();
const memberFindFirstMock = vi.fn(async () => null);
/** The caller owns "conversation-mine" in "org-active" and nothing else. */
const conversationFindFirstMock = vi.fn(
	async (query: {
		where: { id: string; userId: string; organizationId: string };
	}) =>
		query.where.id === "conversation-mine" &&
		query.where.userId === "user-requires-org-1" &&
		query.where.organizationId === "org-active"
			? { id: "conversation-mine" }
			: null,
);

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

vi.mock("@repo/payments", () => ({
	AiUsageLimitExceededError: class AiUsageLimitExceededError extends Error {},
}));

vi.mock("@repo/temporal", () => ({
	ORCHESTRATOR_TASK_QUEUE: "fabric-orchestrator",
	getTemporalClient: vi.fn(async () => ({
		workflow: {
			start: startWorkflowMock,
			getHandle: () => ({
				describe: describeWorkflowMock,
				query: vi.fn(async () => null),
				result: vi.fn(async () => ({})),
			}),
		},
	})),
}));

vi.mock("@repo/database", async () => ({
	// Turn admission (see ./_helpers/conversation-turn-db-mocks.ts).
	...(
		await import("./_helpers/conversation-turn-db-mocks")
	).conversationTurnDbMocks(),
	db: {
		// No membership row: a project guest has a tie, not a membership.
		member: { findFirst: memberFindFirstMock },
		agentConversation: {
			findFirst: (...args: unknown[]) =>
				conversationFindFirstMock(...(args as [never])),
		},
	},
	hasOrganizationTie: (...args: unknown[]) => hasOrganizationTieMock(...args),
}));

const USER_ID = "user-requires-org-1";

function postBody(b: Record<string, unknown>) {
	return { json: async () => b } as never;
}

async function post(body: Record<string, unknown>) {
	const { POST } = await import(
		"../../app/api/agents/fabric-ai/orchestrator-temporal/route"
	);
	const response = await POST(postBody(body));
	return { status: response.status, body: await response.json() };
}

describe("POST orchestrator-temporal — organization is required and verified", () => {
	const originalCacheHost = process.env.CACHE_HOST;
	const originalRedisUrl = process.env.REDIS_URL;

	beforeEach(() => {
		vi.clearAllMocks();
		delete process.env.CACHE_HOST;
		delete process.env.REDIS_URL;
		getAIModelWithMetadataMock.mockResolvedValue({ trackUsage: vi.fn() });
		hasOrganizationTieMock.mockResolvedValue(true);
		// Chat starts require a membership row (the paired interactive
		// routes do too; a project guest's tie alone is not enough).
		memberFindFirstMock.mockResolvedValue({ id: "member-1" } as never);
		startWorkflowMock.mockResolvedValue({ workflowId: "wf-1" });
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

	it("fails closed when neither the body nor the session names an organization", async () => {
		getSessionMock.mockResolvedValue({
			user: { id: USER_ID },
			session: { activeOrganizationId: null },
		});

		const { status, body } = await post({ message: "hello" });

		expect(status).toBe(403);
		expect(body).toEqual({
			error: "Forbidden",
			message: "No organization is active for this session",
		});
		expect(memberFindFirstMock).not.toHaveBeenCalled();
		expect(startWorkflowMock).not.toHaveBeenCalled();
	});

	it("treats an explicit null organization the same as none", async () => {
		getSessionMock.mockResolvedValue({
			user: { id: USER_ID },
			session: {},
		});

		const { status } = await post({
			message: "hello",
			organizationId: null,
		});

		expect(status).toBe(403);
		expect(startWorkflowMock).not.toHaveBeenCalled();
	});

	it("refuses a named organization the caller is not a member of", async () => {
		getSessionMock.mockResolvedValue({
			user: { id: USER_ID },
			session: { activeOrganizationId: "org-mine" },
		});
		memberFindFirstMock.mockResolvedValue(null);

		const { status, body } = await post({
			message: "hello",
			organizationId: "org-not-mine",
		});

		expect(status).toBe(403);
		expect(body.message).toBe("You are not a member of this organization");
		expect(memberFindFirstMock).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { userId: USER_ID, organizationId: "org-not-mine" },
			}),
		);
		expect(startWorkflowMock).not.toHaveBeenCalled();
	});

	it("refuses a stale active organization the caller is no longer a member of", async () => {
		getSessionMock.mockResolvedValue({
			user: { id: USER_ID },
			session: { activeOrganizationId: "org-left" },
		});
		memberFindFirstMock.mockResolvedValue(null);

		const { status } = await post({ message: "hello" });

		expect(status).toBe(403);
		expect(memberFindFirstMock).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { userId: USER_ID, organizationId: "org-left" },
			}),
		);
		expect(startWorkflowMock).not.toHaveBeenCalled();
	});

	it("resolves an omitted organization from the session and threads it through", async () => {
		getSessionMock.mockResolvedValue({
			user: { id: USER_ID },
			session: { activeOrganizationId: "org-active" },
		});

		const { status } = await post({ message: "hello" });

		expect(status).toBe(200);
		expect(memberFindFirstMock).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { userId: USER_ID, organizationId: "org-active" },
			}),
		);
		expect(getAIModelWithMetadataMock).toHaveBeenCalledWith(
			expect.anything(),
			{
				userId: USER_ID,
				organizationId: "org-active",
				planEligible: true,
			},
		);
		const [, options] = startWorkflowMock.mock.calls[0] as [
			string,
			{
				args: [{ organizationId?: string; planEligible?: boolean }];
				memo: Record<string, unknown>;
			},
		];
		expect(options.args[0].organizationId).toBe("org-active");
		// A person typed this turn: its AI steps may use their ChatGPT plan.
		expect(options.args[0].planEligible).toBe(true);
		expect(options.memo).toMatchObject({
			userId: USER_ID,
			organizationId: "org-active",
		});
	});
});

describe("POST orchestrator-temporal — a project guest is refused at start", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		delete process.env.CACHE_HOST;
		delete process.env.REDIS_URL;
		getAIModelWithMetadataMock.mockResolvedValue({ trackUsage: vi.fn() });
		startWorkflowMock.mockResolvedValue({ workflowId: "wf-1" });
		getSessionMock.mockResolvedValue({
			user: { id: USER_ID },
			session: { activeOrganizationId: "org-guest" },
		});
	});

	it("F-7: refuses a caller with an organization tie but no membership, as clarify does", async () => {
		hasOrganizationTieMock.mockResolvedValue(true);
		memberFindFirstMock.mockResolvedValue(null);
		const { status, body } = await post({ message: "hello" });
		expect(status).toBe(403);
		expect(body.message).toBe("You are not a member of this organization");
		expect(startWorkflowMock).not.toHaveBeenCalled();
	});
});

describe("POST orchestrator-temporal — the Planner runs as a turn; Weave keeps the legacy path", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		delete process.env.CACHE_HOST;
		delete process.env.REDIS_URL;
		getAIModelWithMetadataMock.mockResolvedValue({ trackUsage: vi.fn() });
		hasOrganizationTieMock.mockResolvedValue(true);
		memberFindFirstMock.mockResolvedValue({ id: "member-1" } as never);
		// Chat starts require a membership row (the paired interactive
		// routes do too; a project guest's tie alone is not enough).
		memberFindFirstMock.mockResolvedValue({ id: "member-1" } as never);
		startWorkflowMock.mockResolvedValue({ workflowId: "wf-1" });
		getSessionMock.mockResolvedValue({
			user: { id: USER_ID },
			session: { activeOrganizationId: "org-active" },
		});
	});

	it("R1-4: a save_reuse (Planner) start is admitted as a turn and passes its turnId", async () => {
		const { admitConversationTurn } = await import("@repo/database");
		const { status } = await post({
			message: "hello",
			executionMode: "save_reuse",
		});
		expect(status).toBe(200);
		expect(vi.mocked(admitConversationTurn)).toHaveBeenCalledWith(
			expect.objectContaining({ executionMode: "save_reuse" }),
		);
		const [, options] = startWorkflowMock.mock.calls[0] as [
			string,
			{ args: [Record<string, unknown>]; workflowIdReusePolicy: string },
		];
		expect(options.args[0]).toMatchObject({
			executionMode: "save_reuse",
			turnId: "turn-example-1",
		});
		expect(options.workflowIdReusePolicy).toBe("REJECT_DUPLICATE");
	});

	it("R1-4: a weave start creates no turn and passes no turnId", async () => {
		const { admitConversationTurn } = await import("@repo/database");
		const { status } = await post({
			message: "hello",
			executionMode: "weave",
		});
		expect(status).toBe(200);
		expect(vi.mocked(admitConversationTurn)).not.toHaveBeenCalled();
		const [, options] = startWorkflowMock.mock.calls[0] as [
			string,
			{ args: [Record<string, unknown>] },
		];
		expect(options.args[0]).not.toHaveProperty("turnId");
	});

	it("R2-2: refuses a save_reuse start naming another user's conversation", async () => {
		const { status } = await post({
			message: "hello",
			executionMode: "save_reuse",
			conversationId: "conversation-theirs",
		});
		expect(status).toBe(403);
		expect(startWorkflowMock).not.toHaveBeenCalled();
	});

	it("R2-2: refuses a weave start naming the caller's conversation from another organization", async () => {
		const { status } = await post({
			message: "hello",
			executionMode: "weave",
			organizationId: "org-other",
			conversationId: "conversation-mine",
		});
		expect(status).toBe(403);
		expect(startWorkflowMock).not.toHaveBeenCalled();
	});

	it("R2-2: still starts a save_reuse run in the caller's own conversation", async () => {
		const { status } = await post({
			message: "hello",
			executionMode: "save_reuse",
			conversationId: "conversation-mine",
		});
		expect(status).toBe(200);
		expect(startWorkflowMock).toHaveBeenCalledTimes(1);
	});
});

describe("GET orchestrator-temporal — tenant check uses organization-tie semantics", () => {
	const EXECUTION_ID = "orch-0f8fad5b-d9cb-469f-a165-70867728950e";

	async function get() {
		const { GET } = await import(
			"../../app/api/agents/fabric-ai/orchestrator-temporal/route"
		);
		const response = await GET({
			url: `http://localhost/api/agents/fabric-ai/orchestrator-temporal?executionId=${EXECUTION_ID}`,
		} as never);
		return { status: response.status, body: await response.json() };
	}

	beforeEach(() => {
		vi.clearAllMocks();
		delete process.env.CACHE_HOST;
		delete process.env.REDIS_URL;
		getSessionMock.mockResolvedValue({
			user: { id: USER_ID },
			session: { activeOrganizationId: "org-guest" },
		});
		describeWorkflowMock.mockResolvedValue({
			memo: { userId: USER_ID, organizationId: "org-guest" },
			status: { name: "RUNNING" },
		});
	});

	it("lets a project guest (tie, no membership row) read their own run", async () => {
		hasOrganizationTieMock.mockResolvedValue(true);

		const { status, body } = await get();

		expect(status).toBe(200);
		expect(body.executionId).toBe(EXECUTION_ID);
		expect(hasOrganizationTieMock).toHaveBeenCalledWith(
			USER_ID,
			"org-guest",
		);
		expect(memberFindFirstMock).not.toHaveBeenCalled();
	});

	it("refuses a caller with no tie to the run's organization", async () => {
		hasOrganizationTieMock.mockResolvedValue(false);

		const { status, body } = await get();

		expect(status).toBe(403);
		expect(body.message).toBe("You are not a member of this organization");
	});
});

describe("POST orchestrator-temporal — an ambiguous start is retryable", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		getAIModelWithMetadataMock.mockResolvedValue({ trackUsage: vi.fn() });
		memberFindFirstMock.mockResolvedValue({ id: "member-1" } as never);
		getSessionMock.mockResolvedValue({
			user: { id: USER_ID },
			session: { activeOrganizationId: "org-active" },
		});
	});

	it("R2-F2: answers 409 TURN_PENDING with the executionId, not a 500", async () => {
		const grpc = Object.assign(
			new Error("14 UNAVAILABLE: connection reset"),
			{
				code: 14,
				details: "UNAVAILABLE: connection reset",
				metadata: {},
			},
		);
		startWorkflowMock.mockRejectedValue(
			Object.assign(new Error("Failed to start Workflow"), {
				name: "ServiceError",
				cause: grpc,
			}),
		);

		const { status, body } = await post({ message: "hello" });

		expect(status).toBe(409);
		expect(body).toMatchObject({
			code: "TURN_PENDING",
			executionId: expect.stringMatching(/^orch-/),
		});
	});
});
