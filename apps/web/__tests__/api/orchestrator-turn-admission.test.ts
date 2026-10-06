/**
 * POST orchestrator-temporal/stream — Advisor turn admission.
 *
 * Every new turn now goes through the server-owned turn record first:
 *
 *   - the organization is resolved server-side and required (body, else the
 *     session's active organization, with a tie to it), never an optional
 *     extra (ADR-018);
 *   - a conversation the caller cannot access is refused with 403, not
 *     silently discarded;
 *   - a retry carrying the same client key attaches to the turn it already
 *     created and never starts a second workflow; a start whose response was
 *     lost (the workflow already exists) attaches too;
 *   - a second live turn in one conversation is refused with 409 carrying
 *     the live turn's executionId, after the live turn is reconciled against
 *     Temporal (a turn whose workflow is gone is terminalized and the new turn
 *     admitted; a Temporal outage fails closed with 503);
 *   - a key Stop already cancelled before start is refused and starts nothing;
 *   - a client that disconnects during the pre-stream work gets its turn
 *     cancelled (DISCONNECT_BEFORE_START) and no workflow is started;
 *   - the workflow receives the turnId, and the `completed` event reports
 *     the run's domain status ("cancelled") and its limit signals;
 *   - a reattach to a turn that already ended returns its stored result.
 *
 * Harness mirrors orchestrator-resume-no-rebill.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	getSession: vi.fn(),
	getAIModelWithMetadata: vi.fn(),
	trackUsage: vi.fn(),
	getTemporalClient: vi.fn(),
	getHandle: vi.fn(),
	start: vi.fn(),
	hasOrganizationTie: vi.fn(),
	conversationFindFirst: vi.fn(),
	admitConversationTurn: vi.fn(),
	markConversationTurnActive: vi.fn(),
	markConversationTurnStartFailed: vi.fn(),
	abandonConversationTurnStart: vi.fn(),
	finalizeOrphanedConversationTurn: vi.fn(),
	memberFindFirst: vi.fn(),
	requestConversationTurnCancel: vi.fn(),
	finalizeConversationTurn: vi.fn(),
	getConversationTurnForExecution: vi.fn(),
	getConversationTurnOwnerForExecution: vi.fn(),
	getConversationTurnByKey: vi.fn(),
}));

vi.mock("@saas/auth/lib/server", () => ({
	getSession: () => m.getSession(),
}));
vi.mock("@repo/ai", () => ({
	getAIModelWithMetadata: (...args: unknown[]) =>
		m.getAIModelWithMetadata(...args),
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
	getTemporalClient: () => m.getTemporalClient(),
}));
vi.mock("@repo/database", () => ({
	CARRIED_OVER_MARKER_PREFIX: "[carried-over]",
	db: {
		agentConversation: { findFirst: m.conversationFindFirst },
		member: { findFirst: m.memberFindFirst },
		aiChat: { findFirst: vi.fn(async () => null) },
	},
	getConversationWorkspaces: vi.fn(async () => []),
	getConversationProject: vi.fn(async () => null),
	hasProjectAccess: vi.fn(async () => true),
	hasOrganizationTie: (...args: unknown[]) => m.hasOrganizationTie(...args),
	admitConversationTurn: (...args: unknown[]) =>
		m.admitConversationTurn(...args),
	markConversationTurnActive: (...args: unknown[]) =>
		m.markConversationTurnActive(...args),
	markConversationTurnStartFailed: (...args: unknown[]) =>
		m.markConversationTurnStartFailed(...args),
	abandonConversationTurnStart: (...args: unknown[]) =>
		m.abandonConversationTurnStart(...args),
	finalizeOrphanedConversationTurn: (...args: unknown[]) =>
		m.finalizeOrphanedConversationTurn(...args),
	requestConversationTurnCancel: (...args: unknown[]) =>
		m.requestConversationTurnCancel(...args),
	finalizeConversationTurn: (...args: unknown[]) =>
		m.finalizeConversationTurn(...args),
	getConversationTurnForExecution: (...args: unknown[]) =>
		m.getConversationTurnForExecution(...args),
	getConversationTurnOwnerForExecution: (...args: unknown[]) =>
		m.getConversationTurnOwnerForExecution(...args),
	getConversationTurnByKey: (...args: unknown[]) =>
		m.getConversationTurnByKey(...args),
}));

const USER_ID = "user-turn-1";
const ORG_ID = "org-example-1";
const CONVERSATION_ID = "conversation-example-1";
const KEY = "0f8fad5b-d9cb-469f-a165-70867728950e";
const EXEC_A = "orch-aaaaaaaa-0000-4000-8000-000000000001";
const EXEC_B = "orch-bbbbbbbb-0000-4000-8000-000000000002";
/** Held only by the request that created the turn (admission `created`). */
const START_TOKEN = "start-token-of-request-a";

function turnRow(overrides: Record<string, unknown> = {}) {
	return {
		id: "turn-1",
		userId: USER_ID,
		organizationId: ORG_ID,
		conversationId: CONVERSATION_ID,
		scopeConversationId: CONVERSATION_ID,
		clientRequestKey: KEY,
		executionId: EXEC_A,
		generation: 1,
		executionMode: "balanced",
		status: "START_PENDING",
		cancelSource: null,
		cancelRequestedAt: null,
		terminalAt: null,
		terminalReason: null,
		responseText: null,
		limitSignalSummary: null,
		startToken: null,
		createdAt: new Date(),
		updatedAt: new Date(),
		...overrides,
	};
}

async function readEvents(response: Response) {
	const text = await response.text();
	return text
		.split("\n")
		.filter((line) => line.startsWith("data: "))
		.map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
}

function request(body: Record<string, unknown>, signal?: AbortSignal) {
	return { json: async () => body, signal } as never;
}

/** A workflow handle that is already COMPLETED with `result`. */
function completedHandle(
	workflowId: string,
	result: Record<string, unknown> = {
		status: "completed",
		response: "done",
		toolCalls: [],
		totalDurationMs: 1,
	},
) {
	return {
		workflowId,
		describe: vi.fn(async () => ({
			status: { name: "COMPLETED" },
			memo: { userId: USER_ID, organizationId: ORG_ID },
		})),
		query: vi.fn(async () => {
			throw new Error("workflow closed");
		}),
		result: vi.fn(async () => result),
		cancel: vi.fn(),
	};
}

async function post(body: Record<string, unknown>, signal?: AbortSignal) {
	const { POST } = await import(
		"../../app/api/agents/fabric-ai/orchestrator-temporal/stream/route"
	);
	return POST(request(body, signal));
}

function newTurnBody(overrides: Record<string, unknown> = {}) {
	return {
		message: "What is the launch date?",
		organizationId: ORG_ID,
		conversationId: CONVERSATION_ID,
		clientRequestKey: KEY,
		...overrides,
	};
}

describe("POST orchestrator-temporal/stream — turn admission", () => {
	const originalCacheHost = process.env.CACHE_HOST;
	const originalRedisUrl = process.env.REDIS_URL;

	beforeEach(() => {
		vi.clearAllMocks();
		delete process.env.CACHE_HOST;
		delete process.env.REDIS_URL;
		m.getSession.mockResolvedValue({
			user: { id: USER_ID },
			session: { activeOrganizationId: ORG_ID },
		});
		m.getAIModelWithMetadata.mockResolvedValue({
			trackUsage: m.trackUsage,
		});
		m.hasOrganizationTie.mockResolvedValue(true);
		m.memberFindFirst.mockResolvedValue({ id: "member-1" });
		m.abandonConversationTurnStart.mockResolvedValue(true);
		m.finalizeOrphanedConversationTurn.mockResolvedValue({
			outcome: "finalized",
			status: "FAILED",
		});
		m.conversationFindFirst.mockResolvedValue({
			id: CONVERSATION_ID,
			organizationId: ORG_ID,
			parentConversationId: null,
			carriedOverSummary: null,
		});
		m.admitConversationTurn.mockImplementation(
			async (args: { executionId: string }) => ({
				outcome: "created",
				turn: turnRow({
					executionId: args.executionId,
					startToken: START_TOKEN,
				}),
			}),
		);
		m.markConversationTurnActive.mockResolvedValue(true);
		m.markConversationTurnStartFailed.mockResolvedValue(true);
		m.requestConversationTurnCancel.mockResolvedValue({
			outcome: "recorded",
			turn: turnRow({ status: "CANCEL_REQUESTED" }),
		});
		m.finalizeConversationTurn.mockResolvedValue({
			outcome: "finalized",
			status: "FAILED",
		});
		m.getConversationTurnForExecution.mockResolvedValue(null);
		m.getConversationTurnOwnerForExecution.mockResolvedValue(null);
		m.getConversationTurnByKey.mockResolvedValue(null);
		m.start.mockImplementation(
			async (_name: string, opts: { workflowId: string }) =>
				completedHandle(opts.workflowId),
		);
		m.getHandle.mockImplementation((id: string) => completedHandle(id));
		m.getTemporalClient.mockResolvedValue({
			workflow: { start: m.start, getHandle: m.getHandle },
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

	it("admits the turn and starts the workflow with its executionId and turnId", async () => {
		const response = await post(newTurnBody());
		expect(response.status).toBe(200);
		await readEvents(response);

		expect(m.admitConversationTurn).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: USER_ID,
				organizationId: ORG_ID,
				conversationId: CONVERSATION_ID,
				clientRequestKey: KEY,
			}),
		);
		expect(m.start).toHaveBeenCalledTimes(1);
		const [, options] = m.start.mock.calls[0] as [
			string,
			{
				workflowId: string;
				args: [Record<string, unknown>];
				memo: Record<string, unknown>;
			},
		];
		const admitted = m.admitConversationTurn.mock.calls[0]?.[0] as {
			executionId: string;
		};
		expect(options.workflowId).toBe(admitted.executionId);
		expect(options.args[0]).toMatchObject({
			executionId: admitted.executionId,
			turnId: "turn-1",
			turnContractVersion: 1,
			organizationId: ORG_ID,
		});
		expect(options.memo).toMatchObject({
			userId: USER_ID,
			organizationId: ORG_ID,
		});
		expect(m.markConversationTurnActive).toHaveBeenCalledWith({
			turnId: "turn-1",
			executionId: admitted.executionId,
		});
	});

	it("refuses with 403 when neither the body nor the session names an organization", async () => {
		m.getSession.mockResolvedValue({
			user: { id: USER_ID },
			session: { activeOrganizationId: null },
		});
		const response = await post(newTurnBody({ organizationId: undefined }));
		expect(response.status).toBe(403);
		expect(m.admitConversationTurn).not.toHaveBeenCalled();
		expect(m.start).not.toHaveBeenCalled();
	});

	it("refuses with 403 an organization the caller is not a member of", async () => {
		m.memberFindFirst.mockResolvedValue(null);
		const response = await post(
			newTurnBody({ organizationId: "org-not-mine" }),
		);
		expect(response.status).toBe(403);
		expect(m.memberFindFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { userId: USER_ID, organizationId: "org-not-mine" },
			}),
		);
		expect(m.admitConversationTurn).not.toHaveBeenCalled();
		expect(m.start).not.toHaveBeenCalled();
	});

	it("refuses with 403 an explicitly named conversation the caller cannot access, instead of discarding it", async () => {
		m.conversationFindFirst.mockResolvedValue(null);
		const response = await post(newTurnBody());
		expect(response.status).toBe(403);
		expect(m.admitConversationTurn).not.toHaveBeenCalled();
		expect(m.start).not.toHaveBeenCalled();
	});

	it("answers 409 with the live turn's executionId when the conversation already has a running turn", async () => {
		m.admitConversationTurn.mockResolvedValue({
			outcome: "conflict",
			turn: turnRow({
				status: "ACTIVE",
				executionId: EXEC_B,
				clientRequestKey: "other-key",
			}),
		});
		m.getHandle.mockImplementation((id: string) => ({
			...completedHandle(id),
			describe: vi.fn(async () => ({
				status: { name: "RUNNING" },
				memo: { userId: USER_ID, organizationId: ORG_ID },
			})),
		}));

		const response = await post(newTurnBody());
		expect(response.status).toBe(409);
		const body = await response.json();
		expect(body).toMatchObject({
			code: "TURN_IN_PROGRESS",
			executionId: EXEC_B,
		});
		expect(m.start).not.toHaveBeenCalled();
		expect(m.finalizeConversationTurn).not.toHaveBeenCalled();
	});

	it("reconciles a conflicting turn whose workflow is gone, then admits the new turn", async () => {
		m.admitConversationTurn
			.mockResolvedValueOnce({
				outcome: "conflict",
				turn: turnRow({
					id: "turn-orphan",
					status: "ACTIVE",
					executionId: EXEC_B,
					clientRequestKey: "other-key",
				}),
			})
			.mockImplementation(async (args: { executionId: string }) => ({
				outcome: "created",
				turn: turnRow({
					executionId: args.executionId,
					startToken: START_TOKEN,
				}),
			}));
		const notFound = Object.assign(new Error("workflow not found"), {
			name: "WorkflowNotFoundError",
		});
		m.getHandle.mockImplementation((id: string) =>
			id === EXEC_B
				? {
						...completedHandle(id),
						describe: vi.fn(async () => {
							throw notFound;
						}),
					}
				: completedHandle(id),
		);

		const response = await post(newTurnBody());
		expect(response.status).toBe(200);
		await readEvents(response);
		// A compare-and-set on the state admission observed.
		expect(m.finalizeOrphanedConversationTurn).toHaveBeenCalledWith(
			expect.objectContaining({
				turnId: "turn-orphan",
				executionId: EXEC_B,
				userId: USER_ID,
				organizationId: ORG_ID,
				observedStatus: "ACTIVE",
			}),
		);
		expect(m.admitConversationTurn).toHaveBeenCalledTimes(2);
		expect(m.start).toHaveBeenCalledTimes(1);
	});

	it("fails closed with a retryable 503 when Temporal cannot be reached to reconcile a conflicting turn", async () => {
		m.admitConversationTurn.mockResolvedValue({
			outcome: "conflict",
			turn: turnRow({ status: "ACTIVE", executionId: EXEC_B }),
		});
		m.getHandle.mockImplementation((id: string) => ({
			...completedHandle(id),
			describe: vi.fn(async () => {
				throw Object.assign(
					new Error("14 UNAVAILABLE: connect failed"),
					{
						code: 14,
					},
				);
			}),
		}));

		const response = await post(newTurnBody());
		expect(response.status).toBe(503);
		expect(m.start).not.toHaveBeenCalled();
		expect(m.finalizeConversationTurn).not.toHaveBeenCalled();
	});

	it("attaches an idempotent retry to the turn it already started instead of starting a second workflow", async () => {
		m.admitConversationTurn.mockResolvedValue({
			outcome: "existing",
			turn: turnRow({ status: "ACTIVE", executionId: EXEC_A }),
		});

		const response = await post(newTurnBody());
		expect(response.status).toBe(200);
		const events = await readEvents(response);

		expect(m.start).not.toHaveBeenCalled();
		expect(m.getHandle).toHaveBeenCalledWith(EXEC_A);
		expect(events.find((e) => e.type === "started")).toMatchObject({
			executionId: EXEC_A,
			resumed: true,
		});
		// A retry is not a new turn: it is not billed again.
		expect(m.trackUsage).not.toHaveBeenCalled();
	});

	it("a retry of a turn another request is still starting waits and attaches; it never starts the workflow itself", async () => {
		// The first request's start response was lost (or it is still
		// starting); the retry is not the turn's start owner.
		m.admitConversationTurn.mockResolvedValue({
			outcome: "existing",
			turn: turnRow({ status: "START_PENDING", executionId: EXEC_A }),
		});
		m.getConversationTurnForExecution.mockResolvedValue(
			turnRow({ status: "START_PENDING", executionId: EXEC_A }),
		);

		const response = await post(newTurnBody());
		const events = await readEvents(response);

		expect(m.start).not.toHaveBeenCalled();
		expect(m.getHandle).toHaveBeenCalledWith(EXEC_A);
		expect(events.map((e) => e.type)).toContain("completed");
		expect(events.map((e) => e.type)).not.toContain("error");
		expect(m.abandonConversationTurnStart).not.toHaveBeenCalled();
	});

	it("refuses a key Stop already cancelled before start, and starts nothing", async () => {
		m.admitConversationTurn.mockResolvedValue({
			outcome: "existing",
			turn: turnRow({
				status: "CANCELLED",
				executionId: null,
				generation: null,
				cancelSource: "CANCELLED_BEFORE_START",
			}),
		});
		const response = await post(newTurnBody());
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({ code: "TURN_CANCELLED" });
		expect(m.start).not.toHaveBeenCalled();
	});

	it("records a cancel and starts no workflow when the client disconnects during pre-stream work", async () => {
		const controller = new AbortController();
		m.getAIModelWithMetadata.mockImplementation(async () => {
			controller.abort();
			return { trackUsage: m.trackUsage };
		});

		await post(newTurnBody(), controller.signal);

		// The start owner (it holds the token) cancels its own turn.
		expect(m.abandonConversationTurnStart).toHaveBeenCalledWith(
			expect.objectContaining({
				turnId: "turn-1",
				startToken: START_TOKEN,
				cancelled: true,
			}),
		);
		expect(m.start).not.toHaveBeenCalled();
	});

	it("ends the admitted turn FAILED when the request is refused before the start, so it does not hold the conversation", async () => {
		m.getAIModelWithMetadata.mockRejectedValue(
			new Error("No AI provider configured"),
		);
		const response = await post(newTurnBody());
		expect(response.status).toBe(400);
		expect(m.start).not.toHaveBeenCalled();
		expect(m.abandonConversationTurnStart).toHaveBeenCalledWith(
			expect.objectContaining({
				turnId: "turn-1",
				startToken: START_TOKEN,
				cancelled: false,
			}),
		);
	});

	it("reports a cancelled run as `completed` with status 'cancelled' and forwards its limit signals", async () => {
		const limitSignals = [
			{
				kind: "provider_rate_limit",
				provider: "example",
				message: "slow down",
			},
		];
		m.start.mockImplementation(
			async (_name: string, opts: { workflowId: string }) =>
				completedHandle(opts.workflowId, {
					status: "cancelled",
					response: "partial answer",
					toolCalls: [],
					totalDurationMs: 1,
					limitSignals,
					handoffRecommended: { reason: "x", summary: "y" },
				}),
		);

		const events = await readEvents(await post(newTurnBody()));
		const completed = events.find((e) => e.type === "completed");
		expect(completed).toMatchObject({
			status: "cancelled",
			response: "partial answer",
			limitSignals,
		});
		// A cancelled turn offers no "continue in new chat".
		expect(completed?.handoffRecommended).toBeUndefined();
		expect(events.map((e) => e.type)).not.toContain("error");
	});

	it("returns the stored result when reattaching to a turn that already ended", async () => {
		m.getConversationTurnForExecution.mockResolvedValue(
			turnRow({
				status: "CANCELLED",
				executionId: EXEC_A,
				responseText: "partial answer",
				terminalAt: new Date(),
			}),
		);

		const events = await readEvents(
			await post({ executionId: EXEC_A, organizationId: ORG_ID }),
		);

		expect(m.getHandle).not.toHaveBeenCalled();
		expect(events.find((e) => e.type === "completed")).toMatchObject({
			status: "cancelled",
			response: "partial answer",
		});
	});

	it("refuses a reattach to another user's turn", async () => {
		m.getConversationTurnForExecution.mockResolvedValue(null);
		m.getConversationTurnOwnerForExecution.mockResolvedValue({
			userId: "user-someone-else",
			organizationId: ORG_ID,
		});

		const response = await post({
			executionId: EXEC_A,
			organizationId: ORG_ID,
		});
		const events =
			response.status === 200 ? await readEvents(response) : [];
		expect(
			response.status === 403 || events.some((e) => e.type === "error"),
		).toBe(true);
		expect(events.map((e) => e.type)).not.toContain("completed");
	});

	it("refuses a reattach to a run whose memo carries no owner (fails closed)", async () => {
		m.getHandle.mockImplementation((id: string) => ({
			...completedHandle(id),
			describe: vi.fn(async () => ({
				status: { name: "COMPLETED" },
				memo: {},
			})),
		}));

		const response = await post({
			executionId: EXEC_A,
			organizationId: ORG_ID,
		});
		const events =
			response.status === 200 ? await readEvents(response) : [];
		expect(
			response.status === 403 || events.some((e) => e.type === "error"),
		).toBe(true);
		expect(events.map((e) => e.type)).not.toContain("completed");
	});

	// ---------------------------------------------------------------------
	// Review round 1
	// ---------------------------------------------------------------------

	/** A Temporal client `ServiceError` wrapping a gRPC status, as the SDK throws it. */
	function serviceError(code: number, message: string) {
		const grpc = Object.assign(new Error(`${code} ${message}`), {
			code,
			details: message,
			metadata: {},
		});
		return Object.assign(new Error("Failed to start Workflow"), {
			name: "ServiceError",
			cause: grpc,
		});
	}

	it("R1-5: keeps the turn START_PENDING when the start fails ambiguously (ServiceError wrapping UNAVAILABLE)", async () => {
		m.start.mockRejectedValue(
			serviceError(14, "UNAVAILABLE: connection reset"),
		);
		await readEvents(await post(newTurnBody()));
		expect(m.abandonConversationTurnStart).not.toHaveBeenCalled();
	});

	it("R2-F2: an ambiguous start is reported as a retryable start_pending event, never as an error", async () => {
		m.start.mockRejectedValue(
			serviceError(14, "UNAVAILABLE: connection reset"),
		);
		const events = await readEvents(await post(newTurnBody()));
		const types = events.map((e) => e.type);
		expect(types).not.toContain("error");
		expect(types).not.toContain("completed");
		const pending = events.find((e) => e.type === "start_pending");
		// The exact shape the client's retry keys on (see
		// useOrchestratorStream.turn.test.ts, "R2-F2").
		expect(pending).toEqual({
			type: "start_pending",
			retryable: true,
			executionId: expect.stringMatching(/^orch-/),
		});
	});

	it("R2-F2: a definite start failure is still an error event", async () => {
		m.start.mockRejectedValue(
			serviceError(3, "INVALID_ARGUMENT: bad input"),
		);
		const events = await readEvents(await post(newTurnBody()));
		const types = events.map((e) => e.type);
		expect(types).toContain("error");
		expect(types).not.toContain("start_pending");
	});

	it("R1-5: marks the turn FAILED when the start definitely failed (ServiceError wrapping INVALID_ARGUMENT)", async () => {
		m.start.mockRejectedValue(
			serviceError(3, "INVALID_ARGUMENT: bad input"),
		);
		await readEvents(await post(newTurnBody()));
		expect(m.abandonConversationTurnStart).toHaveBeenCalledWith(
			expect.objectContaining({
				turnId: "turn-1",
				startToken: START_TOKEN,
			}),
		);
	});

	it("a plain NOT_FOUND start refusal is definite: the turn is abandoned and reported as an error", async () => {
		m.start.mockRejectedValue(serviceError(5, "NOT_FOUND: namespace"));
		const events = await readEvents(await post(newTurnBody()));
		const types = events.map((e) => e.type);
		expect(types).toContain("error");
		expect(types).not.toContain("start_pending");
		expect(m.abandonConversationTurnStart).toHaveBeenCalledWith(
			expect.objectContaining({
				turnId: "turn-1",
				startToken: START_TOKEN,
			}),
		);
	});

	it("R1-10: starts with REJECT_DUPLICATE and attaches when the execution already exists", async () => {
		await readEvents(await post(newTurnBody()));
		const [, options] = m.start.mock.calls[0] as [
			string,
			{ workflowIdReusePolicy?: string },
		];
		expect(options.workflowIdReusePolicy).toBe("REJECT_DUPLICATE");
	});

	it("R1-10: a start that finds the execution already there (even closed) attaches to it, not a new execution", async () => {
		m.admitConversationTurn.mockResolvedValue({
			outcome: "created",
			turn: turnRow({
				status: "START_PENDING",
				executionId: EXEC_A,
				startToken: START_TOKEN,
			}),
		});
		// With REJECT_DUPLICATE, Temporal refuses a second execution for an
		// id whose first execution has already closed.
		m.start.mockRejectedValue(
			Object.assign(new Error("Workflow execution already started"), {
				name: "WorkflowExecutionAlreadyStartedError",
			}),
		);
		const events = await readEvents(await post(newTurnBody()));
		expect(m.getHandle).toHaveBeenCalledWith(EXEC_A);
		expect(events.find((e) => e.type === "completed")).toMatchObject({
			response: "done",
		});
	});

	it("R1-4: a save_reuse chat start creates no turn and passes no turnId (legacy behaviour)", async () => {
		const response = await post(
			newTurnBody({ executionMode: "save_reuse" }),
		);
		await readEvents(response);
		expect(m.admitConversationTurn).not.toHaveBeenCalled();
		expect(m.start).toHaveBeenCalledTimes(1);
		const [, options] = m.start.mock.calls[0] as [
			string,
			{ args: [Record<string, unknown>]; workflowId: string },
		];
		expect(options.args[0]).not.toHaveProperty("turnId");
		expect(options.args[0].executionMode).toBe("save_reuse");
		expect(options.workflowId).toMatch(/^orch-[a-f0-9-]{36}$/);
	});

	it("R1-4: a weave chat start creates no turn either", async () => {
		await readEvents(await post(newTurnBody({ executionMode: "weave" })));
		expect(m.admitConversationTurn).not.toHaveBeenCalled();
		const [, options] = m.start.mock.calls[0] as [
			string,
			{ args: [Record<string, unknown>] },
		];
		expect(options.args[0]).not.toHaveProperty("turnId");
	});

	it("R1-9: a result-fetch outage after describe() says COMPLETED does not terminalize the conflicting turn", async () => {
		m.admitConversationTurn.mockResolvedValue({
			outcome: "conflict",
			turn: turnRow({ status: "ACTIVE", executionId: EXEC_B }),
		});
		m.getHandle.mockImplementation((id: string) => ({
			...completedHandle(id),
			result: vi.fn(async () => {
				throw serviceError(14, "UNAVAILABLE: connection reset");
			}),
		}));
		const response = await post(newTurnBody());
		expect(response.status).toBe(503);
		expect(m.finalizeConversationTurn).not.toHaveBeenCalled();
		expect(m.start).not.toHaveBeenCalled();
	});

	it("R1-9: a proven execution failure from result() still terminalizes the turn FAILED", async () => {
		m.admitConversationTurn
			.mockResolvedValueOnce({
				outcome: "conflict",
				turn: turnRow({ status: "ACTIVE", executionId: EXEC_B }),
			})
			.mockImplementation(async (args: { executionId: string }) => ({
				outcome: "created",
				turn: turnRow({
					executionId: args.executionId,
					startToken: START_TOKEN,
				}),
			}));
		m.getHandle.mockImplementation((id: string) => ({
			...completedHandle(id),
			result: vi.fn(async () => {
				throw Object.assign(new Error("Workflow execution failed"), {
					name: "WorkflowFailedError",
				});
			}),
		}));
		const response = await post(newTurnBody());
		expect(response.status).toBe(200);
		await readEvents(response);
		expect(m.finalizeConversationTurn).toHaveBeenCalledWith(
			expect.objectContaining({ executionId: EXEC_B, outcome: "FAILED" }),
		);
	});

	it("R1-11: refuses a reattach that names a different conversation than the turn's", async () => {
		m.getConversationTurnForExecution.mockResolvedValue(
			turnRow({ status: "ACTIVE", executionId: EXEC_A }),
		);
		m.conversationFindFirst.mockResolvedValue({ id: "conversation-other" });
		const response = await post({
			executionId: EXEC_A,
			organizationId: ORG_ID,
			conversationId: "conversation-other",
		});
		expect(response.status).toBe(403);
		expect(m.getHandle).not.toHaveBeenCalled();
	});

	describe("R1-8: reattaching to a turn whose workflow has not started yet", () => {
		let timing: { waitMs: number; pollMs: number };
		let saved: { waitMs: number; pollMs: number };
		beforeEach(async () => {
			const admission = await import(
				"../../app/api/agents/fabric-ai/orchestrator-temporal/turn-admission"
			);
			timing = admission.PENDING_ATTACH_TIMING;
			saved = { ...timing };
			timing.waitMs = 300;
			timing.pollMs = 20;
			m.getConversationTurnForExecution.mockResolvedValue(
				turnRow({ status: "START_PENDING", executionId: EXEC_A }),
			);
		});
		afterEach(() => {
			timing.waitMs = saved.waitMs;
			timing.pollMs = saved.pollMs;
		});

		const notFound = () =>
			Object.assign(new Error("workflow not found"), {
				name: "WorkflowNotFoundError",
			});

		it("waits for the workflow to appear, then attaches", async () => {
			let describes = 0;
			m.getHandle.mockImplementation((id: string) => ({
				...completedHandle(id),
				describe: vi.fn(async () => {
					describes++;
					if (describes <= 2) {
						throw notFound();
					}
					return {
						status: { name: "COMPLETED" },
						memo: { userId: USER_ID, organizationId: ORG_ID },
					};
				}),
			}));
			const response = await post({
				executionId: EXEC_A,
				organizationId: ORG_ID,
			});
			expect(response.status).toBe(200);
			const events = await readEvents(response);
			expect(events.map((e) => e.type)).toContain("completed");
			expect(events.map((e) => e.type)).not.toContain("error");
		});

		it("R2-3: terminalizes an abandoned turn past the orphan grace period and returns its terminal result", async () => {
			const abandoned = turnRow({
				status: "START_PENDING",
				executionId: EXEC_A,
				createdAt: new Date(Date.now() - 5 * 60_000),
			});
			m.getConversationTurnForExecution
				.mockReset()
				.mockResolvedValueOnce(abandoned) // reattach lookup
				.mockResolvedValueOnce(abandoned) // re-read after the wait
				.mockResolvedValue(
					turnRow({
						status: "FAILED",
						executionId: EXEC_A,
						terminalReason: "reconciled: workflow not found",
						terminalAt: new Date(),
					}),
				);
			m.getHandle.mockImplementation((id: string) => ({
				...completedHandle(id),
				describe: vi.fn(async () => {
					throw notFound();
				}),
			}));
			const response = await post({
				executionId: EXEC_A,
				organizationId: ORG_ID,
			});
			expect(response.status).toBe(200);
			const events = await readEvents(response);
			expect(m.finalizeOrphanedConversationTurn).toHaveBeenCalledWith(
				expect.objectContaining({
					executionId: EXEC_A,
					observedStatus: "START_PENDING",
				}),
			);
			expect(events.find((e) => e.type === "error")).toMatchObject({
				message: "reconciled: workflow not found",
			});
		});

		it("R2-3: returns the stored result when the turn was cancelled during the wait", async () => {
			m.getConversationTurnForExecution
				.mockReset()
				.mockResolvedValueOnce(
					turnRow({ status: "START_PENDING", executionId: EXEC_A }),
				)
				.mockResolvedValue(
					turnRow({
						status: "CANCELLED",
						executionId: EXEC_A,
						responseText: "partial answer",
						terminalAt: new Date(),
					}),
				);
			m.getHandle.mockImplementation((id: string) => ({
				...completedHandle(id),
				describe: vi.fn(async () => {
					throw notFound();
				}),
			}));
			const response = await post({
				executionId: EXEC_A,
				organizationId: ORG_ID,
			});
			expect(response.status).toBe(200);
			const events = await readEvents(response);
			expect(events.find((e) => e.type === "completed")).toMatchObject({
				status: "cancelled",
				response: "partial answer",
			});
			expect(m.finalizeConversationTurn).not.toHaveBeenCalled();
		});

		it("R2-3: a Temporal transport error while waiting stays a retryable 503", async () => {
			m.getHandle.mockImplementation((id: string) => ({
				...completedHandle(id),
				describe: vi.fn(async () => {
					throw serviceError(14, "UNAVAILABLE: connection reset");
				}),
			}));
			const response = await post({
				executionId: EXEC_A,
				organizationId: ORG_ID,
			});
			expect(response.status).toBe(503);
			expect(m.finalizeConversationTurn).not.toHaveBeenCalled();
		});

		it("answers a retryable 409 TURN_PENDING when it never appears within the bound, without failing the turn", async () => {
			m.getHandle.mockImplementation((id: string) => ({
				...completedHandle(id),
				describe: vi.fn(async () => {
					throw notFound();
				}),
			}));
			const response = await post({
				executionId: EXEC_A,
				organizationId: ORG_ID,
			});
			expect(response.status).toBe(409);
			expect(response.headers.get("Retry-After")).toBeTruthy();
			expect(await response.json()).toMatchObject({
				code: "TURN_PENDING",
				executionId: EXEC_A,
			});
			expect(m.abandonConversationTurnStart).not.toHaveBeenCalled();
			expect(m.finalizeConversationTurn).not.toHaveBeenCalled();
		});
	});

	it("R2-2: refuses a save_reuse start in another user's conversation (no turn path either)", async () => {
		m.conversationFindFirst.mockResolvedValue(null);
		const response = await post(
			newTurnBody({
				executionMode: "save_reuse",
				conversationId: "conv-other-user",
			}),
		);
		expect(response.status).toBe(403);
		expect(m.start).not.toHaveBeenCalled();
		expect(m.conversationFindFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					id: "conv-other-user",
					userId: USER_ID,
					organizationId: ORG_ID,
				},
			}),
		);
	});

	// ---------------------------------------------------------------------
	// Fresh review
	// ---------------------------------------------------------------------

	it("F-4: a duplicate request for a turn another request already promoted neither starts it nor cancels it when it disconnects", async () => {
		// Request B for the same key. A created the turn, started it and
		// marked it ACTIVE; B only ever sees it without the start token.
		m.admitConversationTurn.mockResolvedValue({
			outcome: "existing",
			turn: turnRow({ status: "START_PENDING", executionId: EXEC_A }),
		});
		m.getConversationTurnForExecution.mockResolvedValue(
			turnRow({ status: "ACTIVE", executionId: EXEC_A }),
		);
		const controller = new AbortController();
		controller.abort();

		await post(newTurnBody(), controller.signal);

		expect(m.start).not.toHaveBeenCalled();
		expect(m.abandonConversationTurnStart).not.toHaveBeenCalled();
		expect(m.requestConversationTurnCancel).not.toHaveBeenCalled();
		expect(m.markConversationTurnStartFailed).not.toHaveBeenCalled();
	});

	it("F-4: a duplicate pending request whose wait finds no workflow does not terminalize the turn the other request is starting", async () => {
		const timing = (
			await import(
				"../../app/api/agents/fabric-ai/orchestrator-temporal/turn-admission"
			)
		).PENDING_ATTACH_TIMING;
		const saved = { ...timing };
		timing.waitMs = 100;
		timing.pollMs = 20;
		try {
			m.admitConversationTurn.mockResolvedValue({
				outcome: "existing",
				turn: turnRow({ status: "START_PENDING", executionId: EXEC_A }),
			});
			// Fresh (within the orphan grace period): still being started.
			m.getConversationTurnForExecution.mockResolvedValue(
				turnRow({ status: "START_PENDING", executionId: EXEC_A }),
			);
			m.getHandle.mockImplementation((id: string) => ({
				...completedHandle(id),
				describe: vi.fn(async () => {
					throw Object.assign(new Error("workflow not found"), {
						name: "WorkflowNotFoundError",
					});
				}),
			}));
			const response = await post(newTurnBody());
			expect(response.status).toBe(409);
			expect(await response.json()).toMatchObject({
				code: "TURN_PENDING",
			});
			expect(m.abandonConversationTurnStart).not.toHaveBeenCalled();
			expect(m.finalizeOrphanedConversationTurn).not.toHaveBeenCalled();
			expect(m.start).not.toHaveBeenCalled();
		} finally {
			timing.waitMs = saved.waitMs;
			timing.pollMs = saved.pollMs;
		}
	});

	it("F-5: a conflicting turn the starter promoted after the NotFound observation is not finalized, and the request is refused, not admitted", async () => {
		m.admitConversationTurn.mockResolvedValue({
			outcome: "conflict",
			turn: turnRow({
				id: "turn-racing",
				status: "START_PENDING",
				executionId: EXEC_B,
				clientRequestKey: "other-key",
				createdAt: new Date(Date.now() - 5 * 60_000),
			}),
		});
		m.getHandle.mockImplementation((id: string) => ({
			...completedHandle(id),
			describe: vi.fn(async () => {
				throw Object.assign(new Error("workflow not found"), {
					name: "WorkflowNotFoundError",
				});
			}),
		}));
		// The compare-and-set finds the turn changed (now ACTIVE).
		m.finalizeOrphanedConversationTurn.mockResolvedValue({
			outcome: "changed",
		});

		const response = await post(newTurnBody());
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({
			code: "TURN_IN_PROGRESS",
			executionId: EXEC_B,
		});
		expect(m.finalizeConversationTurn).not.toHaveBeenCalled();
		expect(m.start).not.toHaveBeenCalled();
		expect(m.admitConversationTurn).toHaveBeenCalledTimes(1);
	});

	it("F-7: a project guest (an organization tie but no membership) is refused at start, as clarify refuses them", async () => {
		m.memberFindFirst.mockResolvedValue(null);
		m.hasOrganizationTie.mockResolvedValue(true);
		const response = await post(newTurnBody());
		expect(response.status).toBe(403);
		expect(m.admitConversationTurn).not.toHaveBeenCalled();
		expect(m.start).not.toHaveBeenCalled();
	});
});
