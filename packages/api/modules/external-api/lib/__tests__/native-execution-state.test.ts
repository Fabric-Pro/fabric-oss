import { ServiceError, WorkflowNotFoundError } from "@temporalio/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	admission: vi.fn(),
	client: vi.fn(),
	handle: vi.fn(),
	describe: vi.fn(),
	query: vi.fn(),
	result: vi.fn(),
	deadline: vi.fn(),
}));
vi.mock("@repo/database", () => ({ readAgentExecutionAdmission: h.admission }));
vi.mock("@repo/temporal", () => ({ getTemporalClient: h.client }));

import { readNativeExecutionState } from "../native-execution-state";

const row = {
	id: "example-row",
	executionId: "example-execution",
	organizationId: "example-org",
	userId: "example-user",
	workflowId: "example-workflow",
	runId: null,
	metadata: {},
};
const memo = {
	version: 1,
	executionId: row.id,
	organizationId: row.organizationId,
	userId: row.userId,
	requestHash: "a".repeat(64),
};
const description = {
	type: "deploymentExecutionWorkflow",
	runId: "example-run",
	status: { name: "COMPLETED" },
	memo: { fabricAgentAdmission: memo },
	startTime: new Date("2026-01-01T00:00:00Z"),
	closeTime: new Date("2026-01-01T00:00:01Z"),
};
function wrappedRpcError(code: number) {
	return new ServiceError("Example RPC failure", {
		cause: Object.assign(new Error("Example gRPC status"), {
			code,
			details: "Example status details",
			metadata: {},
		}),
	});
}
beforeEach(() => {
	vi.clearAllMocks();
	h.admission.mockReturnValue({
		requestHash: memo.requestHash,
		dispatch: { workflowType: description.type },
	});
	h.describe.mockResolvedValue(description);
	h.query.mockResolvedValue({ phase: "executing_agent", message: "Working" });
	h.result.mockResolvedValue({
		executionId: row.executionId,
		status: "COMPLETED",
		output: { text: "Example" },
		durationMs: 1000,
	});
	h.handle.mockReturnValue({
		describe: h.describe,
		query: h.query,
		result: h.result,
	});
	h.deadline.mockImplementation(
		async (_deadline: number, fn: () => unknown) => fn(),
	);
	h.client.mockResolvedValue({
		workflow: { getHandle: h.handle },
		connection: { withDeadline: h.deadline },
	});
});
afterEach(() => vi.useRealTimers());
describe("read-only native execution observation", () => {
	it("verifies a missing run receipt against its admission memo and pins the actual run", async () => {
		expect(await readNativeExecutionState(row)).toMatchObject({
			nativeReadStatus: "AVAILABLE",
			runId: "example-run",
			status: "COMPLETED",
			output: { text: "Example" },
		});
		expect(h.handle.mock.calls).toEqual([
			[row.workflowId, undefined],
			[row.workflowId, "example-run", { followRuns: false }],
		]);
		expect(h.deadline.mock.calls[0]?.[0]).toBeLessThanOrEqual(
			Date.now() + 3000,
		);
	});
	it("pins an existing run ID and never falls through to a different run", async () => {
		h.describe.mockResolvedValue({
			...description,
			runId: "example-other-run",
		});
		expect(
			await readNativeExecutionState({
				...row,
				runId: "example-persisted-run",
			}),
		).toEqual({ nativeReadStatus: "IDENTITY_UNVERIFIED" });
		expect(h.handle).toHaveBeenCalledExactlyOnceWith(
			row.workflowId,
			"example-persisted-run",
		);
		expect(h.result).not.toHaveBeenCalled();
	});
	it("recovers a stale missing stored run only through the exact stable admission memo", async () => {
		h.describe
			.mockRejectedValueOnce(
				new WorkflowNotFoundError("Stale run", row.workflowId),
			)
			.mockResolvedValue(description);
		expect(
			await readNativeExecutionState({
				...row,
				runId: "example-stale-run",
			}),
		).toMatchObject({ runId: "example-run", status: "COMPLETED" });
		expect(h.handle.mock.calls).toEqual([
			[row.workflowId, "example-stale-run"],
			[row.workflowId],
			[row.workflowId, "example-run", { followRuns: false }],
		]);
	});
	it("cannot recover a stale legacy run without a persisted admission identity", async () => {
		h.admission.mockReturnValue(null);
		h.describe.mockRejectedValue(
			new WorkflowNotFoundError("Stale run", row.workflowId),
		);
		expect(
			await readNativeExecutionState({
				...row,
				runId: "example-stale-run",
			}),
		).toEqual({ nativeReadStatus: "NOT_FOUND" });
		expect(h.handle).toHaveBeenCalledExactlyOnceWith(
			row.workflowId,
			"example-stale-run",
		);
	});
	it.each([
		["wrapped gRPC NOT_FOUND", () => wrappedRpcError(5)],
		[
			"cross-module WorkflowNotFoundError",
			() =>
				Object.assign(new Error("Example missing run"), {
					name: "WorkflowNotFoundError",
				}),
		],
	])(
		"recovers a stale run for %s only after verified stable admission",
		async (_label, makeError) => {
			h.describe
				.mockRejectedValueOnce(makeError())
				.mockResolvedValue(description);
			expect(
				await readNativeExecutionState({
					...row,
					runId: "example-stale-run",
				}),
			).toMatchObject({
				status: "COMPLETED",
				runId: "example-run",
				nativeReadStatus: "AVAILABLE",
			});
			expect(h.handle.mock.calls).toEqual([
				[row.workflowId, "example-stale-run"],
				[row.workflowId],
				[row.workflowId, "example-run", { followRuns: false }],
			]);
		},
	);
	it("classifies wrapped gRPC missing history as NOT_FOUND without a false outage", async () => {
		h.describe.mockRejectedValue(wrappedRpcError(5));
		expect(await readNativeExecutionState(row)).toEqual({
			nativeReadStatus: "NOT_FOUND",
		});
		expect(h.result).not.toHaveBeenCalled();
	});
	it("keeps wrapped UNAVAILABLE distinct and never falls back from a transient exact-run failure", async () => {
		h.describe.mockRejectedValue(wrappedRpcError(14));
		expect(
			await readNativeExecutionState({ ...row, runId: "example-run" }),
		).toEqual({ nativeReadStatus: "UNAVAILABLE" });
		expect(h.handle).toHaveBeenCalledExactlyOnceWith(
			row.workflowId,
			"example-run",
		);
		expect(h.result).not.toHaveBeenCalled();
	});
	it.each([
		"version",
		"executionId",
		"organizationId",
		"userId",
		"requestHash",
	])("requires exact admission identity %s", async (field) => {
		h.describe.mockResolvedValue({
			...description,
			memo: {
				fabricAgentAdmission: { ...memo, [field]: "example-foreign" },
			},
		});
		expect(await readNativeExecutionState(row)).toEqual({
			nativeReadStatus: "IDENTITY_UNVERIFIED",
		});
		expect(h.result).not.toHaveBeenCalled();
		expect(h.query).not.toHaveBeenCalled();
	});
	it("does not read a missing-run legacy record without an admission", async () => {
		h.admission.mockReturnValue(null);
		expect(await readNativeExecutionState(row)).toEqual({
			nativeReadStatus: "IDENTITY_UNVERIFIED",
		});
		expect(h.client).not.toHaveBeenCalled();
	});
	it("allows an exact stored legacy native run without inventing an admission", async () => {
		h.admission.mockReturnValue(null);
		h.describe.mockResolvedValue({ ...description, memo: undefined });
		expect(
			await readNativeExecutionState({ ...row, runId: "example-run" }),
		).toMatchObject({ status: "COMPLETED" });
	});
	it("refuses the wrong workflow implementation", async () => {
		h.describe.mockResolvedValue({
			...description,
			type: "exampleOtherWorkflow",
		});
		expect(await readNativeExecutionState(row)).toEqual({
			nativeReadStatus: "IDENTITY_UNVERIFIED",
		});
	});
	it("reads running progress without awaiting the result", async () => {
		h.describe.mockResolvedValue({
			...description,
			closeTime: undefined,
			status: { name: "RUNNING" },
		});
		expect(await readNativeExecutionState(row)).toMatchObject({
			status: "RUNNING",
			progress: { phase: "executing_agent" },
		});
		expect(h.result).not.toHaveBeenCalled();
	});
	it("keeps verified running status if an older history lacks a query handler", async () => {
		h.describe.mockResolvedValue({
			...description,
			status: { name: "RUNNING" },
		});
		h.query.mockRejectedValue(new Error("Query not registered"));
		expect(await readNativeExecutionState(row)).toMatchObject({
			status: "RUNNING",
			nativeReadStatus: "AVAILABLE",
		});
	});
	it.each([
		["FAILED", "FAILED"],
		["CANCELLED", "CANCELLED"],
		["TERMINATED", "CANCELLED"],
		["TIMED_OUT", "TIMED_OUT"],
	])(
		"maps native closed %s to %s without claiming business completion",
		async (closed, status) => {
			h.describe.mockResolvedValue({
				...description,
				status: { name: closed },
			});
			expect(await readNativeExecutionState(row)).toMatchObject({
				status,
				nativeReadStatus: "AVAILABLE",
			});
			expect(h.result).not.toHaveBeenCalled();
		},
	);
	it.each(["FAILED", "CANCELLED", "MAX_ITERATIONS_REACHED"])(
		"respects %s in a completed workflow result",
		async (status) => {
			h.result.mockResolvedValue({
				executionId: row.executionId,
				status,
				error: "Example business failure",
			});
			expect(await readNativeExecutionState(row)).toMatchObject({
				status: status === "MAX_ITERATIONS_REACHED" ? "FAILED" : status,
				error: "Example business failure",
			});
		},
	);
	it("retains the full goal-oriented response and verification result", async () => {
		h.admission.mockReturnValue({
			requestHash: memo.requestHash,
			dispatch: { workflowType: "goalOrientedAgentWorkflow" },
		});
		h.describe.mockResolvedValue({
			...description,
			type: "goalOrientedAgentWorkflow",
		});
		const result = {
			executionId: row.executionId,
			status: "COMPLETED",
			response: "Example goal response",
			goalAchieved: true,
			verificationResult: { achieved: true },
		};
		h.result.mockResolvedValue(result);
		expect(await readNativeExecutionState(row)).toMatchObject({ result });
	});
	it.each([
		"nativeDeploymentExecutionWorkflow",
		"nativeGoalOrientedAgentWorkflow",
	])("observes pinned %s rollout histories", async (workflowType) => {
		h.admission.mockReturnValue({
			requestHash: memo.requestHash,
			dispatch: { workflowType },
		});
		h.describe.mockResolvedValue({ ...description, type: workflowType });
		expect(await readNativeExecutionState(row)).toMatchObject({
			status: "COMPLETED",
			nativeReadStatus: "AVAILABLE",
		});
	});
	it.each([
		{ status: "COMPLETED", executionId: "example-foreign" },
		{ status: "ready", executionId: row.executionId },
	])(
		"never treats a foreign or malformed result as successful",
		async (result) => {
			h.result.mockResolvedValue(result);
			expect(await readNativeExecutionState(row)).toMatchObject({
				status: "UNKNOWN",
				nativeReadStatus: "RESULT_UNAVAILABLE",
			});
		},
	);
	it("does not expose oversized native payloads", async () => {
		h.result.mockResolvedValue({
			executionId: row.executionId,
			status: "COMPLETED",
			output: "x".repeat(1_048_576),
		});
		expect(await readNativeExecutionState(row)).toMatchObject({
			status: "UNKNOWN",
			nativeReadStatus: "RESULT_UNAVAILABLE",
		});
	});
	it("labels missing or expired history without claiming the job never started", async () => {
		h.describe.mockRejectedValue(
			new WorkflowNotFoundError("No retained history", row.workflowId),
		);
		expect(await readNativeExecutionState(row)).toEqual({
			nativeReadStatus: "NOT_FOUND",
		});
	});
	it("sanitizes transport failures", async () => {
		h.describe.mockRejectedValue(new Error("secret=example-private"));
		expect(await readNativeExecutionState(row)).toEqual({
			nativeReadStatus: "UNAVAILABLE",
		});
	});
	it("bounds waiting for an unavailable Temporal connection", async () => {
		vi.useFakeTimers();
		h.client.mockReturnValue(new Promise(() => {}));
		const read = readNativeExecutionState(row);
		await vi.advanceTimersByTimeAsync(3001);
		expect(await read).toEqual({ nativeReadStatus: "UNAVAILABLE" });
		expect(h.handle).not.toHaveBeenCalled();
	});
});
