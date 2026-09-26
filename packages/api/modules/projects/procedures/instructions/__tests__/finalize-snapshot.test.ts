/**
 * Tests for `finalizeSnapshotProcedure` — starts
 * `projectInstructionSnapshotWorkflow` (added in Task 10; started here by
 * string name, which is valid ahead of that task per the controller ruling
 * on this brief) and only THEN flips the snapshot to VALIDATING.
 *
 * R15 fix-round coverage: `workflow.start` must run BEFORE
 * the VALIDATING transition (verified via `mock.invocationCallOrder`
 * below), so a start failure leaves the snapshot RECEIVING/VALIDATING for a
 * retried finalize call to repair, instead of stranding it in VALIDATING
 * forever. A retry that hits `WorkflowExecutionAlreadyStartedError` (the
 * earlier attempt's start actually succeeded) is treated as success, not
 * re-thrown. A snapshot already in VALIDATING is reported as-is: a live run
 * owns that row (round 8, finding 1).
 *
 * `getTemporalClient` is imported from `@repo/temporal` (not
 * `@repo/temporal/client`) and `withCorrelationMemo` from
 * `../../../../../lib/temporal-correlation`, matching
 * `contexts/add-google-docs-context.ts`.
 */

import { ORPCError } from "@orpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	handlers: {} as Record<string, (...a: unknown[]) => unknown>,
	getInstructionSnapshot: vi.fn(),
	startInstructionSnapshotValidation: vi.fn(),
	resolveEffectiveProjectPermissions: vi.fn(),
	getTemporalClient: vi.fn(),
	workflowStart: vi.fn(),
	assertInstructionSnapshotMutationAccess: vi.fn(),
	assertProjectPermission: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	getInstructionSnapshot: (...a: unknown[]) => m.getInstructionSnapshot(...a),
	startInstructionSnapshotValidation: (...a: unknown[]) =>
		m.startInstructionSnapshotValidation(...a),
}));
vi.mock("@repo/temporal", () => ({
	getTemporalClient: (...a: unknown[]) => m.getTemporalClient(...a),
}));
vi.mock("../../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: (options: unknown) => options,
}));
vi.mock("../../../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions: (...a: unknown[]) =>
		m.resolveEffectiveProjectPermissions(...a),
}));
vi.mock("../proposal-authorization", () => ({
	assertInstructionSnapshotMutationAccess: (...a: unknown[]) =>
		m.assertInstructionSnapshotMutationAccess(...a),
}));
vi.mock("../../../../../orpc/procedures", () => {
	const builder = {
		use: () => builder,
		route: () => builder,
		input: () => builder,
		handler: (fn: (...a: unknown[]) => unknown) => {
			m.handlers.finalize = fn;
			return fn;
		},
	};
	return {
		tenantProtectedProcedure: builder,
		requireProjectPermission: () => ({}),
		// The handler-side check a publish-first row adds (Fizzy #2737).
		assertProjectPermission: (...a: unknown[]) =>
			m.assertProjectPermission(...a),
		Permissions: {
			INSTRUCTION_READ: "instruction:read",
			INSTRUCTION_UPDATE: "instruction:update",
		},
	};
});

import "../finalize-snapshot";

const ctx = {
	user: { id: "user_1" },
	session: { activeOrganizationId: "org_1" },
};
const baseInput = { projectId: "proj_1", snapshotId: "snap_1" };

beforeEach(() => {
	for (const fn of Object.values(m)) {
		if (typeof fn === "function") {
			(fn as ReturnType<typeof vi.fn>).mockReset?.();
		}
	}
	m.resolveEffectiveProjectPermissions.mockResolvedValue({
		permissions: [],
		source: "org",
		organizationId: "org_1",
	});
	m.getInstructionSnapshot.mockResolvedValue({
		id: "snap_1",
		status: "RECEIVING",
		userId: "user_1",
		proposalStatus: null,
	});
	m.startInstructionSnapshotValidation.mockResolvedValue({ changed: true });
	m.workflowStart.mockResolvedValue(undefined);
	m.getTemporalClient.mockResolvedValue({
		workflow: { start: (...a: unknown[]) => m.workflowStart(...a) },
	});
});

describe("projects.instructions.finalize", () => {
	it("starts the validation workflow with a deterministic id, THEN flips RECEIVING to VALIDATING", async () => {
		const result = await m.handlers.finalize!({
			input: baseInput,
			context: ctx,
		});

		expect(m.workflowStart).toHaveBeenCalledTimes(1);
		expect(m.startInstructionSnapshotValidation).toHaveBeenCalledWith({
			snapshotId: "snap_1",
			projectId: "proj_1",
			organizationId: "org_1",
		});
		// R15: the workflow must be started BEFORE the status write commits,
		// so a start failure never strands the snapshot in VALIDATING with no
		// later finalize call able to retry it.
		expect(m.workflowStart.mock.invocationCallOrder[0]).toBeLessThan(
			m.startInstructionSnapshotValidation.mock.invocationCallOrder[0],
		);

		const [workflowName, options] = m.workflowStart.mock.calls[0]! as [
			string,
			{
				taskQueue: string;
				workflowId: string;
				args: Array<Record<string, unknown>>;
			},
		];
		expect(workflowName).toBe("projectInstructionSnapshotWorkflow");
		// R33: its own queue. On "project-documents" these long, I/O-bound
		// activities competed for the 5 slots that serve a human waiting on a
		// document generation.
		expect(options.taskQueue).toBe("project-instructions");
		expect(options.workflowId).toBe("project-instruction-snapshot-snap_1");
		expect(options.args[0]).toEqual({
			snapshotId: "snap_1",
			projectId: "proj_1",
			organizationId: "org_1",
			userId: "user_1",
		});
		expect(result).toEqual({ status: "VALIDATING" });
	});

	it("propagates a generic workflow-start failure and never writes VALIDATING (leaves the row retryable)", async () => {
		m.workflowStart.mockRejectedValue(new Error("temporal unreachable"));

		await expect(
			m.handlers.finalize!({ input: baseInput, context: ctx }),
		).rejects.toThrow("temporal unreachable");
		expect(m.startInstructionSnapshotValidation).not.toHaveBeenCalled();
	});

	it("treats WorkflowExecutionAlreadyStartedError as success and still flips to VALIDATING", async () => {
		const alreadyStarted = new Error("workflow already started");
		alreadyStarted.name = "WorkflowExecutionAlreadyStartedError";
		m.workflowStart.mockRejectedValue(alreadyStarted);

		const result = await m.handlers.finalize!({
			input: baseInput,
			context: ctx,
		});

		expect(m.startInstructionSnapshotValidation).toHaveBeenCalledWith({
			snapshotId: "snap_1",
			projectId: "proj_1",
			organizationId: "org_1",
		});
		expect(result).toEqual({ status: "VALIDATING" });
	});

	// Round 8, finding 1. A VALIDATING row is owned by a live run, and this
	// handler cannot tell a live one from a dead one. Starting a new execution
	// from an UNCHANGED VALIDATING row left the row indistinguishable from the
	// stale one the reaper's watchdog phase was about to fail — nothing about
	// it had moved — so the watchdog would have written FAILED over a run that
	// had only just begun. Recovery goes the other way: the watchdog marks a
	// genuinely dead row FAILED, and "Try again" restarts it from there, which
	// is the only path that establishes a fresh generation.
	it("reports VALIDATING without starting a workflow or writing a status", async () => {
		m.getInstructionSnapshot.mockResolvedValue({
			id: "snap_1",
			status: "VALIDATING",
		});

		const result = await m.handlers.finalize!({
			input: baseInput,
			context: ctx,
		});

		expect(result).toEqual({ status: "VALIDATING" });
		expect(m.workflowStart).not.toHaveBeenCalled();
		expect(m.startInstructionSnapshotValidation).not.toHaveBeenCalled();
		// Not even a Temporal client: there is nothing to ask it.
		expect(m.getTemporalClient).not.toHaveBeenCalled();
		// The tenant-scoped pre-read, and nothing after it.
		expect(m.getInstructionSnapshot).toHaveBeenCalledTimes(1);
	});

	// R30/I2: FAILED is this feature's "Try again". The tab renders that
	// button for a FAILED snapshot and it calls this procedure; the staging
	// objects are deliberately left in place by
	// `markInstructionSnapshotFailed`, so the new run's integrity/secret gate has the
	// bytes it needs. Temporal permits reusing the workflow id once the
	// previous run has closed, which a FAILED row implies.
	it("re-attempts the start for a FAILED snapshot (the tab's 'Try again')", async () => {
		m.getInstructionSnapshot.mockResolvedValue({
			id: "snap_1",
			status: "FAILED",
		});

		const result = await m.handlers.finalize!({
			input: baseInput,
			context: ctx,
		});

		expect(m.workflowStart).toHaveBeenCalledTimes(1);
		expect(m.startInstructionSnapshotValidation).toHaveBeenCalledWith({
			snapshotId: "snap_1",
			projectId: "proj_1",
			organizationId: "org_1",
		});
		expect(result).toEqual({ status: "VALIDATING" });
	});

	// I3 (round 2): `markInstructionSnapshotFailed` writes FAILED from inside
	// the workflow's boundary catch, which then RETHROWS, so the execution
	// stays open until Temporal processes that final workflow task. A "Try
	// again" inside that window gets `AlreadyStarted` from the OLD run, not a
	// new one — and treating it as success moved FAILED to VALIDATING with no
	// execution behind it, stranding the snapshot in VALIDATING forever once
	// the old run closed.
	it("returns FAILED without writing a status when AlreadyStarted comes from the still-closing previous run", async () => {
		m.getInstructionSnapshot.mockResolvedValue({
			id: "snap_1",
			status: "FAILED",
		});
		const alreadyStarted = new Error("workflow already started");
		alreadyStarted.name = "WorkflowExecutionAlreadyStartedError";
		m.workflowStart.mockRejectedValue(alreadyStarted);

		const result = await m.handlers.finalize!({
			input: baseInput,
			context: ctx,
		});

		expect(result).toEqual({ status: "FAILED" });
		// The whole point: no transition, so the row cannot end up VALIDATING
		// with nothing running. The user retries once the run has closed.
		expect(m.startInstructionSnapshotValidation).not.toHaveBeenCalled();
	});

	// The retry whose response was merely lost: the first call started the
	// workflow and wrote VALIDATING, and the client asks again. It gets the
	// same answer it always did — without a redundant start, and without the
	// `AlreadyStarted` round trip that used to produce it.
	it("answers a repeated finalize for an already-VALIDATING snapshot with VALIDATING", async () => {
		m.getInstructionSnapshot.mockResolvedValue({
			id: "snap_1",
			status: "VALIDATING",
		});

		expect(
			await m.handlers.finalize!({ input: baseInput, context: ctx }),
		).toEqual({ status: "VALIDATING" });
		expect(
			await m.handlers.finalize!({ input: baseInput, context: ctx }),
		).toEqual({ status: "VALIDATING" });
		expect(m.workflowStart).not.toHaveBeenCalled();
		expect(m.startInstructionSnapshotValidation).not.toHaveBeenCalled();
	});

	// I2: the workflow is started BEFORE the status write, so a small upload
	// can reach a terminal state in between. The write used to be
	// unconditional and overwrote that verdict with VALIDATING — and in the
	// READY case the publish activity then refused the snapshot as
	// `not_ready`, so the tab polled a validation that had already finished
	// and could never publish.
	it("leaves a snapshot the workflow already took to READY alone, and returns READY", async () => {
		// The pre-check saw RECEIVING; by the time the transition ran, the
		// workflow had finished.
		m.getInstructionSnapshot
			.mockResolvedValueOnce({ id: "snap_1", status: "RECEIVING" })
			.mockResolvedValueOnce({ id: "snap_1", status: "READY" });
		m.startInstructionSnapshotValidation.mockResolvedValue({
			changed: false,
		});

		const result = await m.handlers.finalize!({
			input: baseInput,
			context: ctx,
		});

		expect(result).toEqual({ status: "READY" });
		// The conditional update is scoped to RECEIVING/FAILED, so it matched
		// nothing; the handler re-read rather than asserting VALIDATING.
		expect(m.getInstructionSnapshot).toHaveBeenCalledTimes(2);
	});

	it("returns REJECTED when the workflow rejected the snapshot while finalize was mid-flight", async () => {
		m.getInstructionSnapshot
			.mockResolvedValueOnce({ id: "snap_1", status: "RECEIVING" })
			.mockResolvedValueOnce({ id: "snap_1", status: "REJECTED" });
		m.startInstructionSnapshotValidation.mockResolvedValue({
			changed: false,
		});

		const result = await m.handlers.finalize!({
			input: baseInput,
			context: ctx,
		});

		expect(result).toEqual({ status: "REJECTED" });
	});

	it("is idempotent: a snapshot already past RECEIVING returns its current status without restarting the workflow", async () => {
		m.getInstructionSnapshot.mockResolvedValue({
			id: "snap_1",
			status: "READY",
		});
		const result = await m.handlers.finalize!({
			input: baseInput,
			context: ctx,
		});
		expect(result).toEqual({ status: "READY" });
		expect(m.startInstructionSnapshotValidation).not.toHaveBeenCalled();
		expect(m.workflowStart).not.toHaveBeenCalled();
	});

	it("404s when the snapshot does not exist or is not scoped to this org/project", async () => {
		m.getInstructionSnapshot.mockResolvedValue(null);
		await expect(
			m.handlers.finalize!({ input: baseInput, context: ctx }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(m.startInstructionSnapshotValidation).not.toHaveBeenCalled();
	});

	// I5: the workflow input's `organizationId` decides which tenant every
	// activity reads and writes, so it has to be the project's host org and
	// not whichever organization the caller happens to be looking at.
	it("scopes the lookup and the workflow input to the project's hosting organization", async () => {
		await m.handlers.finalize!({
			input: { ...baseInput, organizationId: "org_active" },
			context: {
				user: { id: "user_1" },
				session: { activeOrganizationId: "org_active" },
			},
		});

		expect(m.getInstructionSnapshot).toHaveBeenCalledWith(
			"snap_1",
			"proj_1",
			"org_1",
		);
		const [, options] = m.workflowStart.mock.calls[0]! as [
			string,
			{ args: Array<Record<string, unknown>> },
		];
		expect(options.args[0]).toMatchObject({ organizationId: "org_1" });
	});

	/**
	 * The shared finalizer wraps a failure to REACH Temporal in a marker, so
	 * that `submit-change.ts` — which has just created a snapshot row — can
	 * tell "no execution exists, safe to close the row out" from "a start was
	 * called and may have succeeded". This procedure has no such decision to
	 * make, so it unwraps the marker and its caller sees exactly the error it
	 * saw before the finalizer was extracted. The marker itself is covered by
	 * `instruction-workflow-start.test.ts`.
	 */
	it("surfaces the original failure when Temporal cannot be reached", async () => {
		const cause = new Error("getaddrinfo ENOTFOUND temporal");
		m.getTemporalClient.mockRejectedValue(cause);

		await expect(
			m.handlers.finalize!({ input: baseInput, context: ctx }),
		).rejects.toBe(cause);
		expect(m.workflowStart).not.toHaveBeenCalled();
		expect(m.startInstructionSnapshotValidation).not.toHaveBeenCalled();
	});
	// A start that was CALLED and rejected is ambiguous — it may have
	// succeeded with only its acknowledgement lost — so it must NOT be
	// dressed up as "never started".
	it("lets a rejected workflow.start propagate unchanged", async () => {
		const failure = new Error("workflow start rejected by the server");
		m.workflowStart.mockRejectedValue(failure);

		await expect(
			m.handlers.finalize!({ input: baseInput, context: ctx }),
		).rejects.toBe(failure);
		expect(m.startInstructionSnapshotValidation).not.toHaveBeenCalled();
	});

	it("throws FORBIDDEN when the organization cannot be resolved", async () => {
		m.resolveEffectiveProjectPermissions.mockResolvedValue({
			permissions: [],
			source: "owner",
			organizationId: null,
		});
		await expect(
			m.handlers.finalize!({ input: baseInput, context: ctx }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(m.getInstructionSnapshot).not.toHaveBeenCalled();
	});
});

describe("projects.instructions.finalize: publish first, scan afterwards (Fizzy #2737)", () => {
	beforeEach(() => {
		m.getInstructionSnapshot.mockResolvedValue({
			id: "snap_1",
			status: "RECEIVING",
			userId: "user_1",
			proposalStatus: null,
			publishBeforeScan: true,
		});
	});

	it("requires the finisher's publish permission and hands the row's opt-in to the workflow", async () => {
		m.assertProjectPermission.mockResolvedValue(undefined);

		await m.handlers.finalize!({ input: baseInput, context: ctx });

		expect(m.assertProjectPermission).toHaveBeenCalledWith(
			"proj_1",
			"user_1",
			"instruction:update",
		);
		const [, options] = m.workflowStart.mock.calls[0]! as [
			string,
			{ args: Array<Record<string, unknown>> },
		];
		expect(options.args[0]).toEqual({
			snapshotId: "snap_1",
			projectId: "proj_1",
			organizationId: "org_1",
			userId: "user_1",
			publishBeforeScan: true,
		});
	});

	it("refuses a finisher without the publish permission, and starts nothing", async () => {
		m.assertProjectPermission.mockRejectedValue(
			new ORPCError("FORBIDDEN", {
				message: "Missing required permission: instruction:update",
			}),
		);

		await expect(
			m.handlers.finalize!({ input: baseInput, context: ctx }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(m.workflowStart).not.toHaveBeenCalled();
		expect(m.startInstructionSnapshotValidation).not.toHaveBeenCalled();
	});

	it("asks for nothing extra for an ordinary row", async () => {
		m.getInstructionSnapshot.mockResolvedValue({
			id: "snap_1",
			status: "RECEIVING",
			userId: "user_1",
			proposalStatus: null,
			publishBeforeScan: false,
		});

		await m.handlers.finalize!({ input: baseInput, context: ctx });

		expect(m.assertProjectPermission).not.toHaveBeenCalled();
		const [, options] = m.workflowStart.mock.calls[0]! as [
			string,
			{ args: Array<Record<string, unknown>> },
		];
		expect(options.args[0]).not.toHaveProperty("publishBeforeScan");
	});
});
