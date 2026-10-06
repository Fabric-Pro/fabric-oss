/**
 * codeIndexingWorkflow must (a) read its host-local clone only inside the
 * activity that made it, and (b) never leave the ProjectCodeIndex row in
 * INDEXING when the run fails.
 *
 * (a) Clone, secret scan and walk used to be three activities. The clone lives
 * in the worker's own temp dir, so when Temporal scheduled the scan or walk on
 * another worker host (redeploy, scale-out, task-queue split) it failed with
 * ENOENT on every retry. New runs call `prepareRepositoryActivity` once.
 *
 * (b) An error escaping the workflow body failed the workflow without calling
 * `failCodeIndexActivity`, so the row read "indexing" forever. Same for a
 * final stats write that exhausted its retries.
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
	CodeIndexingWorkflowInput,
	CodeIndexingWorkflowOutput,
} from "../code-indexing";

const WORKFLOWS_PATH = resolve(__dirname, "..");
const WORKFLOW_NAME = "codeIndexingWorkflow";

let env: TestWorkflowEnvironment;
let workflowBundle: WorkflowBundleWithSourceMap;
let legacyBundle: WorkflowBundleWithSourceMap;
let preSummariesBundle: WorkflowBundleWithSourceMap;
let taskQueueSeq = 0;

beforeAll(async () => {
	env = await TestWorkflowEnvironment.createTimeSkipping();
	workflowBundle = await bundleWorkflowCode({
		workflowsPath: WORKFLOWS_PATH,
	});
	// Record genuine activity histories with one patch disabled: the
	// worker-local patch (old preparation, slice commands and short
	// finalization timeout) or the summaries patch (one try/catch around the
	// whole summaries loop).
	const bundleWithout = async (patchId: string) => {
		const dir = mkdtempSync(join(WORKFLOWS_PATH, ".code-index-replay-"));
		try {
			const original = readFileSync(
				join(WORKFLOWS_PATH, "code-indexing.ts"),
				"utf8",
			);
			const source = original
				.replace(`patched("${patchId}")`, "false")
				.replace(
					'"./code-indexing-incremental"',
					'"../code-indexing-incremental"',
				);
			if (source.includes(`patched("${patchId}")`)) {
				throw new Error(`${patchId} is evaluated more than once`);
			}
			writeFileSync(join(dir, "workflow.ts"), source);
			return await bundleWorkflowCode({
				workflowsPath: join(dir, "workflow.ts"),
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	};
	legacyBundle = await bundleWithout("code-index-worker-local-consumers-v1");
	preSummariesBundle = await bundleWithout(
		"code-index-summaries-resilient-v1",
	);
}, 180_000);

afterAll(async () => {
	await env?.teardown();
});

const CLONE_PATH = "/tmp/fabric-code-index-test-run";
const MANIFEST_PATH = `${CLONE_PATH}.code-index-manifest.json`;
const CHANGED_MANIFEST_PATH = `${CLONE_PATH}.code-index-changed-manifest.json`;

interface Call {
	name: string;
	args: unknown[];
}

type Overrides = Record<string, (...args: unknown[]) => Promise<unknown>>;

function fail(message: string): never {
	throw ApplicationFailure.nonRetryable(message, "TEST_FAILURE");
}

async function runWorkflow(
	overrides: Overrides = {},
	inputOverrides: Partial<CodeIndexingWorkflowInput> = {},
	bundle = workflowBundle,
): Promise<{
	calls: Call[];
	result?: CodeIndexingWorkflowOutput;
	error?: unknown;
	history?: Awaited<
		ReturnType<
			ReturnType<typeof env.client.workflow.getHandle>["fetchHistory"]
		>
	>;
	workflowId: string;
	firstExecutionRunId: string;
}> {
	const calls: Call[] = [];
	const base: Overrides = {
		checkCodeIndexingEnabledActivity: async () => true,
		resolveRepoTokenActivity: async () => ({
			token: "example-token",
			authMethod: "pat",
		}),
		initCodeIndexActivity: async () => undefined,
		getCodeEmbeddingModelActivity: async () => null,
		prepareRepositoryActivity: async (...args) => {
			const input = args[0] as { changedFiles?: string[] };
			return {
				clone: {
					clonePath: CLONE_PATH,
					commitSha: "abc123",
					branch: "main",
				},
				scan: { secretsFound: 0, redactionManifest: [] },
				tree: {
					manifestPath: MANIFEST_PATH,
					totalFiles: 2,
					skippedFiles: 0,
				},
				...(input.changedFiles
					? {
							changed: {
								manifestPath: CHANGED_MANIFEST_PATH,
								count: 1,
							},
						}
					: {}),
			};
		},
		// The split activities stay registered for pre-patch replay; new runs
		// must never schedule them.
		cloneRepositoryActivity: async () => ({
			clonePath: CLONE_PATH,
			commitSha: "abc123",
			branch: "main",
		}),
		scanForSecretsActivity: async () => ({
			secretsFound: 0,
			redactionManifest: [],
		}),
		walkFileTreeActivity: async () => ({
			manifestPath: MANIFEST_PATH,
			totalFiles: 2,
			skippedFiles: 0,
		}),
		selectChangedFilesFromManifestActivity: async () => ({
			manifestPath: CHANGED_MANIFEST_PATH,
			count: 1,
		}),
		deleteProjectCodeSymbolsActivity: async () => undefined,
		deleteChangedCodeVectorsActivity: async () => ({ deletedPaths: 1 }),
		readFileManifestSliceActivity: async () => ({
			files: [
				{
					relativePath: "src/a.ts",
					absolutePath: `${CLONE_PATH}/src/a.ts`,
					language: "typescript",
				},
			],
		}),
		extractAndPersistSymbolsActivity: async () => ({ insertedCount: 1 }),
		chunkAndEmbedBatchActivity: async () => ({
			chunksCreated: 2,
			filesProcessed: 2,
			errors: [],
		}),
		generateFileSummariesActivity: async () => ({
			summariesCreated: 2,
			errors: [],
		}),
		updateCodeIndexActivity: async () => undefined,
		cleanupCloneDirActivity: async () => undefined,
		failCodeIndexActivity: async () => undefined,
	};

	// Both generations are registered during rollout. Old workers understand
	// only file lists, so any metadata-only invocation of an old name must fail.
	for (const [newName, oldName] of [
		["prepareRepositoryMetadataActivity", "prepareRepositoryActivity"],
		[
			"chunkAndEmbedMaterializedBatchActivity",
			"chunkAndEmbedBatchActivity",
		],
		[
			"generateMaterializedFileSummariesActivity",
			"generateFileSummariesActivity",
		],
		[
			"extractAndPersistMaterializedSymbolsActivity",
			"extractAndPersistSymbolsActivity",
		],
		["updateMaterializedCodeIndexActivity", "updateCodeIndexActivity"],
	]) {
		base[newName] = base[oldName];
	}
	for (const name of [
		"chunkAndEmbedBatchActivity",
		"generateFileSummariesActivity",
		"extractAndPersistSymbolsActivity",
	]) {
		const old = base[name];
		base[name] = async (...args) => {
			if (!(args[0] as { files: unknown[] }).files.length) {
				fail("Legacy activity received an empty metadata batch");
			}
			return old(...args);
		};
	}

	const activities = Object.fromEntries(
		Object.entries({ ...base, ...overrides }).map(([name, impl]) => [
			name,
			async (...args: unknown[]) => {
				calls.push({ name, args });
				return impl(...args);
			},
		]),
	);

	const input: CodeIndexingWorkflowInput = {
		projectId: "proj-1",
		userId: "user-1",
		organizationId: "org-1",
		repositoryUrl: "https://github.com/example-org/example-repo",
		branch: "main",
		token: "example-token",
		integrationId: "integration-1",
		provider: "GITHUB",
		repoName: "example-org/example-repo",
		...inputOverrides,
	};

	const taskQueue = `code-index-prepare-${taskQueueSeq++}`;
	const worker = await Worker.create({
		connection: env.nativeConnection,
		taskQueue,
		workflowBundle: bundle,
		activities,
	});

	const workflowId = `${taskQueue}-wf`;
	const handle = await env.client.workflow.start(WORKFLOW_NAME, {
		args: [input],
		taskQueue,
		workflowId,
	});
	const ids = { workflowId, firstExecutionRunId: handle.firstExecutionRunId };
	try {
		const result = (await worker.runUntil(
			handle.result(),
		)) as CodeIndexingWorkflowOutput;
		const history = await handle.fetchHistory();
		return { calls, result, history, ...ids };
	} catch (error) {
		return { calls, error, ...ids };
	}
}

const named = (calls: Call[], name: string) =>
	calls.filter((c) => c.name === name);

const SPLIT_ACTIVITIES = [
	"cloneRepositoryActivity",
	"scanForSecretsActivity",
	"walkFileTreeActivity",
	"selectChangedFilesFromManifestActivity",
];

describe("codeIndexingWorkflow — one prepare activity", () => {
	it("prepares the repository in one activity and never schedules the split clone/scan/walk", async () => {
		const { calls, result, error } = await runWorkflow();

		expect(error).toBeUndefined();
		expect(result?.success).toBe(true);
		expect(result?.filesIndexed).toBe(2);
		expect(named(calls, "prepareRepositoryMetadataActivity")).toHaveLength(
			1,
		);
		for (const name of [
			"prepareRepositoryActivity",
			"chunkAndEmbedBatchActivity",
			"generateFileSummariesActivity",
			"extractAndPersistSymbolsActivity",
			"updateCodeIndexActivity",
		]) {
			expect(named(calls, name)).toHaveLength(0);
		}
		for (const name of SPLIT_ACTIVITIES) {
			expect(named(calls, name)).toHaveLength(0);
		}
		// Full run: no changed-file list crosses into prepare.
		expect(
			named(calls, "prepareRepositoryMetadataActivity")[0].args[0],
		).not.toHaveProperty("changedFiles");
		// First run records the resolved commit after prepare.
		const inits = named(calls, "initCodeIndexActivity").map(
			(c) => (c.args[0] as { commitSha: string }).commitSha,
		);
		expect(inits).toEqual(["pending", "abc123"]);
		expect(named(calls, "failCodeIndexActivity")).toHaveLength(0);
		expect(named(calls, "readFileManifestSliceActivity")).toHaveLength(0);
		expect(
			named(calls, "prepareRepositoryMetadataActivity")[0].args[0],
		).not.toHaveProperty("disposeAfterPrepare");
		for (const name of [
			"extractAndPersistMaterializedSymbolsActivity",
			"chunkAndEmbedMaterializedBatchActivity",
			"generateMaterializedFileSummariesActivity",
			"updateMaterializedCodeIndexActivity",
		]) {
			expect(named(calls, name)[0].args[0]).toMatchObject({
				repository: { commitSha: "abc123", branch: "main" },
			});
		}
	});

	it("an incremental run gets its changed subset from prepare, not a separate activity", async () => {
		const { calls, result } = await runWorkflow(
			{},
			{ incremental: true, changedFiles: ["src/a.ts"] },
		);

		expect(result?.success).toBe(true);
		const prepareInput = named(
			calls,
			"prepareRepositoryMetadataActivity",
		)[0].args[0] as { changedFiles?: string[] };
		expect(prepareInput.changedFiles).toEqual(["src/a.ts"]);
		expect(
			named(calls, "selectChangedFilesFromManifestActivity"),
		).toHaveLength(0);
		expect(named(calls, "readFileManifestSliceActivity")).toHaveLength(0);
		expect(
			named(calls, "chunkAndEmbedMaterializedBatchActivity")[0].args[0],
		).toMatchObject({
			files: [],
			repository: { commitSha: "abc123" },
			repositoryBatch: {
				startIndex: 0,
				count: 50,
				changedFiles: ["src/a.ts"],
			},
		});
	});

	it("a prepare failure marks the row failed with the activity's own reason", async () => {
		const { calls, result } = await runWorkflow({
			prepareRepositoryMetadataActivity: async () =>
				fail("ENOENT: no such file or directory, scandir"),
		});

		expect(result?.success).toBe(false);
		const failures = named(calls, "failCodeIndexActivity");
		expect(failures).toHaveLength(1);
		expect((failures[0].args[0] as { error: string }).error).toBe(
			"Repository preparation failed: ENOENT: no such file or directory, scandir",
		);
	});
});

describe("codeIndexingWorkflow — nothing leaves the row in INDEXING", () => {
	it("marks the row failed when an activity error escapes the workflow body", async () => {
		const { calls, error } = await runWorkflow({
			getCodeEmbeddingModelActivity: async () =>
				fail("project settings unavailable"),
		});

		expect(error).toBeDefined();
		const failures = named(calls, "failCodeIndexActivity");
		expect(failures).toHaveLength(1);
		expect(failures[0].args[0]).toMatchObject({
			projectId: "proj-1",
			repositoryIntegrationId: "integration-1",
			branch: "main",
			error: "project settings unavailable",
		});
	});

	it("lets continueAsNew recovery through untouched and fails the row once the budget is spent", async () => {
		const { calls, error } = await runWorkflow({
			chunkAndEmbedMaterializedBatchActivity: async () =>
				fail("embedding provider down"),
		});

		expect(error).toBeDefined();
		// First run + MAX_RECOVERY_ATTEMPTS (3) continuations, each re-preparing
		// at the pinned commit — no failCodeIndex on any continueAsNew.
		const prepares = named(calls, "prepareRepositoryMetadataActivity");
		expect(prepares).toHaveLength(4);
		for (const prepare of prepares) {
			expect(prepare.args[0]).not.toHaveProperty("disposeAfterPrepare");
		}
		for (const continuation of prepares.slice(1)) {
			expect(
				(continuation.args[0] as { commitSha?: string }).commitSha,
			).toBe("abc123");
		}
		const failures = named(calls, "failCodeIndexActivity");
		expect(failures).toHaveLength(1);
		expect((failures[0].args[0] as { error: string }).error).toBe(
			"embedding provider down",
		);
	});

	it("marks the row failed when the final stats write fails", async () => {
		const { calls, result } = await runWorkflow({
			updateMaterializedCodeIndexActivity: async () =>
				fail("database unavailable"),
		});

		expect(result?.success).toBe(false);
		const failures = named(calls, "failCodeIndexActivity");
		expect(failures).toHaveLength(1);
		expect((failures[0].args[0] as { error: string }).error).toBe(
			"Could not record index results: database unavailable",
		);
		// Cleanup still runs after the failed write.
		expect(named(calls, "cleanupCloneDirActivity")).toHaveLength(1);
	});
});

/**
 * Every ProjectCodeIndex write carries the indexing chain that owns it.
 *
 * The workflow id is stable per repo and a re-index starts with
 * TERMINATE_EXISTING, which does not stop an activity the terminated run has
 * in flight. The activities keep such a late write off the successor's row by
 * the chain's first run id and start time, so every init / fail / finalize /
 * embed call must carry them — including continueAsNew continuations, which
 * belong to the same chain.
 */
describe("codeIndexingWorkflow — the chain owns its writes", () => {
	// Every activity that writes the index row or the Job Hub row.
	const OWNED = [
		"initCodeIndexActivity",
		"failCodeIndexActivity",
		"updateMaterializedCodeIndexActivity",
		"extractAndPersistMaterializedSymbolsActivity",
		"chunkAndEmbedMaterializedBatchActivity",
		"prepareRepositoryMetadataActivity",
		"generateMaterializedFileSummariesActivity",
	];

	function owners(calls: Call[]) {
		return calls
			.filter((c) => OWNED.includes(c.name))
			.map((c) => ({
				name: c.name,
				owner: (c.args[0] as { owner?: unknown }).owner,
			}));
	}

	/**
	 * Every owned call names the chain's first run. The start time is the
	 * current run's (a continuation reports its own, later one), so it only
	 * ever moves forward along the chain — the ordering the query layer needs.
	 */
	function expectChainOwner(
		calls: Call[],
		firstExecutionRunId: string,
		expectedNames: string[],
	): string[] {
		const owned = owners(calls);
		expect(owned.map((o) => o.name).sort()).toEqual(
			[...expectedNames].sort(),
		);
		for (const call of calls) {
			const descriptor = (
				call.args[0] as { repository?: { owner?: unknown } } | undefined
			)?.repository;
			if (descriptor) {
				expect(descriptor.owner).toEqual(
					(call.args[0] as { owner?: unknown }).owner,
				);
			}
		}
		const startedAts = owned.map((o) => {
			expect(o.owner).toEqual({
				runId: firstExecutionRunId,
				startedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
			});
			return (o.owner as { startedAt: string }).startedAt;
		});
		expect([...startedAts].sort()).toEqual(startedAts);
		return startedAts;
	}

	it("a successful run passes the owner to init, embed and finalize", async () => {
		const { calls, result, firstExecutionRunId } = await runWorkflow();

		expect(result?.success).toBe(true);
		const startedAts = expectChainOwner(calls, firstExecutionRunId, [
			"initCodeIndexActivity",
			"initCodeIndexActivity",
			"prepareRepositoryMetadataActivity",
			"extractAndPersistMaterializedSymbolsActivity",
			"chunkAndEmbedMaterializedBatchActivity",
			"generateMaterializedFileSummariesActivity",
			"updateMaterializedCodeIndexActivity",
		]);
		// One run: one start time.
		expect(new Set(startedAts).size).toBe(1);
	});

	it("the feature-disabled failure carries the owner", async () => {
		const { calls, firstExecutionRunId } = await runWorkflow({
			checkCodeIndexingEnabledActivity: async () => false,
		});

		expectChainOwner(calls, firstExecutionRunId, ["failCodeIndexActivity"]);
	});

	it("the no-token failure carries the owner", async () => {
		const { calls, firstExecutionRunId } = await runWorkflow(
			{
				resolveRepoTokenActivity: async () => ({
					token: null,
					authMethod: null,
				}),
			},
			{ token: undefined },
		);

		expectChainOwner(calls, firstExecutionRunId, ["failCodeIndexActivity"]);
	});

	it("the prepare failure carries the owner", async () => {
		const { calls, firstExecutionRunId } = await runWorkflow({
			prepareRepositoryMetadataActivity: async () =>
				fail("clone refused"),
		});

		expectChainOwner(calls, firstExecutionRunId, [
			"initCodeIndexActivity",
			"prepareRepositoryMetadataActivity",
			"failCodeIndexActivity",
		]);
	});

	it("the fail-on-throw guard carries the owner", async () => {
		const { calls, error, firstExecutionRunId } = await runWorkflow({
			getCodeEmbeddingModelActivity: async () =>
				fail("project settings unavailable"),
		});

		expect(error).toBeDefined();
		expectChainOwner(calls, firstExecutionRunId, [
			"initCodeIndexActivity",
			"failCodeIndexActivity",
		]);
	});

	it("a failed stats write marks the row failed as the same owner", async () => {
		const { calls, firstExecutionRunId } = await runWorkflow({
			updateMaterializedCodeIndexActivity: async () =>
				fail("database unavailable"),
		});

		expectChainOwner(calls, firstExecutionRunId, [
			"initCodeIndexActivity",
			"initCodeIndexActivity",
			"prepareRepositoryMetadataActivity",
			"extractAndPersistMaterializedSymbolsActivity",
			"chunkAndEmbedMaterializedBatchActivity",
			"generateMaterializedFileSummariesActivity",
			"updateMaterializedCodeIndexActivity",
			"failCodeIndexActivity",
		]);
	});

	it("continueAsNew continuations keep the first run's id", async () => {
		const { calls, error, firstExecutionRunId } = await runWorkflow({
			chunkAndEmbedMaterializedBatchActivity: async () =>
				fail("embedding provider down"),
		});

		expect(error).toBeDefined();
		// First run + 3 recovery continuations, each a new run of the chain.
		expect(named(calls, "prepareRepositoryMetadataActivity")).toHaveLength(
			4,
		);
		expectChainOwner(calls, firstExecutionRunId, [
			"initCodeIndexActivity",
			"initCodeIndexActivity",
			"extractAndPersistMaterializedSymbolsActivity",
			...Array(4).fill("prepareRepositoryMetadataActivity"),
			...Array(4).fill("chunkAndEmbedMaterializedBatchActivity"),
			"failCodeIndexActivity",
		]);
	});
});

/**
 * Adding `owner` changes only activity arguments — no command is added or
 * reordered — so no patch marker guards it. This records runs with the new
 * code, strips `owner` from every recorded activity input (the shape a run
 * recorded before this change has), and replays them.
 */
describe("codeIndexingWorkflow — replaying histories recorded without an owner", () => {
	type History = Awaited<
		ReturnType<
			ReturnType<typeof env.client.workflow.getHandle>["fetchHistory"]
		>
	>;

	function stripOwner(history: History): number {
		let stripped = 0;
		for (const event of history.events ?? []) {
			const payload =
				event.activityTaskScheduledEventAttributes?.input
					?.payloads?.[0];
			if (!payload?.data) {
				continue;
			}
			const input = JSON.parse(Buffer.from(payload.data).toString());
			if (input && typeof input === "object" && "owner" in input) {
				delete input.owner;
				payload.data = Buffer.from(JSON.stringify(input));
				stripped += 1;
			}
		}
		return stripped;
	}

	it("replays a successful run", async () => {
		const { result, workflowId, firstExecutionRunId } = await runWorkflow(
			{},
			{},
			legacyBundle,
		);
		expect(result?.success).toBe(true);

		const history = await env.client.workflow
			.getHandle(workflowId, firstExecutionRunId)
			.fetchHistory();
		// init x2, prepare, symbols, embed, summaries, finalize.
		expect(stripOwner(history)).toBe(7);

		await expect(
			Worker.runReplayHistory({ workflowBundle }, history, workflowId),
		).resolves.toBeUndefined();
	}, 120_000);

	it("replays a run that continued-as-new and one of its continuations", async () => {
		const { workflowId, firstExecutionRunId } = await runWorkflow(
			{
				chunkAndEmbedBatchActivity: async () =>
					fail("embedding provider down"),
			},
			{},
			legacyBundle,
		);

		const first = await env.client.workflow
			.getHandle(workflowId, firstExecutionRunId)
			.fetchHistory();
		expect(stripOwner(first)).toBeGreaterThan(0);
		await expect(
			Worker.runReplayHistory({ workflowBundle }, first, workflowId),
		).resolves.toBeUndefined();

		// The latest run of the chain: a continuation that failed the row.
		const last = await env.client.workflow
			.getHandle(workflowId)
			.fetchHistory();
		expect(stripOwner(last)).toBeGreaterThan(0);
		await expect(
			Worker.runReplayHistory({ workflowBundle }, last, workflowId),
		).resolves.toBeUndefined();
	}, 120_000);
});

describe("codeIndexingWorkflow — compatibility", () => {
	it("replays recorded full and incremental histories without the materialization patch", async () => {
		for (const input of [
			{},
			{ incremental: true, changedFiles: ["src/a.ts"] },
		]) {
			const recorded = await runWorkflow({}, input, legacyBundle);
			expect(recorded.error).toBeUndefined();
			expect(recorded.result?.success).toBe(true);
			expect(
				named(recorded.calls, "readFileManifestSliceActivity").length,
			).toBeGreaterThan(0);
			if (!recorded.history) {
				throw new Error("Recorded history missing");
			}
			await Worker.runReplayHistory(
				{ workflowBundle },
				recorded.history,
				recorded.workflowId,
			);
		}
	}, 60_000);
	it("keeps old continuation cursors on their original file ordering", async () => {
		const { calls, result } = await runWorkflow(
			{},
			{
				_cursor: {
					batchIndex: 0,
					totalChunks: 0,
					totalSymbols: 0,
					errorCount: 0,
					commitSha: "abc123",
					startTime: 1,
				},
			},
		);
		expect(result?.success).toBe(true);
		expect(
			named(calls, "prepareRepositoryActivity")[0].args[0],
		).not.toHaveProperty("sortManifest");
		expect(
			named(calls, "readFileManifestSliceActivity").length,
		).toBeGreaterThan(0);
		expect(
			named(calls, "chunkAndEmbedBatchActivity")[0].args[0],
		).not.toHaveProperty("repository");
	});
});

/**
 * File summaries fail per batch, get one re-pass, and whatever is still
 * missing reaches finalize as a count. Before this, the first failing batch
 * abandoned every batch after it and only `errorCount` said so.
 */
describe("codeIndexingWorkflow — summaries survive a failing batch", () => {
	// 150 files: three summaries batches, at offsets 0, 50 and 100.
	const THREE_BATCHES: Overrides = {
		prepareRepositoryMetadataActivity: async () => ({
			clone: {
				clonePath: CLONE_PATH,
				commitSha: "abc123",
				branch: "main",
			},
			scan: { secretsFound: 0, redactionManifest: [] },
			tree: {
				manifestPath: MANIFEST_PATH,
				totalFiles: 150,
				skippedFiles: 0,
			},
		}),
	};

	const startIndex = (args: unknown[]) =>
		(args[0] as { repositoryBatch: { startIndex: number } }).repositoryBatch
			.startIndex;

	/** Summaries by batch offset; `script` answers each call in turn. */
	function summaries(
		script: Record<
			number,
			Array<"throw" | { summariesCreated: number; failedFiles: number }>
		>,
	) {
		const seen = new Map<number, number>();
		return async (...args: unknown[]) => {
			const offset = startIndex(args);
			const attempt = seen.get(offset) ?? 0;
			seen.set(offset, attempt + 1);
			const answer = script[offset]?.[attempt] ?? {
				summariesCreated: 50,
				failedFiles: 0,
			};
			if (answer === "throw") {
				fail(`summaries batch ${offset} failed`);
			}
			return {
				...answer,
				errors: Array(answer.failedFiles).fill("Failed to read a file"),
			};
		};
	}

	const summaryOffsets = (calls: Call[]) =>
		named(calls, "generateMaterializedFileSummariesActivity").map((c) =>
			startIndex(c.args),
		);

	const finalizeInput = (calls: Call[]) =>
		named(calls, "updateMaterializedCodeIndexActivity")[0]?.args[0] as
			| Record<string, unknown>
			| undefined;

	it("re-runs a batch that threw once, and later batches still run", async () => {
		const { calls, result } = await runWorkflow({
			...THREE_BATCHES,
			generateMaterializedFileSummariesActivity: summaries({
				50: ["throw"],
			}),
		});

		expect(summaryOffsets(calls)).toEqual([0, 50, 100, 50]);
		expect(finalizeInput(calls)).toMatchObject({
			summariesCreated: 150,
			summariesFailed: 0,
			summariesTotal: 150,
		});
		expect(result?.success).toBe(true);
		expect(named(calls, "failCodeIndexActivity")).toHaveLength(0);
	});

	it("reports a batch that threw twice as wholly unsummarized, and still finalizes", async () => {
		const { calls, result } = await runWorkflow({
			...THREE_BATCHES,
			generateMaterializedFileSummariesActivity: summaries({
				50: ["throw", "throw"],
			}),
		});

		expect(summaryOffsets(calls)).toEqual([0, 50, 100, 50]);
		expect(finalizeInput(calls)).toMatchObject({
			summariesCreated: 100,
			summariesFailed: 50,
			summariesTotal: 150,
		});
		// The run reports the error, but the row goes READY: finalize ran and
		// nothing failed the index.
		expect(result?.success).toBe(false);
		expect(named(calls, "failCodeIndexActivity")).toHaveLength(0);
	});

	it("re-runs a batch that returned per-file errors, replacing its first result", async () => {
		const { calls, result } = await runWorkflow({
			...THREE_BATCHES,
			generateMaterializedFileSummariesActivity: summaries({
				0: [
					{ summariesCreated: 47, failedFiles: 3 },
					{ summariesCreated: 50, failedFiles: 0 },
				],
			}),
		});

		expect(summaryOffsets(calls)).toEqual([0, 50, 100, 0]);
		// 150, not 197: the re-run's count replaces the partial first one.
		expect(finalizeInput(calls)).toMatchObject({
			summariesCreated: 150,
			summariesFailed: 0,
		});
		expect(result?.success).toBe(true);
	});

	it("keeps a partial batch's first result when its re-run throws", async () => {
		const { calls } = await runWorkflow({
			...THREE_BATCHES,
			generateMaterializedFileSummariesActivity: summaries({
				100: [{ summariesCreated: 45, failedFiles: 5 }, "throw"],
			}),
		});

		expect(finalizeInput(calls)).toMatchObject({
			summariesCreated: 145,
			summariesFailed: 5,
		});
	});

	it("counts the files, not the error strings, of a batch whose embed call failed", async () => {
		const { calls } = await runWorkflow({
			...THREE_BATCHES,
			generateMaterializedFileSummariesActivity: async (...args) => {
				if (startIndex(args) === 100) {
					return {
						summariesCreated: 0,
						errors: ["Batch embedding failed: rate limited"],
						failedFiles: 50,
					};
				}
				return { summariesCreated: 50, errors: [], failedFiles: 0 };
			},
		});

		expect(finalizeInput(calls)).toMatchObject({
			summariesCreated: 100,
			summariesFailed: 50,
		});
	});

	it("falls back to the error count for a result without failedFiles", async () => {
		const { calls } = await runWorkflow({
			...THREE_BATCHES,
			generateMaterializedFileSummariesActivity: async (...args) =>
				startIndex(args) === 0
					? { summariesCreated: 48, errors: ["a", "b"] }
					: { summariesCreated: 50, errors: [] },
		});

		expect(finalizeInput(calls)).toMatchObject({ summariesFailed: 2 });
	});

	it("the unpatched loop still abandons the batches after a failure, with no count", async () => {
		const { calls, result } = await runWorkflow(
			{
				...THREE_BATCHES,
				generateMaterializedFileSummariesActivity: summaries({
					50: ["throw"],
				}),
			},
			{},
			preSummariesBundle,
		);

		expect(summaryOffsets(calls)).toEqual([0, 50]);
		expect(result?.success).toBe(false);
		const finalize = finalizeInput(calls);
		expect(finalize).toMatchObject({ summariesCreated: 50 });
		expect(finalize).not.toHaveProperty("summariesFailed");
		expect(finalize).not.toHaveProperty("summariesTotal");
	});

	it("replays a history recorded before the summaries patch", async () => {
		const recorded = await runWorkflow(
			{
				...THREE_BATCHES,
				generateMaterializedFileSummariesActivity: summaries({
					50: ["throw"],
				}),
			},
			{},
			preSummariesBundle,
		);
		if (!recorded.history) {
			throw new Error("Recorded history missing");
		}

		await expect(
			Worker.runReplayHistory(
				{ workflowBundle },
				recorded.history,
				recorded.workflowId,
			),
		).resolves.toBeUndefined();
	}, 60_000);

	it("replays a history recorded with the summaries patch", async () => {
		const recorded = await runWorkflow({
			...THREE_BATCHES,
			generateMaterializedFileSummariesActivity: summaries({
				50: ["throw", "throw"],
			}),
		});
		if (!recorded.history) {
			throw new Error("Recorded history missing");
		}

		await expect(
			Worker.runReplayHistory(
				{ workflowBundle },
				recorded.history,
				recorded.workflowId,
			),
		).resolves.toBeUndefined();
	}, 60_000);
});
