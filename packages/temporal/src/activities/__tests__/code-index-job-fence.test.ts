/**
 * Every Job Hub write from a code-indexing activity is fenced to its chain.
 *
 * The workflow id is stable per repo and a re-index terminates the previous
 * run with TERMINATE_EXISTING, which does not stop the activity it has in
 * flight. The Job Hub row is per repo; the start path relabels it with the new
 * chain's first run id. Fencing only on the per-branch index row is not
 * enough: after a branch change the terminated chain still owns its own
 * branch's index row, so its late fail / finalize "wins" there and used to go
 * on to fail or complete the successor's job row. Progress writes (clone, scan,
 * walk, embed, summaries, symbols) landed on it the same way.
 *
 * These run the real `job-progress` helpers against a stand-in for the
 * @repo/database BackgroundJob writers that honours the documented fence
 * (a fenced key writes only a row labeled with its chain, or unlabeled — the
 * writers themselves are covered in packages/database). Each assertion is on
 * the one Job Hub row the successor owns.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { MockActivityEnvironment } from "@temporalio/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";

const OLD = { runId: "run-older-chain", startedAt: "2026-01-01T10:00:00.000Z" };
const NEW = { runId: "run-newer-chain", startedAt: "2026-01-01T10:05:00.000Z" };

type Key = { workflowId: string; sourceId?: string | null; runId?: string };

const hub = vi.hoisted(() => ({
	job: {} as {
		runId: string | null;
		runStartedAt: string | null;
		status: string;
		steps: Record<string, string>;
		counts: Record<string, number>;
		error: string | null;
		heartbeats: number;
	},
	keys: [] as Array<{ writer: string; key: Key }>,
	ensured: [] as Array<Record<string, unknown>>,
}));

const indexOutcome = vi.hoisted(() => ({
	upsert: "written" as string,
	status: "written" as string | Error,
	stats: "written" as string,
}));

vi.mock("@repo/database", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	const admits = (key: Key) =>
		hub.job.status === "RUNNING" &&
		(key.runId === undefined ||
			hub.job.runId === null ||
			hub.job.runId === key.runId);
	const record = (writer: string, key: Key) => {
		hub.keys.push({ writer, key });
		return admits(key);
	};
	return {
		...actual,
		setBackgroundJobStep: async (
			key: Key,
			step: string,
			status: string,
		) => {
			if (record("setBackgroundJobStep", key)) {
				hub.job.steps[step] = status;
			}
		},
		touchBackgroundJobHeartbeat: async (key: Key) => {
			if (record("touchBackgroundJobHeartbeat", key)) {
				hub.job.heartbeats += 1;
			}
		},
		incrementBackgroundJobCounts: async (
			key: Key,
			deltas: Record<string, number>,
		) => {
			if (record("incrementBackgroundJobCounts", key)) {
				for (const [k, v] of Object.entries(deltas)) {
					hub.job.counts[k] = (hub.job.counts[k] ?? 0) + v;
				}
			}
		},
		setBackgroundJobCounts: async (
			key: Key,
			counts: Record<string, number>,
		) => {
			if (record("setBackgroundJobCounts", key)) {
				Object.assign(hub.job.counts, counts);
			}
		},
		completeBackgroundJob: async (
			key: Key,
			opts?: { counts?: Record<string, number> },
		) => {
			if (record("completeBackgroundJob", key)) {
				Object.assign(hub.job.counts, opts?.counts ?? {});
				hub.job.status = "COMPLETED";
			}
		},
		failBackgroundJob: async (
			key: Key,
			args: { error: string; runStartedAt?: string },
		) => {
			// The ordered arm (see failBackgroundJob): also take over a row whose
			// ordered claim started no later, relabeling it.
			const ordered =
				key.runId !== undefined && args.runStartedAt !== undefined;
			const takesOver =
				ordered &&
				hub.job.status === "RUNNING" &&
				hub.job.runStartedAt !== null &&
				Date.parse(hub.job.runStartedAt) <=
					Date.parse(args.runStartedAt as string);
			if (record("failBackgroundJob", key) || takesOver) {
				hub.job.status = "FAILED";
				hub.job.error = args.error;
				if (ordered) {
					hub.job.runId = key.runId as string;
					hub.job.runStartedAt = args.runStartedAt as string;
				}
			}
		},
		ensureRunningBackgroundJob: async (args: Record<string, unknown>) => {
			hub.ensured.push(args);
			return "job-1";
		},
		upsertProjectCodeIndex: async () => indexOutcome.upsert,
		updateCodeIndexStatus: async () => {
			if (indexOutcome.status instanceof Error) {
				throw indexOutcome.status;
			}
			return indexOutcome.status;
		},
		failCodeIndexUnlessOwnReady: async () => {
			if (indexOutcome.status instanceof Error) {
				throw indexOutcome.status;
			}
			return indexOutcome.status;
		},
		updateCodeIndexStats: async () => indexOutcome.stats,
		updateCodeIndexProgress: async () => ({ count: 0 }),
		createCodeSymbols: async () => ({ count: 1 }),
		deleteCodeSymbolsByProject: async () => ({ count: 0 }),
	};
});

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

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

// simple-git stand-in: a "clone" writes one source file at the target path.
vi.mock("simple-git", () => ({
	simpleGit: () => ({
		clone: async (_url: string, clonePath: string) => {
			fs.mkdirSync(path.join(clonePath, "src"), { recursive: true });
			fs.writeFileSync(
				path.join(clonePath, "src", "app.ts"),
				"export const app = 1;\n",
			);
		},
		listRemote: async () => "ref: refs/heads/main\tHEAD\n",
		log: async () => ({ latest: { hash: "0123456789abcdef" } }),
	}),
}));

const {
	chunkAndEmbedBatchActivity,
	cleanupCloneDirActivity,
	failCodeIndexActivity,
	generateFileSummariesActivity,
	initCodeIndexActivity,
	persistCodeSymbolsActivity,
	prepareRepositoryActivity,
	updateCodeIndexActivity,
} = await import("../code-indexing");

function run<A extends unknown[], R>(
	fn: (...args: A) => Promise<R>,
	...args: A
): Promise<R> {
	return new MockActivityEnvironment().run(fn, ...args) as Promise<R>;
}

const KEY = {
	projectId: "proj-1",
	repositoryIntegrationId: "repo-1",
	userId: "user-1",
	organizationId: "org-1",
};

let seq = 0;

/** Every Job Hub-writing activity, as one chain would run them. */
async function runEveryActivity(owner: typeof OLD): Promise<void> {
	const prepared = await run(prepareRepositoryActivity, {
		repositoryUrl: "https://github.com/example-org/example-repo",
		branch: "main",
		token: "example-token",
		provider: "GITHUB",
		workflowRunId: `fence-test-${process.pid}-${seq++}`,
		owner,
	});
	try {
		const batch = {
			...KEY,
			files: [],
			repoName: "example-org/example-repo",
			branch: "main",
			owner,
		};
		await run(chunkAndEmbedBatchActivity, {
			...batch,
			filesProcessedSoFar: 0,
			totalFileCount: 1,
		});
		await run(generateFileSummariesActivity, batch);
		await run(persistCodeSymbolsActivity, {
			projectId: KEY.projectId,
			userId: KEY.userId,
			organizationId: KEY.organizationId,
			symbols: [
				{
					name: "app",
					type: "variable",
					filePath: "src/app.ts",
					lineStart: 1,
					lineEnd: 1,
					signature: null,
					language: "typescript",
					projectId: KEY.projectId,
					userId: KEY.userId,
					organizationId: KEY.organizationId,
				},
			] as never,
			owner,
		});
		await run(updateCodeIndexActivity, {
			...KEY,
			branch: "main",
			commitSha: "0123456789abcdef",
			filesIndexed: 1,
			chunksCreated: 4,
			summariesCreated: 1,
			indexDurationMs: 10,
			fileManifest: [],
			owner,
		});
	} finally {
		await run(cleanupCloneDirActivity, {
			clonePath: prepared.clone.clonePath,
		});
	}
}

function seedJob(runId: string | null, runStartedAt: string | null = null) {
	hub.job = {
		runId,
		runStartedAt,
		status: "RUNNING",
		steps: {},
		counts: {},
		error: null,
		heartbeats: 0,
	};
}

beforeEach(() => {
	hub.keys.length = 0;
	hub.ensured.length = 0;
	indexOutcome.upsert = "written";
	indexOutcome.status = "written";
	indexOutcome.stats = "written";
});

describe("a superseded chain leaves the successor's Job Hub row alone", () => {
	it("clone, scan, walk, embed, summaries, symbols and finalize make no effective write", async () => {
		seedJob(NEW.runId);
		const before = structuredClone(hub.job);

		// After a branch change the old chain still owns its own branch's
		// index row, so the finalize's stats write reports "written".
		await runEveryActivity(OLD);

		expect(hub.job).toEqual(before);
		const writers = new Set(hub.keys.map((k) => k.writer));
		for (const writer of [
			"setBackgroundJobStep",
			"setBackgroundJobCounts",
			"touchBackgroundJobHeartbeat",
			"incrementBackgroundJobCounts",
			"completeBackgroundJob",
		]) {
			expect(writers).toContain(writer);
		}
		for (const { key } of hub.keys) {
			expect(key.runId).toBe(OLD.runId);
		}
	});

	it("walk's absolute file count does not overwrite the successor's denominator", async () => {
		seedJob(NEW.runId);
		hub.job.counts.totalFiles = 3400;

		await runEveryActivity(OLD);

		expect(hub.job.counts.totalFiles).toBe(3400);
	});

	it("a fail whose own index-row write landed does not fail the successor's job", async () => {
		seedJob(NEW.runId);

		await run(failCodeIndexActivity, {
			...KEY,
			branch: "main",
			error: "late failure",
			owner: OLD,
		});

		expect(hub.job.status).toBe("RUNNING");
		expect(hub.job.error).toBeNull();
	});

	it("a fail whose status write threw is still fenced", async () => {
		seedJob(NEW.runId);
		indexOutcome.status = new Error("connection lost");

		await expect(
			run(failCodeIndexActivity, {
				...KEY,
				branch: "main",
				error: "late failure",
				owner: OLD,
			}),
		).resolves.toBeUndefined();

		expect(hub.job.status).toBe("RUNNING");
	});

	it("an empty full run's NothingIndexed failure is fenced too", async () => {
		seedJob(NEW.runId);

		await run(updateCodeIndexActivity, {
			...KEY,
			branch: "main",
			commitSha: "0123456789abcdef",
			filesIndexed: 3,
			chunksCreated: 0,
			summariesCreated: 0,
			indexDurationMs: 10,
			fileManifest: [],
			owner: OLD,
		});

		expect(hub.job.status).toBe("RUNNING");
	});
});

describe("a successor that fails before its init", () => {
	it("fails the predecessor-claimed row with its own error and takes the label", async () => {
		// A claimed the row; B's start path kept A's label; B then has no token.
		seedJob(OLD.runId, OLD.startedAt);

		await run(failCodeIndexActivity, {
			...KEY,
			branch: "main",
			error: "No repository token available",
			owner: NEW,
		});

		expect(hub.job).toMatchObject({
			status: "FAILED",
			error: "No repository token available",
			runId: NEW.runId,
			runStartedAt: NEW.startedAt,
		});
	});

	it("a late fail from the older chain is still refused by the newer claim", async () => {
		seedJob(NEW.runId, NEW.startedAt);

		await run(failCodeIndexActivity, {
			...KEY,
			branch: "main",
			error: "late failure",
			owner: OLD,
		});

		expect(hub.job).toMatchObject({ status: "RUNNING", runId: NEW.runId });
	});

	it("the finalize's NothingIndexed failure keeps the plain fence (no take-over)", async () => {
		seedJob(OLD.runId, OLD.startedAt);

		await run(updateCodeIndexActivity, {
			...KEY,
			branch: "main",
			commitSha: "0123456789abcdef",
			filesIndexed: 3,
			chunksCreated: 0,
			summariesCreated: 0,
			indexDurationMs: 10,
			fileManifest: [],
			owner: NEW,
		});

		expect(hub.job).toMatchObject({ status: "RUNNING", runId: OLD.runId });
	});
});

describe("the chain's own writes land", () => {
	it("on the row labeled with its chain", async () => {
		seedJob(NEW.runId);

		await runEveryActivity(NEW);

		expect(hub.job.status).toBe("COMPLETED");
		expect(hub.job.steps).toMatchObject({
			clone: "completed",
			secretScan: "completed",
			walk: "completed",
			symbols: "completed",
			finalize: "completed",
		});
	});

	it("a fail after a status-write error still closes its own job", async () => {
		seedJob(NEW.runId);
		indexOutcome.status = new Error("connection lost");

		await run(failCodeIndexActivity, {
			...KEY,
			branch: "main",
			error: "own failure",
			owner: NEW,
		});

		expect(hub.job).toMatchObject({
			status: "FAILED",
			error: "own failure",
		});
	});

	it("a fail that found its own READY index completes its job", async () => {
		seedJob(NEW.runId);
		indexOutcome.status = "kept-ready";

		await run(failCodeIndexActivity, {
			...KEY,
			branch: "main",
			error: "Could not record index results: clone failed",
			owner: NEW,
		});

		expect(hub.job).toMatchObject({ status: "COMPLETED", error: null });
	});

	it("on an unlabeled row", async () => {
		seedJob(null);

		await run(failCodeIndexActivity, {
			...KEY,
			branch: "main",
			error: "own failure",
			owner: OLD,
		});

		expect(hub.job.status).toBe("FAILED");
	});
});

describe("initCodeIndexActivity", () => {
	it("makes an ordered claim: the chain id (not the current run id) and the chain's start time", async () => {
		seedJob(null);

		await run(initCodeIndexActivity, {
			...KEY,
			branch: "main",
			commitSha: "pending",
			owner: NEW,
		});

		expect(hub.ensured).toHaveLength(1);
		expect(hub.ensured[0]).toMatchObject({
			runId: NEW.runId,
			runStartedAt: NEW.startedAt,
		});
	});

	it("a late init after a branch change still claims in order, so the database can refuse it", async () => {
		// The old chain owns its own branch's index row, so its index claim
		// lands; the Job Hub claim it makes next carries its (older) start time,
		// which `ensureRunningBackgroundJob` refuses against the newer claim.
		seedJob(NEW.runId);

		await run(initCodeIndexActivity, {
			...KEY,
			branch: "main",
			commitSha: "pending",
			owner: OLD,
		});

		expect(hub.ensured[0]).toMatchObject({
			runId: OLD.runId,
			runStartedAt: OLD.startedAt,
		});
	});

	it("without an owner, ensure is unordered, as before", async () => {
		seedJob(null);

		await run(initCodeIndexActivity, {
			...KEY,
			branch: "main",
			commitSha: "pending",
		});

		expect(hub.ensured[0]).not.toHaveProperty("runStartedAt");
		// The current run's id from the activity context, as before — not a
		// chain id.
		expect(hub.ensured[0].runId).toEqual(expect.any(String));
		expect([OLD.runId, NEW.runId]).not.toContain(hub.ensured[0].runId);
	});

	it("a superseded init does not reach the Job Hub", async () => {
		seedJob(NEW.runId);
		indexOutcome.upsert = "superseded";

		await run(initCodeIndexActivity, {
			...KEY,
			branch: "main",
			commitSha: "pending",
			owner: OLD,
		});

		expect(hub.ensured).toHaveLength(0);
	});
});

describe("without an owner (a task scheduled before this change)", () => {
	it("writes unfenced, as before", async () => {
		seedJob(NEW.runId);

		await run(failCodeIndexActivity, {
			...KEY,
			branch: "main",
			error: "legacy failure",
		});

		expect(hub.job.status).toBe("FAILED");
		for (const { key } of hub.keys) {
			expect(key).not.toHaveProperty("runId");
		}
	});
});
