/**
 * What a node can address when it reads earlier output.
 *
 * Two forms are documented: `{{Node Label.field}}` and `{{$nodeId.field}}`.
 * They looked interchangeable, but only labels were injected for every earlier
 * node — the `$id` key was added for direct predecessors alone. Two steps down
 * a chain, `{{$firstNode.field}}` therefore resolved to nothing, and because an
 * unresolved reference becomes an empty string rather than an error, the value
 * just went missing. The id form is the one worth recommending, since it is the
 * one that survives renaming a node, so it is the one that has to reach.
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

function node(id: string, label: string, type = "http-request") {
	return {
		id,
		type,
		data: { label, config: {} },
		position: { x: 0, y: 0 },
	};
}

/** A → B → C, so C sees A only through the "every earlier node" path. */
const chain = {
	nodes: [
		node("trigger-1", "Trigger", "trigger"),
		node("first", "First Step"),
		node("second", "Second Step"),
		node("third", "Third Step"),
	],
	edges: [
		{ id: "e1", source: "trigger-1", target: "first" },
		{ id: "e2", source: "first", target: "second" },
		{ id: "e3", source: "second", target: "third" },
	],
};

/** The inputs the named node was invoked with. */
function inputsFor(nodeId: string): Record<string, unknown> {
	const call = nodeMock.mock.calls.find((c) => c[0].nodeId === nodeId);
	if (!call) {
		throw new Error(`${nodeId} never ran`);
	}
	return call[0].inputs as Record<string, unknown>;
}

beforeEach(() => {
	vi.clearAllMocks();
	nodeMock.mockImplementation(async (args: { nodeId: string }) => ({
		success: true,
		output: { ranAs: args.nodeId },
	}));
	updateStatus.mockResolvedValue(undefined);
	createLog.mockResolvedValue(undefined);
});

describe("addressing an earlier node", () => {
	it("reaches a non-adjacent node by id, not only by label", async () => {
		await workflowBuilderExecutionWorkflow({
			executionId: "exec-1",
			workflowId: "wf-1",
			userId: "user-1",
			skipPreflightValidation: true,
			nodes: chain.nodes as never,
			edges: chain.edges as never,
		});

		const third = inputsFor("third");

		// Two hops back: the label form always worked, the id form did not.
		expect(third["First Step"]).toEqual({ ranAs: "first" });
		expect(third.$first).toEqual({ ranAs: "first" });
	});

	it("still reaches the direct predecessor both ways", async () => {
		await workflowBuilderExecutionWorkflow({
			executionId: "exec-1",
			workflowId: "wf-1",
			userId: "user-1",
			skipPreflightValidation: true,
			nodes: chain.nodes as never,
			edges: chain.edges as never,
		});

		const third = inputsFor("third");

		expect(third["Second Step"]).toEqual({ ranAs: "second" });
		expect(third.$second).toEqual({ ranAs: "second" });
	});

	it("does not offer a node that has not run yet", async () => {
		await workflowBuilderExecutionWorkflow({
			executionId: "exec-1",
			workflowId: "wf-1",
			userId: "user-1",
			skipPreflightValidation: true,
			nodes: chain.nodes as never,
			edges: chain.edges as never,
		});

		const first = inputsFor("first");

		expect(first).not.toHaveProperty("$second");
		expect(first).not.toHaveProperty("Second Step");
	});
});
