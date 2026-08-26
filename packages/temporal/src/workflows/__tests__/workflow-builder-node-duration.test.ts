/**
 * Per-node duration has to be written, not just rendered.
 *
 * The column existed, `updateExecutionLog` accepted it, and the execution
 * panel displayed it and summed it into a total — but the workflow never sent
 * it. Every node read null, so every per-node timing was blank and the panel's
 * total was a sum of zeroes. Nothing failed, which is why it survived: the only
 * symptom was a number that was always 0.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { nodeMock, updateStatus, createLog } = vi.hoisted(() => ({
	nodeMock: vi.fn(),
	updateStatus: vi.fn(),
	createLog: vi.fn(),
}));

vi.mock("@temporalio/workflow", () => ({
	sleep: vi.fn(async () => undefined),
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
	patched: () => true,
	isCancellation: () => false,
	CancellationScope: {
		nonCancellable: async (fn: () => Promise<unknown>) => await fn(),
	},
	proxyActivities: () => ({
		executeWorkflowNode: nodeMock,
		updateWorkflowExecutionStatus: updateStatus,
		createWorkflowExecutionLog: createLog,
		getWorkflowDefinition: vi.fn(),
		validateWorkflowGraph: vi.fn(),
		preflightValidation: vi.fn(),
		createApprovalRequest: vi.fn(),
		waitForApproval: vi.fn(),
	}),
}));

import { workflowBuilderExecutionWorkflow } from "../workflow-builder-execution";

const nodes = [
	{
		id: "trigger-1",
		type: "trigger",
		data: { label: "Trigger", config: {} },
		position: { x: 0, y: 0 },
	},
	{
		id: "step-1",
		type: "http-request",
		data: { label: "Fetch", config: {} },
		position: { x: 250, y: 0 },
	},
];
const edges = [{ id: "e1", source: "trigger-1", target: "step-1" }];

async function run() {
	return await workflowBuilderExecutionWorkflow({
		executionId: "exec-1",
		workflowId: "wf-1",
		userId: "user-1",
		skipPreflightValidation: true,
		nodes: nodes as never,
		edges: edges as never,
	});
}

/** The closing log call for a node — the one that carries the outcome. */
function closingCall(nodeId: string) {
	const calls = createLog.mock.calls
		.map((c) => c[0])
		.filter((c) => c.nodeId === nodeId && c.status !== "RUNNING");
	expect(calls).toHaveLength(1);
	return calls[0];
}

beforeEach(() => {
	vi.clearAllMocks();
	updateStatus.mockResolvedValue(undefined);
	createLog.mockResolvedValue(undefined);
});

describe("per-node timing", () => {
	it("records a duration when the node succeeds", async () => {
		nodeMock.mockResolvedValue({ success: true, output: {} });

		await run();

		expect(closingCall("step-1").duration).toEqual(expect.any(Number));
	});

	it("records a duration when the node fails", async () => {
		// A failed node is the one you most want a timing for — a step that
		// burned nine minutes before erroring reads very differently from one
		// that failed immediately.
		nodeMock.mockImplementation(async (args: { nodeId: string }) =>
			args.nodeId === "step-1"
				? { success: false, error: "boom" }
				: { success: true, output: {} },
		);

		const result = await run();

		expect(result.status).toBe("FAILED");
		expect(closingCall("step-1").duration).toEqual(expect.any(Number));
	});

	it("records the node's own config as the log input, not the whole context", async () => {
		// The obvious patch was to pass `nodeInputs`, which carries every
		// earlier node's output — quadratic per node against a 200-node
		// ceiling. The config is bounded by what the author typed and is what
		// makes a run reproducible.
		nodeMock.mockResolvedValue({ success: true, output: {} });

		await run();

		const opening = createLog.mock.calls
			.map((c) => c[0])
			.find((c) => c.nodeId === "step-1" && c.status === "RUNNING");

		expect(opening.input).toEqual({});
		expect(opening.input).not.toHaveProperty("Trigger");
	});

	it("does not put a duration on the opening call", async () => {
		nodeMock.mockResolvedValue({ success: true, output: {} });

		await run();

		const opening = createLog.mock.calls
			.map((c) => c[0])
			.filter((c) => c.status === "RUNNING");

		expect(opening.length).toBeGreaterThan(0);
		for (const call of opening) {
			expect(call.duration).toBeUndefined();
		}
	});
});
