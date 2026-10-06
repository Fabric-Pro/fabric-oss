/**
 * Behavioral (TestWorkflowEnvironment) test for `projectContextEmbeddingWorkflow`:
 * the content versions copied into its input reach the stamp activity, so a row
 * that changed between the copy and the stamp can be left alone. An input
 * without them (an execution started before they existed) stamps by id alone.
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
import {
	PROJECT_EMBEDDING_TASK_QUEUE,
	PROJECT_OPERATIONS_ACTIVITY_TASK_QUEUE,
} from "../src/task-queues";

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

async function run(
	contexts: Array<Record<string, unknown>>,
	stamp: ReturnType<typeof vi.fn>,
) {
	const taskQueue = `project-context-embedding-${taskQueueSeq++}`;
	const worker = await Worker.create({
		connection: env.nativeConnection,
		taskQueue,
		workflowBundle,
	});
	const embeddingWorker = await Worker.create({
		connection: env.nativeConnection,
		taskQueue: PROJECT_EMBEDDING_TASK_QUEUE,
		activities: {
			generateContextEmbeddings: async () => contexts.map(() => [0.1]),
			storeContextsInQdrant: async () => contexts.map((c) => `q-${c.id}`),
		},
	});
	const operationsWorker = await Worker.create({
		connection: env.nativeConnection,
		taskQueue: PROJECT_OPERATIONS_ACTIVITY_TASK_QUEUE,
		activities: { updateContextEmbeddingStatus: stamp },
	});
	return worker.runUntil(() =>
		embeddingWorker.runUntil(() =>
			operationsWorker.runUntil(
				env.client.workflow.execute("projectContextEmbeddingWorkflow", {
					args: [
						{
							projectId: "p",
							userId: "u",
							organizationId: "o",
							contexts,
						},
					],
					taskQueue,
					workflowId: `${taskQueue}-wf`,
				}),
			),
		),
	);
}

describe("projectContextEmbeddingWorkflow", () => {
	it("hands the stamp each row's copied content version", async () => {
		const stamp = vi.fn(async () => undefined);

		await run(
			[
				{
					id: "c1",
					type: "TEXT",
					content: "a",
					contentHash: null,
					updatedAt: "2026-10-01T10:00:00.000Z",
				},
				{
					id: "c2",
					type: "TEXT",
					content: "b",
					contentHash: "h",
					updatedAt: "2026-10-01T10:00:01.000Z",
				},
			],
			stamp,
		);

		expect(stamp).toHaveBeenCalledWith({
			projectId: "p",
			contextIds: ["c1", "c2"],
			qdrantIds: ["q-c1", "q-c2"],
			versions: [
				{ contentHash: null, updatedAt: "2026-10-01T10:00:00.000Z" },
				{ contentHash: "h", updatedAt: "2026-10-01T10:00:01.000Z" },
			],
		});
	}, 60_000);

	it("stamps by id alone when the input carries no versions", async () => {
		const stamp = vi.fn(async () => undefined);

		await run([{ id: "c1", type: "TEXT", content: "a" }], stamp);

		expect(stamp).toHaveBeenCalledWith({
			projectId: "p",
			contextIds: ["c1"],
			qdrantIds: ["q-c1"],
		});
	}, 60_000);
});
