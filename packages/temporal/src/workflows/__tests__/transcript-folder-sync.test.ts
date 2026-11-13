/**
 * The per-project OneDrive transcript folder sync (Fizzy #3507).
 *
 * The contract: every waiting file goes through the upload's own ingest
 * workflow and its outcome is recorded; a copy that keeps failing is marked
 * and does not stop the rest; files waiting on a reconnect do not spin the
 * loop; and the workflow ends once the project has no connected folder.
 */

import { resolve } from "node:path";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import {
	bundleWorkflowCode,
	Worker,
	type WorkflowBundleWithSourceMap,
} from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PROJECT_OPERATIONS_ACTIVITY_TASK_QUEUE } from "../../task-queues";

const WORKFLOWS_PATH = resolve(__dirname, "..");

let env: TestWorkflowEnvironment;
let workflowBundle: WorkflowBundleWithSourceMap;
let taskQueueSeq = 0;

beforeAll(async () => {
	env = await TestWorkflowEnvironment.createTimeSkipping();
	workflowBundle = await bundleWorkflowCode({
		workflowsPath: WORKFLOWS_PATH,
	});
}, 180_000);

afterAll(async () => {
	await env?.teardown();
});

interface Calls {
	reads: number;
	ingested: string[];
	recorded: string[];
	failed: string[];
}

async function run(activities: {
	/** `signalConnect` sends the signal a folder connection sends. */
	listFolders: (
		signalConnect: () => Promise<void>,
	) => string[] | Promise<string[]>;
	read: (folderId: string, readCount: number) => string[];
	importFile: (
		fileId: string,
	) =>
		| { outcome: "ingest"; contextId: string }
		| { outcome: "done" }
		| { outcome: "waiting" };
}): Promise<Calls> {
	const calls: Calls = { reads: 0, ingested: [], recorded: [], failed: [] };
	const taskQueue = `transcript-folder-sync-${++taskQueueSeq}`;
	const workflowId = `transcript-folder-sync-test-${taskQueueSeq}`;
	const signalConnect = () =>
		env.client.workflow
			.getHandle(workflowId)
			.signal("syncTranscriptFoldersNow");

	const workflowWorker = await Worker.create({
		connection: env.nativeConnection,
		taskQueue,
		workflowBundle,
	});
	// Both workflows send their activities to the operations queue.
	const activityWorker = await Worker.create({
		connection: env.nativeConnection,
		taskQueue: PROJECT_OPERATIONS_ACTIVITY_TASK_QUEUE,
		activities: {
			listTranscriptFoldersToSync: async () => ({
				folderIds: await activities.listFolders(signalConnect),
			}),
			readTranscriptFolder: async (input: { folderId: string }) => {
				calls.reads += 1;
				return {
					pendingFileIds: activities.read(
						input.folderId,
						calls.reads,
					),
				};
			},
			importTranscriptFolderFile: async (input: { fileId: string }) => {
				const result = activities.importFile(input.fileId);
				if (result.outcome === "ingest") {
					return {
						...result,
						projectId: "project-1",
						userId: "user-1",
						organizationId: "org-1",
					};
				}
				return result;
			},
			markTranscriptFolderFileFailed: async (input: {
				fileId: string;
			}) => {
				calls.failed.push(input.fileId);
			},
			recordTranscriptFolderFileOutcome: async (input: {
				fileId: string;
			}) => {
				calls.recorded.push(input.fileId);
			},
			// The child: the upload's own ingest.
			ingestUploadedTranscript: async (input: { contextId: string }) => {
				calls.ingested.push(input.contextId);
				return { outcome: "ingested", transcriptRecordId: "t-1" };
			},
			startUploadedTranscriptPipelines: async () => undefined,
			markUploadedTranscriptFailed: async () => undefined,
		},
	});

	await activityWorker.runUntil(
		workflowWorker.runUntil(
			env.client.workflow.execute("transcriptFolderSyncWorkflow", {
				taskQueue,
				workflowId,
				args: [{ projectId: "project-1" }],
			}),
		),
	);
	return calls;
}

describe("transcriptFolderSyncWorkflow", () => {
	it("imports through the upload ingest, records every file, and ends with no folders", async () => {
		let lists = 0;
		const calls = await run({
			listFolders: () => (++lists === 1 ? ["folder-1"] : []),
			read: (_folderId, readCount) =>
				readCount === 1 ? ["f1", "f2"] : [],
			importFile: (fileId) =>
				fileId === "f1"
					? { outcome: "ingest", contextId: "context-1" }
					: { outcome: "done" },
		});

		expect(calls.ingested).toEqual(["context-1"]);
		expect(calls.recorded).toEqual(["f1", "f2"]);
		expect(calls.failed).toEqual([]);
	}, 60_000);

	it("marks a file whose copy keeps failing, and goes on to the next", async () => {
		let lists = 0;
		const calls = await run({
			listFolders: () => (++lists === 1 ? ["folder-1"] : []),
			read: (_folderId, readCount) =>
				readCount === 1 ? ["bad", "good"] : [],
			importFile: (fileId) => {
				if (fileId === "bad") {
					// Non-retryable, so the test does not wait out the retries.
					throw Object.assign(new Error("Graph refused"), {
						name: "ValidationError",
					});
				}
				return { outcome: "ingest", contextId: "context-good" };
			},
		});

		expect(calls.failed).toEqual(["bad"]);
		expect(calls.ingested).toEqual(["context-good"]);
		expect(calls.recorded).toEqual(["good"]);
	}, 60_000);

	it("waits out the interval when a full batch is only waiting on a reconnect", async () => {
		const batch = Array.from({ length: 20 }, (_, i) => `f${i}`);
		let lists = 0;
		const calls = await run({
			// Two passes, then the folder is disconnected.
			listFolders: () => (++lists <= 2 ? ["folder-1"] : []),
			read: () => batch,
			importFile: () => ({ outcome: "waiting" }),
		});

		// One read per pass: the stuck batch did not spin the loop.
		expect(calls.reads).toBe(2);
		expect(calls.recorded).toEqual([]);
	}, 60_000);

	it("comes straight back for the next batch of a large folder", async () => {
		const batch = Array.from({ length: 20 }, (_, i) => `f${i}`);
		let lists = 0;
		const calls = await run({
			listFolders: () => (++lists <= 3 ? ["folder-1"] : []),
			read: (_folderId, readCount) => (readCount <= 2 ? batch : []),
			importFile: () => ({ outcome: "done" }),
		});

		expect(calls.reads).toBe(3);
		expect(calls.recorded).toHaveLength(40);
	}, 60_000);

	it("reads the list again when a folder is connected while it found none", async () => {
		let lists = 0;
		const calls = await run({
			listFolders: async (signalConnect) => {
				lists += 1;
				if (lists === 1) {
					// The connection commits, and signals, while this read is
					// still answering "no folders".
					await signalConnect();
					return [];
				}
				return lists === 2 ? ["folder-1"] : [];
			},
			read: (_folderId, readCount) => (readCount === 1 ? ["f1"] : []),
			importFile: () => ({ outcome: "done" }),
		});

		expect(lists).toBe(3);
		expect(calls.recorded).toEqual(["f1"]);
	}, 60_000);
});
