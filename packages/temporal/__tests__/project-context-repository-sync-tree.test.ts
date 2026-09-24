/**
 * `syncContextTreeFromRepository` — the Living Memory repository sync's
 * clone-and-apply activity (design 2026-09-23 §4.3, §5.3.1, §5.3.2, §8,
 * Fizzy #2657), against mocked git and the in-memory database fake
 * (`helpers/context-repository-sync-store.ts`).
 *
 * Git is a fake repository of commits: the clone lands on the remote's head,
 * `fetchPinnedCommit` moves to a commit the remote still has, the inventory
 * lists a commit's entries under the selected paths, and the sparse checkout
 * WRITES the requested files into the clone directory, so the activity's
 * real `lstat`, read, classification and hash run against real bytes.
 * `node:fs/promises` is wrapped only to record which files were read.
 *
 * `project-context-repository-sync-real-git.test.ts` runs the same activity
 * against a real repository.
 *
 * Run with: pnpm --filter @repo/temporal exec vitest run __tests__/project-context-repository-sync-tree.test.ts
 */
import { existsSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Assembled so the source carries no credential-shaped literal for the
// publication gitleaks scan; the tests only need a unique marker.
const TOKEN = ["tok", "placeholder", "context", "456"].join("-");
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

type RepoFile = {
	path: string;
	body?: string | Buffer;
	/** Defaults to a regular file. */
	mode?: string;
	type?: string;
};

const m = vi.hoisted(() => ({
	commits: new Map<string, RepoFile[]>(),
	remoteHead: "",
	heads: new Map<string, string>(),
	reads: [] as string[],
	cloneTreeless: vi.fn(),
	fetchPinnedCommit: vi.fn(),
	revParseHead: vi.fn(),
	readBlobCapped: vi.fn(),
	sparseCheckout: vi.fn(),
	listContextInventory: vi.fn(),
	resolveFreshRepoToken: vi.fn(),
	forceReExchangeRepoCredentials: vi.fn(),
	markRepoReauthRequired: vi.fn(),
	drain: vi.fn(),
	start: vi.fn(),
	emit: vi.fn(),
	log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@repo/database", async () => {
	const { databaseMock } = await import(
		"./helpers/context-repository-sync-store"
	);
	return databaseMock;
});
vi.mock("@repo/integrations", () => ({
	resolveFreshRepoToken: m.resolveFreshRepoToken,
	forceReExchangeRepoCredentials: m.forceReExchangeRepoCredentials,
	markRepoReauthRequired: m.markRepoReauthRequired,
	isGitAuthError: (e: unknown) =>
		String((e as Error)?.message)
			.toLowerCase()
			.includes("authentication failed"),
}));
vi.mock("@repo/logs", () => ({ logger: m.log }));
vi.mock("@repo/utils/realtime-emit", () => ({ emitContextChange: m.emit }));
vi.mock("../src/client", () => ({
	getTemporalClient: async () => ({ workflow: { start: m.start } }),
}));
vi.mock("../src/lib/delete-channel-context", () => ({
	drainPendingVectorCleanup: m.drain,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
	const real = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...real,
		readFile: vi.fn((...args: Parameters<typeof real.readFile>) => {
			m.reads.push(String(args[0]));
			return real.readFile(...args);
		}),
	};
});
vi.mock(
	"../src/activities/lib/instruction-sync-git",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../src/activities/lib/instruction-sync-git")
		>()),
		cloneTreeless: m.cloneTreeless,
		fetchPinnedCommit: m.fetchPinnedCommit,
		revParseHead: m.revParseHead,
		readBlobCapped: m.readBlobCapped,
		sparseCheckout: m.sparseCheckout,
	}),
);
vi.mock(
	"../src/activities/lib/context-sync-inventory",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("../src/activities/lib/context-sync-inventory")
		>()),
		listContextInventory: m.listContextInventory,
	}),
);

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { GitCommandError } from "../src/activities/lib/instruction-sync-git";
import { syncContextTreeFromRepository } from "../src/activities/project-context-repository-sync";
import type { ContextSyncFrozenContext } from "../src/lib/context-sync-types";
import {
	committed,
	contextRow,
	databaseMock as db,
	ORG,
	PROJECT,
	queuedCleanupsOf,
	type Row,
	RUN,
	resetStore,
	runRow,
	SYNC,
	seedContext,
	seedIntegration,
	seedRun,
	seedSync,
	sha256,
	store,
} from "./helpers/context-repository-sync-store";

// =============================================================================
// The fake repository
// =============================================================================

const bodyOf = (file: RepoFile): Buffer =>
	Buffer.isBuffer(file.body) ? file.body : Buffer.from(file.body ?? "");

const oidOf = (file: RepoFile): string =>
	createHash("sha1")
		.update(file.path)
		.update("\0")
		.update(bodyOf(file))
		.digest("hex");

const underSelected = (paths: readonly string[], p: string) =>
	paths.some((s) => s === "" || p === s || p.startsWith(`${s}/`));

/** Publish a commit and move the remote branch to it. */
function serve(sha: string, files: RepoFile[]): void {
	m.commits.set(sha, files);
	m.remoteHead = sha;
}

function installGit(): void {
	m.cloneTreeless.mockImplementation(async ({ dir }: { dir: string }) => {
		await mkdir(dir, { recursive: true });
		m.heads.set(dir, m.remoteHead);
	});
	m.revParseHead.mockImplementation(
		async ({ dir }: { dir: string }) => m.heads.get(dir) as string,
	);
	m.fetchPinnedCommit.mockImplementation(
		async ({ dir, sha }: { dir: string; sha: string }) => {
			if (!m.commits.has(sha)) {
				throw new GitCommandError(
					"exit",
					128,
					"fatal: remote error: upload-pack: not our ref",
					"fetch",
				);
			}
			m.heads.set(dir, sha);
		},
	);
	m.listContextInventory.mockImplementation(
		async ({
			sha,
			paths,
			maxEntries,
		}: {
			sha: string;
			paths: string[];
			maxEntries: number;
		}) => {
			const entries = (m.commits.get(sha) ?? [])
				.filter((f) => underSelected(paths, f.path))
				.map((f) => ({
					path: f.path,
					utf8: true,
					mode: f.mode ?? "100644",
					type: f.type ?? "blob",
					oid: oidOf(f),
				}));
			return entries.length > maxEntries
				? { ok: false }
				: { ok: true, entries };
		},
	);
	m.readBlobCapped.mockImplementation(
		async ({ oid, maxBytes }: { oid: string; maxBytes: number }) => {
			for (const files of m.commits.values()) {
				const file = files.find((f) => oidOf(f) === oid);
				if (file) {
					const bytes = bodyOf(file);
					return bytes.length > maxBytes ? null : bytes;
				}
			}
			throw new GitCommandError(
				"exit",
				128,
				"fatal: bad object",
				"cat-file",
			);
		},
	);
	m.sparseCheckout.mockImplementation(
		async ({ dir, repoPaths }: { dir: string; repoPaths: string[] }) => {
			const files = m.commits.get(m.heads.get(dir) as string) ?? [];
			for (const repoPath of repoPaths) {
				const file = files.find((f) => f.path === repoPath);
				if (!file) {
					continue;
				}
				await mkdir(path.dirname(path.join(dir, repoPath)), {
					recursive: true,
				});
				await writeFile(path.join(dir, repoPath), bodyOf(file));
			}
		},
	);
}

// =============================================================================
// Setup
// =============================================================================

function context(paths: string[]): ContextSyncFrozenContext {
	return {
		projectId: PROJECT,
		organizationId: ORG,
		syncId: SYNC,
		generation: 3,
		runKey: RUN,
		trigger: "MANUAL",
		repositoryIntegrationId: "int-1",
		ref: "main",
		paths,
		actingUserId: "user-1",
	};
}

/** The configuration, its running run and the integration, all at generation 3. */
function configure(paths: string[]): ContextSyncFrozenContext {
	seedIntegration();
	seedSync({ paths });
	seedRun({ context: { paths, ref: "main" } });
	return context(paths);
}

const sync = (ctx: ContextSyncFrozenContext) =>
	syncContextTreeFromRepository(ctx);

function failureOf(error: unknown) {
	return error as Error & {
		type: string;
		details: Array<{ commitSha?: string; counts?: Record<string, number> }>;
		nonRetryable: boolean;
	};
}

async function failed(ctx: ContextSyncFrozenContext) {
	return failureOf(await sync(ctx).catch((error: unknown) => error));
}

const plan = () =>
	runRow().plan as {
		keptCount: number;
		excludedCount: number;
		attentionCount: number;
		attention: Array<{ key: string; reason: string }>;
		protectedPrefixes: string[];
		missingPaths: string[];
		keptKeys: string[];
		protectedKeys: string[];
	};
const outcomes = () => runRow().outcomes as Record<string, string>;
const managedKeys = () =>
	committed()
		.context.filter((c) => c.repositorySyncId === SYNC)
		.map((c) => c.sourcePath)
		.sort();

beforeEach(() => {
	vi.clearAllMocks();
	resetStore();
	m.commits.clear();
	m.heads.clear();
	m.remoteHead = "";
	m.reads = [];
	installGit();
	m.resolveFreshRepoToken.mockResolvedValue({ token: TOKEN });
	m.start.mockResolvedValue(undefined);
	m.emit.mockResolvedValue(undefined);
	m.drain.mockImplementation(async (record: { id: string }) => {
		committed().cleanup = committed().cleanup.filter(
			(c) => c.id !== record.id,
		);
	});
});

// =============================================================================
// Planning and apply
// =============================================================================

describe("syncContextTreeFromRepository — what a run applies", () => {
	it("applies two folders and a file at the pinned commit, records the plan and the ledger, and indexes what it wrote", async () => {
		const ctx = configure(["docs", "notes", "README.md"]);
		serve(SHA_A, [
			{ path: "docs/a.md", body: "# Alpha" },
			{ path: "docs/guides/b.md", body: "Beta" },
			{ path: "docs/diagram.png", body: "PNG" },
			{ path: "docs/CLAUDE.md", body: "instructions" },
			{ path: "notes/n.txt", body: "a note" },
			{ path: "README.md", body: "readme" },
			{ path: "other/x.md", body: "not selected" },
		]);

		expect(await sync(ctx)).toEqual({
			outcome: "applied",
			commitSha: SHA_A,
		});

		expect(runRow().commitSha).toBe(SHA_A);
		expect(managedKeys()).toEqual([
			"README.md",
			"docs/a.md",
			"docs/guides/b.md",
			"notes/n.txt",
		]);
		expect(contextRow("docs/a.md")).toMatchObject({
			content: "# Alpha",
			contentHash: sha256("# Alpha"),
			organizationId: ORG,
		});
		expect(plan()).toEqual({
			keptCount: 4,
			// The image (wrong extension) and CLAUDE.md (a default exclusion).
			excludedCount: 2,
			attentionCount: 0,
			attention: [],
			protectedPrefixes: [],
			missingPaths: [],
			keptKeys: [
				"README.md",
				"docs/a.md",
				"docs/guides/b.md",
				"notes/n.txt",
			],
			protectedKeys: [],
		});
		expect(outcomes()).toEqual({
			"README.md": "created",
			"docs/a.md": "created",
			"docs/guides/b.md": "created",
			"notes/n.txt": "created",
		});
		// Every fence locked the configuration row before the run row.
		const locks = store.log.filter((l) => l.startsWith("lock:"));
		expect(locks.length).toBeGreaterThan(0);
		for (let i = 0; i < locks.length; i += 2) {
			expect(locks.slice(i, i + 2)).toEqual(["lock:sync", "lock:run"]);
		}
		// One embedding start per row written, and the clone is gone.
		expect(m.start).toHaveBeenCalledTimes(4);
		expect(m.emit).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: PROJECT,
				userId: "user-1",
				userName: "Example Member",
			}),
		);
		expect(existsSync(m.cloneTreeless.mock.calls[0]?.[0].cwd)).toBe(false);
		// Only the checked-out candidates were read, never the excluded ones.
		expect(m.sparseCheckout).toHaveBeenCalledWith(
			expect.objectContaining({
				repoPaths: [
					"README.md",
					"docs/a.md",
					"docs/guides/b.md",
					"notes/n.txt",
				],
			}),
		);
	});

	it("evaluates each selected folder's own .contextignore against paths relative to it", async () => {
		const ctx = configure(["docs", "notes"]);
		serve(SHA_A, [
			{ path: "docs/.contextignore", body: "drafts/\n" },
			{ path: "docs/drafts/d.md", body: "draft" },
			{ path: "docs/keep.md", body: "keep" },
			{ path: "notes/drafts/n.md", body: "notes have no ignore file" },
		]);
		seedContext("docs/drafts/d.md", "draft");

		await sync(ctx);

		expect(plan().keptKeys).toEqual(["docs/keep.md", "notes/drafts/n.md"]);
		// The ignored draft and the ignore file itself.
		expect(plan().excludedCount).toBe(2);
		// Excluded by a policy that was evaluated: its managed row is pruned.
		expect(contextRow("docs/drafts/d.md")).toBeUndefined();
		expect(runRow().removedCount).toBe(1);
	});

	it("adopts an unowned identical row, leaves an unowned different row alone, and records a raced write as a conflict", async () => {
		const ctx = configure(["docs"]);
		serve(SHA_A, [
			{ path: "docs/a.md", body: "same" },
			{ path: "docs/b.md", body: "repository" },
			{ path: "docs/c.md", body: "repository c" },
		]);
		seedContext("docs/a.md", "same", { repositorySyncId: null });
		seedContext("docs/b.md", "pushed by the CLI", {
			repositorySyncId: null,
		});
		seedContext("docs/c.md", "old c");
		store.racedKeys.add("docs/c.md");

		await sync(ctx);

		expect(outcomes()).toEqual({
			"docs/a.md": "adopted",
			"docs/b.md": "path-in-use",
			"docs/c.md": "conflict",
		});
		expect(contextRow("docs/a.md")?.repositorySyncId).toBe(SYNC);
		expect(contextRow("docs/b.md")).toMatchObject({
			repositorySyncId: null,
			content: "pushed by the CLI",
		});
		expect(contextRow("docs/c.md")?.content).toBe("old c");
		expect(runRow().removedCount).toBe(0);
	});

	it("renames by creating the new key before pruning the old one", async () => {
		const ctx = configure(["docs"]);
		serve(SHA_A, [{ path: "docs/new-name.md", body: "the same body" }]);
		seedContext("docs/old-name.md", "the same body");

		await sync(ctx);

		expect(outcomes()).toEqual({ "docs/new-name.md": "created" });
		expect(managedKeys()).toEqual(["docs/new-name.md"]);
		expect(runRow().removedCount).toBe(1);
		const writes = store.log.filter(
			(l) => l.startsWith("create:") || l.startsWith("delete:"),
		);
		expect(writes).toEqual([
			"create:docs/new-name.md",
			"delete:docs/old-name.md",
		]);
	});

	it("prunes excluded entries but protects too-large, binary and empty ones — and never reads the oversized file", async () => {
		const ctx = configure(["docs"]);
		serve(SHA_A, [
			{ path: "docs/.contextignore", body: "drafts/\n" },
			{ path: "docs/drafts/x.md", body: "now ignored" },
			{ path: "docs/big.md", body: "a".repeat(2 * 1024 * 1024 + 1) },
			{ path: "docs/bin.md", body: Buffer.from([0x68, 0x00, 0x69]) },
			{ path: "docs/empty.md", body: " \n\t\n" },
			{ path: "docs/ok.md", body: "fine" },
		]);
		seedContext("docs/drafts/x.md", "old draft");
		seedContext("docs/big.md", "last good big");
		seedContext("docs/bin.md", "last good bin");
		seedContext("docs/empty.md", "last good empty");

		await sync(ctx);

		expect(contextRow("docs/drafts/x.md")).toBeUndefined();
		for (const [key, body] of [
			["docs/big.md", "last good big"],
			["docs/bin.md", "last good bin"],
			["docs/empty.md", "last good empty"],
		] as const) {
			expect(contextRow(key)?.content).toBe(body);
		}
		expect(plan()).toMatchObject({
			keptKeys: ["docs/ok.md"],
			attentionCount: 3,
			attention: [
				{ key: "docs/big.md", reason: "too-large" },
				{ key: "docs/bin.md", reason: "binary" },
				{ key: "docs/empty.md", reason: "empty" },
			],
			protectedKeys: ["docs/big.md", "docs/bin.md", "docs/empty.md"],
		});
		expect(m.reads.some((p) => p.endsWith("docs/big.md"))).toBe(false);
		expect(m.reads.some((p) => p.endsWith("docs/ok.md"))).toBe(true);
	});

	it.each([
		[
			"a symlink",
			{ path: "docs/.contextignore", body: "x", mode: "120000" },
		],
		[
			"a submodule",
			{ path: "docs/.contextignore", mode: "160000", type: "commit" },
		],
		[
			"over 64 KiB",
			{ path: "docs/.contextignore", body: "#".repeat(64 * 1024 + 1) },
		],
		[
			"not UTF-8",
			{ path: "docs/.contextignore", body: Buffer.from([0xff, 0xfe]) },
		],
	])(
		"an ignore policy that is %s protects its folder — even a managed row the inventory no longer has — and nothing under it is written",
		async (_label, ignoreFile: RepoFile) => {
			const ctx = configure(["docs", "notes"]);
			serve(SHA_A, [
				ignoreFile,
				{ path: "docs/a.md", body: "new a" },
				{ path: "notes/n.md", body: "note" },
			]);
			seedContext("docs/a.md", "old a");
			seedContext("docs/gone.md", "not in the commit");
			seedContext("notes/old.md", "not in the commit either");

			await sync(ctx);

			expect(contextRow("docs/a.md")?.content).toBe("old a");
			expect(contextRow("docs/gone.md")).toBeDefined();
			expect(contextRow("notes/old.md")).toBeUndefined();
			expect(outcomes()).toEqual({ "notes/n.md": "created" });
			expect(plan()).toMatchObject({
				protectedPrefixes: ["docs/"],
				attention: [
					{ key: "docs", reason: "ignore-policy-unreadable" },
				],
			});
		},
	);

	it("for the whole repository, an unreadable policy protects EVERY managed row and writes nothing", async () => {
		const ctx = configure([""]);
		serve(SHA_A, [
			{ path: ".contextignore", body: "x", mode: "120000" },
			{ path: "a.md", body: "new a" },
		]);
		seedContext("a.md", "old a");
		seedContext("deep/gone.md", "not in the commit");

		await sync(ctx);

		expect(plan()).toMatchObject({
			protectedPrefixes: [""],
			keptKeys: [],
		});
		expect(managedKeys()).toEqual(["a.md", "deep/gone.md"]);
		expect(contextRow("a.md")?.content).toBe("old a");
		expect(runRow().removedCount).toBe(0);
		expect(db.pruneRepositoryContextBatch).not.toHaveBeenCalled();
	});

	it("prunes the rows of a selected path that is gone while other selected paths are present", async () => {
		const ctx = configure(["docs", "archive"]);
		serve(SHA_A, [{ path: "docs/a.md", body: "a" }]);
		seedContext("archive/old.md", "archived");

		await sync(ctx);

		expect(plan()).toMatchObject({
			missingPaths: ["archive"],
			attention: [{ key: "archive", reason: "path-missing" }],
		});
		expect(contextRow("archive/old.md")).toBeUndefined();
	});

	it("stops with PATHS_MISSING, the commit in its details, when every selected path is gone — planning and pruning nothing", async () => {
		const ctx = configure(["archive", "old.md"]);
		serve(SHA_A, [{ path: "docs/a.md", body: "a" }]);
		seedContext("archive/old.md", "archived");

		const error = await failed(ctx);

		expect(error.type).toBe("PATHS_MISSING");
		expect(error.details[0]).toEqual({ commitSha: SHA_A });
		expect(runRow().plan).toBeNull();
		expect(contextRow("archive/old.md")).toBeDefined();
	});

	it.each([
		["a symlink", { mode: "120000", body: "target.md" }],
		["a submodule", { mode: "160000", type: "commit" }],
	])(
		"a selected file that is now %s is present, not missing: excluded, and its row pruned",
		async (_label, shape) => {
			const ctx = configure(["notes/glossary.md"]);
			serve(SHA_A, [{ path: "notes/glossary.md", ...shape }]);
			seedContext("notes/glossary.md", "old glossary");

			expect(await sync(ctx)).toEqual({
				outcome: "applied",
				commitSha: SHA_A,
			});
			expect(plan()).toMatchObject({
				missingPaths: [],
				keptCount: 0,
				excludedCount: 1,
			});
			expect(contextRow("notes/glossary.md")).toBeUndefined();
		},
	);

	it("refuses more than 5 000 kept files with LIMITS_EXCEEDED before checking anything out", async () => {
		const ctx = configure(["docs"]);
		serve(
			SHA_A,
			Array.from({ length: 5_001 }, (_, i) => ({
				path: `docs/f-${String(i).padStart(4, "0")}.md`,
				body: "x",
			})),
		);

		const error = await failed(ctx);

		expect(error.type).toBe("LIMITS_EXCEEDED");
		expect(error.details[0]).toEqual({
			commitSha: SHA_A,
			counts: { kept: 5_001 },
		});
		expect(m.sparseCheckout).not.toHaveBeenCalled();
		expect(runRow().plan).toBeNull();
	});

	it("refuses more than 50 MiB of storable files with LIMITS_EXCEEDED before reading any", async () => {
		const ctx = configure(["docs"]);
		serve(SHA_A, [
			...Array.from({ length: 25 }, (_, i) => ({
				path: `docs/f-${String(i).padStart(2, "0")}.md`,
				body: "a".repeat(2 * 1024 * 1024),
			})),
			{ path: "docs/last.md", body: "b" },
		]);

		const error = await failed(ctx);

		expect(error.type).toBe("LIMITS_EXCEEDED");
		expect(m.reads.filter((p) => p.includes("/repo/"))).toEqual([]);
		expect(runRow().plan).toBeNull();
	});

	it("refuses an inventory past its entry cap with LIMITS_EXCEEDED", async () => {
		const ctx = configure(["docs"]);
		serve(SHA_A, [{ path: "docs/a.md", body: "a" }]);
		m.listContextInventory.mockResolvedValueOnce({ ok: false });

		expect((await failed(ctx)).type).toBe("LIMITS_EXCEEDED");
	});
});

// =============================================================================
// The pin, the plan and the ledger across attempts (§4.3, §5.3.2)
// =============================================================================

describe("syncContextTreeFromRepository — retries", () => {
	it("pins the first attempt's head: a second attempt that clones a newer head fetches and applies the winner", async () => {
		const ctx = configure(["docs"]);
		serve(SHA_A, [{ path: "docs/a.md", body: "version A" }]);
		// Fence 2 is the plan write: the first attempt dies after its pin.
		store.beforeFence = (call) => {
			if (call === 2) {
				throw new Error("connection reset");
			}
		};
		const first = await failed(ctx);
		expect(first.type).toBe("STORE_FAILED");
		expect(first.details[0]).toEqual({ commitSha: SHA_A });
		expect(runRow()).toMatchObject({ commitSha: SHA_A, plan: null });

		store.beforeFence = null;
		serve(SHA_B, [{ path: "docs/a.md", body: "version B" }]);

		expect(await sync(ctx)).toEqual({
			outcome: "applied",
			commitSha: SHA_A,
		});
		expect(m.fetchPinnedCommit).toHaveBeenCalledWith(
			expect.objectContaining({ sha: SHA_A }),
		);
		expect(runRow().commitSha).toBe(SHA_A);
		expect(contextRow("docs/a.md")?.content).toBe("version A");
	});

	it("maps a pinned commit the remote refuses to serve to CLONE_FAILED", async () => {
		const ctx = configure(["docs"]);
		// Pinned by an earlier attempt; the remote has moved on and no longer
		// serves it.
		runRow().commitSha = SHA_A;
		serve(SHA_B, [{ path: "docs/a.md", body: "b" }]);

		const error = await failed(ctx);

		expect(error.type).toBe("CLONE_FAILED");
		expect(error.details[0]).toEqual({ commitSha: SHA_A });
	});

	it("writes the plan once and a retry applies exactly its keys, even when the retry's own planning would differ", async () => {
		const ctx = configure(["docs"]);
		const files: RepoFile[] = [
			{ path: "docs/.contextignore", body: "drafts/\n" },
			{ path: "docs/a.md", body: "a" },
			{ path: "docs/b.md", body: "b" },
			{ path: "docs/drafts/d.md", body: "draft" },
		];
		serve(SHA_A, files);
		// Fence 3 is the first apply batch.
		store.beforeFence = (call) => {
			if (call === 3) {
				throw new Error("connection reset");
			}
		};
		expect((await failed(ctx)).type).toBe("STORE_FAILED");
		expect(plan().keptKeys).toEqual(["docs/a.md", "docs/b.md"]);
		expect(committed().context).toEqual([]);

		// What a re-plan would now see: b.md ignored, the draft kept.
		store.beforeFence = null;
		files[0] = { path: "docs/.contextignore", body: "b.md\n" };
		m.readBlobCapped.mockClear();
		db.writeContextRepositorySyncRunPlan.mockClear();

		await sync(ctx);

		expect(db.writeContextRepositorySyncRunPlan).not.toHaveBeenCalled();
		expect(m.readBlobCapped).not.toHaveBeenCalled();
		expect(managedKeys()).toEqual(["docs/a.md", "docs/b.md"]);
		expect(plan().keptKeys).toEqual(["docs/a.md", "docs/b.md"]);
	});

	it("uses the plan another attempt stored first, whatever this attempt planned", async () => {
		const ctx = configure(["docs"]);
		serve(SHA_A, [
			{ path: "docs/a.md", body: "a" },
			{ path: "docs/b.md", body: "b" },
		]);
		const stored = {
			keptCount: 1,
			excludedCount: 0,
			attentionCount: 0,
			attention: [],
			protectedPrefixes: [],
			missingPaths: [],
			keptKeys: ["docs/b.md"],
			protectedKeys: ["docs/a.md"],
		};
		// A concurrent attempt of this run writes its plan between this
		// attempt's pin and its own plan write.
		store.beforeFence = (call) => {
			if (call === 2) {
				runRow().plan = stored;
			}
		};

		await sync(ctx);

		expect(plan()).toEqual(stored);
		expect(outcomes()).toEqual({ "docs/b.md": "created" });
		expect(contextRow("docs/a.md")).toBeUndefined();
	});

	it("re-reads the ledger under the run lock and skips a key another attempt decided after this one's pin", async () => {
		const ctx = configure(["docs"]);
		serve(SHA_A, [
			{ path: "docs/a.md", body: "new a" },
			{ path: "docs/b.md", body: "b" },
		]);
		seedContext("docs/a.md", "old a");
		store.beforeFence = (call) => {
			if (call === 3) {
				(runRow().outcomes as Record<string, string>)["docs/a.md"] =
					"conflict";
			}
		};

		await sync(ctx);

		expect(contextRow("docs/a.md")?.content).toBe("old a");
		expect(outcomes()).toEqual({
			"docs/a.md": "conflict",
			"docs/b.md": "created",
		});
		expect(
			db.applyRepositoryContextBatch.mock.calls[0]?.[1].decided,
		).toEqual(new Set(["docs/a.md"]));
	});

	it("a retry after a partial prune deletes only the remainder and counts every delete exactly once", async () => {
		const ctx = configure(["docs"]);
		serve(SHA_A, [{ path: "docs/keep.md", body: "keep" }]);
		for (let i = 0; i < 60; i++) {
			seedContext(
				`docs/old-${String(i).padStart(2, "0")}.md`,
				`old ${i}`,
			);
		}
		// Fences: 1 pin, 2 plan, 3 apply, 4 prune (50 rows), 5 prune (10 rows).
		store.beforeFence = (call) => {
			if (call === 5) {
				throw new Error("connection reset");
			}
		};
		expect((await failed(ctx)).type).toBe("STORE_FAILED");
		expect(runRow().removedCount).toBe(50);
		expect(managedKeys()).toHaveLength(11);

		store.beforeFence = null;
		await sync(ctx);

		expect(managedKeys()).toEqual(["docs/keep.md"]);
		expect(runRow().removedCount).toBe(60);
		expect(runRow().pruneConflicts).toEqual({ keys: [], overflow: 0 });
		// The retry decided nothing twice.
		expect(outcomes()).toEqual({ "docs/keep.md": "created" });
	});

	it.each([
		[
			"re-configured (generation moved)",
			() => {
				(committed().sync[0] as Row).generation = 4;
			},
			"CONFIGURATION_CHANGED",
		],
		[
			"disconnected (configuration deleted)",
			() => {
				committed().sync = [];
			},
			"CONFIGURATION_CHANGED",
		],
		[
			"held by another run",
			() => {
				(committed().sync[0] as Row).activeRunKey = `${SYNC}:run-z`;
			},
			"SUPERSEDED",
		],
		[
			"completed by reconciliation",
			() => {
				runRow().finishedAt = new Date("2026-09-23T13:00:00Z");
			},
			"SUPERSEDED",
		],
	])(
		"stops mid-apply when the run is %s, with the commit in the failure and the first batch kept",
		async (_label, move, code) => {
			const ctx = configure(["docs"]);
			serve(
				SHA_A,
				Array.from({ length: 60 }, (_, i) => ({
					path: `docs/f-${String(i).padStart(2, "0")}.md`,
					body: `file ${i}`,
				})),
			);
			// Fences: 1 pin, 2 plan, 3 apply (50), 4 apply (10).
			store.beforeFence = (call) => {
				if (call === 4) {
					move();
				}
			};

			const error = await failed(ctx);

			expect(error.type).toBe(code);
			expect(error.details[0]).toEqual({ commitSha: SHA_A });
			expect(Object.keys(outcomes())).toHaveLength(50);
			expect(
				committed().context.filter((c) => c.repositorySyncId === SYNC),
			).toHaveLength(50);
			expect(db.pruneRepositoryContextBatch).not.toHaveBeenCalled();
		},
	);
});

// =============================================================================
// Prune cleanup, permission, index (§5.3.1 steps 7–9)
// =============================================================================

describe("syncContextTreeFromRepository — prune, permission and index", () => {
	it("queues a prune batch's vector cleanup in the batch's own transaction: a failed ledger write keeps the rows and queues nothing", async () => {
		const ctx = configure(["docs"]);
		serve(SHA_A, [{ path: "docs/keep.md", body: "keep" }]);
		seedContext("docs/old.md", "old");
		store.failRecordPrune = 1;

		expect((await failed(ctx)).type).toBe("STORE_FAILED");
		expect(contextRow("docs/old.md")).toBeDefined();
		expect(committed().cleanup).toEqual([]);
		expect(runRow()).toMatchObject({ removedCount: 0 });
	});

	it("drains each prune batch's cleanup once; a record that did not drain stays queued under the run's key", async () => {
		const ctx = configure(["docs"]);
		serve(SHA_A, [{ path: "docs/keep.md", body: "keep" }]);
		for (let i = 0; i < 60; i++) {
			seedContext(
				`docs/old-${String(i).padStart(2, "0")}.md`,
				`old ${i}`,
			);
		}
		const drain = m.drain.getMockImplementation();
		m.drain
			.mockImplementationOnce(drain as never)
			.mockRejectedValueOnce(new Error("vector store unavailable"));

		await sync(ctx);

		expect(m.drain).toHaveBeenCalledTimes(2);
		expect(m.drain.mock.calls[0]?.[0]).toMatchObject({
			projectId: PROJECT,
			organizationId: ORG,
			userId: null,
		});
		expect(m.drain.mock.calls[0]?.[0].contextIds).toHaveLength(50);
		expect(runRow()).toMatchObject({ removedCount: 60 });
		expect(runRow()).not.toHaveProperty("cleanupPending");
		// The record that did not drain stays for the scheduled sweep, stamped
		// with this run's key: the receipt counts it live from the queue.
		expect(committed().cleanup).toHaveLength(1);
		expect(committed().cleanup[0]?.contextIds).toHaveLength(10);
		expect(queuedCleanupsOf(RUN)).toHaveLength(1);
		// Whoever drains it later — the sweep, or this attempt's abandoned
		// drain completing — the run's count falls with the queue.
		committed().cleanup = [];
		expect(queuedCleanupsOf(RUN)).toHaveLength(0);
	});

	it("re-checks CONTEXT_CREATE in the first apply batch and refuses PERMISSION_DENIED, writing nothing", async () => {
		const ctx = configure(["docs"]);
		serve(SHA_A, [{ path: "docs/a.md", body: "a" }]);
		seedContext("docs/old.md", "old");
		store.permitted.clear();

		const error = await failed(ctx);

		expect(error.type).toBe("PERMISSION_DENIED");
		expect(error.details[0]).toEqual({ commitSha: SHA_A });
		expect(contextRow("docs/a.md")).toBeUndefined();
		expect(contextRow("docs/old.md")).toBeDefined();
		expect(outcomes()).toEqual({});
	});

	it("re-checks CONTEXT_CREATE in the first prune batch too, when nothing is left to apply", async () => {
		const ctx = configure(["docs"]);
		serve(SHA_A, [{ path: "docs/a.md", body: "same" }]);
		seedContext("docs/a.md", "same");
		seedContext("docs/old.md", "old");
		runRow().outcomes = { "docs/a.md": "unchanged" };
		runRow().commitSha = SHA_A;
		runRow().plan = {
			keptCount: 1,
			excludedCount: 0,
			attentionCount: 0,
			attention: [],
			protectedPrefixes: [],
			missingPaths: [],
			keptKeys: ["docs/a.md"],
			protectedKeys: [],
		};
		store.permitted.clear();

		const error = await failed(ctx);

		expect(error.type).toBe("PERMISSION_DENIED");
		expect(contextRow("docs/old.md")).toBeDefined();
		// Everything was decided: the retry neither listed nor checked out.
		expect(m.listContextInventory).not.toHaveBeenCalled();
		expect(m.sparseCheckout).not.toHaveBeenCalled();
	});

	it("starts one re-embed per managed row still unindexed — including rows an earlier run left — and none for indexed rows", async () => {
		const ctx = configure(["docs"]);
		serve(SHA_A, [
			{ path: "docs/a.md", body: "new" },
			{ path: "docs/b.md", body: "left unindexed" },
			{ path: "docs/c.md", body: "indexed" },
		]);
		seedContext("docs/b.md", "left unindexed", { embeddedAt: null });
		seedContext("docs/c.md", "indexed");

		await sync(ctx);

		expect(m.start).toHaveBeenCalledTimes(2);
		const started = m.start.mock.calls.map(([type, options]) => ({
			type,
			taskQueue: options.taskQueue,
			input: options.args[0],
		}));
		expect(started).toEqual([
			{
				type: "contextEmbeddingWorkflow",
				taskQueue: "project-documents",
				input: expect.objectContaining({
					contextId: contextRow("docs/a.md")?.id,
					projectId: PROJECT,
					userId: "user-1",
					organizationId: ORG,
					reembed: true,
				}),
			},
			{
				type: "contextEmbeddingWorkflow",
				taskQueue: "project-documents",
				input: expect.objectContaining({
					contextId: contextRow("docs/b.md")?.id,
					reembed: true,
				}),
			},
		]);
	});

	it("maps a failed embedding start to STORE_FAILED; the retry repeats only the index step", async () => {
		const ctx = configure(["docs"]);
		serve(SHA_A, [{ path: "docs/a.md", body: "a" }]);
		m.start.mockRejectedValueOnce(new Error("temporal unavailable"));

		const error = await failed(ctx);
		expect(error.type).toBe("STORE_FAILED");
		expect(error.details[0]).toEqual({ commitSha: SHA_A });

		db.applyRepositoryContextBatch.mockClear();
		await sync(ctx);

		expect(db.applyRepositoryContextBatch).not.toHaveBeenCalled();
		expect(m.start).toHaveBeenCalledTimes(2);
		expect(outcomes()).toEqual({ "docs/a.md": "created" });
	});
});

// =============================================================================
// The integration and the credential (§5.3.1 steps 1–2, §8)
// =============================================================================

describe("syncContextTreeFromRepository — integration and credential", () => {
	it.each([
		[{ status: "TOKEN_EXPIRED" }],
		[
			{
				repositoryUrl:
					"https://github.com/example-org/handbook.git?access_token=x",
			},
		],
	])(
		"fails closed with a non-retryable INTEGRATION_UNAVAILABLE for %o, before any token or git work",
		async (overrides) => {
			const ctx = context(["docs"]);
			seedIntegration(overrides);
			seedSync({ paths: ["docs"] });
			seedRun();

			const error = await failed(ctx);

			expect(error.type).toBe("INTEGRATION_UNAVAILABLE");
			expect(error.nonRetryable).toBe(true);
			expect(m.resolveFreshRepoToken).not.toHaveBeenCalled();
			expect(m.cloneTreeless).not.toHaveBeenCalled();
		},
	);

	it("maps a missing branch to REF_MISSING", async () => {
		const ctx = configure(["docs"]);
		m.cloneTreeless.mockRejectedValue(
			new GitCommandError(
				"exit",
				128,
				"warning: Could not find remote branch main to clone.",
				"clone",
			),
		);
		expect((await failed(ctx)).type).toBe("REF_MISSING");
	});

	it("never lets the token reach a result, a failure, a log line, an event or the ledger — only git's environment", async () => {
		const ctx = configure(["docs"]);
		serve(SHA_A, [{ path: "docs/a.md", body: "a" }]);
		seedContext("docs/old.md", "old");
		const ok = await sync(ctx);
		const env = m.cloneTreeless.mock.calls[0]?.[0].env;
		expect(env.FABRIC_GIT_CREDENTIAL).toBe(TOKEN);
		expect(m.cloneTreeless.mock.calls[0]?.[0].url).toBe(
			"https://github.com/example-org/handbook.git",
		);

		const leak = `fatal: unable to access 'https://x-access-token:${TOKEN}@github.com/': ${TOKEN}`;
		m.cloneTreeless.mockRejectedValueOnce(
			new GitCommandError("exit", 128, leak, "clone"),
		);
		const cloneFailure = await failed(ctx);
		m.sparseCheckout.mockRejectedValueOnce(
			new GitCommandError("exit", 128, leak, "checkout"),
		);
		runRow().plan = null;
		const checkoutFailure = await failed(ctx);
		expect(cloneFailure.type).toBe("CLONE_FAILED");
		expect(checkoutFailure.type).toBe("CLONE_FAILED");

		// The message is not an own enumerable property: spell it out.
		const errorView = (e: Error) => ({ ...e, message: e.message });
		const outputs = JSON.stringify([
			ok,
			errorView(cloneFailure),
			errorView(checkoutFailure),
			m.log.debug.mock.calls,
			m.log.info.mock.calls,
			m.log.warn.mock.calls,
			m.log.error.mock.calls,
			m.emit.mock.calls,
			m.start.mock.calls,
			m.drain.mock.calls,
			committed().run,
			committed().context,
		]);
		expect(outputs).not.toContain(TOKEN);
		expect(outputs).not.toContain("x-access-token:");
		// The redacted stderr did reach the debug log.
		expect(m.log.debug).toHaveBeenCalledWith(
			expect.objectContaining({ event: "context.sync.git_failed" }),
			expect.any(String),
		);
	});
});
