/**
 * `syncContextTreeFromRepository` against REAL git (design 2026-09-23
 * §5.3.1, §9, Fizzy #2657): a throwaway repository in a temp directory,
 * served over the file protocol, cloned treeless, listed with exact
 * pathspecs, its `.contextignore` read as a blob, sparse-checked-out and
 * applied into the in-memory database fake
 * (`helpers/context-repository-sync-store.ts`).
 *
 * The only departures from production are the ones the file protocol
 * forces: the clone URL is the `file://` URL itself (production accepts
 * HTTPS only, through `credentialFreeUrl`), and git's environment also
 * allows the file protocol and names a host for the askpass helper, which a
 * local clone never asks. Everything else — `runBoundedProcess`, the
 * inventory parser, the sparse patterns, the checkout, the reads — is real.
 *
 * Skipped cleanly where no `git` binary exists, like the plumbing's own
 * real-git suite.
 *
 * Run with: pnpm --filter @repo/temporal exec vitest run __tests__/project-context-repository-sync-real-git.test.ts
 */
import { execFileSync } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	rename,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

const m = vi.hoisted(() => ({
	// Assembled so the source carries no credential-shaped literal.
	token: ["tok", "placeholder", "realgit", "789"].join("-"),
	start: vi.fn(),
	emit: vi.fn(),
	drain: vi.fn(),
	log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
	/** Run directories this suite's attempts created. */
	runDirs: [] as string[],
	/** Files under a run directory that held the token when it was removed. */
	tokenOnDisk: [] as string[],
}));
const TOKEN = m.token;

vi.mock("@repo/database", async () => {
	const { databaseMock } = await import(
		"./helpers/context-repository-sync-store"
	);
	return databaseMock;
});
vi.mock("@repo/integrations", () => ({
	resolveFreshRepoToken: async () => ({ token: m.token }),
	forceReExchangeRepoCredentials: async () => ({ refreshed: false }),
	markRepoReauthRequired: async () => {},
	isGitAuthError: () => false,
}));
vi.mock("@repo/logs", () => ({ logger: m.log }));
vi.mock("@repo/utils/realtime-emit", () => ({ emitContextChange: m.emit }));
vi.mock("../src/client", () => ({
	getTemporalClient: async () => ({ workflow: { start: m.start } }),
}));
vi.mock("../src/lib/delete-channel-context", () => ({
	drainPendingVectorCleanup: m.drain,
}));
vi.mock(
	"../src/activities/lib/instruction-sync-git",
	async (importOriginal) => {
		const real =
			await importOriginal<
				typeof import("../src/activities/lib/instruction-sync-git")
			>();
		return {
			...real,
			// The file protocol, for this test only (see the header).
			credentialFreeUrl: (url: string) =>
				url.startsWith("file://") ? url : real.credentialFreeUrl(url),
			buildGitEnv: (input: Parameters<typeof real.buildGitEnv>[0]) => ({
				...real.buildGitEnv({
					...input,
					host: input.host || "localhost",
				}),
				GIT_CONFIG_COUNT: "1",
				GIT_CONFIG_KEY_0: "protocol.file.allow",
				GIT_CONFIG_VALUE_0: "always",
			}),
		};
	},
);

vi.mock(
	"../src/activities/lib/instruction-sync-temp",
	async (importOriginal) => {
		const real =
			await importOriginal<
				typeof import("../src/activities/lib/instruction-sync-temp")
			>();
		const { lstat, readdir, readFile } = await import("node:fs/promises");
		const { join } = await import("node:path");
		async function filesHolding(dir: string, needle: string) {
			const hits: string[] = [];
			for (const entry of await readdir(dir, { withFileTypes: true })) {
				const full = join(dir, entry.name);
				if (entry.isDirectory()) {
					hits.push(...(await filesHolding(full, needle)));
				} else if ((await lstat(full)).isFile()) {
					if ((await readFile(full)).includes(needle)) {
						hits.push(full);
					}
				}
			}
			return hits;
		}
		return {
			...real,
			createSyncRunDir: async (base?: string) => {
				const dir = await real.createSyncRunDir(base);
				m.runDirs.push(dir);
				return dir;
			},
			// Before the activity's `finally` removes the clone: did the
			// token reach .git/config, the checkout, or anything else?
			removeSyncRunDir: async (dir: string) => {
				m.tokenOnDisk.push(...(await filesHolding(dir, m.token)));
				return real.removeSyncRunDir(dir);
			},
		};
	},
);

import { existsSync } from "node:fs";
import { syncContextTreeFromRepository } from "../src/activities/project-context-repository-sync";
import type { ContextSyncFrozenContext } from "../src/lib/context-sync-types";
import {
	committed,
	contextRow,
	ORG,
	PROJECT,
	queuedCleanupsOf,
	type Row,
	resetStore,
	SYNC,
	seedIntegration,
	seedRun,
	seedSync,
	sha256,
} from "./helpers/context-repository-sync-store";

let hasGit = true;
try {
	execFileSync("git", ["--version"], { stdio: "ignore" });
} catch {
	hasGit = false;
}

let work: string;
let source: string;

function git(args: string[]): string {
	return execFileSync("git", args, {
		cwd: source,
		env: {
			PATH: process.env.PATH,
			HOME: work,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: "/dev/null",
		},
		encoding: "utf8",
	}).trim();
}

function commit(message: string): string {
	git(["add", "-A"]);
	git([
		"-c",
		"user.name=Example",
		"-c",
		"user.email=dev@example.com",
		"commit",
		"-q",
		"-m",
		message,
	]);
	return git(["rev-parse", "HEAD"]);
}

async function put(relative: string, body: string): Promise<void> {
	const full = path.join(source, relative);
	await mkdir(path.dirname(full), { recursive: true });
	await writeFile(full, body);
}

const PATHS = ["docs", "notes/glossary.md"];

/** A fresh running run of the configuration, holding its key. */
function beginRun(
	runId: string,
	overrides: Row = {},
): ContextSyncFrozenContext {
	const runKey = `${SYNC}:${runId}`;
	for (const run of committed().run) {
		run.finishedAt ??= new Date("2026-09-23T13:00:00Z");
	}
	(committed().sync[0] as Row).activeRunKey = runKey;
	seedRun({ id: runKey, ...overrides });
	return {
		projectId: PROJECT,
		organizationId: ORG,
		syncId: SYNC,
		generation: 3,
		runKey,
		trigger: "MANUAL",
		repositoryIntegrationId: "int-1",
		ref: "main",
		paths: PATHS,
		actingUserId: "user-1",
	};
}

const managed = () =>
	Object.fromEntries(
		committed()
			.context.filter((c) => c.repositorySyncId === SYNC)
			.map((c) => [c.sourcePath as string, c.content as string])
			.sort(([a], [b]) => (a < b ? -1 : 1)),
	);

describe.skipIf(!hasGit)(
	"syncContextTreeFromRepository against real git",
	() => {
		let first: string;
		let second: string;

		beforeAll(async () => {
			work = await mkdtemp(path.join(tmpdir(), "context-sync-real-git-"));
			source = path.join(work, "source");
			await mkdir(source);
			git(["init", "-q", "-b", "main"]);
			git(["config", "uploadpack.allowFilter", "true"]);
			git(["config", "uploadpack.allowAnySHA1InWant", "true"]);
			await put("docs/.contextignore", "drafts/\n");
			await put("docs/a.md", "# Alpha\n");
			await put("docs/guides/b.md", "Beta\n");
			await put("docs/drafts/d.md", "a draft\n");
			await put("docs/diagram.png", "not text");
			await put("docs/x[1].md", "brackets in the name\n");
			await put("docs/x1.md", "the bracket file's neighbour\n");
			await symlink("a.md", path.join(source, "docs/link.md"));
			await put("notes/glossary.md", "Glossary\n");
			await put("notes/other.md", "not selected\n");
			await put("README.md", "not selected\n");
			first = commit("one");

			await put("docs/a.md", "# Alpha, revised\n");
			await rename(
				path.join(source, "docs/guides/b.md"),
				path.join(source, "docs/guides/b-renamed.md"),
			);
			second = commit("two");
		});

		afterAll(async () => {
			await rm(work, { recursive: true, force: true });
		});

		beforeEach(() => {
			vi.clearAllMocks();
			resetStore();
			m.runDirs = [];
			m.tokenOnDisk = [];
			m.start.mockResolvedValue(undefined);
			m.emit.mockResolvedValue(undefined);
			m.drain.mockImplementation(async (record: { id: string }) => {
				committed().cleanup = committed().cleanup.filter(
					(c) => c.id !== record.id,
				);
			});
			seedIntegration({
				repositoryUrl: `file://${source}`,
			});
			seedSync({ paths: PATHS, activeRunKey: null });
		});

		it("applies the head commit's selected paths, then a later commit's edit and rename, pruning the old name", async () => {
			// The head is the second commit; pin the first to apply it first.
			const one = beginRun("run-1", { commitSha: first });
			expect(await syncContextTreeFromRepository(one)).toEqual({
				outcome: "applied",
				commitSha: first,
			});
			expect(managed()).toEqual({
				"docs/a.md": "# Alpha\n",
				"docs/guides/b.md": "Beta\n",
				"docs/x1.md": "the bracket file's neighbour\n",
				"docs/x[1].md": "brackets in the name\n",
				"notes/glossary.md": "Glossary\n",
			});
			const plan = committed().run.find((r) => r.id === one.runKey)
				?.plan as { excludedCount: number; attentionCount: number };
			// The ignore file, the draft, the image and the symlink.
			expect(plan).toMatchObject({ excludedCount: 4, attentionCount: 0 });

			const two = beginRun("run-2");
			expect(await syncContextTreeFromRepository(two)).toEqual({
				outcome: "applied",
				commitSha: second,
			});
			expect(managed()).toEqual({
				"docs/a.md": "# Alpha, revised\n",
				"docs/guides/b-renamed.md": "Beta\n",
				"docs/x1.md": "the bracket file's neighbour\n",
				"docs/x[1].md": "brackets in the name\n",
				"notes/glossary.md": "Glossary\n",
			});
			const run = committed().run.find((r) => r.id === two.runKey) as Row;
			expect(run).toMatchObject({
				commitSha: second,
				removedCount: 1,
				outcomes: {
					"docs/a.md": "updated",
					"docs/guides/b-renamed.md": "created",
					"docs/x1.md": "unchanged",
					"docs/x[1].md": "unchanged",
					"notes/glossary.md": "unchanged",
				},
			});
			expect(contextRow("docs/a.md")?.contentHash).toBe(
				sha256("# Alpha, revised\n"),
			);
			// The prune queued one cleanup, and the drain took it.
			expect(m.drain).toHaveBeenCalledTimes(1);
			expect(queuedCleanupsOf(two.runKey)).toEqual([]);
		});

		it("keeps the token off disk and out of every log line, and leaves no clone behind", async () => {
			const ctx = beginRun("run-3");
			await syncContextTreeFromRepository(ctx);

			expect(m.runDirs).toHaveLength(1);
			expect(m.tokenOnDisk).toEqual([]);
			expect(existsSync(m.runDirs[0] as string)).toBe(false);
			const outputs = JSON.stringify([
				m.log.debug.mock.calls,
				m.log.info.mock.calls,
				m.log.warn.mock.calls,
				m.log.error.mock.calls,
				m.emit.mock.calls,
				m.start.mock.calls,
				committed(),
			]);
			expect(outputs).not.toContain(TOKEN);
		});
	},
);
