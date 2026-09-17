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

vi.mock("@repo/database", () => ({
	db: {
		// No membership row: a project guest has a tie, not a membership.
		member: { findFirst: memberFindFirstMock },
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
		expect(hasOrganizationTieMock).not.toHaveBeenCalled();
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

	it("refuses a named organization the caller has no tie to", async () => {
		getSessionMock.mockResolvedValue({
			user: { id: USER_ID },
			session: { activeOrganizationId: "org-mine" },
		});
		hasOrganizationTieMock.mockResolvedValue(false);

		const { status, body } = await post({
			message: "hello",
			organizationId: "org-not-mine",
		});

		expect(status).toBe(403);
		expect(body.message).toBe("You are not a member of this organization");
		expect(hasOrganizationTieMock).toHaveBeenCalledWith(
			USER_ID,
			"org-not-mine",
		);
		expect(startWorkflowMock).not.toHaveBeenCalled();
	});

	it("refuses a stale active organization the caller no longer has a tie to", async () => {
		getSessionMock.mockResolvedValue({
			user: { id: USER_ID },
			session: { activeOrganizationId: "org-left" },
		});
		hasOrganizationTieMock.mockResolvedValue(false);

		const { status } = await post({ message: "hello" });

		expect(status).toBe(403);
		expect(hasOrganizationTieMock).toHaveBeenCalledWith(
			USER_ID,
			"org-left",
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
		expect(hasOrganizationTieMock).toHaveBeenCalledWith(
			USER_ID,
			"org-active",
		);
		expect(getAIModelWithMetadataMock).toHaveBeenCalledWith(
			expect.anything(),
			{ userId: USER_ID, organizationId: "org-active" },
		);
		const [, options] = startWorkflowMock.mock.calls[0] as [
			string,
			{
				args: [{ organizationId?: string }];
				memo: Record<string, unknown>;
			},
		];
		expect(options.args[0].organizationId).toBe("org-active");
		expect(options.memo).toMatchObject({
			userId: USER_ID,
			organizationId: "org-active",
		});
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
