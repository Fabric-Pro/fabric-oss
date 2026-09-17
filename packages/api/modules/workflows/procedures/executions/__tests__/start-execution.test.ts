/**
 * Starting a manual run.
 *
 * Three things here are easy to get wrong and expensive when wrong:
 *
 * - Refusing an invalid graph has to happen *before* the execution row exists,
 *   or the run history fills with rows that never ran.
 * - The editor can post unsaved nodes/edges. Those are what must be validated
 *   and executed — validating the stored graph and running the posted one (or
 *   the reverse) is a silent correctness hole.
 * - When Temporal will not take the run, the row must reach a terminal state.
 *   Nothing sweeps PENDING executions, so a row left as created reads as
 *   "queued" in the UI forever rather than "never started".
 * - A duplicate submission (double-click, browser retry) carrying the same
 *   client idempotency key must resolve to the run already started — before
 *   the tenant's cap is consulted, and even when the first start's outcome
 *   was never confirmed — and the procedure must spend the caller's workflow
 *   rate-limit budget before it does any database work.
 * - The key is released only in the write that records a CONFIRMED
 *   not-started run. An unconfirmed start is a resolved "unconfirmed"
 *   result, never a thrown error or a success-shaped "started".
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	accessMock,
	getWorkflowMock,
	reserveMock,
	createExecutionIdempotentMock,
	resolveLimitMock,
	executionUpdateMock,
	markRunningMock,
	temporalAvailableMock,
	startMock,
	describeMock,
	enforceWorkflowRateLimitMock,
	useMocks,
} = vi.hoisted(() => ({
	accessMock: vi.fn(),
	getWorkflowMock: vi.fn(),
	reserveMock: vi.fn(),
	createExecutionIdempotentMock: vi.fn(),
	resolveLimitMock: vi.fn(),
	executionUpdateMock: vi.fn(),
	markRunningMock: vi.fn(),
	temporalAvailableMock: vi.fn(),
	startMock: vi.fn(),
	describeMock: vi.fn(),
	enforceWorkflowRateLimitMock: vi.fn(),
	/** Every middleware handed to `.use()` on the builder, in mount order. */
	useMocks: [] as unknown[],
}));

vi.mock("@repo/database", () => ({
	db: { workflowExecution: { update: executionUpdateMock } },
	createWorkflowExecutionIdempotent: createExecutionIdempotentMock,
	getWorkflowById: getWorkflowMock,
	hasWorkflowAccess: accessMock,
	markExecutionRunningIfPending: markRunningMock,
	// Mirrors the real helper (unit-tested in @repo/database): the key moves
	// out of the matched path into `releasedIdempotencyKey`.
	releasedIdempotencyTriggerInput: (input: unknown) => {
		if (
			!input ||
			typeof input !== "object" ||
			!("idempotencyKey" in input)
		) {
			return undefined;
		}
		const { idempotencyKey, ...rest } = input as Record<string, unknown>;
		return { ...rest, releasedIdempotencyKey: idempotencyKey };
	},
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: async () => ({
		workflow: {
			start: startMock,
			getHandle: () => ({ describe: describeMock }),
		},
	}),
	isTemporalAvailable: temporalAvailableMock,
}));

vi.mock("../../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: (o: unknown) => o,
}));

// The row is created inside the capacity reservation; the mock returns the
// row the way the real helper does.
vi.mock("../../../lib/execution-concurrency", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		createExecutionWithinConcurrencyCap: reserveMock,
		resolveExecutionConcurrencyLimit: resolveLimitMock,
	};
});

/** Temporal's typed errors are matched by name, so a named Error stands in. */
function temporalError(name: string): Error {
	const error = new Error(name);
	error.name = name;
	return error;
}

function failedWrites() {
	return executionUpdateMock.mock.calls.filter(
		([args]) =>
			(args as { data?: { status?: string } }).data?.status === "FAILED",
	);
}

vi.mock("../../../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: async () => ({ id: "member-1" }),
}));

vi.mock("../../../../../orpc/procedures", () => {
	// The builder is stubbed down to a bare handler, but `.use()` records what
	// was mounted so the rate-limit middleware can be exercised on its own.
	const builder = {
		use: (mw: unknown) => {
			useMocks.push(mw);
			return builder;
		},
		route: () => ({
			input: () => ({
				handler: (fn: unknown) => fn,
				output: () => ({ handler: (fn: unknown) => fn }),
			}),
		}),
	};
	return {
		Permissions: { WORKSPACE_UPDATE: "workspace:update" },
		requirePermission: () => "permission-middleware",
		resolveOrganizationId: (input: string | null | undefined) =>
			input ?? undefined,
		enforceWorkflowRateLimit: enforceWorkflowRateLimitMock,
		tenantProtectedProcedure: builder,
	};
});

import { startWorkflowExecutionProcedure } from "../start-execution";

// The builder is stubbed to a bare handler above.
const start = startWorkflowExecutionProcedure as unknown as (args: {
	input: Record<string, unknown>;
	context: typeof ctx;
}) => Promise<{
	execution: { id: string; status?: string };
	temporalWorkflowId: string | null;
	status: "started" | "failed" | "unconfirmed";
	outcome?: "started" | "failed" | "unconfirmed";
	message?: string;
	deduplicated?: true;
}>;

const USER = "user-1";

/** A saved graph with one real node — valid on its own. */
const SAVED_NODES = [{ id: "saved", type: "http-request", data: {} }];

const ctx = { user: { id: USER }, session: {} };

beforeEach(() => {
	vi.clearAllMocks();
	accessMock.mockResolvedValue(true);
	getWorkflowMock.mockResolvedValue({
		id: "wf-1",
		version: 3,
		projectId: "proj-1",
		nodes: SAVED_NODES,
		edges: [],
	});
	reserveMock.mockResolvedValue({
		allowed: true,
		execution: {
			id: "exec-1",
			startedAt: new Date("2026-08-08T00:00:00Z"),
			status: "PENDING",
		},
		inFlight: 1,
		limit: 25,
	});
	resolveLimitMock.mockResolvedValue(25);
	executionUpdateMock.mockResolvedValue({});
	markRunningMock.mockResolvedValue(true);
	temporalAvailableMock.mockResolvedValue(true);
	startMock.mockResolvedValue({ workflowId: "temporal-run-1" });
	// Default: a start that threw really did not happen.
	describeMock.mockRejectedValue(temporalError("WorkflowNotFoundError"));
	enforceWorkflowRateLimitMock.mockResolvedValue(undefined);
});

describe("the workflow rate limit is spent before any work", () => {
	/** The middleware this procedure mounts after the permission gate. */
	function rateLimitMiddleware() {
		const mw = useMocks.find((m) => typeof m === "function") as
			| ((opts: {
					context: unknown;
					next: () => Promise<unknown>;
					path: string[];
			  }) => Promise<unknown>)
			| undefined;
		expect(
			mw,
			"expected a rate-limit middleware mounted via .use()",
		).toBeDefined();
		// biome-ignore lint/style/noNonNullAssertion: asserted defined above
		return mw!;
	}

	it("mounts a middleware after the permission gate", () => {
		expect(useMocks[0]).toBe("permission-middleware");
		expect(typeof useMocks[1]).toBe("function");
	});

	it("charges RATE_LIMIT_PRESETS.workflow to the caller and the procedure path, then continues", async () => {
		const next = vi.fn().mockResolvedValue("downstream");
		const path = ["workflows", "executions", "start"];

		const result = await rateLimitMiddleware()({
			context: ctx,
			next,
			path,
		});

		expect(enforceWorkflowRateLimitMock).toHaveBeenCalledWith(USER, path);
		expect(next).toHaveBeenCalledTimes(1);
		expect(result).toBe("downstream");
	});

	it("does not reach the handler when the limit is exceeded", async () => {
		enforceWorkflowRateLimitMock.mockRejectedValue(
			Object.assign(new Error("Workflow rate limit exceeded"), {
				code: "TOO_MANY_REQUESTS",
			}),
		);
		const next = vi.fn();

		await expect(
			rateLimitMiddleware()({ context: ctx, next, path: [] }),
		).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });

		expect(next).not.toHaveBeenCalled();
	});
});

describe("idempotency key", () => {
	const EXISTING = {
		id: "exec-existing",
		status: "RUNNING",
		temporalRunId: "temporal-run-existing",
		startedAt: new Date("2026-08-08T00:00:00Z"),
	};

	it("is not consulted when the caller sends none — the plain reservation path is unchanged", async () => {
		await start({ input: { id: "wf-1" }, context: ctx });

		expect(reserveMock).toHaveBeenCalledTimes(1);
		expect(createExecutionIdempotentMock).not.toHaveBeenCalled();
	});

	it("creates through the serialised find-or-create, scoped to caller, workflow and a five-minute window, with the tenant's cap", async () => {
		createExecutionIdempotentMock.mockResolvedValue({
			outcome: "created",
			execution: {
				id: "exec-1",
				startedAt: new Date("2026-08-08T00:00:00Z"),
				status: "PENDING",
			},
			inFlight: 1,
			limit: 25,
		});

		const result = await start({
			input: {
				id: "wf-1",
				organizationId: "org-1",
				idempotencyKey: "click-abc",
				variables: { a: 1 },
			},
			context: ctx,
		});

		expect(reserveMock).not.toHaveBeenCalled();
		expect(resolveLimitMock).toHaveBeenCalledWith("org-1");
		expect(createExecutionIdempotentMock).toHaveBeenCalledWith(
			expect.objectContaining({
				workflowId: "wf-1",
				userId: USER,
				organizationId: "org-1",
				idempotencyKey: "click-abc",
				windowMs: 5 * 60_000,
				limit: 25,
				triggerInput: expect.objectContaining({ variables: { a: 1 } }),
			}),
		);
		expect(startMock).toHaveBeenCalledTimes(1);
		expect(result.status).toBe("started");
	});

	it("returns the run the first submission started and does not start another", async () => {
		// First click: created and started.
		createExecutionIdempotentMock.mockResolvedValueOnce({
			outcome: "created",
			execution: {
				id: "exec-existing",
				startedAt: EXISTING.startedAt,
				status: "PENDING",
			},
			inFlight: 1,
			limit: 25,
		});
		startMock.mockResolvedValueOnce({
			workflowId: EXISTING.temporalRunId,
		});
		const first = await start({
			input: { id: "wf-1", idempotencyKey: "click-abc" },
			context: ctx,
		});
		expect(first.status).toBe("started");
		expect(startMock).toHaveBeenCalledTimes(1);

		// Second click with the same key: the row already exists.
		createExecutionIdempotentMock.mockResolvedValueOnce({
			outcome: "existing",
			execution: EXISTING,
		});
		const second = await start({
			input: { id: "wf-1", idempotencyKey: "click-abc" },
			context: ctx,
		});

		expect(second.execution.id).toBe(first.execution.id);
		expect(second.temporalWorkflowId).toBe(EXISTING.temporalRunId);
		expect(second.status).toBe("started");
		expect(second).toMatchObject({ deduplicated: true });
		// No second engine start, no second status write.
		expect(startMock).toHaveBeenCalledTimes(1);
		expect(markRunningMock).toHaveBeenCalledTimes(1);
		expect(executionUpdateMock).not.toHaveBeenCalled();
	});

	it("returns the existing run on a same-key retry even when the tenant is at its cap", async () => {
		// The first request started the last permitted run and lost its
		// response. The retry asks for nothing new: it must get that run
		// back, not the 429 a cap-first ordering handed it.
		createExecutionIdempotentMock.mockResolvedValue({
			outcome: "existing",
			execution: EXISTING,
		});
		resolveLimitMock.mockResolvedValue(1);

		const result = await start({
			input: { id: "wf-1", idempotencyKey: "click-abc" },
			context: ctx,
		});

		expect(result.execution.id).toBe("exec-existing");
		expect(result).toMatchObject({ deduplicated: true, status: "started" });
		expect(reserveMock).not.toHaveBeenCalled();
		expect(startMock).not.toHaveBeenCalled();
	});

	it("refuses a NEW keyed run at the cap, creating nothing", async () => {
		createExecutionIdempotentMock.mockResolvedValue({
			outcome: "limit-reached",
			inFlight: 25,
			limit: 25,
		});

		await expect(
			start({
				input: { id: "wf-1", idempotencyKey: "click-new" },
				context: ctx,
			}),
		).rejects.toThrow(/already has 25/);

		expect(startMock).not.toHaveBeenCalled();
		expect(executionUpdateMock).not.toHaveBeenCalled();
	});

	it("returns the PENDING row of an accepted-but-unconfirmed start on a same-key retry, rather than starting again", async () => {
		// First submission: the start call failed and the describe could not
		// settle it, so the row stayed PENDING and the key stayed claimed.
		createExecutionIdempotentMock.mockResolvedValueOnce({
			outcome: "created",
			execution: {
				id: "exec-ambiguous",
				startedAt: EXISTING.startedAt,
				status: "PENDING",
			},
			inFlight: 1,
			limit: 25,
		});
		startMock.mockRejectedValueOnce(new Error("DEADLINE_EXCEEDED"));
		describeMock.mockRejectedValueOnce(new Error("UNAVAILABLE"));
		const first = await start({
			input: { id: "wf-1", idempotencyKey: "click-abc" },
			context: ctx,
		});
		expect(first).toMatchObject({
			status: "unconfirmed",
			outcome: "unconfirmed",
		});
		expect(first.execution.id).toBe("exec-ambiguous");
		expect(first.message).toMatch(/exec-ambiguous/);
		expect(failedWrites()).toHaveLength(0);

		// The retry finds that row under its key: same execution, no second
		// engine start.
		createExecutionIdempotentMock.mockResolvedValueOnce({
			outcome: "existing",
			execution: {
				id: "exec-ambiguous",
				status: "PENDING",
				temporalRunId: null,
				startedAt: EXISTING.startedAt,
			},
		});
		const retry = await start({
			input: { id: "wf-1", idempotencyKey: "click-abc" },
			context: ctx,
		});

		expect(retry.execution.id).toBe("exec-ambiguous");
		// Not "started": nothing has confirmed a run exists. The editor
		// follows the execution and keeps the key.
		expect(retry).toMatchObject({
			deduplicated: true,
			status: "unconfirmed",
			outcome: "unconfirmed",
		});
		expect(startMock).toHaveBeenCalledTimes(1);
	});

	it("does not start a second run when the first was accepted, its run-id write failed, and the run later recorded FAILED", async () => {
		// 1. The start is confirmed, but persisting RUNNING + the run id throws.
		createExecutionIdempotentMock.mockResolvedValueOnce({
			outcome: "created",
			execution: {
				id: "exec-accepted",
				startedAt: EXISTING.startedAt,
				status: "PENDING",
				triggerInput: { idempotencyKey: "click-abc" },
			},
			inFlight: 1,
			limit: 25,
		});
		startMock.mockResolvedValueOnce({
			workflowId: "workflow-execution-exec-accepted",
		});
		markRunningMock.mockRejectedValueOnce(new Error("connection reset"));
		const first = await start({
			input: { id: "wf-1", idempotencyKey: "click-abc" },
			context: ctx,
		});
		expect(first.status).toBe("started");
		// The starter never released the key: no FAILED write, and no write
		// that touches triggerInput.
		expect(failedWrites()).toHaveLength(0);
		expect(executionUpdateMock).not.toHaveBeenCalled();

		// 2. The workflow itself later records FAILED, with no run id stored.
		//    The row still carries its key, so the lookup matches it.
		createExecutionIdempotentMock.mockResolvedValueOnce({
			outcome: "existing",
			execution: {
				id: "exec-accepted",
				status: "FAILED",
				temporalRunId: null,
				startedAt: EXISTING.startedAt,
				triggerInput: { idempotencyKey: "click-abc" },
			},
		});

		// 3. The same-key retry gets that execution back and starts nothing.
		const retry = await start({
			input: { id: "wf-1", idempotencyKey: "click-abc" },
			context: ctx,
		});
		expect(retry.execution.id).toBe("exec-accepted");
		expect(retry).toMatchObject({ deduplicated: true, status: "failed" });
		expect(startMock).toHaveBeenCalledTimes(1);
		expect(createExecutionIdempotentMock).toHaveBeenCalledTimes(2);
	});

	it("releases the key in the same write that records a confirmed not-started run", async () => {
		createExecutionIdempotentMock.mockResolvedValueOnce({
			outcome: "created",
			execution: {
				id: "exec-refused",
				startedAt: EXISTING.startedAt,
				status: "PENDING",
				triggerInput: {
					variables: { a: 1 },
					idempotencyKey: "click-abc",
				},
			},
			inFlight: 1,
			limit: 25,
		});
		startMock.mockRejectedValueOnce(new Error("connection refused"));
		describeMock.mockRejectedValueOnce(
			temporalError("WorkflowNotFoundError"),
		);

		const result = await start({
			input: { id: "wf-1", idempotencyKey: "click-abc" },
			context: ctx,
		});

		expect(result.status).toBe("failed");
		expect(executionUpdateMock).toHaveBeenCalledTimes(1);
		expect(executionUpdateMock).toHaveBeenCalledWith({
			where: { id: "exec-refused" },
			data: expect.objectContaining({
				status: "FAILED",
				triggerInput: {
					variables: { a: 1 },
					releasedIdempotencyKey: "click-abc",
				},
			}),
		});
	});

	it("reports a deduplicated run that has since failed as failed, not started", async () => {
		createExecutionIdempotentMock.mockResolvedValue({
			outcome: "existing",
			execution: { ...EXISTING, status: "FAILED" },
		});

		const result = await start({
			input: { id: "wf-1", idempotencyKey: "click-abc" },
			context: ctx,
		});

		expect(result.status).toBe("failed");
		expect(startMock).not.toHaveBeenCalled();
	});
});

describe("validation happens before anything is written", () => {
	it("refuses an empty graph without creating an execution row", async () => {
		getWorkflowMock.mockResolvedValue({
			id: "wf-1",
			version: 3,
			nodes: [],
			edges: [],
		});

		await expect(
			start({ input: { id: "wf-1" }, context: ctx }),
		).rejects.toThrow(/validation failed/i);

		expect(reserveMock).not.toHaveBeenCalled();
		expect(startMock).not.toHaveBeenCalled();
	});

	it("validates the posted graph, not the stored one", async () => {
		// Saved graph is fine; what the editor posted is not. Validating the
		// stored graph here would let a broken canvas run.
		await expect(
			start({
				input: { id: "wf-1", nodes: [], edges: [] },
				context: ctx,
			}),
		).rejects.toThrow(/validation failed/i);

		expect(reserveMock).not.toHaveBeenCalled();
	});

	it("refuses at the concurrency cap and starts nothing", async () => {
		reserveMock.mockResolvedValue({
			allowed: false,
			inFlight: 25,
			limit: 25,
		});

		await expect(
			start({ input: { id: "wf-1" }, context: ctx }),
		).rejects.toThrow(/already has 25/);

		expect(startMock).not.toHaveBeenCalled();
		expect(executionUpdateMock).not.toHaveBeenCalled();
	});

	it("reserves the row with its content, so the cap and the insert are one decision", async () => {
		await start({
			input: { id: "wf-1", triggerData: { a: 1 } },
			context: ctx,
		});

		expect(reserveMock).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: USER,
				data: expect.objectContaining({
					workflowId: "wf-1",
					version: 3,
					triggerType: "MANUAL",
					triggerInput: expect.objectContaining({
						triggerData: { a: 1 },
					}),
				}),
			}),
		);
	});
});

describe("unsaved canvas changes", () => {
	it("executes the posted nodes and edges when the editor sends them", async () => {
		const posted = [{ id: "posted", type: "http-request", data: {} }];

		await start({
			input: { id: "wf-1", nodes: posted, edges: [] },
			context: ctx,
		});

		const [, options] = startMock.mock.calls[0];
		expect(options.args[0].nodes).toEqual(posted);
	});

	it("leaves nodes undefined when nothing was posted, so the run loads the stored graph", async () => {
		await start({ input: { id: "wf-1" }, context: ctx });

		const [, options] = startMock.mock.calls[0];
		expect(options.args[0].nodes).toBeUndefined();
	});
});

describe("when the engine will not take the run", () => {
	it("records FAILED rather than leaving the row PENDING when Temporal is unavailable", async () => {
		temporalAvailableMock.mockResolvedValue(false);

		const result = await start({ input: { id: "wf-1" }, context: ctx });

		expect(result.status).toBe("failed");
		expect(executionUpdateMock).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "exec-1" },
				data: expect.objectContaining({ status: "FAILED" }),
			}),
		);
	});

	it("records FAILED when the start call throws AND Temporal confirms no run exists under the row's id", async () => {
		startMock.mockRejectedValue(new Error("connection refused"));
		describeMock.mockRejectedValue(temporalError("WorkflowNotFoundError"));

		const result = await start({ input: { id: "wf-1" }, context: ctx });

		expect(result.status).toBe("failed");
		expect(result.message).toMatch(/connection refused/);
		expect(executionUpdateMock).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ status: "FAILED" }),
			}),
		);
	});

	it("reports an accepted-but-lost start as started — the run exists, so a retry would duplicate it", async () => {
		// The client timed out after the server accepted the start. Failing
		// the row here was the bug: it released the idempotency key, and the
		// same-key retry created a new row, a new id, and a second run.
		startMock.mockRejectedValue(new Error("DEADLINE_EXCEEDED"));
		describeMock.mockResolvedValue({ runId: "run-accepted" });

		const result = await start({ input: { id: "wf-1" }, context: ctx });

		expect(result.status).toBe("started");
		expect(result.temporalWorkflowId).toBe("workflow-execution-exec-1");
		expect(failedWrites()).toHaveLength(0);
		expect(markRunningMock).toHaveBeenCalledWith({
			executionId: "exec-1",
			temporalRunId: "workflow-execution-exec-1",
		});
	});

	it("treats an already-started rejection as the run it is", async () => {
		startMock.mockRejectedValue(
			temporalError("WorkflowExecutionAlreadyStartedError"),
		);

		const result = await start({ input: { id: "wf-1" }, context: ctx });

		expect(result.status).toBe("started");
		expect(describeMock).not.toHaveBeenCalled();
		expect(failedWrites()).toHaveLength(0);
	});

	it("resolves an unconfirmed outcome and leaves the row active when neither the start nor the describe can settle it", async () => {
		startMock.mockRejectedValue(new Error("DEADLINE_EXCEEDED"));
		describeMock.mockRejectedValue(new Error("UNAVAILABLE"));

		// Resolved, not thrown: an error reads as "retry".
		const result = await start({ input: { id: "wf-1" }, context: ctx });
		expect(result).toMatchObject({
			status: "unconfirmed",
			outcome: "unconfirmed",
		});
		expect(result.message).toMatch(/exec-1/);
		expect(markRunningMock).not.toHaveBeenCalled();

		// Neither FAILED (releases the key and invites a duplicate retry) nor
		// RUNNING (claims a confirmation nobody has): the row is left exactly
		// as created.
		expect(executionUpdateMock).not.toHaveBeenCalled();
	});

	it("reports the failure to the caller instead of a success-shaped result", async () => {
		// Both UI call sites treat a resolved mutation as "started" unless the
		// status says otherwise, so this field is load-bearing.
		temporalAvailableMock.mockResolvedValue(false);

		const result = await start({ input: { id: "wf-1" }, context: ctx });

		expect(result.temporalWorkflowId).toBeNull();
		expect(result.message).toMatch(/not started/i);
	});
});

describe("the happy path still works", () => {
	it("starts the run on the workflow-builder queue with a ceiling and marks it RUNNING", async () => {
		const result = await start({ input: { id: "wf-1" }, context: ctx });

		const [type, options] = startMock.mock.calls[0];
		expect(type).toBe("workflowBuilderExecutionWorkflow");
		expect(options.taskQueue).toBe("workflow-builder");
		expect(options.workflowExecutionTimeout).toBe("6 hours");
		expect(result.status).toBe("started");
		// Conditional on PENDING: a run that already finished stays finished.
		expect(markRunningMock).toHaveBeenCalledWith({
			executionId: "exec-1",
			temporalRunId: "temporal-run-1",
		});
		expect(executionUpdateMock).not.toHaveBeenCalled();
	});

	it("still reports a started run when marking the row RUNNING fails, and never marks it FAILED", async () => {
		markRunningMock.mockRejectedValueOnce(new Error("connection reset"));

		const result = await start({ input: { id: "wf-1" }, context: ctx });

		expect(startMock).toHaveBeenCalledTimes(1);
		expect(result.status).toBe("started");
		expect(failedWrites()).toHaveLength(0);
	});
});
