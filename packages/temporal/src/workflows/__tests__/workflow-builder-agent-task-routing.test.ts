/**
 * An agent turn runs for minutes, so the executor sends `agent-task` nodes
 * through their own activity proxy (longer timeout, no retry) and tells every
 * node which workflow it belongs to. Same technique as
 * `workflow-builder-retry-policy.test.ts`: the `proxyActivities` mock returns a
 * different `executeWorkflowNode` per timeout, so "which proxy" is the
 * assertion.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { providedWorkflowGraph } from "../../../__tests__/test-helpers/workflow-builder-graph";

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

async function run(
	nodes: ReturnType<typeof node>[],
	edges: unknown[] = [],
	triggerData?: Record<string, unknown>,
) {
	return await workflowBuilderExecutionWorkflow({
		executionId: "exec-1",
		workflowId: "wf-1",
		userId: "user-1",
		organizationId: "org-1",
		skipPreflightValidation: true,
		nodes: nodes as never,
		edges: edges as never,
		triggerData,
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	getDefinition.mockImplementation(providedWorkflowGraph);
	const ok = { success: true, output: {} };
	ordinaryNode.mockResolvedValue(ok);
	agentNode.mockResolvedValue(ok);
	updateStatus.mockResolvedValue(undefined);
	createLog.mockResolvedValue(undefined);
});

describe("workflowBuilderExecutionWorkflow agent-task routing", () => {
	it("resolves the graph through the execution-scoped definition activity", async () => {
		const nodes = [node("n1", "trigger")];
		await run(nodes);
		expect(getDefinition).toHaveBeenCalledWith({
			workflowId: "wf-1",
			executionId: "exec-1",
			userId: "user-1",
			organizationId: "org-1",
			override: { nodes, edges: [] },
		});
	});
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
			expect(call).not.toHaveProperty("frameId");
		}
	});

	it("forwards the definition activity's Workspace origin through both activity proxies", async () => {
		getDefinition.mockImplementation(async (request) => ({
			...(await providedWorkflowGraph(request)),
			usageFrameId: "workspace",
		}));
		await run(
			[node("n1", "trigger"), node("n2", "agent-task")],
			[{ id: "e1", source: "n1", target: "n2" }],
		);
		expect(getDefinition).toHaveBeenCalledOnce();
		for (const [call] of [
			...ordinaryNode.mock.calls,
			...agentNode.mock.calls,
		]) {
			expect(call.frameId).toBe("workspace");
		}
	});

	it("does not derive an origin from trigger data or editable node config in historical definitions", async () => {
		const trigger = node("n1", "trigger");
		trigger.data.config = { frameId: "spoofed", usageFrameId: "spoofed" };
		await run([trigger], [], {
			frameId: "spoofed",
			usageFrameId: "spoofed",
			workspaceWorkflowBinding: { workspaceFrameId: "spoofed" },
		});
		expect(getDefinition).toHaveBeenCalledOnce();
		expect(ordinaryNode).toHaveBeenCalledExactlyOnceWith({
			executionId: "exec-1",
			workflowId: "wf-1",
			nodeId: "n1",
			nodeType: "trigger",
			nodeConfig: trigger.data.config,
			inputs: expect.any(Object),
			userId: "user-1",
			organizationId: "org-1",
			projectId: undefined,
		});
	});
});
