/**
 * Behavioral (TestWorkflowEnvironment) test for
 * `projectRepositorySyncFollowUpWorkflow`: it keeps asking while the sync's run
 * is open, starts the queued run once it has closed, and gives up after a
 * bounded number of waits rather than waiting for ever.
 *
 * Same harness as `project-instruction-snapshot-workflow.test.ts`.
 */
import { resolve } from "node:path";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import {
	bundleWorkflowCode,
	Worker,
	type WorkflowBundleWithSourceMap,
} from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { REPOSITORY_SYNC_FOLLOW_UP_MAX_WAITS } from "../src/lib/repository-sync-follow-up";

const WORKFLOWS_PATH = resolve(__dirname, "..", "src", "workflows");

let env: TestWorkflowEnvironment;
let workflowBundle: WorkflowBundleWithSourceMap;

beforeAll(async () => {
	env = await TestWorkflowEnvironment.createTimeSkipping();
	workflowBundle = await bundleWorkflowCode({
		workflowsPath: WORKFLOWS_PATH,
	});
}, 120_000);

afterAll(async () => {
	await env?.teardown();
});

let taskQueueSeq = 0;

const INPUT = {
	subject: "context" as const,
	projectId: "proj_1",
	organizationId: "org_1",
	requesterUserId: "user_1",
};

async function run(
	awaitClosed: ReturnType<typeof vi.fn>,
	startQueued: ReturnType<typeof vi.fn>,
) {
	const taskQueue = `repository-sync-follow-up-${taskQueueSeq++}`;
	const worker = await Worker.create({
		connection: env.nativeConnection,
		taskQueue,
		workflowBundle,
		activities: {
			awaitRepositorySyncClosed: awaitClosed,
			startQueuedRepositorySync: startQueued,
		},
	});
	return worker.runUntil(
		env.client.workflow.execute("projectRepositorySyncFollowUpWorkflow", {
			args: [INPUT],
			taskQueue,
			workflowId: `${taskQueue}-wf`,
		}),
	);
}

describe("projectRepositorySyncFollowUpWorkflow", () => {
	it("starts the queued run as soon as the open one has closed", async () => {
		const awaitClosed = vi.fn(async () => ({ closed: true }));
		const startQueued = vi.fn(async () => ({
			outcome: "started" as const,
		}));

		const result = await run(awaitClosed, startQueued);

		expect(result).toEqual({ outcome: "started" });
		expect(awaitClosed).toHaveBeenCalledWith({
			subject: "context",
			projectId: "proj_1",
		});
		expect(startQueued).toHaveBeenCalledWith(INPUT);
	}, 60_000);

	it("keeps waiting while the run stays open, and starts nothing until it closes", async () => {
		const awaitClosed = vi
			.fn()
			.mockResolvedValueOnce({ closed: false })
			.mockResolvedValueOnce({ closed: false })
			.mockResolvedValueOnce({ closed: true });
		const startQueued = vi.fn(async () => ({
			outcome: "started" as const,
		}));

		await run(awaitClosed, startQueued);

		expect(awaitClosed).toHaveBeenCalledTimes(3);
		expect(startQueued).toHaveBeenCalledTimes(1);
	}, 60_000);

	it("reports what starting reached, including an already-open run", async () => {
		const result = await run(
			vi.fn(async () => ({ closed: true })),
			vi.fn(async () => ({ outcome: "already_running" as const })),
		);

		expect(result).toEqual({ outcome: "already_running" });
	}, 60_000);

	it("gives up after a bounded number of waits and starts nothing", async () => {
		const awaitClosed = vi.fn(async () => ({ closed: false }));
		const startQueued = vi.fn(async () => ({
			outcome: "started" as const,
		}));

		const result = await run(awaitClosed, startQueued);

		expect(result).toEqual({ outcome: "still_running" });
		expect(awaitClosed).toHaveBeenCalledTimes(
			REPOSITORY_SYNC_FOLLOW_UP_MAX_WAITS,
		);
		expect(startQueued).not.toHaveBeenCalled();
	}, 60_000);
});
