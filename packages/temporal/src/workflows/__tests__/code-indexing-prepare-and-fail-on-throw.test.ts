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

	try {
		const result = (await worker.runUntil(
			env.client.workflow.execute(WORKFLOW_NAME, {
				args: [input],
				taskQueue,
				workflowId: `${taskQueue}-wf`,
			}),
		)) as CodeIndexingWorkflowOutput;
		return { calls, result };
	} catch (error) {
		return { calls, error };
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
