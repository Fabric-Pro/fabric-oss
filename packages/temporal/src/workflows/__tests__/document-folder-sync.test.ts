/**
 * The per-project OneDrive and SharePoint document folder sync (Fizzy #2808).
 *
 * The contract: due folders are read one at a time, and only a complete read
 * goes on to confirm its removal candidates; a context is deleted through the
 * deletion workflow and released only once that child succeeded, so a failed
 * child is driven again on a later pass; every waiting file goes through the
 * generic processing workflow and its outcome is recorded; and the workflow
 * waits while any folder is connected, ending only when none is.
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
import {
	PROJECT_EMBEDDING_TASK_QUEUE,
	PROJECT_OPERATIONS_ACTIVITY_TASK_QUEUE,
} from "../../task-queues";

const WORKFLOWS_PATH = resolve(__dirname, "..");
const MINUTE = 60_000;
const INTERVAL = 30 * MINUTE;

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

interface SyncState {
	anyConnected: boolean;
	dueFolderIds: string[];
	nextReadAfter?: string | null;
}

interface ReadResult {
	complete: boolean;
	candidates?: Array<{ fileId: string; driveItemId: string }>;
	nextReadAfter?: string | null;
}

interface Deletion {
	fileId: string;
	contextId: string;
}

type ImportOutcome =
	| { outcome: "process"; contextId: string }
	| { outcome: "record"; contextId: string }
	| { outcome: "done" }
	| { outcome: "waiting" };

interface Script {
	/** The n-th listing (1-based). `signal` sends Sync now. */
	list: (n: number, now: number) => SyncState;
	read?: (
		folderId: string,
		n: number,
		signal: () => Promise<void>,
	) => ReadResult | Promise<ReadResult>;
	/** Runs as a folder's candidates are confirmed; may throw. */
	confirm?: (folderId: string) => void;
	deletions?: (n: number) => Deletion[];
	/** Runs as the n-th released row is finished; may throw. */
	finish?: (fileId: string, n: number) => void;
	deleteContext?: (contextId: string, n: number) => { success: boolean };
	imports?: (folderId: string, n: number) => string[];
	importFile?: (fileId: string) => ImportOutcome;
	process?: (contextId: string) => { success: boolean };
}

interface Calls {
	start: number;
	events: string[];
	lists: number[];
	reads: Array<{ folderId: string; passId: string; at: number }>;
	confirms: Array<{ folderId: string; candidates: unknown[] }>;
	deletionChildren: string[];
	finished: string[];
	processed: string[];
	recorded: Array<{ fileId: string; processing: string }>;
	downloadFailed: string[];
}

/** An activity failure the retry policy does not retry, so tests run at once. */
function activityFails(): never {
	throw ApplicationFailure.nonRetryable("database unavailable");
}

const DELETION_ROW = {
	projectId: "project-1",
	userId: "user-1",
	organizationId: "org-1",
};

async function run(
	script: Script,
	options: {
		/** Start with Sync now, as connecting a folder does. */
		signalWithStart?: boolean;
		/** Runs after start, before waiting for the result. */
		whileRunning?: (
			calls: Calls,
			signal: () => Promise<void>,
		) => Promise<void>;
		/** Extra runs of the same id, each started by Sync now. */
		restarts?: number;
	} = {},
): Promise<Calls> {
	const seq = ++taskQueueSeq;
	const taskQueue = `document-folder-sync-${seq}`;
	const workflowId = `document-folder-sync-test-${seq}`;
	const calls: Calls = {
		start: await env.currentTimeMs(),
		events: [],
		lists: [],
		reads: [],
		confirms: [],
		deletionChildren: [],
		finished: [],
		processed: [],
		recorded: [],
		downloadFailed: [],
	};
	const signal = () =>
		env.client.workflow
			.getHandle(workflowId)
			.signal("syncDocumentFoldersNow");
	const counters = { reads: 0, deletions: 0, imports: 0, finishes: 0 };
	const deleteCounts = new Map<string, number>();

	const workflowWorker = await Worker.create({
		connection: env.nativeConnection,
		taskQueue,
		workflowBundle,
	});
	const operationsWorker = await Worker.create({
		connection: env.nativeConnection,
		taskQueue: PROJECT_OPERATIONS_ACTIVITY_TASK_QUEUE,
		activities: {
			listDocumentFoldersToSync: async () => {
				const now = await env.currentTimeMs();
				calls.lists.push(now);
				calls.events.push("list");
				return {
					nextReadAfter: null,
					...script.list(calls.lists.length, now),
				};
			},
			readDocumentFolder: async (input: {
				folderId: string;
				passId: string;
			}) => {
				counters.reads += 1;
				calls.reads.push({
					folderId: input.folderId,
					passId: input.passId,
					at: await env.currentTimeMs(),
				});
				calls.events.push(`read:${input.folderId}`);
				const result = (await script.read?.(
					input.folderId,
					counters.reads,
					signal,
				)) ?? { complete: true };
				return {
					candidates: [],
					nextReadAfter: null,
					...result,
				};
			},
			confirmDocumentFolderCandidates: async (input: {
				folderId: string;
				candidates: unknown[];
			}) => {
				calls.confirms.push(input);
				calls.events.push(`confirm:${input.folderId}`);
				script.confirm?.(input.folderId);
				return { status: "retired", retiredCount: 0 };
			},
			listDocumentFolderDeletions: async () => {
				counters.deletions += 1;
				const deletions = script.deletions?.(counters.deletions) ?? [];
				return {
					deletions: deletions.map((row) => ({
						...DELETION_ROW,
						...row,
					})),
				};
			},
			finishDocumentFolderContextDeletion: async (input: {
				fileId: string;
				contextId: string;
			}) => {
				counters.finishes += 1;
				calls.finished.push(input.fileId);
				calls.events.push(`finish:${input.fileId}`);
				script.finish?.(input.fileId, counters.finishes);
				return { released: true };
			},
			listDocumentFolderImports: async (input: { folderId: string }) => {
				counters.imports += 1;
				return {
					fileIds:
						script.imports?.(input.folderId, counters.imports) ??
						[],
				};
			},
			importDocumentFolderFile: async (input: { fileId: string }) => {
				calls.events.push(`import:${input.fileId}`);
				const result = script.importFile?.(input.fileId) ?? {
					outcome: "done",
				};
				if (result.outcome === "process") {
					return { ...result, ...DELETION_ROW };
				}
				return result;
			},
			markDocumentFolderFileDownloadFailed: async (input: {
				fileId: string;
			}) => {
				calls.downloadFailed.push(input.fileId);
				return { settled: true };
			},
			recordDocumentFolderFileProcessing: async (input: {
				fileId: string;
				processing: string;
			}) => {
				calls.recorded.push({
					fileId: input.fileId,
					processing: input.processing,
				});
				return { settled: true };
			},
			// The processing child's own status activities.
			getProjectContextStatus: async () => "FAILED",
			updateProjectContextStatus: async () => undefined,
			failContextTargetDocument: async () => ({ applied: false }),
		},
	});
	// The two children send their heavy activities to the embedding queue.
	const embeddingWorker = await Worker.create({
		connection: env.nativeConnection,
		taskQueue: PROJECT_EMBEDDING_TASK_QUEUE,
		activities: {
			deleteSingleContextActivity: async (input: {
				contextId: string;
			}) => {
				const n = (deleteCounts.get(input.contextId) ?? 0) + 1;
				deleteCounts.set(input.contextId, n);
				calls.deletionChildren.push(input.contextId);
				calls.events.push(`delete:${input.contextId}`);
				const { success } = script.deleteContext?.(
					input.contextId,
					n,
				) ?? { success: true };
				return success
					? { success: true, qdrantDeleted: true, dbDeleted: true }
					: {
							success: false,
							error: "refused",
							qdrantDeleted: false,
							dbDeleted: false,
						};
			},
			processProjectContext: async (contextId: string) => {
				calls.processed.push(contextId);
				calls.events.push(`process:${contextId}`);
				const { success } = script.process?.(contextId) ?? {
					success: true,
				};
				return success
					? {
							success: true,
							chunkCount: 1,
							extractorUsed: "local",
							qdrantIds: [],
						}
					: { success: false, error: "unreadable", qdrantIds: [] };
			},
		},
	});

	const startOptions = {
		taskQueue,
		workflowId,
		args: [{ projectId: "project-1", organizationId: "org-1" }],
	};
	const once = async () => {
		const handle = options.signalWithStart
			? await env.client.workflow.signalWithStart(
					"documentFolderSyncWorkflow",
					{
						...startOptions,
						signal: "syncDocumentFoldersNow",
						signalArgs: [],
					},
				)
			: await env.client.workflow.start(
					"documentFolderSyncWorkflow",
					startOptions,
				);
		await options.whileRunning?.(calls, signal);
		await handle.result();
	};

	await embeddingWorker.runUntil(
		operationsWorker.runUntil(
			workflowWorker.runUntil(async () => {
				await once();
				for (let i = 0; i < (options.restarts ?? 0); i++) {
					await env.client.workflow
						.signalWithStart("documentFolderSyncWorkflow", {
							...startOptions,
							signal: "syncDocumentFoldersNow",
							signalArgs: [],
						})
						.then((handle) => handle.result());
				}
			}),
		),
	);
	return calls;
}

/** Connected and due on the first `passes` listings, then disconnected. */
function duePasses(passes: number, folderIds = ["folder-1"]) {
	return (n: number): SyncState =>
		n <= passes
			? { anyConnected: true, dueFolderIds: folderIds }
			: { anyConnected: false, dueFolderIds: [] };
}

describe("documentFolderSyncWorkflow", () => {
	it("reads a newly connected folder at once, then confirms its candidates", async () => {
		const calls = await run(
			{
				list: duePasses(1),
				read: () => ({
					complete: true,
					candidates: [{ fileId: "f1", driveItemId: "d1" }],
				}),
			},
			{ signalWithStart: true },
		);

		expect(calls.reads).toHaveLength(1);
		expect(calls.reads[0].at - calls.start).toBeLessThan(MINUTE);
		expect(calls.confirms).toEqual([
			{
				folderId: "folder-1",
				candidates: [{ fileId: "f1", driveItemId: "d1" }],
			},
		]);
	}, 60_000);

	it("confirms nothing after an incomplete read", async () => {
		const calls = await run({
			list: duePasses(1),
			read: () => ({ complete: false }),
		});

		expect(calls.reads).toHaveLength(1);
		expect(calls.confirms).toEqual([]);
	}, 60_000);

	it("reads folders one at a time, each with its own pass id", async () => {
		const calls = await run({
			list: duePasses(2, ["folder-1", "folder-2"]),
		});

		expect(calls.reads.map((read) => read.folderId)).toEqual([
			"folder-1",
			"folder-2",
			"folder-1",
			"folder-2",
		]);
		expect(new Set(calls.reads.map((read) => read.passId)).size).toBe(4);
	}, 60_000);

	it("reads again at once when Sync now arrives during the wait", async () => {
		const calls = await run(
			{ list: duePasses(2) },
			{
				whileRunning: async (running, signal) => {
					// Real time does not skip until the result is awaited, so
					// the workflow sits in its wait while this signals.
					while (running.reads.length < 1) {
						await new Promise((done) => setTimeout(done, 50));
					}
					await signal();
				},
			},
		);

		expect(calls.reads).toHaveLength(2);
		expect(calls.reads[1].at - calls.reads[0].at).toBeLessThan(INTERVAL);
	}, 60_000);

	it("turns two Sync now signals during one pass into exactly one extra pass", async () => {
		const calls = await run({
			list: duePasses(3),
			read: async (_folderId, n, signal) => {
				if (n === 1) {
					await signal();
					await signal();
				}
				return { complete: true };
			},
		});

		expect(calls.reads).toHaveLength(3);
		// The extra pass came straight away...
		expect(calls.reads[1].at - calls.reads[0].at).toBeLessThan(INTERVAL);
		// ...and the one after it waited out the interval.
		expect(calls.reads[2].at - calls.reads[1].at).toBeGreaterThanOrEqual(
			INTERVAL,
		);
	}, 60_000);

	it("ends with no folder connected, and Sync now starts it again", async () => {
		let lists = 0;
		const calls = await run(
			{
				list: () => {
					lists += 1;
					// The first run finds nothing; the restarted one finds a
					// folder once, then none.
					return lists === 2
						? { anyConnected: true, dueFolderIds: ["folder-1"] }
						: { anyConnected: false, dueFolderIds: [] };
				},
			},
			{ restarts: 1 },
		);

		expect(calls.lists).toHaveLength(3);
		expect(calls.reads).toHaveLength(1);
	}, 60_000);

	it("waits while the flag is off, and reads once it is on again", async () => {
		const calls = await run({
			// The flag-off listing: connected, nothing due.
			list: (n) =>
				n === 1
					? { anyConnected: true, dueFolderIds: [] }
					: duePasses(1)(n - 1),
		});

		expect(calls.reads).toHaveLength(1);
		expect(calls.reads[0].at - calls.start).toBeGreaterThanOrEqual(
			INTERVAL,
		);
	}, 60_000);

	it("keeps running through a throttle cool-down and reads when it passes", async () => {
		const calls = await run({
			list: (n, now) =>
				n === 1
					? {
							anyConnected: true,
							dueFolderIds: [],
							nextReadAfter: new Date(
								now + 10 * MINUTE,
							).toISOString(),
						}
					: duePasses(1)(n - 1),
		});

		expect(calls.reads).toHaveLength(1);
		const waited = calls.reads[0].at - calls.start;
		expect(waited).toBeGreaterThanOrEqual(10 * MINUTE);
		expect(waited).toBeLessThan(INTERVAL);
	}, 60_000);

	it("waits only until a throttled read's own next-read-after", async () => {
		const calls = await run({
			list: duePasses(2),
			read: async (_folderId, n) =>
				n === 1
					? {
							complete: false,
							nextReadAfter: new Date(
								(await env.currentTimeMs()) + 5 * MINUTE,
							).toISOString(),
						}
					: { complete: true },
		});

		expect(calls.reads).toHaveLength(2);
		expect(calls.reads[1].at - calls.reads[0].at).toBeLessThan(INTERVAL);
	}, 60_000);

	it("deletes a tombstoned row's context through one deletion child, then releases it", async () => {
		const calls = await run({
			list: duePasses(2),
			deletions: (n) =>
				n === 1 ? [{ fileId: "f1", contextId: "ctx-1" }] : [],
		});

		expect(calls.deletionChildren).toEqual(["ctx-1"]);
		expect(calls.finished).toEqual(["f1"]);
	}, 60_000);

	it("leaves the row when the deletion child fails, and drives it again on the next pass", async () => {
		let finished = false;
		const calls = await run({
			list: duePasses(3),
			deletions: () =>
				finished ? [] : [{ fileId: "f1", contextId: "ctx-1" }],
			deleteContext: (_contextId, n) => {
				if (n === 2) {
					finished = true;
				}
				return { success: n >= 2 };
			},
		});

		expect(calls.deletionChildren).toEqual(["ctx-1", "ctx-1"]);
		// Released only after the child that succeeded.
		expect(calls.finished).toEqual(["f1"]);
	}, 60_000);

	it("deletes a refreshing file's old context before importing its new version", async () => {
		const calls = await run({
			list: duePasses(1),
			deletions: (n) =>
				n === 1 ? [{ fileId: "f1", contextId: "ctx-old" }] : [],
			imports: (_folderId, n) => (n === 1 ? ["f1"] : []),
			importFile: () => ({ outcome: "process", contextId: "ctx-new" }),
		});

		expect(calls.events).toEqual([
			"list",
			"read:folder-1",
			"confirm:folder-1",
			"delete:ctx-old",
			"finish:f1",
			"import:f1",
			"process:ctx-new",
			"list",
		]);
		expect(calls.recorded).toEqual([
			{ fileId: "f1", processing: "succeeded" },
		]);
	}, 60_000);

	it("records a processing failure and goes on with the next file", async () => {
		const calls = await run({
			list: duePasses(1),
			imports: (_folderId, n) => (n === 1 ? ["bad", "good"] : []),
			importFile: (fileId) => ({
				outcome: "process",
				contextId: `ctx-${fileId}`,
			}),
			process: (contextId) => ({ success: contextId !== "ctx-bad" }),
		});

		expect(calls.processed).toEqual(["ctx-bad", "ctx-good"]);
		expect(calls.recorded).toEqual([
			{ fileId: "bad", processing: "failed" },
			{ fileId: "good", processing: "succeeded" },
		]);
	}, 60_000);

	it("marks a file whose download keeps failing, and goes on to the next", async () => {
		const calls = await run({
			list: duePasses(1),
			imports: (_folderId, n) => (n === 1 ? ["bad", "good"] : []),
			importFile: (fileId) => {
				if (fileId === "bad") {
					// Non-retryable, so the test does not wait out the retries.
					throw Object.assign(new Error("Graph refused"), {
						name: "ValidationError",
					});
				}
				return { outcome: "process", contextId: "ctx-good" };
			},
		});

		expect(calls.downloadFailed).toEqual(["bad"]);
		expect(calls.recorded).toEqual([
			{ fileId: "good", processing: "succeeded" },
		]);
	}, 60_000);

	it("drains a large folder batch by batch within one pass", async () => {
		const batch = (prefix: string) =>
			Array.from({ length: 20 }, (_, i) => `${prefix}${i}`);
		const calls = await run({
			list: duePasses(1),
			imports: (_folderId, n) =>
				n === 1 ? batch("a") : n === 2 ? batch("b") : ["c0"],
		});

		expect(calls.reads).toHaveLength(1);
		expect(
			calls.events.filter((event) => event.startsWith("import:")),
		).toHaveLength(41);
	}, 60_000);

	it("stops draining when a full batch settles nothing", async () => {
		const calls = await run({
			list: duePasses(1),
			imports: () => Array.from({ length: 20 }, (_, i) => `f${i}`),
			importFile: () => ({ outcome: "waiting" }),
		});

		expect(
			calls.events.filter((event) => event.startsWith("import:")),
		).toHaveLength(20);
	}, 60_000);

	it("waits out a pass whose deletion listing failed, then runs the next", async () => {
		const calls = await run({
			list: duePasses(2),
			deletions: (n) => (n === 1 ? activityFails() : []),
		});

		expect(calls.lists).toHaveLength(3);
		expect(calls.reads).toHaveLength(2);
		expect(calls.reads[1].at - calls.reads[0].at).toBeGreaterThanOrEqual(
			INTERVAL,
		);
	}, 60_000);

	it("waits out a pass whose folder listing failed, then runs the next", async () => {
		const calls = await run({
			list: (n) => (n === 1 ? activityFails() : duePasses(1)(n - 1)),
		});

		expect(calls.lists).toHaveLength(3);
		expect(calls.reads).toHaveLength(1);
		expect(calls.reads[0].at - calls.start).toBeGreaterThanOrEqual(
			INTERVAL,
		);
	}, 60_000);

	it("confirms nothing for a folder whose read failed, and still reads the next", async () => {
		const calls = await run({
			list: duePasses(1, ["folder-1", "folder-2"]),
			read: (folderId) =>
				folderId === "folder-1" ? activityFails() : { complete: true },
		});

		expect(calls.reads.map((read) => read.folderId)).toEqual([
			"folder-1",
			"folder-2",
		]);
		expect(calls.confirms.map((confirm) => confirm.folderId)).toEqual([
			"folder-2",
		]);
	}, 60_000);

	it("goes on with the pass when confirming a folder's candidates failed", async () => {
		const calls = await run({
			list: duePasses(1),
			confirm: () => activityFails(),
			deletions: (n) =>
				n === 1 ? [{ fileId: "f1", contextId: "ctx-1" }] : [],
			imports: (_folderId, n) => (n === 1 ? ["a"] : []),
		});

		expect(calls.events).toEqual([
			"list",
			"read:folder-1",
			"confirm:folder-1",
			"delete:ctx-1",
			"finish:f1",
			"import:a",
			"list",
		]);
	}, 60_000);

	it("goes on with the pass when releasing a deleted row failed, and releases it next pass", async () => {
		const calls = await run({
			list: duePasses(2),
			deletions: (n) =>
				n <= 2 ? [{ fileId: "f1", contextId: "ctx-1" }] : [],
			finish: (_fileId, n) => (n === 1 ? activityFails() : undefined),
			imports: (_folderId, n) => (n === 1 ? ["a"] : []),
		});

		expect(calls.finished).toEqual(["f1", "f1"]);
		const firstPass = calls.events.slice(
			0,
			calls.events.indexOf("list", 1),
		);
		expect(firstPass).toEqual([
			"list",
			"read:folder-1",
			"confirm:folder-1",
			"delete:ctx-1",
			"finish:f1",
			"import:a",
		]);
		expect(calls.reads).toHaveLength(2);
	}, 60_000);

	it("only records a file an earlier attempt already processed", async () => {
		const calls = await run({
			list: duePasses(1),
			imports: (_folderId, n) => (n === 1 ? ["f1"] : []),
			importFile: () => ({ outcome: "record", contextId: "ctx-done" }),
		});

		expect(calls.processed).toEqual([]);
		expect(calls.recorded).toEqual([
			{ fileId: "f1", processing: "unknown" },
		]);
	}, 60_000);

	it("spreads a deletion backlog over several passes, one share per pass", async () => {
		const backlog = ["c1", "c2", "c3", "c4", "c5"];
		const calls = await run({
			list: duePasses(3),
			// The activity hands out at most one pass's share.
			deletions: (n) =>
				backlog.slice((n - 1) * 2, n * 2).map((contextId) => ({
					fileId: `file-${contextId}`,
					contextId,
				})),
		});

		expect(calls.deletionChildren).toEqual(backlog);
		expect(calls.finished).toEqual(backlog.map((c) => `file-${c}`));
		expect(calls.reads).toHaveLength(3);
	}, 60_000);
});
