/**
 * How the graph is walked.
 *
 * Independent branches used to run strictly one after another: the scheduler
 * took a single node per iteration and, when its dependencies were not ready,
 * re-queued it behind a 100ms timer. Two branches off the same trigger ran in
 * series, and every not-ready dequeue wrote a timer into workflow history.
 *
 * The wave scheduler runs every ready node concurrently. It changes the order
 * commands are emitted in, so it sits behind `patched()` — histories recorded
 * before it shipped must still replay through the original walk. Both paths
 * are exercised here; the replay gate in CI is what proves the real thing.
 *
 * A second patch, `builder-requeue-guard`, covers what happens when the graph
 * cannot advance — a join behind a condition whose other branch never ran.
 * The wave scheduler used to drop such a node silently; the original walk
 * re-queued it behind a timer forever. Both now record it as SKIPPED and
 * finish. The mock below is keyed by patch id so each can be turned off alone.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { patches, nodeMock, updateStatus, createLog, sleepMock } = vi.hoisted(
	() => ({
		/** Patch ids that read as NOT present — i.e. the pre-patch replay path. */
		patches: { disabled: new Set<string>() },
		nodeMock: vi.fn(),
		updateStatus: vi.fn(),
		createLog: vi.fn(),
		sleepMock: vi.fn(async () => undefined),
	}),
);

const PARALLEL_WALK = "workflow-builder-parallel-walk-v1";
const REQUEUE_GUARD = "builder-requeue-guard";

vi.mock("@temporalio/workflow", () => ({
	sleep: sleepMock,
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
	patched: (id: string) => !patches.disabled.has(id),
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

function node(id: string, type = "http-request", data: object = {}) {
	return {
		id,
		type,
		data: { config: {}, ...data },
		position: { x: 0, y: 0 },
	};
}
function edge(source: string, target: string, sourceHandle?: string) {
	return { id: `${source}->${target}`, source, target, sourceHandle };
}

async function run(nodes: unknown[], edges: unknown[] = []) {
	return await workflowBuilderExecutionWorkflow({
		executionId: "exec-1",
		workflowId: "wf-1",
		userId: "user-1",
		skipPreflightValidation: true,
		nodes: nodes as never,
		edges: edges as never,
	});
}

/** A diamond: A fans out to B and C, both feeding D. */
const diamond = {
	nodes: [node("A", "trigger"), node("B"), node("C"), node("D")],
	edges: [edge("A", "B"), edge("A", "C"), edge("B", "D"), edge("C", "D")],
};

/**
 * A condition whose `true` branch feeds a join that also waits on the `false`
 * branch. Only one branch ever runs, so the join can never become ready.
 */
const conditionJoin = {
	nodes: [
		node("A", "trigger"),
		node("C", "condition"),
		node("T"),
		node("F"),
		node("J"),
	],
	edges: [
		edge("A", "C"),
		edge("C", "T", "true"),
		edge("C", "F", "false"),
		edge("T", "J"),
		edge("F", "J"),
	],
};

/** Node results for `conditionJoin`: the condition takes the `true` branch. */
function conditionTakesTrue() {
	nodeMock.mockImplementation(async (args: { nodeType: string }) =>
		args.nodeType === "condition"
			? { success: true, output: { result: true } }
			: { success: true, output: {} },
	);
}

function skippedLogs() {
	return createLog.mock.calls
		.map((c) => c[0])
		.filter((entry) => entry.status === "SKIPPED");
}

beforeEach(() => {
	vi.clearAllMocks();
	patches.disabled = new Set();
	nodeMock.mockResolvedValue({ success: true, output: {} });
	updateStatus.mockResolvedValue(undefined);
	createLog.mockResolvedValue(undefined);
});

describe("wave scheduler (patched)", () => {
	it("runs independent branches concurrently", async () => {
		// Resolve B and C only once both have been entered — this deadlocks
		// unless they are genuinely in flight at the same time.
		const entered: string[] = [];
		let releaseBoth: () => void = () => {
			// replaced below
		};
		const bothEntered = new Promise<void>((resolve) => {
			releaseBoth = resolve;
		});

		nodeMock.mockImplementation(async (args: { nodeId: string }) => {
			if (args.nodeId === "B" || args.nodeId === "C") {
				entered.push(args.nodeId);
				if (entered.length === 2) {
					releaseBoth();
				}
				await bothEntered;
			}
			return { success: true, output: {} };
		});

		const result = await run(diamond.nodes, diamond.edges);

		expect(result.status).toBe("COMPLETED");
		expect(entered.sort()).toEqual(["B", "C"]);
	});

	it("runs a join node exactly once, after both branches", async () => {
		await run(diamond.nodes, diamond.edges);

		const order = nodeMock.mock.calls.map((c) => c[0].nodeId);
		expect(order.filter((id: string) => id === "D")).toHaveLength(1);
		expect(order.indexOf("D")).toBeGreaterThan(order.indexOf("B"));
		expect(order.indexOf("D")).toBeGreaterThan(order.indexOf("C"));
	});

	it("never sleeps waiting for dependencies", async () => {
		await run(diamond.nodes, diamond.edges);

		expect(sleepMock).not.toHaveBeenCalled();
	});

	it("stops instead of spinning when a graph cannot progress", async () => {
		// B and C depend on each other, so neither is ever ready. The old
		// scheduler re-queued them behind a timer forever.
		const result = await run(
			[node("A", "trigger"), node("B"), node("C")],
			[edge("A", "B"), edge("B", "C"), edge("C", "B")],
		);

		expect(result.status).toBe("COMPLETED");
		expect(nodeMock.mock.calls.map((c) => c[0].nodeId)).toEqual(["A"]);
	});

	describe("a join behind a condition", () => {
		beforeEach(conditionTakesTrue);

		it("completes with the join skipped rather than run or hung", async () => {
			const result = await run(conditionJoin.nodes, conditionJoin.edges);

			expect(result.status).toBe("COMPLETED");
			const ran = nodeMock.mock.calls.map((c) => c[0].nodeId);
			expect(ran).toEqual(["A", "C", "T"]);
			expect(result.executedNodes).toEqual(["A", "C", "T"]);
			expect(sleepMock).not.toHaveBeenCalled();
		});

		it("records the join as SKIPPED naming the dependency that never ran", async () => {
			await run(conditionJoin.nodes, conditionJoin.edges);

			expect(skippedLogs()).toEqual([
				expect.objectContaining({
					executionId: "exec-1",
					nodeId: "J",
					nodeType: "http-request",
					status: "SKIPPED",
					error: expect.stringMatching(
						/unreachable dependency.*\bF\b/,
					),
					userId: "user-1",
				}),
			]);
		});

		it("does not mark the untaken branch itself — it was never queued", async () => {
			await run(conditionJoin.nodes, conditionJoin.edges);

			expect(skippedLogs().map((l) => l.nodeId)).not.toContain("F");
		});

		it("writes no SKIPPED rows while replaying a history recorded before the guard", async () => {
			// The log writes are new commands; a pre-guard history must still
			// replay through the silent break.
			patches.disabled = new Set([REQUEUE_GUARD]);

			const result = await run(conditionJoin.nodes, conditionJoin.edges);

			expect(result.status).toBe("COMPLETED");
			expect(skippedLogs()).toEqual([]);
		});
	});

	it("follows only the matching branch of a condition", async () => {
		nodeMock.mockImplementation(async (args: { nodeType: string }) =>
			args.nodeType === "condition"
				? { success: true, output: { result: true } }
				: { success: true, output: {} },
		);

		await run(
			[node("A", "condition"), node("T"), node("F")],
			[edge("A", "T", "true"), edge("A", "F", "false")],
		);

		const ran = nodeMock.mock.calls.map((c) => c[0].nodeId);
		expect(ran).toContain("T");
		expect(ran).not.toContain("F");
	});

	it("fails the run when a node fails", async () => {
		nodeMock.mockImplementation(async (args: { nodeId: string }) =>
			args.nodeId === "B"
				? { success: false, output: {}, error: "boom" }
				: { success: true, output: {} },
		);

		const result = await run(diamond.nodes, diamond.edges);

		expect(result.status).toBe("FAILED");
		expect(result.error).toContain("boom");
	});
});

describe("disabled nodes", () => {
	it("skips a disabled node but still runs its successors", async () => {
		await run(
			[
				node("A", "trigger"),
				node("B", "http-request", { enabled: false }),
				node("C"),
			],
			[edge("A", "B"), edge("B", "C")],
		);

		const ran = nodeMock.mock.calls.map((c) => c[0].nodeId);
		expect(ran).not.toContain("B");
		expect(ran).toContain("C");
	});

	it("records no output for a skipped node", async () => {
		const result = await run(
			[
				node("A", "trigger"),
				node("B", "http-request", { enabled: false }),
			],
			[edge("A", "B")],
		);

		expect(result.outputs.B).toBeNull();
	});
});

describe("legacy scheduler (unpatched replay path)", () => {
	beforeEach(() => {
		patches.disabled = new Set([PARALLEL_WALK]);
	});

	it("still completes the same graph", async () => {
		const result = await run(diamond.nodes, diamond.edges);

		expect(result.status).toBe("COMPLETED");
		expect(nodeMock.mock.calls.map((c) => c[0].nodeId).sort()).toEqual([
			"A",
			"B",
			"C",
			"D",
		]);
	});

	it("keeps its timer-based wait, which is what recorded histories contain", async () => {
		// A fans out to B and D directly, but D also waits on C behind B. D is
		// therefore dequeued while C is still pending, and the old scheduler
		// re-queues it behind a timer. That timer is in the recorded history
		// and must still be emitted on replay — it is the reason the wave
		// scheduler needed a patch rather than a straight replacement.
		//
		// (The plain diamond does NOT sleep: its queue order happens to reach
		// the join only after both branches are done.)
		await run(
			[node("A", "trigger"), node("B"), node("C"), node("D")],
			[edge("A", "B"), edge("A", "D"), edge("B", "C"), edge("C", "D")],
		);

		expect(sleepMock).toHaveBeenCalled();
	});

	describe("a join behind a condition", () => {
		beforeEach(conditionTakesTrue);

		it("finishes with the join skipped instead of re-queueing it forever", async () => {
			const result = await run(conditionJoin.nodes, conditionJoin.edges);

			expect(result.status).toBe("COMPLETED");
			expect(nodeMock.mock.calls.map((c) => c[0].nodeId)).toEqual([
				"A",
				"C",
				"T",
			]);
			expect(skippedLogs().map((l) => l.nodeId)).toEqual(["J"]);
		});

		it("gives every queued node one full pass before deciding, then stops sleeping", async () => {
			// One not-ready dequeue is normal (a sibling may still be about to
			// run). Only when the whole queue has cycled without progress is
			// the graph stuck — so exactly one timer, not an unbounded stream.
			await run(conditionJoin.nodes, conditionJoin.edges);

			expect(sleepMock).toHaveBeenCalledTimes(1);
		});

		it("skips every stuck node, not just the first one dequeued", async () => {
			// Two joins both waiting on the branch that never ran.
			await run(
				[...conditionJoin.nodes, node("K")],
				[...conditionJoin.edges, edge("T", "K"), edge("F", "K")],
			);

			expect(
				skippedLogs()
					.map((l) => l.nodeId)
					.sort(),
			).toEqual(["J", "K"]);
		});
	});
});
