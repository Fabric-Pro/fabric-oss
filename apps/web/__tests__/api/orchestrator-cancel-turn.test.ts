/**
 * POST orchestrator-temporal/cancel — Stop on an Advisor turn.
 *
 *   - The cancel is recorded durably (CANCEL_REQUESTED, who, when, source)
 *     BEFORE Temporal is asked to cancel, so a Temporal outage cannot lose
 *     it: the turn's next dispatch check refuses every further model call.
 *   - Temporal NotFound means the run already ended: the turn is reconciled
 *     and the cancel answers success. A transport or auth error is NOT
 *     "already ended": it answers 503, and the recorded cancel stays.
 *   - Stop before `started`: a cancel by client key with no turn yet leaves
 *     a tombstone; with a turn, it cancels that turn's execution.
 *   - The caller must own the turn (user + organization). For a run with no
 *     turn row, a memo with no owner fails closed instead of passing.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	getSession: vi.fn(),
	checkRateLimit: vi.fn(),
	getTemporalClient: vi.fn(),
	getHandle: vi.fn(),
	describe: vi.fn(),
	cancel: vi.fn(),
	hasOrganizationTie: vi.fn(),
	memberFindFirst: vi.fn(),
	requestConversationTurnCancel: vi.fn(),
	finalizeConversationTurn: vi.fn(),
	finalizeOrphanedConversationTurn: vi.fn(),
	getConversationTurnForExecution: vi.fn(),
	getConversationTurnOwnerForExecution: vi.fn(),
	order: [] as string[],
}));

vi.mock("@saas/auth/lib/server", () => ({
	getSession: () => m.getSession(),
}));
vi.mock("@repo/api/lib/rate-limit", () => ({
	checkRateLimit: (...a: unknown[]) => m.checkRateLimit(...a),
}));
vi.mock("@repo/temporal", () => ({
	getTemporalClient: () => m.getTemporalClient(),
}));
vi.mock("@repo/database", () => ({
	db: { member: { findFirst: m.memberFindFirst } },
	hasOrganizationTie: (...a: unknown[]) => m.hasOrganizationTie(...a),
	requestConversationTurnCancel: (...a: unknown[]) =>
		m.requestConversationTurnCancel(...a),
	finalizeConversationTurn: (...a: unknown[]) =>
		m.finalizeConversationTurn(...a),
	finalizeOrphanedConversationTurn: (...a: unknown[]) =>
		m.finalizeOrphanedConversationTurn(...a),
	getConversationTurnForExecution: (...a: unknown[]) =>
		m.getConversationTurnForExecution(...a),
	getConversationTurnOwnerForExecution: (...a: unknown[]) =>
		m.getConversationTurnOwnerForExecution(...a),
}));

import { POST } from "../../app/api/agents/fabric-ai/orchestrator-temporal/cancel/route";

const USER_ID = "user-cancel-1";
const ORG_ID = "org-example-1";
const EXEC = "orch-cccccccc-0000-4000-8000-000000000003";
const KEY = "1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed";

function turnRow(overrides: Record<string, unknown> = {}) {
	return {
		id: "turn-1",
		userId: USER_ID,
		organizationId: ORG_ID,
		conversationId: "conversation-1",
		scopeConversationId: "conversation-1",
		clientRequestKey: KEY,
		executionId: EXEC,
		status: "ACTIVE",
		createdAt: new Date(),
		updatedAt: new Date(),
		...overrides,
	};
}

function request(body: Record<string, unknown>) {
	return { json: async () => body } as never;
}

beforeEach(() => {
	vi.clearAllMocks();
	m.order.length = 0;
	m.getSession.mockResolvedValue({
		user: { id: USER_ID },
		session: { activeOrganizationId: ORG_ID },
	});
	m.checkRateLimit.mockResolvedValue({
		allowed: true,
		remaining: 9,
		resetInSeconds: 60,
	});
	m.hasOrganizationTie.mockResolvedValue(true);
	m.memberFindFirst.mockResolvedValue({ id: "member-1" });
	m.getConversationTurnForExecution.mockResolvedValue(turnRow());
	m.getConversationTurnOwnerForExecution.mockResolvedValue({
		userId: USER_ID,
		organizationId: ORG_ID,
	});
	m.requestConversationTurnCancel.mockImplementation(async () => {
		m.order.push("record");
		return {
			outcome: "recorded",
			turn: turnRow({ status: "CANCEL_REQUESTED" }),
		};
	});
	m.finalizeConversationTurn.mockResolvedValue({
		outcome: "finalized",
		status: "CANCELLED",
	});
	m.finalizeOrphanedConversationTurn.mockResolvedValue({
		outcome: "finalized",
		status: "CANCELLED",
	});
	m.describe.mockResolvedValue({
		status: { name: "RUNNING" },
		memo: { userId: USER_ID, organizationId: ORG_ID },
	});
	m.cancel.mockImplementation(async () => {
		m.order.push("temporal-cancel");
	});
	m.getHandle.mockReturnValue({ describe: m.describe, cancel: m.cancel });
	m.getTemporalClient.mockResolvedValue({
		workflow: { getHandle: m.getHandle },
	});
});

describe("POST orchestrator-temporal/cancel — turn cancellation", () => {
	it("records the cancel durably before asking Temporal to cancel", async () => {
		const response = await POST(
			request({ executionId: EXEC, organizationId: ORG_ID }),
		);
		expect(response.status).toBe(200);
		expect(m.requestConversationTurnCancel).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: USER_ID,
				organizationId: ORG_ID,
				executionId: EXEC,
				source: "USER_STOP",
				requestedByUserId: USER_ID,
			}),
		);
		expect(m.order).toEqual(["record", "temporal-cancel"]);
	});

	it("answers 503 on a Temporal transport error, and the recorded cancel stays", async () => {
		m.describe.mockRejectedValue(
			Object.assign(new Error("14 UNAVAILABLE: connection refused"), {
				code: 14,
			}),
		);
		const response = await POST(
			request({ executionId: EXEC, organizationId: ORG_ID }),
		);
		expect(response.status).toBe(503);
		const body = await response.json();
		expect(body).toMatchObject({ cancelRecorded: true });
		expect(m.requestConversationTurnCancel).toHaveBeenCalled();
		expect(m.cancel).not.toHaveBeenCalled();
		// Nothing pretends the run ended.
		expect(m.finalizeConversationTurn).not.toHaveBeenCalled();
	});

	it("answers 503 when the Temporal cancel call itself fails", async () => {
		m.cancel.mockRejectedValue(
			Object.assign(new Error("deadline exceeded"), { code: 4 }),
		);
		const response = await POST(
			request({ executionId: EXEC, organizationId: ORG_ID }),
		);
		expect(response.status).toBe(503);
		expect(m.requestConversationTurnCancel).toHaveBeenCalled();
	});

	it("treats Temporal NotFound as already ended and reconciles the turn", async () => {
		m.describe.mockRejectedValue(
			Object.assign(new Error("workflow not found"), {
				name: "WorkflowNotFoundError",
			}),
		);
		const response = await POST(
			request({ executionId: EXEC, organizationId: ORG_ID }),
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			alreadyTerminated: true,
		});
		// A compare-and-set on the cancel-requested state just recorded.
		expect(m.finalizeOrphanedConversationTurn).toHaveBeenCalledWith(
			expect.objectContaining({
				turnId: "turn-1",
				executionId: EXEC,
				userId: USER_ID,
				organizationId: ORG_ID,
				observedStatus: "CANCEL_REQUESTED",
			}),
		);
	});

	it("refuses another user's turn without recording or sending anything", async () => {
		m.getConversationTurnForExecution.mockResolvedValue(null);
		m.getConversationTurnOwnerForExecution.mockResolvedValue({
			userId: "user-someone-else",
			organizationId: ORG_ID,
		});
		const response = await POST(
			request({ executionId: EXEC, organizationId: ORG_ID }),
		);
		expect(response.status).toBe(403);
		expect(m.requestConversationTurnCancel).not.toHaveBeenCalled();
		expect(m.cancel).not.toHaveBeenCalled();
	});

	it("refuses an organization the caller is not a member of", async () => {
		m.memberFindFirst.mockResolvedValue(null);
		const response = await POST(
			request({ executionId: EXEC, organizationId: "org-not-mine" }),
		);
		expect(response.status).toBe(403);
		expect(m.requestConversationTurnCancel).not.toHaveBeenCalled();
		expect(m.cancel).not.toHaveBeenCalled();
	});

	it("fails closed for a run with no turn row whose memo names no owner", async () => {
		m.getConversationTurnForExecution.mockResolvedValue(null);
		m.getConversationTurnOwnerForExecution.mockResolvedValue(null);
		m.describe.mockResolvedValue({ status: { name: "RUNNING" }, memo: {} });
		const response = await POST(
			request({ executionId: EXEC, organizationId: ORG_ID }),
		);
		expect(response.status).toBe(403);
		expect(m.cancel).not.toHaveBeenCalled();
	});

	it("still cancels a legacy run (no turn row) the caller owns by memo", async () => {
		m.getConversationTurnForExecution.mockResolvedValue(null);
		m.getConversationTurnOwnerForExecution.mockResolvedValue(null);
		const response = await POST(
			request({ executionId: EXEC, organizationId: ORG_ID }),
		);
		expect(response.status).toBe(200);
		expect(m.cancel).toHaveBeenCalledTimes(1);
	});

	it("tombstones a Stop by client key that arrives before the turn exists", async () => {
		m.requestConversationTurnCancel.mockResolvedValue({
			outcome: "tombstoned",
			turn: turnRow({
				status: "CANCELLED",
				executionId: null,
				cancelSource: "CANCELLED_BEFORE_START",
			}),
		});
		const response = await POST(
			request({
				clientRequestKey: KEY,
				conversationId: "conversation-1",
				organizationId: ORG_ID,
			}),
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			success: true,
			cancelledBeforeStart: true,
		});
		expect(m.requestConversationTurnCancel).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: USER_ID,
				organizationId: ORG_ID,
				clientRequestKey: KEY,
				conversationId: "conversation-1",
			}),
		);
		expect(m.getHandle).not.toHaveBeenCalled();
	});

	it("cancels the started turn's execution on a Stop by client key", async () => {
		const response = await POST(
			request({ clientRequestKey: KEY, organizationId: ORG_ID }),
		);
		expect(response.status).toBe(200);
		expect(m.getHandle).toHaveBeenCalledWith(EXEC);
		expect(m.order).toEqual(["record", "temporal-cancel"]);
	});

	it("refuses a key cancel naming a conversation that is not the turn's", async () => {
		m.requestConversationTurnCancel.mockResolvedValue({
			outcome: "scope_mismatch",
		});
		const response = await POST(
			request({
				clientRequestKey: KEY,
				conversationId: "conversation-other",
				organizationId: ORG_ID,
			}),
		);
		expect(response.status).toBe(403);
		expect(m.getHandle).not.toHaveBeenCalled();
	});

	it("R1-3: records the cancel even when the Temporal client cannot be acquired, and answers 503", async () => {
		m.getTemporalClient.mockRejectedValue(
			new Error("Failed to connect to Temporal"),
		);
		const response = await POST(
			request({ executionId: EXEC, organizationId: ORG_ID }),
		);
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({ cancelRecorded: true });
		expect(m.requestConversationTurnCancel).toHaveBeenCalledWith(
			expect.objectContaining({ executionId: EXEC, source: "USER_STOP" }),
		);
	});

	it("R1-3: tombstones a Stop by key with no Temporal connection at all", async () => {
		m.getTemporalClient.mockRejectedValue(
			new Error("Failed to connect to Temporal"),
		);
		m.requestConversationTurnCancel.mockResolvedValue({
			outcome: "tombstoned",
			turn: turnRow({ status: "CANCELLED", executionId: null }),
		});
		const response = await POST(
			request({ clientRequestKey: KEY, organizationId: ORG_ID }),
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			cancelledBeforeStart: true,
		});
	});

	it("R1-11: refuses a cancel by executionId that names a different conversation than the turn's", async () => {
		const response = await POST(
			request({
				executionId: EXEC,
				organizationId: ORG_ID,
				conversationId: "conversation-other",
			}),
		);
		expect(response.status).toBe(403);
		expect(m.requestConversationTurnCancel).not.toHaveBeenCalled();
		expect(m.cancel).not.toHaveBeenCalled();
	});
});
