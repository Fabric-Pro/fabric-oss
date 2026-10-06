import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MockActivityEnvironment } from "@temporalio/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileManifestEntry } from "../code-indexing";

const state = vi.hoisted(() => ({
	paths: [] as string[],
	fetches: [] as string[][],
	failFetch: false,
	fetchGate: null as Promise<void> | null,
	jobHeartbeat: vi.fn(),
	jobStep: vi.fn(),
	jobSetCounts: vi.fn(),
	updateCodeIndexStats: vi.fn(),
	createCodeSymbols: vi.fn(async (rows: unknown[]) => ({
		count: rows.length,
	})),
	deleteCodeSymbolsByProjectAndFilePaths: vi.fn(),
	chunkCodeFile: vi.fn(async (_file: string, content: string) => [
		{
			index: 0,
			content,
			contextualizedContent: content,
			codeMetadata: {
				language: "typescript",
				entities: [],
				scopeChain: [],
			},
		},
	]),
	generateEmbeddings: vi.fn(async (texts: string[]) => ({
		embeddings: texts.map(() => [1, 0]),
	})),
	upsert: vi.fn(),
}));
vi.mock("../lib/job-progress", async (original) => ({
	...(await original<typeof import("../lib/job-progress")>()),
	jobStep: state.jobStep,
	jobSetCounts: state.jobSetCounts,
	jobEnsure: vi.fn(),
	jobIncrement: vi.fn(),
	jobHeartbeat: state.jobHeartbeat,
	jobComplete: vi.fn(),
	jobFail: vi.fn(),
}));
vi.mock("@repo/database", async (original) => ({
	...(await original<typeof import("@repo/database")>()),
	updateCodeIndexStats: state.updateCodeIndexStats,
	createCodeSymbols: state.createCodeSymbols,
	deleteCodeSymbolsByProjectAndFilePaths:
		state.deleteCodeSymbolsByProjectAndFilePaths,
}));
vi.mock("@repo/integrations/repo-auth", async (original) => ({
	...(await original<typeof import("@repo/integrations/repo-auth")>()),
	resolveFreshRepoToken: async () => ({ token: "example-token" }),
}));
vi.mock("@repo/rag/lib/chunking/code-chunker", () => ({
	isAstChunkable: () => true,
	chunkCodeFile: state.chunkCodeFile,
	applyContextualRetrieval: (content: string) => content,
}));
vi.mock("@repo/rag/lib/embedding", () => ({
	generateEmbeddings: state.generateEmbeddings,
}));
vi.mock("@repo/rag/lib/embedding/sparse", () => ({
	generateSparseVector: () => ({ indices: [], values: [] }),
}));
vi.mock("@repo/rag/lib/collection-manager", () => ({
	getCollectionLayout: async () => ({
		denseVectorName: "dense",
		isHybrid: false,
	}),
	getCollectionName: () => "example-collection",
}));
vi.mock("@repo/rag/lib/project-contexts/client", () => ({
	qdrantClient: { upsert: state.upsert },
}));
vi.mock("@repo/rag/lib/utils", () => ({ generatePointId: (id: string) => id }));

const PINNED_COMMIT = "a".repeat(40);
const FAKE_SECRET = `${"AK"}${"IA"}${"Q".repeat(16)}`;
function writeCheckout(dir: string) {
	// Deliberately write in reverse lexical order; slices must rebuild stably.
	fs.mkdirSync(path.join(dir, "src"), { recursive: true });
	fs.writeFileSync(
		path.join(dir, "src/z.ts"),
		"export function zebra() {}\n",
	);
	fs.writeFileSync(
		path.join(dir, "src/a.ts"),
		`export const key = "${FAKE_SECRET}";\nexport function alpha() {}\n`,
	);
	fs.writeFileSync(path.join(dir, "README.md"), "# example\n");
	fs.symlinkSync("a.ts", path.join(dir, "src/link.ts"));
}
vi.mock("simple-git", () => ({
	simpleGit: (dir?: string) => ({
		init: async () => {
			state.paths.push(dir as string);
		},
		addRemote: async () => undefined,
		listRemote: async () => "ref: refs/heads/main\tHEAD\n",
		fetch: async (args: string[]) => {
			state.fetches.push(args);
			await state.fetchGate;
			if (state.failFetch) {
				throw new Error("connection reset by peer");
			}
		},
		checkout: async () => writeCheckout(dir as string),
		clone: async (_url: string, clonePath: string) =>
			writeCheckout(clonePath),
		log: async () => ({ latest: { hash: PINNED_COMMIT } }),
	}),
}));

const {
	chunkAndEmbedMaterializedBatchActivity,
	generateMaterializedFileSummariesActivity,
	extractAndPersistMaterializedSymbolsActivity,
	updateMaterializedCodeIndexActivity,
	prepareRepositoryMetadataActivity,
	withMaterializedRepositoryBatch,
} = await import("../code-indexing");

const owner = {
	projectId: "example-project",
	userId: "example-user",
	organizationId: "example-org",
};
const runOwner = {
	runId: "example-chain",
	startedAt: "2026-01-01T10:00:00.000Z",
};
const repository = {
	owner: runOwner,
	integrationId: "example-integration",
	...owner,
	repositoryUrl: "https://github.com/example-org/example-repo",
	branch: "main",
	provider: "GITHUB" as const,
	token: "example-token",
	workflowRunId: "example-run",
	commitSha: PINNED_COMMIT,
};
const absentClone = path.join(
	os.tmpdir(),
	"fabric-code-index-absent-example-run",
);
const files = [
	{
		relativePath: "src/a.ts",
		absolutePath: `${absentClone}/src/a.ts`,
		language: "typescript",
	},
];
const input = {
	owner: runOwner,
	...owner,
	repoName: "example-repo",
	files,
	repository,
	repositoryBatch: { startIndex: 1, count: 1 },
};
function run<A extends unknown[], R>(
	fn: (...args: A) => Promise<R>,
	...args: A
): Promise<R> {
	return new MockActivityEnvironment().run(fn, ...args) as Promise<R>;
}
function expectClean() {
	for (const dir of state.paths) {
		expect(fs.existsSync(dir)).toBe(false);
		expect(fs.existsSync(`${dir}.code-index-manifest.json`)).toBe(false);
	}
	expect(fs.existsSync(absentClone)).toBe(false);
}
beforeEach(() => {
	vi.clearAllMocks();
	state.paths.length = 0;
	state.fetches.length = 0;
	state.failFetch = false;
	state.fetchGate = null;
	expect(fs.existsSync(absentClone)).toBe(false);
});

describe("worker-local repository consumers", () => {
	it("embedding reads a sanitized pinned checkout without the producer files", async () => {
		const result = await run(chunkAndEmbedMaterializedBatchActivity, input);
		expect(result.chunksCreated).toBe(1);
		expect(result.errors).toEqual([]);
		const content = state.chunkCodeFile.mock.calls[0][1];
		expect(content).toContain("[REDACTED]");
		expect(content).not.toContain(FAKE_SECRET);
		expect(state.fetches).toEqual([
			["--depth", "1", "origin", PINNED_COMMIT],
		]);
		expect(
			state.jobStep.mock.calls.some(([step]) =>
				["clone", "secretScan", "walk"].includes(step),
			),
		).toBe(false);
		expectClean();
	});
	it("summaries read real local files without the producer checkout", async () => {
		const result = await run(
			generateMaterializedFileSummariesActivity,
			input,
		);
		expect(result.summariesCreated).toBe(1);
		expect(result.errors).toEqual([]);
		expect(state.generateEmbeddings.mock.calls[0][0][0]).toContain("alpha");
		expectClean();
	});
	it("symbols read real local files and persist the extracted function", async () => {
		const result = await run(
			extractAndPersistMaterializedSymbolsActivity,
			input,
		);
		expect(result.insertedCount).toBeGreaterThan(0);
		expect(state.createCodeSymbols.mock.calls[0][0]).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "alpha" }),
			]),
		);
		expectClean();
	});
	it("finalization reconstructs the missing manifest in its own activity", async () => {
		await run(updateMaterializedCodeIndexActivity, {
			...owner,
			owner: runOwner,
			repository,
			manifestPath: `${absentClone}.code-index-manifest.json`,
			commitSha: PINNED_COMMIT,
			filesIndexed: 3,
			chunksCreated: 3,
			summariesCreated: 3,
			indexDurationMs: 10,
		});
		expect(state.updateCodeIndexStats).toHaveBeenCalledWith(
			expect.objectContaining({
				owner: runOwner,
				fileManifest: ["README.md", "src/a.ts", "src/z.ts"].map((p) =>
					expect.objectContaining({ path: p }),
				),
			}),
		);
		expectClean();
	});
	it("rebuilds sorted bounded full and changed slices inside each consumer", async () => {
		const seen: string[] = [];
		for (let startIndex = 0; startIndex < 3; startIndex++) {
			await run(
				withMaterializedRepositoryBatch,
				{
					...input,
					files: [],
					repositoryBatch: { startIndex, count: 1 },
				},
				async (localFiles: FileManifestEntry[]) => {
					expect(localFiles).toHaveLength(1);
					seen.push(localFiles[0].relativePath);
					expect(
						fs.readFileSync(localFiles[0].absolutePath, "utf8"),
					).not.toContain(FAKE_SECRET);
				},
			);
		}
		expect(seen).toEqual(["README.md", "src/a.ts", "src/z.ts"]);
		await run(
			withMaterializedRepositoryBatch,
			{
				...input,
				files: [],
				repositoryBatch: {
					startIndex: 0,
					count: 50,
					changedFiles: ["src/z.ts", "deleted.ts"],
				},
			},
			async (localFiles) =>
				expect(localFiles.map((f) => f.relativePath)).toEqual([
					"src/z.ts",
				]),
		);
		expect(new Set(state.paths).size).toBe(4);
		expectClean();
	});
	it("cleans overlapping consumer invocations independently", async () => {
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		let entered!: () => void;
		const ready = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const first = run(
			withMaterializedRepositoryBatch,
			input,
			async (localFiles) => {
				entered();
				await blocked;
				expect(
					fs.readFileSync(localFiles[0].absolutePath, "utf8"),
				).toContain("alpha");
			},
		);
		await ready;
		await run(
			withMaterializedRepositoryBatch,
			input,
			async () => undefined,
		);
		expect(state.paths[0]).not.toBe(state.paths[1]);
		expect(fs.existsSync(state.paths[0])).toBe(true);
		release();
		await first;
		expectClean();
	});
	it("lets reconstruction failures retry rather than reporting an empty successful batch", async () => {
		state.failFetch = true;
		await expect(
			run(chunkAndEmbedMaterializedBatchActivity, input),
		).rejects.toThrow("connection reset");
		expect(state.chunkCodeFile).not.toHaveBeenCalled();
		expectClean();
	});
	it("cleans up when the consumer throws", async () => {
		await expect(
			run(withMaterializedRepositoryBatch, input, async () => {
				throw new Error("consumer failed");
			}),
		).rejects.toThrow("consumer failed");
		expectClean();
	});
	it.each([
		"../outside.ts",
		"/outside.ts",
		"C:\\outside.ts",
		"src/../../outside.ts",
		"src/link.ts",
	])("rejects unsafe relative path %s", async (relativePath) => {
		await expect(
			run(
				withMaterializedRepositoryBatch,
				{
					...input,
					repositoryBatch: undefined,
					files: [{ ...files[0], relativePath }],
				},
				async () => undefined,
			),
		).rejects.toThrow("Invalid repository-relative");
		expectClean();
	});
	it("rejects an unpinned revision and mismatched tenant before cloning", async () => {
		await expect(
			run(chunkAndEmbedMaterializedBatchActivity, {
				...input,
				repository: { ...repository, commitSha: "main" },
			}),
		).rejects.toThrow("pinned commit");
		await expect(
			run(chunkAndEmbedMaterializedBatchActivity, {
				...input,
				repository: { ...repository, organizationId: "other-org" },
			}),
		).rejects.toThrow("context mismatch");
		expect(state.paths).toEqual([]);
	});
	it("disposes preparation on its owner and reports metadata in sorted order", async () => {
		const result = await run(prepareRepositoryMetadataActivity, {
			...repository,
			disposeAfterPrepare: false,
			sortManifest: false,
		});
		expect(result.tree.totalFiles).toBe(3);
		expect(fs.existsSync(result.clone.clonePath)).toBe(false);
		expect(fs.existsSync(result.tree.manifestPath)).toBe(false);
	});
});

describe("materialized activity contracts and heartbeat", () => {
	it("rejects missing materialization fields rather than falling through to empty success", async () => {
		for (const activity of [
			chunkAndEmbedMaterializedBatchActivity,
			generateMaterializedFileSummariesActivity,
			extractAndPersistMaterializedSymbolsActivity,
		]) {
			await expect(
				run(async () =>
					activity({ ...input, repository: undefined, files: [] }),
				),
			).rejects.toThrow("requires repository and batch");
			await expect(
				run(async () =>
					activity({
						...input,
						repositoryBatch: undefined,
						files: [],
					}),
				),
			).rejects.toThrow("requires repository and batch");
		}
		await expect(
			run(updateMaterializedCodeIndexActivity, {
				...owner,
				commitSha: PINNED_COMMIT,
				filesIndexed: 0,
				chunksCreated: 0,
				summariesCreated: 0,
				indexDurationMs: 1,
			}),
		).rejects.toThrow("requires the indexed repository revision");
		expect(state.paths).toEqual([]);
	});
	it("keeps the job alive during pending git without resetting phases and stops the timer", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		let release!: () => void;
		state.fetchGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		try {
			const pending = run(
				extractAndPersistMaterializedSymbolsActivity,
				input,
			);
			await vi.waitFor(() => expect(state.fetches).toHaveLength(1));
			expect(state.jobHeartbeat).toHaveBeenCalledWith(
				"example-integration",
				{ runId: runOwner.runId },
			);
			const initial = state.jobHeartbeat.mock.calls.length;
			await vi.advanceTimersByTimeAsync(120_000);
			expect(state.jobHeartbeat.mock.calls.length).toBeGreaterThanOrEqual(
				initial + 2,
			);
			expect(state.jobStep).not.toHaveBeenCalled();
			release();
			await pending;
			expect(vi.getTimerCount()).toBe(0);
			expectClean();
		} finally {
			release();
			vi.useRealTimers();
		}
	});
	it("a stalled DB touch never blocks consumption or cleanup and Temporal pulses continue", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		state.jobHeartbeat.mockImplementationOnce(
			() => new Promise<void>(() => {}),
		);
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		let entered = false;
		const env = new MockActivityEnvironment();
		const pulses: unknown[] = [];
		env.on("heartbeat", (details) => {
			if (details === "materializing repository") {
				pulses.push(details);
			}
		});
		try {
			const pending = env.run(
				withMaterializedRepositoryBatch,
				input,
				async (localFiles: FileManifestEntry[]) => {
					expect(
						fs.readFileSync(localFiles[0].absolutePath, "utf8"),
					).toContain("alpha");
					entered = true;
					await blocked;
				},
			);
			await vi.waitFor(() => expect(entered).toBe(true));
			const initial = pulses.length;
			await vi.advanceTimersByTimeAsync(120_000);
			expect(pulses.length).toBeGreaterThanOrEqual(initial + 2);
			expect(state.jobHeartbeat).toHaveBeenCalledTimes(1);
			release();
			await pending;
			expect(vi.getTimerCount()).toBe(0);
			expectClean();
		} finally {
			release();
			vi.useRealTimers();
		}
	});

	it("a delayed materialization heartbeat cannot touch the successor job", async () => {
		let release!: () => void;
		let started = false;
		let currentRunId = runOwner.runId;
		let touches = 0;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		state.jobHeartbeat.mockImplementationOnce(async (_sourceId, fence) => {
			started = true;
			await blocked;
			if (fence?.runId === currentRunId) {
				touches++;
			}
		});
		await run(
			withMaterializedRepositoryBatch,
			input,
			async () => undefined,
		);
		expect(started).toBe(true);
		expect(state.jobHeartbeat).toHaveBeenCalledWith("example-integration", {
			runId: runOwner.runId,
		});
		expectClean();
		currentRunId = "example-successor-chain";
		release();
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(touches).toBe(0);
	});

	it("heartbeat failures do not mask clone failures or leak timers", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		try {
			state.jobHeartbeat.mockRejectedValueOnce(
				new Error("heartbeat unavailable"),
			);
			state.failFetch = true;
			await expect(
				run(chunkAndEmbedMaterializedBatchActivity, input),
			).rejects.toThrow("connection reset");
			expect(vi.getTimerCount()).toBe(0);
			expectClean();
		} finally {
			vi.useRealTimers();
		}
	});
});
