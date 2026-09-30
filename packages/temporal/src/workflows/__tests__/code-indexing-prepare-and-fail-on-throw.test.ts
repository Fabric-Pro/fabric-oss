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

import { resolve } from "node:path";
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
): Promise<{
	calls: Call[];
	result?: CodeIndexingWorkflowOutput;
	error?: unknown;
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
		workflowBundle,
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
		return { calls, result, ...ids };
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
		expect(named(calls, "prepareRepositoryActivity")).toHaveLength(1);
		for (const name of SPLIT_ACTIVITIES) {
			expect(named(calls, name)).toHaveLength(0);
		}
		// Full run: no changed-file list crosses into prepare.
		expect(
			named(calls, "prepareRepositoryActivity")[0].args[0],
		).not.toHaveProperty("changedFiles");
		// First run records the resolved commit after prepare.
		const inits = named(calls, "initCodeIndexActivity").map(
			(c) => (c.args[0] as { commitSha: string }).commitSha,
		);
		expect(inits).toEqual(["pending", "abc123"]);
		expect(named(calls, "failCodeIndexActivity")).toHaveLength(0);
	});

	it("an incremental run gets its changed subset from prepare, not a separate activity", async () => {
		const { calls, result } = await runWorkflow(
			{},
			{ incremental: true, changedFiles: ["src/a.ts"] },
		);

		expect(result?.success).toBe(true);
		const prepareInput = named(calls, "prepareRepositoryActivity")[0]
			.args[0] as { changedFiles?: string[] };
		expect(prepareInput.changedFiles).toEqual(["src/a.ts"]);
		expect(
			named(calls, "selectChangedFilesFromManifestActivity"),
		).toHaveLength(0);
		const embedSlices = named(calls, "readFileManifestSliceActivity").map(
			(c) => (c.args[0] as { manifestPath: string }).manifestPath,
		);
		expect(embedSlices).toContain(CHANGED_MANIFEST_PATH);
	});

	it("a prepare failure marks the row failed with the activity's own reason", async () => {
		const { calls, result } = await runWorkflow({
			prepareRepositoryActivity: async () =>
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
			chunkAndEmbedBatchActivity: async () =>
				fail("embedding provider down"),
		});

		expect(error).toBeDefined();
		// First run + MAX_RECOVERY_ATTEMPTS (3) continuations, each re-preparing
		// at the pinned commit — no failCodeIndex on any continueAsNew.
		const prepares = named(calls, "prepareRepositoryActivity");
		expect(prepares).toHaveLength(4);
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
			updateCodeIndexActivity: async () => fail("database unavailable"),
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
		"updateCodeIndexActivity",
		"chunkAndEmbedBatchActivity",
		"prepareRepositoryActivity",
		"generateFileSummariesActivity",
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
			"prepareRepositoryActivity",
			"chunkAndEmbedBatchActivity",
			"generateFileSummariesActivity",
			"updateCodeIndexActivity",
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
			prepareRepositoryActivity: async () => fail("clone refused"),
		});

		expectChainOwner(calls, firstExecutionRunId, [
			"initCodeIndexActivity",
			"prepareRepositoryActivity",
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
			updateCodeIndexActivity: async () => fail("database unavailable"),
		});

		expectChainOwner(calls, firstExecutionRunId, [
			"initCodeIndexActivity",
			"initCodeIndexActivity",
			"prepareRepositoryActivity",
			"chunkAndEmbedBatchActivity",
			"generateFileSummariesActivity",
			"updateCodeIndexActivity",
			"failCodeIndexActivity",
		]);
	});

	it("continueAsNew continuations keep the first run's id", async () => {
		const { calls, error, firstExecutionRunId } = await runWorkflow({
			chunkAndEmbedBatchActivity: async () =>
				fail("embedding provider down"),
		});

		expect(error).toBeDefined();
		// First run + 3 recovery continuations, each a new run of the chain.
		expect(named(calls, "prepareRepositoryActivity")).toHaveLength(4);
		expectChainOwner(calls, firstExecutionRunId, [
			"initCodeIndexActivity",
			"initCodeIndexActivity",
			...Array(4).fill("prepareRepositoryActivity"),
			...Array(4).fill("chunkAndEmbedBatchActivity"),
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
		const { result, workflowId, firstExecutionRunId } = await runWorkflow();
		expect(result?.success).toBe(true);

		const history = await env.client.workflow
			.getHandle(workflowId, firstExecutionRunId)
			.fetchHistory();
		// init x2, prepare, embed, summaries, finalize.
		expect(stripOwner(history)).toBe(6);

		await expect(
			Worker.runReplayHistory({ workflowBundle }, history, workflowId),
		).resolves.toBeUndefined();
	}, 120_000);

	it("replays a run that continued-as-new and one of its continuations", async () => {
		const { workflowId, firstExecutionRunId } = await runWorkflow({
			chunkAndEmbedBatchActivity: async () =>
				fail("embedding provider down"),
		});

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
