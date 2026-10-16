/**
 * An agent turn runs for minutes, so the executor sends `agent-task` nodes
 * through their own activity proxy (longer timeout, no retry) and tells every
 * node which workflow it belongs to. Same technique as
 * `workflow-builder-retry-policy.test.ts`: the `proxyActivities` mock returns a
 * different `executeWorkflowNode` per timeout, so "which proxy" is the
 * assertion.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { ordinaryNode, agentNode, updateStatus, createLog, getDefinition } =
	vi.hoisted(() => ({
		ordinaryNode: vi.fn(),
		agentNode: vi.fn(),
		updateStatus: vi.fn(),
		createLog: vi.fn(),
		getDefinition: vi.fn(),
	}));

vi.mock("@temporalio/workflow", () => ({
	sleep: vi.fn(async () => undefined),
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
	isCancellation: () => false,
	patched: () => true,
	CancellationScope: {
		nonCancellable: async (fn: () => Promise<unknown>) => await fn(),
	},
	proxyActivities: (opts: { startToCloseTimeout?: string }) => ({
		executeWorkflowNode:
			opts?.startToCloseTimeout === "20 minutes"
				? agentNode
				: ordinaryNode,
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

async function run(nodes: ReturnType<typeof node>[], edges: unknown[] = []) {
	return await workflowBuilderExecutionWorkflow({
		executionId: "exec-1",
		workflowId: "wf-1",
		userId: "user-1",
		organizationId: "org-1",
		skipPreflightValidation: true,
		nodes: nodes as never,
		edges: edges as never,
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	const ok = { success: true, output: {} };
	ordinaryNode.mockResolvedValue(ok);
	agentNode.mockResolvedValue(ok);
	updateStatus.mockResolvedValue(undefined);
	createLog.mockResolvedValue(undefined);
});

describe("workflowBuilderExecutionWorkflow agent-task routing", () => {
	it("sends agent-task nodes through the long-running proxy", async () => {
		await run(
			[
				node("n1", "trigger"),
				node("n2", "agent-task"),
				node("n3", "publish-frame"),
			],
			[
				{ id: "e1", source: "n1", target: "n2" },
				{ id: "e2", source: "n2", target: "n3" },
			],
		);

		expect(agentNode).toHaveBeenCalledOnce();
		expect(agentNode.mock.calls[0][0]).toMatchObject({
			nodeType: "agent-task",
		});
		expect(ordinaryNode.mock.calls.map(([call]) => call.nodeType)).toEqual([
			"trigger",
			"publish-frame",
		]);
	});

	it("tells every node which workflow and run it belongs to", async () => {
		await run(
			[node("n1", "trigger"), node("n2", "agent-task")],
			[{ id: "e1", source: "n1", target: "n2" }],
		);

		for (const [call] of [
			...ordinaryNode.mock.calls,
			...agentNode.mock.calls,
		]) {
			expect(call).toMatchObject({
				workflowId: "wf-1",
				executionId: "exec-1",
				organizationId: "org-1",
			});
		}
	});
});
