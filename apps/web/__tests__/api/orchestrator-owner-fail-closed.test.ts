/**
 * Orchestrator run owner checks fail closed.
 *
 * Every route that acts on an orchestrator run checked ownership as
 * `if (workflowUserId && workflowUserId !== userId)` — a run whose memo
 * carries no owner passed the check. A run is attributable only through its
 * memo (and, for a chat turn, its turn row), so a missing owner must refuse,
 * the way the direct-chat cancel route already does. A run with a turn row
 * additionally requires the caller to be the turn's user in the turn's
 * organization.
 *
 * Covers the approve, clarify and follow-up routes and the non-stream GET
 * (the cancel and stream routes have their own suites).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	getSession: vi.fn(),
	checkRateLimit: vi.fn(),
	describe: vi.fn(),
	signal: vi.fn(),
	query: vi.fn(),
	getConversationTurnOwnerForExecution: vi.fn(),
}));

vi.mock("@saas/auth/lib/server", () => ({
	getSession: () => m.getSession(),
}));
vi.mock("@repo/api/lib/rate-limit", () => ({
	checkRateLimit: (...a: unknown[]) => m.checkRateLimit(...a),
}));
vi.mock("@repo/temporal", () => ({
	ORCHESTRATOR_TASK_QUEUE: "fabric-orchestrator",
	getTemporalClient: async () => ({
		workflow: {
			getHandle: () => ({
				describe: m.describe,
				signal: m.signal,
				query: m.query,
				result: vi.fn(async () => ({ status: "completed" })),
			}),
		},
	}),
}));
vi.mock("@repo/ai", () => ({ getAIModelWithMetadata: vi.fn() }));
vi.mock("@repo/agent-core/backend", () => ({
	getDefaultEnabledMcpConfigIds: vi.fn(async () => []),
}));
vi.mock("@repo/payments", () => ({
	AiUsageLimitExceededError: class AiUsageLimitExceededError extends Error {},
}));
vi.mock("@repo/database", () => ({
	db: { member: { findFirst: vi.fn(async () => ({ id: "member-1" })) } },
	hasOrganizationTie: vi.fn(async () => true),
	getConversationTurnOwnerForExecution: (...a: unknown[]) =>
		m.getConversationTurnOwnerForExecution(...a),
}));

const USER_ID = "user-owner-1";
const ORG_ID = "org-example-1";
const EXEC = "orch-dddddddd-0000-4000-8000-000000000004";
const PENDING_APPROVAL_ID = "authority-sess-1-call-1";

type RouteCall = () => Promise<Response>;

function jsonRequest(body: Record<string, unknown>) {
	return { json: async () => body } as never;
}

const routes: Array<[string, RouteCall]> = [
	[
		"approve",
		async () => {
			const { POST } = await import(
				"../../app/api/agents/fabric-ai/orchestrator-temporal/approve/route"
			);
			return POST(jsonRequest({ executionId: EXEC, approved: true }));
		},
	],
	[
		"clarify",
		async () => {
			const { POST } = await import(
				"../../app/api/agents/fabric-ai/orchestrator-temporal/clarify/route"
			);
			return POST(jsonRequest({ executionId: EXEC, answer: "staging" }));
		},
	],
	[
		"follow-up",
		async () => {
			const { POST } = await import(
				"../../app/api/agents/fabric-ai/orchestrator-temporal/follow-up/route"
			);
			return POST(
				jsonRequest({ executionId: EXEC, message: "also check docs" }),
			);
		},
	],
	[
		"GET status",
		async () => {
			const { GET } = await import(
				"../../app/api/agents/fabric-ai/orchestrator-temporal/route"
			);
			return GET({
				url: `http://localhost/api/agents/fabric-ai/orchestrator-temporal?executionId=${EXEC}`,
			} as never);
		},
	],
];

beforeEach(() => {
	vi.clearAllMocks();
	m.getSession.mockResolvedValue({
		user: { id: USER_ID },
		session: { activeOrganizationId: ORG_ID },
	});
	m.checkRateLimit.mockResolvedValue({
		allowed: true,
		remaining: 9,
		resetInSeconds: 60,
	});
	m.getConversationTurnOwnerForExecution.mockResolvedValue(null);
	m.query.mockImplementation(async (name: string) =>
		name === "pendingApproval" ? { approvalId: PENDING_APPROVAL_ID } : null,
	);
});

describe.each(routes)("%s — owner check fails closed", (_name, call) => {
	it("refuses a run whose memo names no owner", async () => {
		m.describe.mockResolvedValue({
			status: { name: "RUNNING" },
			memo: {},
		});
		const response = await call();
		expect(response.status).toBe(403);
		expect(m.signal).not.toHaveBeenCalled();
	});

	it("refuses a run with no memo at all", async () => {
		m.describe.mockResolvedValue({ status: { name: "RUNNING" } });
		const response = await call();
		expect(response.status).toBe(403);
		expect(m.signal).not.toHaveBeenCalled();
	});

	it("refuses a run whose turn belongs to another user, even when the memo names the caller", async () => {
		m.describe.mockResolvedValue({
			status: { name: "RUNNING" },
			memo: { userId: USER_ID, organizationId: ORG_ID },
		});
		m.getConversationTurnOwnerForExecution.mockResolvedValue({
			userId: "user-someone-else",
			organizationId: ORG_ID,
		});
		const response = await call();
		expect(response.status).toBe(403);
		expect(m.signal).not.toHaveBeenCalled();
	});

	it("still serves the run's owner", async () => {
		m.describe.mockResolvedValue({
			status: { name: "RUNNING" },
			memo: { userId: USER_ID, organizationId: ORG_ID },
		});
		m.getConversationTurnOwnerForExecution.mockResolvedValue({
			userId: USER_ID,
			organizationId: ORG_ID,
		});
		const response = await call();
		expect(response.status).toBe(200);
	});
});

describe("approve — names the approval the person answered", () => {
	async function approve(body: Record<string, unknown>) {
		m.describe.mockResolvedValue({
			status: { name: "RUNNING" },
			memo: { userId: USER_ID, organizationId: ORG_ID },
		});
		const { POST } = await import(
			"../../app/api/agents/fabric-ai/orchestrator-temporal/approve/route"
		);
		return POST(
			jsonRequest({ executionId: EXEC, approved: true, ...body }),
		);
	}

	it("passes the approval id to the run, which takes the answer only for that approval", async () => {
		const response = await approve({
			approvalId: "authority-sess-1-call-1",
		});

		expect(response.status).toBe(200);
		expect(m.signal).toHaveBeenCalledWith("approval", {
			approved: true,
			feedback: undefined,
			decidedBy: USER_ID,
			approvalId: "authority-sess-1-call-1",
		});
	});

	it("still signals an answer from a client that names no approval", async () => {
		const response = await approve({});

		expect(response.status).toBe(200);
		expect(m.signal).toHaveBeenCalledWith(
			"approval",
			expect.not.objectContaining({ approvalId: expect.anything() }),
		);
	});

	it.each([[""], [42], ["x".repeat(501)]])(
		"refuses an approval id that is not one (%s)",
		async (approvalId) => {
			const response = await approve({ approvalId });

			expect(response.status).toBe(400);
			expect(m.signal).not.toHaveBeenCalled();
		},
	);
});

describe("approve — reports an answer the run would drop", () => {
	async function approve(body: Record<string, unknown>) {
		m.describe.mockResolvedValue({
			status: { name: "RUNNING" },
			memo: { userId: USER_ID, organizationId: ORG_ID },
		});
		const { POST } = await import(
			"../../app/api/agents/fabric-ai/orchestrator-temporal/approve/route"
		);
		return POST(
			jsonRequest({ executionId: EXEC, approved: true, ...body }),
		);
	}

	it("refuses with 409 and sends nothing when no approval is pending", async () => {
		m.query.mockResolvedValue(null);

		for (const body of [{ approvalId: PENDING_APPROVAL_ID }, {}]) {
			const response = await approve(body);

			expect(response.status).toBe(409);
			expect(await response.json()).toEqual({
				error: "This approval is no longer pending.",
				code: "APPROVAL_NOT_PENDING",
			});
		}
		expect(m.query).toHaveBeenCalledWith("pendingApproval");
		expect(m.signal).not.toHaveBeenCalled();
	});

	it("refuses with 409 and sends nothing when a different approval is pending", async () => {
		const response = await approve({
			approvalId: "authority-sess-0-call-0",
		});

		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({
			code: "APPROVAL_NOT_PENDING",
		});
		expect(m.signal).not.toHaveBeenCalled();
	});

	it("signals and returns 200 when the answered approval is the pending one", async () => {
		const response = await approve({ approvalId: PENDING_APPROVAL_ID });

		expect(response.status).toBe(200);
		expect(m.signal).toHaveBeenCalledTimes(1);
		expect(m.signal).toHaveBeenCalledWith(
			"approval",
			expect.objectContaining({ approvalId: PENDING_APPROVAL_ID }),
		);
	});
});
