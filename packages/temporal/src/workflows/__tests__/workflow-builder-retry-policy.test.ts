/**
 * Nodes that write to an external source must not be auto-retried: a step
 * reports business failures by RETURNING `{ success: false }`, so a thrown
 * error means an infrastructure failure — the case where the remote write may
 * already have landed and a retry would duplicate the ticket / message.
 *
 * Repo convention (see `document-refresh-dispatcher.test.ts`) is to mock the
 * activity surface and drive the workflow body directly rather than pull
 * Temporalite into CI. Here the `proxyActivities` mock hands back a different
 * `executeWorkflowNode` per retry policy, so the assertion is literally "which
 * proxy did this node go through".
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { patchedFlag } = vi.hoisted(() => ({
	patchedFlag: { value: true },
}));

const {
	retryingNode,
	nonRetryingNode,
	updateStatus,
	createLog,
	getDefinition,
} = vi.hoisted(() => ({
	retryingNode: vi.fn(),
	nonRetryingNode: vi.fn(),
	updateStatus: vi.fn(),
	createLog: vi.fn(),
	getDefinition: vi.fn(),
}));

vi.mock("@temporalio/workflow", () => ({
	sleep: vi.fn(async () => undefined),
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
	isCancellation: (err: unknown) =>
		err instanceof Error && err.name === "CancelledFailure",
	// Default to the post-patch path; the scheduler suite flips this to cover
	// the legacy walk that recorded histories still replay through.
	patched: () => patchedFlag.value,
	CancellationScope: {
		// The real scope shields the status write from the cancellation that
		// is unwinding the workflow; for the workflow body's purposes it just
		// runs the callback.
		nonCancellable: async (fn: () => Promise<unknown>) => await fn(),
	},
	proxyActivities: (opts: { retry?: { maximumAttempts?: number } }) => ({
		executeWorkflowNode:
			opts?.retry?.maximumAttempts === 1 ? nonRetryingNode : retryingNode,
		updateWorkflowExecutionStatus: updateStatus,
		createWorkflowExecutionLog: createLog,
		getWorkflowDefinition: getDefinition,
		validateWorkflowGraph: vi.fn(),
		preflightValidation: vi.fn(),
		createApprovalRequest: vi.fn(),
		waitForApproval: vi.fn(),
	}),
}));

import { workflowBuilderExecutionWorkflow } from "../workflow-builder-execution";

function node(id: string, type: string) {
	return { id, type, data: { config: {} }, position: { x: 0, y: 0 } };
}

function edge(source: string, target: string) {
	return { id: `${source}->${target}`, source, target };
}

async function run(nodes: ReturnType<typeof node>[], edges = [] as unknown[]) {
	return await workflowBuilderExecutionWorkflow({
		executionId: "exec-1",
		workflowId: "wf-1",
		userId: "user-1",
		// Pre-flight runs its own activities and is exercised elsewhere; this
		// test is about which proxy dispatches the node.
		skipPreflightValidation: true,
		nodes: nodes as never,
		edges: edges as never,
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	const ok = { success: true, output: {} };
	retryingNode.mockResolvedValue(ok);
	nonRetryingNode.mockResolvedValue(ok);
	updateStatus.mockResolvedValue(undefined);
	createLog.mockResolvedValue(undefined);
});

describe("workflowBuilderExecutionWorkflow retry routing", () => {
	it("sends external writes through the no-retry proxy", async () => {
		await run(
			[node("n1", "trigger"), node("n2", "slack-send")],
			[edge("n1", "n2")],
		);

		expect(nonRetryingNode).toHaveBeenCalledOnce();
		expect(nonRetryingNode.mock.calls[0][0]).toMatchObject({
			nodeType: "slack-send",
		});
	});

	it("keeps retries for reads and internal steps", async () => {
		await run(
			[
				node("n1", "trigger"),
				node("n2", "http-request"),
				node("n3", "linear-find-issues"),
			],
			[edge("n1", "n2"), edge("n2", "n3")],
		);

		expect(nonRetryingNode).not.toHaveBeenCalled();
		expect(retryingNode).toHaveBeenCalledTimes(3);
	});

	it("routes legacy bare node types by their resolved type", async () => {
		await run(
			// "create-ticket" is the pre-rename Freshservice write.
			[node("n1", "trigger"), node("n2", "create-ticket")],
			[edge("n1", "n2")],
		);

		expect(nonRetryingNode).toHaveBeenCalledOnce();
		expect(nonRetryingNode.mock.calls[0][0]).toMatchObject({
			nodeType: "create-ticket",
		});
	});

	it("treats mcp-tool as non-retryable — it may dispatch a write", async () => {
		await run(
			[node("n1", "trigger"), node("n2", "mcp-tool")],
			[edge("n1", "n2")],
		);

		expect(nonRetryingNode).toHaveBeenCalledOnce();
	});
});

describe("cancellation", () => {
	function cancelled() {
		const err = new Error("Workflow cancelled");
		err.name = "CancelledFailure";
		return err;
	}

	it("records CANCELLED rather than FAILED", async () => {
		retryingNode.mockRejectedValueOnce(cancelled());

		const result = await run([node("n1", "trigger")], []);

		expect(result.status).toBe("CANCELLED");
		expect(updateStatus).toHaveBeenCalledWith(
			expect.objectContaining({ status: "CANCELLED" }),
		);
	});

	it("keeps the outputs of nodes that already finished", async () => {
		// First node succeeds, then cancellation lands on the second.
		retryingNode
			.mockResolvedValueOnce({ success: true, output: { a: 1 } })
			.mockRejectedValueOnce(cancelled());

		const result = await run(
			[node("n1", "trigger"), node("n2", "http-request")],
			[edge("n1", "n2")],
		);

		expect(result.status).toBe("CANCELLED");
		expect(result.outputs).toMatchObject({ n1: { a: 1 } });
		expect(updateStatus).toHaveBeenCalledWith(
			expect.objectContaining({
				status: "CANCELLED",
				output: expect.objectContaining({ n1: { a: 1 } }),
			}),
		);
	});

	it("still records FAILED for an ordinary error", async () => {
		retryingNode.mockRejectedValueOnce(new Error("boom"));

		const result = await run([node("n1", "trigger")], []);

		expect(result.status).toBe("FAILED");
		expect(result.error).toContain("boom");
	});
});
