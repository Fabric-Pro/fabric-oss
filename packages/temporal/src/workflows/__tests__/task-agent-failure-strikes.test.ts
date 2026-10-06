/**
 * The task agent's stop after repeated tool failures (Fizzy #2931).
 *
 * The workflow counted every failed tool call toward its five-failure stop and
 * checked the count inside the turn's tool-call loop, so one turn in which the
 * model fired five parallel calls with the same bad argument failed the plan
 * mid-turn. Under `task-agent-failure-strike-per-turn-v1` a turn whose calls
 * all failed earns one strike, a turn with any successful call clears the
 * count, and five such turns in a row stop the plan once the fifth turn's
 * calls have all run.
 *
 * The final status (Fizzy #2933): a run with no artifact fails only on a
 * failed call that no later turn retried past with the same tool.
 *
 * Runs the real workflow in a time-skipping test environment with stubbed
 * activities. The legacy bundle is the same source with the marker replaced
 * by `false`, which records the histories an execution started before this
 * change has, and those histories are replayed against the current code.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ApplicationFailure } from "@temporalio/common";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import {
	bundleWorkflowCode,
	Worker,
	type WorkflowBundleWithSourceMap,
} from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
	TaskAgentWorkflowInput,
	TaskAgentWorkflowOutput,
} from "../task-agent-workflow";

const WORKFLOWS_PATH = resolve(__dirname, "..");
const WORKFLOW_NAME = "taskAgentWorkflow";
const PATCH_ID = "task-agent-failure-strike-per-turn-v1";

let env: TestWorkflowEnvironment;
let workflowBundle: WorkflowBundleWithSourceMap;
let legacyBundle: WorkflowBundleWithSourceMap;
/** The current source with the final status taken from every failed call. */
let anyFailureBundle: WorkflowBundleWithSourceMap;
let taskQueueSeq = 0;

beforeAll(async () => {
	env = await TestWorkflowEnvironment.createTimeSkipping();
	workflowBundle = await bundleWorkflowCode({
		workflowsPath: WORKFLOWS_PATH,
	});
	const dir = mkdtempSync(join(WORKFLOWS_PATH, ".task-agent-replay-"));
	try {
		const original = readFileSync(
			join(WORKFLOWS_PATH, "task-agent-workflow.ts"),
			"utf8",
		);
		const source = original.replace(
			"patched(FAILURE_STRIKE_PER_TURN_PATCH)",
			"false",
		);
		if (source === original || source.includes("patched(")) {
			throw new Error(`${PATCH_ID} is not evaluated exactly once`);
		}
		writeFileSync(join(dir, "workflow.ts"), source);
		legacyBundle = await bundleWorkflowCode({
			workflowsPath: join(dir, "workflow.ts"),
		});

		const anyFailure = original.replace(
			"hasArtifacts || unrecoveredFailures.length === 0",
			"hasArtifacts || failedSteps.length === 0",
		);
		if (anyFailure === original) {
			throw new Error("the final-status rule was not found");
		}
		writeFileSync(join(dir, "any-failure.ts"), anyFailure);
		anyFailureBundle = await bundleWorkflowCode({
			workflowsPath: join(dir, "any-failure.ts"),
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}, 180_000);

afterAll(async () => {
	await env?.teardown();
});

interface ToolCall {
	id: string;
	name: string;
	args: Record<string, unknown>;
}

/** One scripted model turn: the calls it fires, or none to finish. */
type Turn = ToolCall[];

const BAD_REF = "missing-branch";

function read(id: string, ref: string): ToolCall {
	return {
		id,
		name: "GitHub__get_file_contents",
		args: { path: "src/flags.ts", ref },
	};
}

/** A different tool from `read`, failing on the bad ref the same way. */
function listCommits(id: string, ref: string): ToolCall {
	return { id, name: "GitHub__list_commits", args: { ref } };
}

/** A turn of `count` parallel reads, all with the bad ref. */
function failingTurn(turn: number, count: number): Turn {
	return Array.from({ length: count }, (_, i) =>
		read(`t${turn}-c${i}`, BAD_REF),
	);
}

/** A turn that asks for approval, then makes the given calls. */
function approvalTurn(turn: number, ...calls: ToolCall[]): Turn {
	return [
		{
			id: `t${turn}-approval`,
			name: "request_approval",
			args: { tool: "Example", action: "Confirm the ref", data: {} },
		},
		...calls,
	];
}

const INPUT: TaskAgentWorkflowInput = {
	planId: "plan-1",
	taskId: "task-1",
	projectId: "project-1",
	userId: "user-1",
	organizationId: "org-1",
	taskTitle: "Check the launch flag",
	taskDescription: "Read src/flags.ts and report the launch flag.",
};

interface Run {
	toolCalls: string[];
	agentTurns: number;
	result?: TaskAgentWorkflowOutput;
	error?: unknown;
	workflowId: string;
	/** The last plan update that set a final status. */
	finalPlan?: {
		status: string;
		result?: { success?: boolean; warnings?: unknown[] };
	};
}

function scriptedActivities(turns: Turn[], run: Run) {
	return {
		initializeWorkflowPlan: async () => undefined,
		updateWorkflowPlan: async (update: NonNullable<Run["finalPlan"]>) => {
			if (update.status === "completed" || update.status === "failed") {
				run.finalPlan = update;
			}
		},
		addWorkflowLog: async () => undefined,
		broadcastProgress: async () => undefined,
		loadMcpConfiguration: async () => ({ servers: [], tools: [] }),
		retrieveProjectContexts: async () => [],
		executeAgentTurn: async () => {
			const calls = turns[run.agentTurns] ?? [];
			run.agentTurns += 1;
			return calls.length > 0
				? {
						response: "",
						summary: "Reading the file",
						toolCalls: calls,
						stopReason: "tool_use",
					}
				: { response: "Done", summary: "Done", stopReason: "end_turn" };
		},
		executeTaskAgentTool: async (input: {
			toolName: string;
			args: Record<string, unknown>;
		}) => {
			run.toolCalls.push(String(input.args.ref));
			if (input.args.ref === BAD_REF) {
				throw ApplicationFailure.nonRetryable(
					`No commit found for the ref ${BAD_REF}`,
					"TOOL_ERROR",
				);
			}
			return { content: "export const launchFlag = true;" };
		},
	};
}

async function settle(
	handle: Awaited<ReturnType<typeof env.client.workflow.start>>,
	run: Run,
): Promise<Run> {
	try {
		run.result = (await handle.result()) as TaskAgentWorkflowOutput;
	} catch (error) {
		run.error = error;
	}
	return run;
}

async function runWorkflow(
	turns: Turn[],
	bundle = workflowBundle,
): Promise<Run> {
	const taskQueue = `task-agent-strikes-${taskQueueSeq++}`;
	const run: Run = {
		toolCalls: [],
		agentTurns: 0,
		workflowId: `${taskQueue}-wf`,
	};
	const worker = await Worker.create({
		connection: env.nativeConnection,
		taskQueue,
		workflowBundle: bundle,
		activities: scriptedActivities(turns, run),
	});

	return worker.runUntil(async () => {
		const handle = await env.client.workflow.start(WORKFLOW_NAME, {
			args: [INPUT],
			taskQueue,
			workflowId: run.workflowId,
		});
		return settle(handle, run);
	});
}

/**
 * An execution in flight at deploy: a worker on the code before this change
 * runs until the first approval wait, then a worker on the current code
 * replays that history, the approval arrives, and the run continues live.
 */
async function runAcrossUpgrade(turns: Turn[]): Promise<Run> {
	const taskQueue = `task-agent-strikes-${taskQueueSeq++}`;
	const run: Run = {
		toolCalls: [],
		agentTurns: 0,
		workflowId: `${taskQueue}-wf`,
	};
	const activities = scriptedActivities(turns, run);

	const before = await Worker.create({
		connection: env.nativeConnection,
		taskQueue,
		workflowBundle: legacyBundle,
		activities,
		// No sticky cache, so the next worker picks up the workflow task.
		maxCachedWorkflows: 0,
	});
	const handle = await before.runUntil(async () => {
		const started = await env.client.workflow.start(WORKFLOW_NAME, {
			args: [INPUT],
			taskQueue,
			workflowId: run.workflowId,
		});
		for (;;) {
			const status = await started.query<{ isAtCheckpoint: boolean }>(
				"status",
			);
			if (status.isAtCheckpoint) {
				return started;
			}
			await new Promise((r) => setTimeout(r, 50));
		}
	});

	const after = await Worker.create({
		connection: env.nativeConnection,
		taskQueue,
		workflowBundle,
		activities,
	});
	return after.runUntil(async () => {
		await handle.signal("resolveCheckpoint", { action: "approve" });
		return settle(handle, run);
	});
}

function stopMessage(error: unknown): string | undefined {
	return (error as { cause?: { message?: string } } | undefined)?.cause
		?.message;
}

async function fetchHistory(workflowId: string) {
	return env.client.workflow.getHandle(workflowId).fetchHistory();
}

describe("taskAgentWorkflow — failure strikes per turn", () => {
	it("keeps going after one turn of five parallel calls that all failed", async () => {
		const { toolCalls, agentTurns, result, error } = await runWorkflow([
			failingTurn(0, 5),
			[read("t1-c0", "main")],
			[],
		]);

		expect(error).toBeUndefined();
		expect(toolCalls).toEqual([...Array(5).fill(BAD_REF), "main"]);
		expect(agentTurns).toBe(3);
		expect(result?.status).toBe("completed");
		expect(result?.error).toBeUndefined();
	}, 120_000);

	it("stops after five turns in a row whose calls all failed, once the fifth turn's calls have run", async () => {
		const { toolCalls, agentTurns, error } = await runWorkflow([
			failingTurn(0, 2),
			failingTurn(1, 2),
			failingTurn(2, 2),
			failingTurn(3, 2),
			failingTurn(4, 3),
			[read("t5-c0", "main")],
		]);

		expect(stopMessage(error)).toBe(
			"Agent stopped after 5 consecutive turns in which every tool call failed",
		);
		expect(agentTurns).toBe(5);
		expect(toolCalls).toHaveLength(11);
	}, 120_000);

	it("clears the count on a turn with any successful call, even one that came before a failure", async () => {
		const { toolCalls, agentTurns, error } = await runWorkflow([
			failingTurn(0, 1),
			failingTurn(1, 1),
			failingTurn(2, 1),
			failingTurn(3, 1),
			[read("t4-c0", "main"), read("t4-c1", BAD_REF)],
			failingTurn(5, 1),
			failingTurn(6, 1),
			failingTurn(7, 1),
			failingTurn(8, 1),
			[],
		]);

		expect(error).toBeUndefined();
		expect(agentTurns).toBe(10);
		expect(toolCalls).toHaveLength(10);
	}, 120_000);

	it("records the marker on a run that calls tools, and replays that history", async () => {
		const { workflowId, error } = await runWorkflow([
			failingTurn(0, 5),
			[read("t1-c0", "main")],
			[],
		]);
		expect(error).toBeUndefined();

		const history = await fetchHistory(workflowId);
		const markers = (history.events ?? []).filter(
			(event) => event.markerRecordedEventAttributes,
		);
		expect(markers).toHaveLength(1);

		await expect(
			Worker.runReplayHistory({ workflowBundle }, history, workflowId),
		).resolves.toBeUndefined();
	}, 120_000);
});

describe("taskAgentWorkflow — final status after failed tool calls (Fizzy #2933)", () => {
	it("completes a run that retried past its failures, and keeps them as warnings", async () => {
		const { result, finalPlan } = await runWorkflow([
			failingTurn(0, 2),
			[read("t1-c0", "main")],
			[],
		]);

		expect(result?.status).toBe("completed");
		expect(result?.error).toBeUndefined();
		expect(finalPlan?.status).toBe("completed");
		expect(finalPlan?.result?.success).toBe(true);
		expect(finalPlan?.result?.warnings).toHaveLength(2);
	}, 120_000);

	it("fails a run whose last failed call was never retried", async () => {
		const { result, finalPlan } = await runWorkflow([
			[read("t0-c0", "main")],
			failingTurn(1, 1),
			[],
		]);

		expect(result?.status).toBe("failed");
		expect(result?.error).toBe("1 tool(s) failed");
		expect(finalPlan?.result?.success).toBe(false);
	}, 120_000);

	it("does not count a success in the same turn as a recovery", async () => {
		const { result } = await runWorkflow([
			[read("t0-c0", "main"), read("t0-c1", BAD_REF)],
			[],
		]);

		expect(result?.status).toBe("failed");
		expect(result?.error).toBe("1 tool(s) failed");
	}, 120_000);

	it("does not count a later success of a different tool as a recovery", async () => {
		const { result } = await runWorkflow([
			[listCommits("t0-c0", BAD_REF), read("t0-c1", BAD_REF)],
			[read("t1-c0", "main")],
			[],
		]);

		expect(result?.status).toBe("failed");
		expect(result?.error).toBe("1 tool(s) failed");
	}, 120_000);

	it("replays a recovered run recorded under the old any-failure status", async () => {
		const { result, workflowId } = await runWorkflow(
			[failingTurn(0, 2), [read("t1-c0", "main")], []],
			anyFailureBundle,
		);
		expect(result?.status).toBe("failed");

		const history = await fetchHistory(workflowId);
		await expect(
			Worker.runReplayHistory({ workflowBundle }, history, workflowId),
		).resolves.toBeUndefined();
	}, 120_000);
});

describe("taskAgentWorkflow — histories recorded without the marker", () => {
	it("the unpatched loop still stops on the fifth failed call, mid-turn", async () => {
		const { toolCalls, error } = await runWorkflow(
			[failingTurn(0, 6), []],
			legacyBundle,
		);

		expect(stopMessage(error)).toBe(
			"Agent stopped after 5 consecutive tool failures",
		);
		expect(toolCalls).toHaveLength(5);
	}, 120_000);

	it("an execution in flight at deploy finishes its open turn on the per-call count", async () => {
		const { toolCalls, error } = await runAcrossUpgrade([
			failingTurn(0, 4),
			approvalTurn(1, read("t1-c1", BAD_REF)),
			[],
		]);

		expect(stopMessage(error)).toBe(
			"Agent stopped after 5 consecutive tool failures",
		);
		expect(toolCalls).toHaveLength(5);
	}, 120_000);

	it("an execution in flight at deploy counts its later turns from zero, not from the per-call count", async () => {
		const { toolCalls, agentTurns, error, workflowId } =
			await runAcrossUpgrade([
				failingTurn(0, 4),
				approvalTurn(1),
				failingTurn(2, 4),
				[],
			]);

		expect(error).toBeUndefined();
		expect(agentTurns).toBe(4);
		expect(toolCalls).toHaveLength(8);

		const history = await fetchHistory(workflowId);
		expect(
			(history.events ?? []).filter(
				(event) => event.markerRecordedEventAttributes,
			),
		).toHaveLength(1);
		await expect(
			Worker.runReplayHistory({ workflowBundle }, history, workflowId),
		).resolves.toBeUndefined();
	}, 120_000);

	it("replays a mid-turn stop, a stop across turns, and a recovered run against the current code", async () => {
		for (const turns of [
			[failingTurn(0, 6), []],
			[failingTurn(0, 2), failingTurn(1, 2), failingTurn(2, 2), []],
			[failingTurn(0, 3), [read("t1-c0", "main")], failingTurn(2, 1), []],
		]) {
			const { workflowId } = await runWorkflow(turns, legacyBundle);
			const history = await fetchHistory(workflowId);
			expect(
				(history.events ?? []).some(
					(event) => event.markerRecordedEventAttributes,
				),
			).toBe(false);

			await expect(
				Worker.runReplayHistory(
					{ workflowBundle },
					history,
					workflowId,
				),
			).resolves.toBeUndefined();
		}
	}, 180_000);
});
