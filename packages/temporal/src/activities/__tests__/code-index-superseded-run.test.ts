/**
 * A superseded indexing run must not write its successor's Job Hub row.
 *
 * The code-indexing workflow id is stable per repo, and a re-index terminates
 * the previous run without stopping the activity it has in flight. The Job
 * Hub writers key on (workflowId, repo), so the terminated run's late
 * init / fail / finalize would adopt, fail or complete the successor's open
 * row. The ProjectCodeIndex write goes first and reports whether this run's
 * chain still owns the row; a "superseded" outcome stops every Job Hub write
 * after it. Without an owner (a task scheduled before ownership existed) the
 * activities behave as before.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const jobMocks = vi.hoisted(() => ({
	jobStep: vi.fn(),
	jobComplete: vi.fn(),
	jobFail: vi.fn(),
	jobSetCounts: vi.fn(),
	jobEnsure: vi.fn(),
	jobIncrement: vi.fn(),
	jobHeartbeat: vi.fn(),
}));

vi.mock("../lib/job-progress", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return { ...actual, ...jobMocks };
});

const order = vi.hoisted(() => [] as string[]);

const dbMocks = vi.hoisted(() => ({
	updateCodeIndexStats: vi.fn(),
	updateCodeIndexStatus: vi.fn(),
	updateCodeIndexProgress: vi.fn(),
	upsertProjectCodeIndex: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return { ...actual, ...dbMocks };
});

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@temporalio/activity", () => ({
	Context: {
		current: () => ({
			info: {
				workflowExecution: {
					workflowId: "code-index-proj-1-repo-1",
					runId: "run-1",
				},
			},
			heartbeat: vi.fn(),
		}),
	},
	heartbeat: vi.fn(),
}));

// chunkAndEmbedBatchActivity loads these lazily; an empty batch touches only
// the collection lookup before its progress write.
vi.mock("@repo/rag/lib/chunking/code-chunker", () => ({
	chunkCodeFile: vi.fn(),
	isAstChunkable: vi.fn(),
	applyContextualRetrieval: vi.fn(),
}));
vi.mock("@repo/rag/lib/embedding", () => ({ generateEmbeddings: vi.fn() }));
vi.mock("@repo/rag/lib/embedding/sparse", () => ({
	generateSparseVector: vi.fn(),
}));
vi.mock("@repo/rag/lib/collection-manager", () => ({
	getCollectionLayout: vi.fn(async () => ({})),
	getCollectionName: vi.fn(() => "project-contexts"),
}));
vi.mock("@repo/rag/lib/project-contexts/client", () => ({
	qdrantClient: { upsert: vi.fn() },
}));
vi.mock("@repo/rag/lib/utils", () => ({ generatePointId: vi.fn() }));

import {
	chunkAndEmbedBatchActivity,
	failCodeIndexActivity,
	initCodeIndexActivity,
	updateCodeIndexActivity,
} from "../code-indexing";

const OWNER = { runId: "run-first-1", startedAt: "2026-01-01T10:00:00.000Z" };

const KEY = {
	projectId: "proj-1",
	repositoryIntegrationId: "repo-1",
	branch: "main",
};

const INIT = {
	...KEY,
	userId: "user-1",
	organizationId: "org-1",
	commitSha: "abc123",
	workflowId: "code-index-proj-1-repo-1",
	repoName: "example-org/example-repo",
};

const UPDATE = {
	...KEY,
	userId: "user-1",
	organizationId: "org-1",
	commitSha: "abc123",
	filesIndexed: 29,
	chunksCreated: 400,
	summariesCreated: 29,
	indexDurationMs: 1000,
	fileManifest: [],
	redactionManifest: [],
};

function allJobWrites() {
	return Object.entries(jobMocks).flatMap(([name, fn]) =>
		fn.mock.calls.map((args) => ({ name, args })),
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	order.length = 0;
	jobMocks.jobEnsure.mockImplementation(async () => {
		order.push("jobEnsure");
	});
	jobMocks.jobFail.mockImplementation(async () => {
		order.push("jobFail");
	});
	dbMocks.upsertProjectCodeIndex.mockImplementation(async () => {
		order.push("upsert");
		return "written";
	});
	dbMocks.updateCodeIndexStatus.mockImplementation(async () => {
		order.push("status");
		return "written";
	});
	dbMocks.updateCodeIndexStats.mockResolvedValue("written");
	dbMocks.updateCodeIndexProgress.mockResolvedValue({ count: 1 });
});

describe("initCodeIndexActivity", () => {
	it("claims the row before opening the Job Hub row", async () => {
		await initCodeIndexActivity({ ...INIT, owner: OWNER });

		expect(dbMocks.upsertProjectCodeIndex).toHaveBeenCalledWith(
			expect.objectContaining({
				...KEY,
				status: "INDEXING",
				owner: OWNER,
			}),
		);
		expect(order).toEqual(["upsert", "jobEnsure"]);
	});

	it("a superseded run does not adopt the successor's Job Hub row", async () => {
		dbMocks.upsertProjectCodeIndex.mockResolvedValue("superseded");

		await initCodeIndexActivity({ ...INIT, owner: OWNER });

		expect(jobMocks.jobEnsure).not.toHaveBeenCalled();
	});

	it("without an owner, keeps the original order and unconditional write", async () => {
		await initCodeIndexActivity(INIT);

		expect(order).toEqual(["jobEnsure", "upsert"]);
		expect(
			dbMocks.upsertProjectCodeIndex.mock.calls[0][0].owner,
		).toBeUndefined();
	});
});

describe("failCodeIndexActivity", () => {
	// The Job Hub write is fenced on the chain id rather than gated on the
	// index-row outcome: the index row is per branch, the job row per repo, so
	// an outcome gate misses a superseded run that still owns its own branch's
	// row. The fence is what keeps it off the successor's row.
	it.each(["written", "absent", "superseded"])(
		"always fails the job fenced to the chain (index row %s)",
		async (outcome) => {
			dbMocks.updateCodeIndexStatus.mockImplementation(async () => {
				order.push("status");
				return outcome;
			});

			await failCodeIndexActivity({
				...KEY,
				error: "boom",
				owner: OWNER,
			});

			expect(dbMocks.updateCodeIndexStatus).toHaveBeenCalledWith(
				KEY,
				"FAILED",
				"boom",
				OWNER,
			);
			expect(order).toEqual(["jobFail", "status"]);
			// Fenced and ordered: see failBackgroundJob's `runStartedAt`.
			expect(jobMocks.jobFail).toHaveBeenCalledWith("boom", {
				sourceId: "repo-1",
				runId: OWNER.runId,
				runStartedAt: OWNER.startedAt,
			});
		},
	);

	it("still fails the job, fenced, when the status write throws — and does not throw", async () => {
		dbMocks.updateCodeIndexStatus.mockRejectedValue(
			new Error("connection lost"),
		);

		await expect(
			failCodeIndexActivity({ ...KEY, error: "boom", owner: OWNER }),
		).resolves.toBeUndefined();

		expect(jobMocks.jobFail).toHaveBeenCalledWith("boom", {
			sourceId: "repo-1",
			runId: OWNER.runId,
			runStartedAt: OWNER.startedAt,
		});
	});

	it("without an owner, fails the job unfenced first, even when the status write throws", async () => {
		dbMocks.updateCodeIndexStatus.mockImplementation(async () => {
			order.push("status");
			throw new Error("connection lost");
		});

		await expect(
			failCodeIndexActivity({ ...KEY, error: "boom" }),
		).resolves.toBeUndefined();

		expect(order).toEqual(["jobFail", "status"]);
		expect(jobMocks.jobFail).toHaveBeenCalledWith("boom", {
			sourceId: "repo-1",
		});
		const [key, status, error, owner] =
			dbMocks.updateCodeIndexStatus.mock.calls[0];
		expect([key, status, error]).toEqual([KEY, "FAILED", "boom"]);
		expect(owner).toBeUndefined();
	});
});

describe("updateCodeIndexActivity", () => {
	it("passes the owner to the stats write and fences every Job Hub write", async () => {
		await updateCodeIndexActivity({ ...UPDATE, owner: OWNER });

		expect(dbMocks.updateCodeIndexStats).toHaveBeenCalledWith(
			expect.objectContaining({ ...KEY, owner: OWNER }),
		);
		expect(jobMocks.jobComplete).toHaveBeenCalledWith(
			expect.objectContaining({ runId: OWNER.runId }),
		);
		for (const [, , opts] of jobMocks.jobStep.mock.calls) {
			expect(opts).toMatchObject({ runId: OWNER.runId });
		}
	});

	it("a superseded run makes no Job Hub write at all", async () => {
		dbMocks.updateCodeIndexStats.mockResolvedValue("superseded");

		await updateCodeIndexActivity({ ...UPDATE, owner: OWNER });

		expect(allJobWrites()).toEqual([]);
	});

	it("a superseded empty run does not fail the successor's job either", async () => {
		dbMocks.updateCodeIndexStats.mockResolvedValue("superseded");

		await updateCodeIndexActivity({
			...UPDATE,
			chunksCreated: 0,
			owner: OWNER,
		});

		expect(allJobWrites()).toEqual([]);
	});

	it("without an owner, closes the job as before", async () => {
		dbMocks.updateCodeIndexStats.mockResolvedValue("absent");

		await updateCodeIndexActivity(UPDATE);

		expect(
			dbMocks.updateCodeIndexStats.mock.calls[0][0].owner,
		).toBeUndefined();
		expect(jobMocks.jobComplete).toHaveBeenCalled();
	});
});

describe("chunkAndEmbedBatchActivity", () => {
	it("passes the owner to the live-progress write", async () => {
		await chunkAndEmbedBatchActivity({
			files: [],
			...KEY,
			userId: "user-1",
			organizationId: "org-1",
			repoName: "example-org/example-repo",
			filesProcessedSoFar: 50,
			totalFileCount: 120,
			owner: OWNER,
		});

		expect(dbMocks.updateCodeIndexProgress).toHaveBeenCalledWith(
			KEY,
			{ indexedFileCount: 50, totalFileCount: 120 },
			OWNER,
		);
	});

	it("a superseded batch (progress matched no row) fences every Job Hub write", async () => {
		dbMocks.updateCodeIndexProgress.mockResolvedValue({ count: 0 });

		await chunkAndEmbedBatchActivity({
			files: [],
			...KEY,
			userId: "user-1",
			organizationId: "org-1",
			repoName: "example-org/example-repo",
			filesProcessedSoFar: 50,
			totalFileCount: 120,
			owner: OWNER,
		});

		expect(jobMocks.jobStep).toHaveBeenCalledWith("embed", "running", {
			sourceId: "repo-1",
			runId: OWNER.runId,
		});
		expect(jobMocks.jobHeartbeat).toHaveBeenCalledWith("repo-1", {
			runId: OWNER.runId,
		});
		expect(jobMocks.jobIncrement).toHaveBeenCalledWith(
			expect.anything(),
			"repo-1",
			{ runId: OWNER.runId },
		);
	});
});
