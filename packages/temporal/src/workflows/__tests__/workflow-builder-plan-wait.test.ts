/**
 * A workflow-builder node that runs on a ChatGPT plan (Fizzy #2770 D3) waits
 * out a spent plan in the real execution workflow: the text step throws the
 * refusal to the workflow, which sleeps until the estimated reset and runs the
 * node once more. A model the plan does not serve is a failed node — no
 * estimate, no timer. (The image step never waits: its only plan call is an
 * optional prompt enhancement, which it skips instead.)
 *
 * Time-skipping makes the hours pass instantly; the step activity is a stub.
 */

import { resolve } from "node:path";
import { ApplicationFailure } from "@temporalio/common";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import {
	bundleWorkflowCode,
	Worker,
	type WorkflowBundleWithSourceMap,
} from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const WORKFLOW_PATH = resolve(__dirname, "..", "workflow-builder-execution.ts");
const HOUR = 60 * 60_000;

let env: TestWorkflowEnvironment;
let bundle: WorkflowBundleWithSourceMap;
let taskQueueSeq = 0;

beforeAll(async () => {
	env = await TestWorkflowEnvironment.createTimeSkipping();
	bundle = await bundleWorkflowCode({ workflowsPath: WORKFLOW_PATH });
}, 180_000);

afterAll(async () => {
	await env?.teardown();
});

type NodeResult = { success: boolean; output?: unknown; error?: string };

async function run(nodeType: string, attempts: Array<() => NodeResult>) {
	const taskQueue = `builder-plan-wait-${++taskQueueSeq}`;
	let calls = 0;
	const estimates: unknown[] = [];
	const worker = await Worker.create({
		connection: env.nativeConnection,
		taskQueue,
		workflowBundle: bundle,
		activities: {
			executeWorkflowNode: async () => {
				const attempt = attempts[calls++];
				if (!attempt) {
					throw new Error("called too often");
				}
				return attempt();
			},
			updateWorkflowExecutionStatus: async () => undefined,
			createWorkflowExecutionLog: async () => undefined,
			estimatePlanPoolResetActivity: async (input: unknown) => {
				estimates.push(input);
				return { waitMs: 2 * HOUR, jitterMs: 0 };
			},
		},
	});
	const handle = await env.client.workflow.start(
		"workflowBuilderExecutionWorkflow",
		{
			taskQueue,
			workflowId: `${taskQueue}-wf`,
			args: [
				{
					executionId: "exec-1",
					workflowId: "wf-1",
					userId: "user-1",
					organizationId: "org-1",
					skipPreflightValidation: true,
					nodes: [
						{
							id: "n1",
							type: nodeType,
							data: { config: {} },
							position: { x: 0, y: 0 },
						},
					],
					edges: [],
				},
			],
		},
	);
	const startedAt = await env.currentTimeMs();
	const output = await worker.runUntil(handle.result());
	const elapsedMs = (await env.currentTimeMs()) - startedAt;
	const history = await handle.fetchHistory();
	const timers =
		history.events?.filter((event) => event.timerStartedEventAttributes)
			.length ?? 0;
	return { output, calls: () => calls, estimates, elapsedMs, timers };
}

const spent = () => {
	throw ApplicationFailure.nonRetryable(
		"Every ChatGPT plan this work may use has no usage left in this window.",
		"SubscriptionPlanExhaustedError",
	);
};

describe("workflowBuilderExecutionWorkflow — a spent ChatGPT plan", () => {
	it.each(["ai-generate-text"])(
		"%s waits for the reset, then runs the node once more",
		async (nodeType) => {
			const { output, calls, estimates, elapsedMs, timers } = await run(
				nodeType,
				[spent, () => ({ success: true, output: { ok: true } })],
			);
			expect(output.status).toBe("COMPLETED");
			expect(calls()).toBe(2);
			expect(estimates).toEqual([
				{ organizationId: "org-1", userId: "user-1" },
			]);
			expect(timers).toBe(1);
			expect(elapsedMs).toBeGreaterThanOrEqual(2 * HOUR);
		},
		60_000,
	);

	it("fails a node whose model the plan does not serve, without waiting", async () => {
		const { output, calls, estimates, timers } = await run(
			"ai-generate-text",
			[
				() => ({
					success: false,
					error: "The ChatGPT plan does not serve gpt-5.6-luna.",
				}),
			],
		);
		expect(output.status).toBe("FAILED");
		expect(output.error).toContain("does not serve gpt-5.6-luna");
		expect(calls()).toBe(1);
		expect(estimates).toEqual([]);
		expect(timers).toBe(0);
	}, 60_000);
});
