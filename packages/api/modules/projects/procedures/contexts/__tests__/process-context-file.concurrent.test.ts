/**
 * Concurrent-invocation regression test for `processContextFileProcedure` —
 * Unified Context Uploader Wizard spec §5.3.
 *
 * Group 7 of the spec implements multi-file upload as **client-side fan-out**:
 * N parallel `createUploadUrl → PUT → processFile` round-trips against the
 * same `projectId`. The procedure shape is unchanged, but it must remain
 * safe to invoke in parallel against a single project. This test pins that
 * contract so a future `findOrCreate` race or shared-state regression
 * (e.g. caching a result on `projectId` instead of `contextId`) breaks loudly.
 *
 * Scenarios:
 *   (a) Two concurrent invocations with **distinct** contextIds for the same
 *       projectId resolve independently: both succeed, both start workflows,
 *       and the per-contextId mocks each receive exactly one call.
 *   (b) A concurrent failure on the second invocation (Temporal start
 *       throws a non-"already started" error) reverts only its own context
 *       to PENDING; the first invocation succeeds and is untouched.
 *   (c) `WorkflowExecutionAlreadyStartedError` returns success without
 *       reverting status — idempotency keyed on contextId is preserved even
 *       when two callers race the same context (handler must NOT call
 *       updateContextExtractionStatus("PENDING") on the already-started
 *       branch).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockGetContextById,
	mockHasProjectAccess,
	mockUpdateContextExtractionStatus,
	mockTemporalWorkflowStart,
} = vi.hoisted(() => ({
	mockGetContextById: vi.fn(),
	mockHasProjectAccess: vi.fn(),
	mockUpdateContextExtractionStatus: vi.fn(),
	mockTemporalWorkflowStart: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	// Job Hub telemetry — the procedure now opens a BackgroundJob row before
	// starting the workflow, and closes it if the start throws.
	createBackgroundJob: vi.fn(async () => "job-1"),
	failBackgroundJob: vi.fn(async () => undefined),
	seedSteps: (keys: string[]) =>
		keys.map((key) => ({ key, status: "pending" })),
	getContextById: mockGetContextById,
	hasProjectAccess: mockHasProjectAccess,
	updateContextExtractionStatus: mockUpdateContextExtractionStatus,
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: vi.fn(async () => ({
		workflow: { start: mockTemporalWorkflowStart },
	})),
}));

vi.mock("../../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: <T>(opts: T) => opts,
}));

vi.mock("../../../../../orpc/procedures", () => {
	const builder: Record<string, unknown> = {};
	builder.use = () => builder;
	builder.route = () => builder;
	builder.input = () => builder;
	builder.handler = (fn: unknown) => ({ handler: fn });
	return {
		tenantProtectedProcedure: builder,
		resolveOrganizationId: (
			input: string | null | undefined,
			session: { activeOrganizationId?: string | null },
		) => {
			if (input) {
				return input;
			}
			if (input === null) {
				return undefined;
			}
			return session?.activeOrganizationId ?? undefined;
		},
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requirePermission: () => (c: unknown) => c,
		requireProjectPermission: () => (c: unknown) => c,
	};
});

type Handler = (args: {
	input: {
		projectId: string;
		contextId: string;
		organizationId?: string | null;
	};
	context: {
		user: { id: string };
		session: { activeOrganizationId?: string };
	};
}) => Promise<{
	success: boolean;
	contextId: string;
	status: string;
	message: string;
}>;

async function loadHandler(): Promise<Handler> {
	const mod = await import("../process-context-file");
	return (mod.processContextFileProcedure as unknown as { handler: Handler })
		.handler;
}

const personalCtx = {
	user: { id: "user-1" },
	session: { activeOrganizationId: undefined },
};

// Per-context registry so two concurrent invocations resolve to different
// rows (mirroring the real-world fan-out shape where each call passes its
// own `contextId` produced by the prior `createUploadUrl` round-trip).
const contextRegistry = new Map<
	string,
	{
		id: string;
		projectId: string;
		organizationId: string | null;
		extractionStatus: "PENDING" | "EXTRACTING" | "COMPLETED" | "FAILED";
	}
>();

beforeEach(() => {
	vi.clearAllMocks();
	contextRegistry.clear();
	mockHasProjectAccess.mockResolvedValue(true);
	mockGetContextById.mockImplementation(async (id: string) => {
		return contextRegistry.get(id) ?? null;
	});
	mockUpdateContextExtractionStatus.mockImplementation(
		async (id: string, status: "PENDING" | "EXTRACTING") => {
			const row = contextRegistry.get(id);
			if (row) {
				row.extractionStatus = status as never;
			}
		},
	);
	mockTemporalWorkflowStart.mockResolvedValue(undefined);
});

function seedContext(
	id: string,
	overrides: Partial<{
		projectId: string;
		organizationId: string | null;
		extractionStatus: "PENDING" | "EXTRACTING" | "COMPLETED" | "FAILED";
	}> = {},
) {
	contextRegistry.set(id, {
		id,
		projectId: "proj-1",
		organizationId: null,
		extractionStatus: "PENDING",
		...overrides,
	});
}

// ─────────────────────────────────────────────────────────────────────
// (a) Happy path — two concurrent invocations against the same projectId
//     with distinct contextIds both succeed independently.
// ─────────────────────────────────────────────────────────────────────

describe("processContextFile — concurrent invocations (same project, distinct contexts)", () => {
	it("resolves both invocations independently when contextIds differ", async () => {
		seedContext("ctx-a");
		seedContext("ctx-b");
		const handler = await loadHandler();

		const [resA, resB] = await Promise.all([
			handler({
				input: { projectId: "proj-1", contextId: "ctx-a" },
				context: personalCtx,
			}),
			handler({
				input: { projectId: "proj-1", contextId: "ctx-b" },
				context: personalCtx,
			}),
		]);

		expect(resA).toEqual({
			success: true,
			contextId: "ctx-a",
			status: "EXTRACTING",
			message: "File processing started",
		});
		expect(resB).toEqual({
			success: true,
			contextId: "ctx-b",
			status: "EXTRACTING",
			message: "File processing started",
		});

		// Each context row was looked up once.
		expect(mockGetContextById).toHaveBeenCalledTimes(2);
		expect(mockGetContextById).toHaveBeenCalledWith("ctx-a");
		expect(mockGetContextById).toHaveBeenCalledWith("ctx-b");

		// Each context was flipped to EXTRACTING exactly once.
		expect(mockUpdateContextExtractionStatus).toHaveBeenCalledTimes(2);
		expect(mockUpdateContextExtractionStatus).toHaveBeenCalledWith(
			"ctx-a",
			"EXTRACTING",
		);
		expect(mockUpdateContextExtractionStatus).toHaveBeenCalledWith(
			"ctx-b",
			"EXTRACTING",
		);

		// Two distinct workflows started — one per contextId. Workflow ID is
		// deterministic on contextId (`project-context-processing-${contextId}`),
		// which is the guardrail keeping parallel calls from colliding.
		expect(mockTemporalWorkflowStart).toHaveBeenCalledTimes(2);
		const workflowIds = mockTemporalWorkflowStart.mock.calls.map(
			(call) => (call[1] as { workflowId: string }).workflowId,
		);
		expect(workflowIds).toEqual(
			expect.arrayContaining([
				"project-context-processing-ctx-a",
				"project-context-processing-ctx-b",
			]),
		);

		// Final DB state: both rows EXTRACTING, neither reverted.
		expect(contextRegistry.get("ctx-a")?.extractionStatus).toBe(
			"EXTRACTING",
		);
		expect(contextRegistry.get("ctx-b")?.extractionStatus).toBe(
			"EXTRACTING",
		);
	});
});

// ─────────────────────────────────────────────────────────────────────
// (b) Genuine Temporal failure on one of two concurrent invocations only
//     reverts the failing context, not its sibling.
// ─────────────────────────────────────────────────────────────────────

describe("processContextFile — concurrent invocations with one Temporal failure", () => {
	it("reverts only the failing context to PENDING, leaves the sibling EXTRACTING", async () => {
		seedContext("ctx-ok");
		seedContext("ctx-fail");
		mockTemporalWorkflowStart.mockImplementation(async (_name, opts) => {
			const workflowId = (opts as { workflowId: string }).workflowId;
			if (workflowId.endsWith("ctx-fail")) {
				throw new Error("Temporal internal failure");
			}
			return undefined;
		});
		const handler = await loadHandler();

		const results = await Promise.allSettled([
			handler({
				input: { projectId: "proj-1", contextId: "ctx-ok" },
				context: personalCtx,
			}),
			handler({
				input: { projectId: "proj-1", contextId: "ctx-fail" },
				context: personalCtx,
			}),
		]);

		expect(results[0]).toMatchObject({
			status: "fulfilled",
			value: { contextId: "ctx-ok", status: "EXTRACTING" },
		});
		expect(results[1]).toMatchObject({
			status: "rejected",
			reason: expect.objectContaining({ code: "INTERNAL_SERVER_ERROR" }),
		});

		// ctx-ok stays EXTRACTING; ctx-fail is reverted to PENDING for retry.
		expect(contextRegistry.get("ctx-ok")?.extractionStatus).toBe(
			"EXTRACTING",
		);
		expect(contextRegistry.get("ctx-fail")?.extractionStatus).toBe(
			"PENDING",
		);

		// PENDING revert happened only for the failing context — not the sibling.
		expect(mockUpdateContextExtractionStatus).toHaveBeenCalledWith(
			"ctx-fail",
			"PENDING",
		);
		expect(mockUpdateContextExtractionStatus).not.toHaveBeenCalledWith(
			"ctx-ok",
			"PENDING",
		);
	});
});

// ─────────────────────────────────────────────────────────────────────
// (c) Idempotency under same-contextId race: documents the two layers of
//     the procedure's idempotency guard so a future refactor that drops
//     either layer fails loudly.
//
//     Layer 1: PENDING-status precheck (line 69-73) rejects callers that
//     see EXTRACTING/COMPLETED/FAILED with BAD_REQUEST. Wins when the
//     racing caller's `getContextById` lands AFTER another caller's
//     `updateContextExtractionStatus(_, "EXTRACTING")`.
//
//     Layer 2: WorkflowExecutionAlreadyStartedError branch (line 114-132)
//     returns success when the racing caller's workflow.start lands AFTER
//     another caller already started the same deterministic workflowId.
//     Wins when both callers slip past the PENDING precheck before either
//     `updateContextExtractionStatus` lands.
//
//     The realistic spec §5.3 fan-out uses DISTINCT contextIds so this
//     race doesn't fire in production. Same-contextId only happens on
//     explicit retry — the two guards together keep that safe.
// ─────────────────────────────────────────────────────────────────────

describe("processContextFile — same-contextId race idempotency (defense-in-depth)", () => {
	it("Layer 1: BAD_REQUEST when a racing caller sees the row already EXTRACTING", async () => {
		seedContext("ctx-dup", { extractionStatus: "EXTRACTING" });
		const handler = await loadHandler();

		await expect(
			handler({
				input: { projectId: "proj-1", contextId: "ctx-dup" },
				context: personalCtx,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });

		// Status precheck rejects BEFORE any DB write or workflow start.
		expect(mockUpdateContextExtractionStatus).not.toHaveBeenCalled();
		expect(mockTemporalWorkflowStart).not.toHaveBeenCalled();
		expect(contextRegistry.get("ctx-dup")?.extractionStatus).toBe(
			"EXTRACTING",
		);
	});

	it("Layer 2: WorkflowExecutionAlreadyStartedError → success without reverting status to PENDING", async () => {
		seedContext("ctx-dup");
		// Both callers pass the PENDING precheck (read-then-write race), but
		// Temporal's deterministic workflowId rejects the second start.
		mockTemporalWorkflowStart.mockRejectedValueOnce(
			Object.assign(new Error("workflow execution already started"), {
				name: "WorkflowExecutionAlreadyStartedError",
			}),
		);
		const handler = await loadHandler();

		const result = await handler({
			input: { projectId: "proj-1", contextId: "ctx-dup" },
			context: personalCtx,
		});

		expect(result).toEqual({
			success: true,
			contextId: "ctx-dup",
			status: "EXTRACTING",
			message: "File processing already in progress",
		});

		// Critical contract: the already-started branch must NOT revert to
		// PENDING. If it did, the second concurrent caller would clobber the
		// EXTRACTING row written by the winning caller back to PENDING.
		expect(mockUpdateContextExtractionStatus).not.toHaveBeenCalledWith(
			"ctx-dup",
			"PENDING",
		);
		expect(contextRegistry.get("ctx-dup")?.extractionStatus).toBe(
			"EXTRACTING",
		);
	});
});
