/**
 * Parlume's meeting notes survive a failed model call: the notes activity
 * rethrows the failure on every attempt but the last, and Temporal's retry
 * policy runs it again. "Regenerate notes" runs the same workflow and tells
 * the activity to write over the notes there are. Once the notes are written
 * the run tells the invitees, and a notice that fails does not fail the run.
 *
 * The activities are stubs on their own queue; time-skipping makes the retry
 * backoff pass at once.
 */

import { resolve } from "node:path";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import {
	bundleWorkflowCode,
	Worker,
	type WorkflowBundleWithSourceMap,
} from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PARLUME_NOTES_MAX_ATTEMPTS } from "../../lib/parlume-notes-retry";
import { PROJECT_OPERATIONS_ACTIVITY_TASK_QUEUE } from "../../task-queues";

const WORKFLOW_PATH = resolve(__dirname, "..", "parlume-notes.ts");

let env: TestWorkflowEnvironment;
let bundle: WorkflowBundleWithSourceMap;
let sequence = 0;

beforeAll(async () => {
	env = await TestWorkflowEnvironment.createTimeSkipping();
	bundle = await bundleWorkflowCode({ workflowsPath: WORKFLOW_PATH });
}, 180_000);

afterAll(async () => {
	await env?.teardown();
});

async function run(
	writeNotes: (input: unknown) => Promise<void>,
	input: Record<string, unknown>,
	notifyNotesReady: (
		input: unknown,
	) => Promise<{ notified: number }> = async () => ({ notified: 0 }),
) {
	const taskQueue = `parlume-notes-retry-${++sequence}`;
	const workflowWorker = await Worker.create({
		connection: env.nativeConnection,
		taskQueue,
		workflowBundle: bundle,
	});
	const activityWorker = await Worker.create({
		connection: env.nativeConnection,
		taskQueue: PROJECT_OPERATIONS_ACTIVITY_TASK_QUEUE,
		activities: {
			writeParlumeNotes: writeNotes,
			notifyParlumeNotesReady: notifyNotesReady,
		},
	});
	const handle = await env.client.workflow.start("parlumeNotesWorkflow", {
		taskQueue,
		workflowId: `${taskQueue}-wf`,
		args: [input],
	});
	await workflowWorker.runUntil(activityWorker.runUntil(handle.result()));
}

describe("parlumeNotesWorkflow — a failed model call", () => {
	it("retries the notes after a model failure and completes", async () => {
		const inputs: unknown[] = [];
		await run(
			async (input) => {
				inputs.push(input);
				if (inputs.length === 1) {
					throw new Error("The model is overloaded.");
				}
			},
			{ sessionId: "session-1", organizationId: "org-1" },
		);
		const attempt = {
			sessionId: "session-1",
			finalAttempt: false,
			regenerate: false,
			maxAttempts: PARLUME_NOTES_MAX_ATTEMPTS,
		};
		expect(inputs).toEqual([attempt, attempt]);
	}, 60_000);

	it("runs the activity at most the attempts it tells the activity", async () => {
		const inputs: unknown[] = [];
		await expect(
			run(
				async (input) => {
					inputs.push(input);
					throw new Error("The model is down.");
				},
				{ sessionId: "session-1" },
			),
		).rejects.toThrow();
		expect(inputs).toHaveLength(PARLUME_NOTES_MAX_ATTEMPTS);
		expect(inputs[0]).toMatchObject({
			maxAttempts: PARLUME_NOTES_MAX_ATTEMPTS,
		});
	}, 60_000);

	it("tells the activity to write over the notes when regenerating", async () => {
		const inputs: unknown[] = [];
		await run(
			async (input) => {
				inputs.push(input);
			},
			{ sessionId: "session-1", regenerate: true },
		);
		expect(inputs).toEqual([
			{
				sessionId: "session-1",
				finalAttempt: false,
				regenerate: true,
				maxAttempts: PARLUME_NOTES_MAX_ATTEMPTS,
			},
		]);
	}, 60_000);
});

describe("parlumeNotesWorkflow — the notes-ready notice", () => {
	it("tells the invitees once the notes are written", async () => {
		const calls: string[] = [];
		const notices: unknown[] = [];
		await run(
			async () => {
				calls.push("write");
			},
			{ sessionId: "session-1" },
			async (input) => {
				calls.push("notify");
				notices.push(input);
				return { notified: 2 };
			},
		);
		expect(calls).toEqual(["write", "notify"]);
		expect(notices).toEqual([{ sessionId: "session-1" }]);
	}, 60_000);

	it("tells no one after a run whose notes failed", async () => {
		const notices: unknown[] = [];
		await expect(
			run(
				async () => {
					throw new Error("The model is down.");
				},
				{ sessionId: "session-1" },
				async (input) => {
					notices.push(input);
					return { notified: 1 };
				},
			),
		).rejects.toThrow();
		expect(notices).toEqual([]);
	}, 60_000);

	it("finishes the run when the notice fails, and does not try it again", async () => {
		const notices: unknown[] = [];
		await run(
			async () => {},
			{ sessionId: "session-1" },
			async (input) => {
				notices.push(input);
				throw new Error("Mail is down.");
			},
		);
		expect(notices).toHaveLength(1);
	}, 60_000);
});
