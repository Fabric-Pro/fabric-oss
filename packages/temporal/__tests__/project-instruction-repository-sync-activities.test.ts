import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { SNAPSHOT_LIMITS, stagingKey } from "@repo/instructions";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Assembled so the source carries no credential-shaped literal for the
// publication gitleaks scan; the tests only need a unique marker.
const TOKEN = ["tok", "placeholder", "123"].join("-");
const SHA = "c".repeat(40);
const OLD_SHA = "b".repeat(40);

const m = vi.hoisted(() => ({
	getInstructionRepositorySyncForRun: vi.fn(),
	getInstructionRepositorySyncRunReceipt: vi.fn(),
	insertInstructionRepositorySyncRun: vi.fn(),
	canCreateProjectInstructions: vi.fn(),
	getInstructionSnapshotBySyncRunKey: vi.fn(),
	getProjectRepoIntegration: vi.fn(),
	getPublishedInstructionTree: vi.fn(),
	getProjectInstructionSettings: vi.fn(),
	createInstructionSnapshot: vi.fn(),
	claimInstructionFileStagingKey: vi.fn(),
	recordAudit: vi.fn(),
	getInstructionSnapshotWithPublishedPointer: vi.fn(),
	rejectAbandonedInstructionSnapshot: vi.fn(),
	markAbandonedInstructionSnapshotSwept: vi.fn(),
	rotateAbandonedInstructionSnapshot: vi.fn(),
	completeInstructionRepositorySyncRun: vi.fn(),
	deleteInstructionSnapshot: vi.fn(),
	listPrunableInstructionSnapshots: vi.fn(),
	resolveFreshRepoToken: vi.fn(),
	forceReExchangeRepoCredentials: vi.fn(),
	markRepoReauthRequired: vi.fn(),
	uploadFile: vi.fn(),
	listObjects: vi.fn(),
	deleteObjects: vi.fn(),
	describe: vi.fn(),
	result: vi.fn(),
	heartbeat: vi.fn(),
	cloneTreeless: vi.fn(),
	fetchPinnedCommit: vi.fn(),
	revParseHead: vi.fn(),
	listTree: vi.fn(),
	readBlobCapped: vi.fn(),
	sparseCheckout: vi.fn(),
	log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@repo/database", () => ({
	getInstructionRepositorySyncForRun: m.getInstructionRepositorySyncForRun,
	getInstructionRepositorySyncRunReceipt:
		m.getInstructionRepositorySyncRunReceipt,
	insertInstructionRepositorySyncRun: m.insertInstructionRepositorySyncRun,
	canCreateProjectInstructions: m.canCreateProjectInstructions,
	getInstructionSnapshotBySyncRunKey: m.getInstructionSnapshotBySyncRunKey,
	getProjectRepoIntegration: m.getProjectRepoIntegration,
	getPublishedInstructionTree: m.getPublishedInstructionTree,
	getProjectInstructionSettings: m.getProjectInstructionSettings,
	createInstructionSnapshot: m.createInstructionSnapshot,
	claimInstructionFileStagingKey: m.claimInstructionFileStagingKey,
	recordAudit: m.recordAudit,
	getInstructionSnapshotWithPublishedPointer:
		m.getInstructionSnapshotWithPublishedPointer,
	rejectAbandonedInstructionSnapshot: m.rejectAbandonedInstructionSnapshot,
	markAbandonedInstructionSnapshotSwept:
		m.markAbandonedInstructionSnapshotSwept,
	rotateAbandonedInstructionSnapshot: m.rotateAbandonedInstructionSnapshot,
	completeInstructionRepositorySyncRun:
		m.completeInstructionRepositorySyncRun,
	deleteInstructionSnapshot: m.deleteInstructionSnapshot,
	listPrunableInstructionSnapshots: m.listPrunableInstructionSnapshots,
}));
vi.mock("@repo/integrations", () => ({
	resolveFreshRepoToken: m.resolveFreshRepoToken,
	forceReExchangeRepoCredentials: m.forceReExchangeRepoCredentials,
	markRepoReauthRequired: m.markRepoReauthRequired,
	isGitAuthError: (e: unknown) =>
		String((e as Error)?.message)
			.toLowerCase()
			.includes("authentication failed"),
}));
vi.mock("@repo/storage", () => ({
	getStorageProvider: () => ({
		uploadFile: m.uploadFile,
		listObjects: m.listObjects,
		deleteObjects: m.deleteObjects,
	}),
}));
vi.mock("@repo/config", () => ({
	config: { storage: { bucketNames: { skills: "skills" } } },
}));
vi.mock("@repo/logs", () => ({ logger: m.log }));
vi.mock("../src/client", () => ({
	getTemporalClient: async () => ({
		workflow: {
			getHandle: () => ({ describe: m.describe, result: m.result }),
		},
	}),
}));
vi.mock("@temporalio/activity", () => ({
	heartbeat: m.heartbeat,
	Context: {
		current: () => {
			throw new Error("not in an activity");
		},
	},
	ApplicationFailure: {
		create: (o: {
			message: string;
			type: string;
			details?: unknown[];
			nonRetryable?: boolean;
		}) =>
			Object.assign(new Error(o.message), {
				name: "ApplicationFailure",
				type: o.type,
				details: o.details ?? [],
				nonRetryable: o.nonRetryable ?? false,
			}),
		nonRetryable: (message: string, type: string) =>
			Object.assign(new Error(message), {
				name: "ApplicationFailure",
				type,
				nonRetryable: true,
			}),
	},
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
			cloneTreeless: m.cloneTreeless,
			fetchPinnedCommit: m.fetchPinnedCommit,
			revParseHead: m.revParseHead,
			listTree: m.listTree,
			readBlobCapped: m.readBlobCapped,
			sparseCheckout: m.sparseCheckout,
		};
	},
);

import { GitCommandError } from "../src/activities/lib/instruction-sync-git";
import {
	acquireInstructionTreeFromRepository,
	awaitInstructionSnapshotSettled,
	beginInstructionRepositorySyncRun,
	recordInstructionRepositorySyncRun,
} from "../src/activities/project-instruction-repository-sync";
import type {
	InstructionSyncTrigger,
	RecordSyncRunInput,
	SyncRunContext,
} from "../src/lib/instruction-sync-types";

const CONTEXT: SyncRunContext = {
	projectId: "proj_1",
	organizationId: "org_1",
	syncId: "sync_1",
	generation: 3,
	repositoryIntegrationId: "int_1",
	ref: "main",
	rootPath: "agents",
	actingUserId: "user_1",
	trigger: "MANUAL",
	runKey: "sync_1:run_a",
};

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

type RepoFile = { path: string; body: string; mode?: "100644" | "100755" };

/**
 * Serves a repository through the mocked git operations. The sparse checkout
 * WRITES the requested files into the clone directory, so the activity's
 * real `lstat`, read and hash run against real bytes.
 */
function serveRepo(
	files: RepoFile[],
	opts: { rootPath?: string; head?: string } = {},
) {
	const root = opts.rootPath ?? "agents";
	const entries = files.map((f, i) => ({
		repoPath: root === "" ? f.path : `${root}/${f.path}`,
		relPath: f.path,
		gitMode: f.mode ?? "100644",
		oid: String(i + 1).padStart(40, "0"),
	}));
	const body = (repoPath: string) =>
		files[entries.findIndex((e) => e.repoPath === repoPath)]?.body ?? "";
	m.cloneTreeless.mockImplementation(async ({ dir }: { dir: string }) => {
		await mkdir(dir, { recursive: true });
	});
	m.revParseHead.mockResolvedValue(opts.head ?? SHA);
	m.listTree.mockResolvedValue({
		ok: true,
		summary: {
			files: entries,
			excludedCount: 0,
			underRoot: entries.length,
		},
	});
	m.readBlobCapped.mockImplementation(async ({ oid }: { oid: string }) => {
		const entry = entries.find((e) => e.oid === oid);
		return entry ? Buffer.from(body(entry.repoPath)) : null;
	});
	m.sparseCheckout.mockImplementation(
		async ({ dir, repoPaths }: { dir: string; repoPaths: string[] }) => {
			for (const p of repoPaths) {
				await mkdir(path.dirname(path.join(dir, p)), {
					recursive: true,
				});
				await writeFile(path.join(dir, p), body(p));
			}
		},
	);
	return entries;
}

function failureOf(error: unknown) {
	return error as Error & {
		type: string;
		details: Array<Record<string, unknown>>;
		nonRetryable: boolean;
	};
}

beforeEach(() => {
	for (const value of Object.values(m)) {
		if (typeof value === "function") value.mockReset();
	}
	for (const fn of Object.values(m.log)) fn.mockReset();
	m.getInstructionSnapshotBySyncRunKey.mockResolvedValue(null);
	m.getProjectRepoIntegration.mockResolvedValue({
		id: "int_1",
		projectId: "proj_1",
		provider: "GITHUB",
		repositoryUrl: "https://github.com/example-org/instructions.git",
		status: "ACTIVE",
	});
	m.resolveFreshRepoToken.mockResolvedValue({ token: TOKEN });
	m.getPublishedInstructionTree.mockResolvedValue(null);
	m.getProjectInstructionSettings.mockResolvedValue({
		ignoreGlobs: null,
		sourceOfTruth: "REPOSITORY",
	});
	m.createInstructionSnapshot.mockImplementation(
		async ({
			files,
		}: {
			files: Array<{ path: string; storageKey: string }>;
		}) => ({
			id: "snap_1",
			version: 4,
			files: files.map((f, i) => ({
				id: `file_${i}`,
				path: f.path,
				storageKey: f.storageKey,
			})),
		}),
	);
	m.claimInstructionFileStagingKey.mockResolvedValue({ moved: true });
	m.uploadFile.mockResolvedValue(undefined);
	m.listObjects.mockResolvedValue({ objects: [] });
	m.deleteObjects.mockResolvedValue({ deleted: 0, errors: [] });
	m.markAbandonedInstructionSnapshotSwept.mockResolvedValue({
		changed: true,
	});
	m.completeInstructionRepositorySyncRun.mockResolvedValue({
		completed: true,
		configurationCurrent: true,
	});
	m.describe.mockRejectedValue(
		Object.assign(new Error("not found"), {
			name: "WorkflowNotFoundError",
		}),
	);
});

describe("beginInstructionRepositorySyncRun (spec §5.3.1)", () => {
	const row = {
		id: "sync_1",
		projectId: "proj_1",
		organizationId: "org_1",
		userId: "delegate_1",
		repositoryIntegrationId: "int_1",
		ref: "main",
		rootPath: "agents",
		automatic: true,
		generation: 3,
		automaticPausedReason: null,
		repositoryIntegration: {
			id: "int_1",
			projectId: "proj_1",
			status: "ACTIVE",
		},
	};
	const input = {
		projectId: "proj_1",
		organizationId: "org_1",
		trigger: "MANUAL" as const,
		requesterUserId: "user_1",
		workflowRunId: "run_a",
	};

	beforeEach(() => {
		m.getInstructionRepositorySyncForRun.mockResolvedValue(row);
		m.insertInstructionRepositorySyncRun.mockResolvedValue({
			inserted: true,
			generation: 3,
		});
		m.canCreateProjectInstructions.mockResolvedValue(true);
	});

	it("returns NOT_CONFIGURED with no context when the row is missing or names another organization", async () => {
		m.getInstructionRepositorySyncForRun.mockResolvedValueOnce(null);
		expect(await beginInstructionRepositorySyncRun(input)).toEqual({
			ok: false,
			error: "NOT_CONFIGURED",
		});
		m.getInstructionRepositorySyncForRun.mockResolvedValueOnce({
			...row,
			organizationId: "org_other",
		});
		expect(await beginInstructionRepositorySyncRun(input)).toEqual({
			ok: false,
			error: "NOT_CONFIGURED",
		});
		expect(m.insertInstructionRepositorySyncRun).not.toHaveBeenCalled();
	});

	it("a manual run acts as the requester and inserts its run row once, keyed by syncId:runId", async () => {
		const result = await beginInstructionRepositorySyncRun(input);
		expect(result).toEqual({
			ok: true,
			context: { ...CONTEXT, actingUserId: "user_1" },
		});
		expect(m.insertInstructionRepositorySyncRun).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "sync_1:run_a",
				syncId: "sync_1",
				userId: "user_1",
				generation: 3,
				trigger: "MANUAL",
			}),
		);
		expect(m.canCreateProjectInstructions).toHaveBeenCalledWith(
			"proj_1",
			"user_1",
		);
	});

	it("an automatic run acts as the delegate on the row NOW, not the one it was queued under", async () => {
		const result = await beginInstructionRepositorySyncRun({
			...input,
			trigger: "POLL",
			requesterUserId: undefined,
		});
		expect(result).toMatchObject({
			ok: true,
			context: { actingUserId: "delegate_1", trigger: "POLL" },
		});
	});

	it("skips POLL and WEBHOOK when automatic is off, but not a trigger outside AUTOMATIC_INSTRUCTION_SYNC_TRIGGERS (Decision 47)", async () => {
		m.getInstructionRepositorySyncForRun.mockResolvedValue({
			...row,
			automatic: false,
		});
		for (const trigger of ["POLL", "WEBHOOK"] as const) {
			expect(
				await beginInstructionRepositorySyncRun({
					...input,
					trigger,
					requesterUserId: undefined,
				}),
			).toMatchObject({ ok: false, skipped: "automatic_disabled" });
		}

		const future = "FUTURE_TRIGGER" as unknown as InstructionSyncTrigger;
		expect(
			await beginInstructionRepositorySyncRun({
				...input,
				trigger: future,
				requesterUserId: undefined,
			}),
		).toMatchObject({
			ok: true,
			context: { actingUserId: "delegate_1", trigger: future },
		});
	});

	it("checks automatic eligibility before `expected`, so a stale generation on a now-disabled sync is skipped, not CONFIGURATION_CHANGED", async () => {
		const stale = { syncId: "sync_1", generation: 2 };
		m.getInstructionRepositorySyncForRun.mockResolvedValueOnce({
			...row,
			automatic: false,
		});
		expect(
			await beginInstructionRepositorySyncRun({
				...input,
				trigger: "POLL",
				requesterUserId: undefined,
				expected: stale,
			}),
		).toMatchObject({ ok: false, skipped: "automatic_disabled" });

		// Eligibility does not swallow a real re-configure: a still-automatic
		// sync with a stale `expected` generation is refused as
		// CONFIGURATION_CHANGED, same as before the reorder.
		m.getInstructionRepositorySyncForRun.mockResolvedValueOnce({
			...row,
			automatic: true,
		});
		expect(
			await beginInstructionRepositorySyncRun({
				...input,
				trigger: "POLL",
				requesterUserId: undefined,
				expected: stale,
			}),
		).toMatchObject({ ok: false, error: "CONFIGURATION_CHANGED" });
	});

	it("reports an inactive integration with context, after inserting the run row (so the tab can show it)", async () => {
		m.getInstructionRepositorySyncForRun.mockResolvedValue({
			...row,
			repositoryIntegration: {
				...row.repositoryIntegration,
				status: "TOKEN_EXPIRED",
			},
		});
		expect(await beginInstructionRepositorySyncRun(input)).toMatchObject({
			ok: false,
			error: "INTEGRATION_UNAVAILABLE",
			context: { syncId: "sync_1" },
		});
		expect(m.insertInstructionRepositorySyncRun).toHaveBeenCalledTimes(1);
	});

	it.each([
		["automatic_disabled", { automatic: false }],
		["paused", { automaticPausedReason: "REF_MISSING" }],
	])(
		"skips an automatic run that became %s after it was queued",
		async (skipped, change) => {
			m.getInstructionRepositorySyncForRun.mockResolvedValue({
				...row,
				...change,
			});
			expect(
				await beginInstructionRepositorySyncRun({
					...input,
					trigger: "WEBHOOK",
					requesterUserId: undefined,
				}),
			).toMatchObject({ ok: false, skipped });
		},
	);

	it("never skips a manual run for the automatic switches", async () => {
		m.getInstructionRepositorySyncForRun.mockResolvedValue({
			...row,
			automatic: false,
			automaticPausedReason: "PERMISSION_REVOKED",
		});
		expect(await beginInstructionRepositorySyncRun(input)).toMatchObject({
			ok: true,
		});
	});

	it("returns PERMISSION_DENIED with context when the acting user lacks instruction:create", async () => {
		m.canCreateProjectInstructions.mockResolvedValue(false);
		expect(await beginInstructionRepositorySyncRun(input)).toMatchObject({
			ok: false,
			error: "PERMISSION_DENIED",
			context: { actingUserId: "user_1" },
		});
	});

	it("a retry that finds its run row under an older generation reports CONFIGURATION_CHANGED with that generation", async () => {
		m.getInstructionRepositorySyncForRun.mockResolvedValue({
			...row,
			generation: 4,
		});
		m.insertInstructionRepositorySyncRun.mockResolvedValue({
			inserted: false,
			generation: 3,
		});
		expect(await beginInstructionRepositorySyncRun(input)).toMatchObject({
			ok: false,
			error: "CONFIGURATION_CHANGED",
			context: { generation: 3 },
		});
		expect(m.canCreateProjectInstructions).not.toHaveBeenCalled();
	});

	describe("the row an automatic start was decided on (Decision 56)", () => {
		const automatic = {
			...input,
			trigger: "POLL" as const,
			requesterUserId: undefined,
		};

		it.each([
			[
				"another sync id (the configuration was replaced)",
				{ syncId: "sync_0", generation: 3 },
			],
			[
				"another generation (the configuration was changed)",
				{ syncId: "sync_1", generation: 2 },
			],
		])(
			"refuses a run whose row now has %s, after inserting its receipt",
			async (_label, expected) => {
				expect(
					await beginInstructionRepositorySyncRun({
						...automatic,
						expected,
					}),
				).toEqual({
					ok: false,
					error: "CONFIGURATION_CHANGED",
					context: {
						...CONTEXT,
						actingUserId: "delegate_1",
						trigger: "POLL",
					},
				});
				// The receipt went in first, so the refusal has a run row.
				expect(
					m.insertInstructionRepositorySyncRun,
				).toHaveBeenCalledTimes(1);
				expect(m.canCreateProjectInstructions).not.toHaveBeenCalled();
			},
		);

		it("begins a run whose row still matches", async () => {
			expect(
				await beginInstructionRepositorySyncRun({
					...automatic,
					expected: { syncId: "sync_1", generation: 3 },
				}),
			).toMatchObject({
				ok: true,
				context: { syncId: "sync_1", generation: 3, trigger: "POLL" },
			});
		});

		it("begins a run that carries no expectation, as a manual one never does", async () => {
			expect(
				await beginInstructionRepositorySyncRun(automatic),
			).toMatchObject({ ok: true });
			expect(
				await beginInstructionRepositorySyncRun(input),
			).toMatchObject({
				ok: true,
			});
		});
	});
});

describe("acquireInstructionTreeFromRepository (spec §5.3.2)", () => {
	it("stages the kept files with git modes, repository columns and the run key, then cleans up", async () => {
		serveRepo([
			{ path: "CLAUDE.md", body: "# rules\n" },
			{
				path: "scripts/run.sh",
				body: "#!/bin/sh\necho hi\n",
				mode: "100755",
			},
		]);

		const result = await acquireInstructionTreeFromRepository(CONTEXT);

		expect(result).toEqual({
			outcome: "staged",
			snapshotId: "snap_1",
			commitSha: SHA,
		});
		expect(m.sparseCheckout).toHaveBeenCalledWith(
			expect.objectContaining({
				repoPaths: ["agents/CLAUDE.md", "agents/scripts/run.sh"],
			}),
		);
		expect(m.createInstructionSnapshot).toHaveBeenCalledWith({
			projectId: "proj_1",
			organizationId: "org_1",
			userId: "user_1",
			source: "REPOSITORY",
			repositoryIntegrationId: "int_1",
			sourceRef: "main",
			sourceCommitSha: SHA,
			syncRunKey: "sync_1:run_a",
			publishOnReady: true,
			excludedCount: 0,
			settingsFrozen: {
				ignoreGlobs: expect.any(Array),
				layer: "default",
				limits: SNAPSHOT_LIMITS,
				rootPath: "agents",
				syncId: "sync_1",
				syncGeneration: 3,
			},
			files: [
				{
					path: "CLAUDE.md",
					size: 8,
					sha256: sha256("# rules\n"),
					mimeType: "text/markdown",
					isText: true,
					kind: "INSTRUCTIONS",
					storageKey: stagingKey("proj_1", "pending", "0"),
					mode: 0o644,
				},
				expect.objectContaining({
					path: "scripts/run.sh",
					kind: "SCRIPT",
					mode: 0o755,
				}),
			],
		});
		expect(m.claimInstructionFileStagingKey).toHaveBeenCalledWith({
			fileId: "file_0",
			snapshotId: "snap_1",
			projectId: "proj_1",
			organizationId: "org_1",
			from: stagingKey("proj_1", "pending", "0"),
			to: stagingKey("proj_1", "snap_1", "file_0"),
		});
		expect(m.uploadFile).toHaveBeenCalledWith(
			stagingKey("proj_1", "snap_1", "file_0"),
			Buffer.from("# rules\n"),
			{ bucket: "skills", contentType: "text/markdown" },
		);
		expect(m.recordAudit).toHaveBeenCalledWith(
			expect.objectContaining({
				action: "project.instructions.upload_started",
				metadata: expect.objectContaining({
					mode: "repository",
					trigger: "MANUAL",
					keptCount: 2,
				}),
			}),
		);
		const runDir = m.cloneTreeless.mock.calls[0]?.[0].cwd as string;
		expect(existsSync(runDir)).toBe(false);
	});

	it("maps an unknown branch to REF_MISSING", async () => {
		m.cloneTreeless.mockRejectedValue(
			new GitCommandError(
				"exit",
				128,
				"fatal: Remote branch main not found in upstream origin",
				"clone",
			),
		);
		const error = failureOf(
			await acquireInstructionTreeFromRepository(CONTEXT).catch((e) => e),
		);
		expect(error.type).toBe("REF_MISSING");
	});

	it("maps an empty inventory under a configured root to ROOT_MISSING, with the commit", async () => {
		serveRepo([]);
		const error = failureOf(
			await acquireInstructionTreeFromRepository(CONTEXT).catch((e) => e),
		);
		expect(error.type).toBe("ROOT_MISSING");
		expect(error.details[0]).toEqual({ commitSha: SHA });
	});

	it("is unchanged when the published snapshot came from this commit under this (syncId, generation)", async () => {
		serveRepo([{ path: "CLAUDE.md", body: "x" }]);
		m.getPublishedInstructionTree.mockResolvedValue({
			snapshotId: "snap_0",
			sourceCommitSha: SHA,
			settingsFrozen: { syncId: "sync_1", syncGeneration: 3 },
			files: [],
		});
		expect(await acquireInstructionTreeFromRepository(CONTEXT)).toEqual({
			outcome: "unchanged",
			commitSha: SHA,
		});
		expect(m.listTree).not.toHaveBeenCalled();
	});

	it("re-plans the same commit when the published tree holds a path the always layer now excludes (Fizzy #2705)", async () => {
		// The published version was filtered through an older built-in list
		// and still carries the committed `CLAUDE.local.md`; the current
		// always layer excludes it, so the same-commit shortcut must not keep
		// that version, and the planning pass must drop the path.
		serveRepo([
			{ path: "CLAUDE.md", body: "x" },
			{ path: "CLAUDE.local.md", body: "mine" },
		]);
		m.getPublishedInstructionTree.mockResolvedValue({
			snapshotId: "snap_0",
			sourceCommitSha: SHA,
			settingsFrozen: { syncId: "sync_1", syncGeneration: 3 },
			files: [
				{ path: "CLAUDE.md", sha256: sha256("x"), mode: null },
				{ path: "CLAUDE.local.md", sha256: sha256("mine"), mode: null },
			],
		});
		const result = await acquireInstructionTreeFromRepository(CONTEXT);
		expect(result.outcome).toBe("staged");
		expect(m.listTree).toHaveBeenCalled();
		// The plan is the current tree only; the stale path is not carried.
		const rows = m.createInstructionSnapshot.mock.calls[0]?.[0].files as {
			path: string;
		}[];
		expect(rows.map((r) => r.path)).toEqual(["CLAUDE.md"]);
	});

	it("keeps a same-commit version unchanged when EVERY published path is now always-excluded (Fizzy #2705)", async () => {
		// Same commit and same pair: a planning pass would keep nothing and
		// be refused, on this sync and on every later one. Leave the version
		// alone; only a repository change can repair it.
		serveRepo([{ path: "CLAUDE.local.md", body: "mine" }]);
		m.getPublishedInstructionTree.mockResolvedValue({
			snapshotId: "snap_0",
			sourceCommitSha: SHA,
			settingsFrozen: { syncId: "sync_1", syncGeneration: 3 },
			files: [
				{ path: "CLAUDE.local.md", sha256: sha256("mine"), mode: null },
			],
		});
		expect(await acquireInstructionTreeFromRepository(CONTEXT)).toEqual({
			outcome: "unchanged",
			commitSha: SHA,
		});
		expect(m.listTree).not.toHaveBeenCalled();
	});

	it("is unchanged by tree across a new commit, including a 0644 file that starts with #! (Review Focus 2)", async () => {
		serveRepo([
			{ path: "CLAUDE.md", body: "same" },
			{ path: "notes.sh", body: "#!/bin/sh\n# sample\n" },
		]);
		m.getPublishedInstructionTree.mockResolvedValue({
			snapshotId: "snap_0",
			sourceCommitSha: OLD_SHA,
			settingsFrozen: { syncId: "sync_1", syncGeneration: 3 },
			files: [
				{ path: "CLAUDE.md", sha256: sha256("same"), mode: null },
				{
					path: "notes.sh",
					sha256: sha256("#!/bin/sh\n# sample\n"),
					mode: 0o644,
				},
			],
		});
		expect(await acquireInstructionTreeFromRepository(CONTEXT)).toEqual({
			outcome: "unchanged",
			commitSha: SHA,
		});
		expect(m.createInstructionSnapshot).not.toHaveBeenCalled();
	});

	it("stages a mode-only change, which the digest cannot see", async () => {
		serveRepo([{ path: "run.sh", body: "#!/bin/sh\n", mode: "100755" }]);
		m.getPublishedInstructionTree.mockResolvedValue({
			snapshotId: "snap_0",
			sourceCommitSha: OLD_SHA,
			settingsFrozen: { syncId: "sync_1", syncGeneration: 3 },
			files: [
				{ path: "run.sh", sha256: sha256("#!/bin/sh\n"), mode: 0o644 },
			],
		});
		expect(
			await acquireInstructionTreeFromRepository(CONTEXT),
		).toMatchObject({ outcome: "staged" });
	});

	it("refuses an inventory over the cap before planning", async () => {
		serveRepo([{ path: "a.md", body: "a" }]);
		m.listTree.mockResolvedValue({ ok: false });
		const error = failureOf(
			await acquireInstructionTreeFromRepository(CONTEXT).catch((e) => e),
		);
		expect(error.type).toBe("LIMITS_EXCEEDED");
		expect(m.sparseCheckout).not.toHaveBeenCalled();
	});

	it("refuses too many kept files before any content is fetched", async () => {
		serveRepo(
			Array.from({ length: SNAPSHOT_LIMITS.maxFiles + 1 }, (_, i) => ({
				path: `f${i}.md`,
				body: "x",
			})),
		);
		const error = failureOf(
			await acquireInstructionTreeFromRepository(CONTEXT).catch((e) => e),
		);
		expect(error.type).toBe("LIMITS_EXCEEDED");
		expect(error.details[0]).toEqual({
			commitSha: SHA,
			keptCount: SNAPSHOT_LIMITS.maxFiles + 1,
		});
		expect(m.sparseCheckout).not.toHaveBeenCalled();
	});

	it("refuses a file over the per-file cap from lstat, with the commit", async () => {
		serveRepo([
			{
				path: "big.md",
				body: "x".repeat(SNAPSHOT_LIMITS.maxFileBytes + 1),
			},
		]);
		const error = failureOf(
			await acquireInstructionTreeFromRepository(CONTEXT).catch((e) => e),
		);
		expect(error.type).toBe("LIMITS_EXCEEDED");
		expect(error.details[0]).toEqual({ commitSha: SHA });
		expect(m.createInstructionSnapshot).not.toHaveBeenCalled();
	});

	it("refuses a tree the planner refuses as TREE_REFUSED with only the refusal code", async () => {
		serveRepo([
			{ path: "A.md", body: "1" },
			{ path: "a.md", body: "2" },
		]);
		const error = failureOf(
			await acquireInstructionTreeFromRepository(CONTEXT).catch((e) => e),
		);
		expect(error.type).toBe("TREE_REFUSED");
		expect(error.details[0]).toEqual({
			commitSha: SHA,
			refusal: "duplicate_path",
		});
	});

	// Git stores `Docs` and `docs/` as different names, but a case-insensitive
	// checkout cannot write a file and a folder under one name, so the sync
	// refuses the same tree the upload procedure refuses.
	it("refuses a name that is a file in one path and a folder in another", async () => {
		serveRepo([
			{ path: "docs/a.md", body: "1" },
			{ path: "Docs", body: "2" },
		]);
		const error = failureOf(
			await acquireInstructionTreeFromRepository(CONTEXT).catch((e) => e),
		);
		expect(error.type).toBe("TREE_REFUSED");
		expect(error.details[0]).toEqual({
			commitSha: SHA,
			refusal: "file_directory_conflict",
		});
		expect(m.sparseCheckout).not.toHaveBeenCalled();
	});

	it("stages a backslash repository path under its stored path with the right bytes (Review Focus 3)", async () => {
		serveRepo([{ path: "docs\\guide.md", body: "guide body" }]);

		await acquireInstructionTreeFromRepository(CONTEXT);

		expect(m.sparseCheckout).toHaveBeenCalledWith(
			expect.objectContaining({ repoPaths: ["agents/docs\\guide.md"] }),
		);
		expect(
			m.createInstructionSnapshot.mock.calls[0]?.[0].files[0],
		).toMatchObject({
			path: "docs/guide.md",
			sha256: sha256("guide body"),
		});
		expect(m.uploadFile).toHaveBeenCalledWith(
			stagingKey("proj_1", "snap_1", "file_0"),
			Buffer.from("guide body"),
			expect.anything(),
		);
	});

	it("excludes an oversized .fabricignore from the kept set as well as ignoring its rules (Review Focus 5)", async () => {
		serveRepo([
			{ path: ".fabricignore", body: "*.md\n" },
			{ path: "CLAUDE.md", body: "keep" },
		]);
		m.readBlobCapped.mockResolvedValue(null);

		await acquireInstructionTreeFromRepository(CONTEXT);

		const created = m.createInstructionSnapshot.mock.calls[0]?.[0];
		expect(created.files.map((f: { path: string }) => f.path)).toEqual([
			"CLAUDE.md",
		]);
		expect(created.excludedCount).toBe(1);
		expect(created.settingsFrozen.layer).toBe("default");
		expect(m.sparseCheckout).toHaveBeenCalledWith(
			expect.objectContaining({ repoPaths: ["agents/CLAUDE.md"] }),
		);
	});

	it("applies a readable .fabricignore exactly as begin does, and keeps the file", async () => {
		serveRepo([
			{ path: ".fabricignore", body: "drafts/**\n" },
			{ path: "CLAUDE.md", body: "keep" },
			{ path: "drafts/x.md", body: "drop" },
		]);
		await acquireInstructionTreeFromRepository(CONTEXT);
		const created = m.createInstructionSnapshot.mock.calls[0]?.[0];
		expect(created.settingsFrozen.layer).toBe("fabricignore");
		expect(
			created.files.map((f: { path: string }) => f.path).sort(),
		).toEqual([".fabricignore", "CLAUDE.md"]);
		expect(created.excludedCount).toBe(1);
	});

	it("an adopted row that is no longer RECEIVING is returned at once: the child owns it", async () => {
		m.getInstructionSnapshotBySyncRunKey.mockResolvedValue({
			id: "snap_9",
			version: 9,
			status: "VALIDATING",
			sourceCommitSha: SHA,
			files: [],
		});
		expect(await acquireInstructionTreeFromRepository(CONTEXT)).toEqual({
			outcome: "staged",
			snapshotId: "snap_9",
			commitSha: SHA,
		});
		expect(m.cloneTreeless).not.toHaveBeenCalled();
	});

	it("an adopted RECEIVING row re-fetches its pinned commit, maps stored paths back to repository paths, and re-uploads to its own file ids", async () => {
		serveRepo([{ path: "docs\\guide.md", body: "guide body" }], {
			head: SHA,
		});
		m.getInstructionSnapshotBySyncRunKey.mockResolvedValue({
			id: "snap_9",
			version: 9,
			status: "RECEIVING",
			sourceCommitSha: OLD_SHA,
			files: [
				{
					id: "file_a",
					path: "docs/guide.md",
					sha256: sha256("guide body"),
					mode: 0o644,
					size: 10,
					storageKey: stagingKey("proj_1", "snap_9", "file_a"),
					mimeType: "text/markdown",
				},
			],
		});
		m.revParseHead.mockResolvedValue(OLD_SHA);

		expect(await acquireInstructionTreeFromRepository(CONTEXT)).toEqual({
			outcome: "staged",
			snapshotId: "snap_9",
			commitSha: OLD_SHA,
		});
		expect(m.fetchPinnedCommit).toHaveBeenCalledWith(
			expect.objectContaining({ sha: OLD_SHA }),
		);
		expect(m.sparseCheckout).toHaveBeenCalledWith(
			expect.objectContaining({ repoPaths: ["agents/docs\\guide.md"] }),
		);
		expect(m.createInstructionSnapshot).not.toHaveBeenCalled();
		expect(m.claimInstructionFileStagingKey).not.toHaveBeenCalled();
		expect(m.uploadFile).toHaveBeenCalledWith(
			stagingKey("proj_1", "snap_9", "file_a"),
			Buffer.from("guide body"),
			{ bucket: "skills", contentType: "text/markdown" },
		);
	});

	it("an adopted row whose pinned commit no longer reproduces its hashes is CLONE_FAILED, never a second row", async () => {
		serveRepo([{ path: "CLAUDE.md", body: "different now" }]);
		m.getInstructionSnapshotBySyncRunKey.mockResolvedValue({
			id: "snap_9",
			version: 9,
			status: "RECEIVING",
			sourceCommitSha: OLD_SHA,
			files: [
				{
					id: "file_a",
					path: "CLAUDE.md",
					sha256: sha256("original"),
					mode: 0o644,
					size: 8,
					storageKey: "k",
					mimeType: "text/markdown",
				},
			],
		});
		const error = failureOf(
			await acquireInstructionTreeFromRepository(CONTEXT).catch((e) => e),
		);
		expect(error.type).toBe("CLONE_FAILED");
		expect(error.details[0]).toMatchObject({ snapshotId: "snap_9" });
		expect(m.createInstructionSnapshot).not.toHaveBeenCalled();
	});

	it("a pinned commit the server refuses is CLONE_FAILED (retryable)", async () => {
		serveRepo([{ path: "CLAUDE.md", body: "x" }]);
		m.getInstructionSnapshotBySyncRunKey.mockResolvedValue({
			id: "snap_9",
			version: 9,
			status: "RECEIVING",
			sourceCommitSha: OLD_SHA,
			files: [],
		});
		m.fetchPinnedCommit.mockRejectedValue(
			new GitCommandError(
				"exit",
				128,
				"fatal: remote error: upload-pack: not our ref",
				"fetch",
			),
		);
		const error = failureOf(
			await acquireInstructionTreeFromRepository(CONTEXT).catch((e) => e),
		);
		expect(error.type).toBe("CLONE_FAILED");
		expect(error.nonRetryable).toBe(false);
	});

	it("a concurrent attempt of the same run that won the create turns this one into an adoption of its row", async () => {
		serveRepo([{ path: "CLAUDE.md", body: "x" }]);
		m.createInstructionSnapshot.mockResolvedValueOnce({
			id: "snap_w",
			version: 5,
			files: [],
			existing: true,
		});
		m.getInstructionSnapshotBySyncRunKey
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce({
				id: "snap_w",
				version: 5,
				status: "RECEIVING",
				sourceCommitSha: SHA,
				files: [
					{
						id: "file_w",
						path: "CLAUDE.md",
						sha256: sha256("x"),
						mode: 0o644,
						size: 1,
						storageKey: stagingKey("proj_1", "snap_w", "file_w"),
						mimeType: "text/markdown",
					},
				],
			});

		expect(await acquireInstructionTreeFromRepository(CONTEXT)).toEqual({
			outcome: "staged",
			snapshotId: "snap_w",
			commitSha: SHA,
		});
		expect(m.createInstructionSnapshot).toHaveBeenCalledTimes(1);
		expect(m.cloneTreeless).toHaveBeenCalledTimes(2);
		expect(m.fetchPinnedCommit).toHaveBeenCalledWith(
			expect.objectContaining({ sha: SHA }),
		);
	});

	it("re-exchanges the credential once after an auth failure and retries the clone", async () => {
		serveRepo([{ path: "CLAUDE.md", body: "x" }]);
		const clone = m.cloneTreeless.getMockImplementation();
		m.cloneTreeless.mockRejectedValueOnce(
			new GitCommandError(
				"exit",
				128,
				"fatal: Authentication failed for 'https://github.com/'",
				"clone",
			),
		);
		m.cloneTreeless.mockImplementation(clone as never);
		m.forceReExchangeRepoCredentials.mockResolvedValue({ refreshed: true });
		m.resolveFreshRepoToken
			.mockResolvedValueOnce({ token: TOKEN })
			.mockResolvedValueOnce({ token: "tok-FRESH" });

		expect(
			await acquireInstructionTreeFromRepository(CONTEXT),
		).toMatchObject({ outcome: "staged" });
		expect(
			m.cloneTreeless.mock.calls[1]?.[0].env.FABRIC_GIT_CREDENTIAL,
		).toBe("tok-FRESH");
		expect(m.markRepoReauthRequired).not.toHaveBeenCalled();
	});

	it("gives up with a non-retryable INTEGRATION_UNAVAILABLE and flags reconnect when the re-exchange cannot help", async () => {
		m.cloneTreeless.mockRejectedValue(
			new GitCommandError(
				"exit",
				128,
				"fatal: Authentication failed",
				"clone",
			),
		);
		m.forceReExchangeRepoCredentials.mockResolvedValue({
			refreshed: false,
		});
		const error = failureOf(
			await acquireInstructionTreeFromRepository(CONTEXT).catch((e) => e),
		);
		expect(error.type).toBe("INTEGRATION_UNAVAILABLE");
		expect(error.nonRetryable).toBe(true);
		expect(m.markRepoReauthRequired).toHaveBeenCalledWith(
			expect.objectContaining({ integrationId: "int_1" }),
		);
	});

	it.each([
		"https://github.com/example-org/instructions.git?access_token=tok",
		"https://dev.azure.com/org/proj/_git/repo#tok",
		`https://user:tok@${"gitlab.com"}/example-org/instructions.git?private_token=tok`,
	])(
		"fails closed with a non-retryable INTEGRATION_UNAVAILABLE, before any git or token work, for the stored URL %s",
		async (repositoryUrl) => {
			m.getProjectRepoIntegration.mockResolvedValue({
				id: "int_1",
				projectId: "proj_1",
				provider: "GITHUB",
				repositoryUrl,
				status: "ACTIVE",
			});
			const error = failureOf(
				await acquireInstructionTreeFromRepository(CONTEXT).catch(
					(e) => e,
				),
			);
			expect(error.type).toBe("INTEGRATION_UNAVAILABLE");
			expect(error.nonRetryable).toBe(true);
			expect(m.resolveFreshRepoToken).not.toHaveBeenCalled();
			expect(m.cloneTreeless).not.toHaveBeenCalled();
		},
	);

	it("clones an Azure DevOps Clone-button URL with its userinfo stripped", async () => {
		serveRepo([{ path: "CLAUDE.md", body: "x" }]);
		m.getProjectRepoIntegration.mockResolvedValue({
			id: "int_1",
			projectId: "proj_1",
			provider: "AZURE_DEVOPS",
			// Assembled so the literal is not email-shaped for the publication scan.
			repositoryUrl: `https://example-org@${"dev.azure.com"}/example-org/proj/_git/repo`,
			status: "ACTIVE",
		});
		await acquireInstructionTreeFromRepository(CONTEXT);
		expect(m.cloneTreeless).toHaveBeenCalledWith(
			expect.objectContaining({
				url: "https://dev.azure.com/example-org/proj/_git/repo",
			}),
		);
	});

	it("maps a storage failure to STORAGE_FAILED carrying the snapshot id, so the retry adopts", async () => {
		serveRepo([{ path: "CLAUDE.md", body: "x" }]);
		m.uploadFile.mockRejectedValue(
			new Error("503 from https://storage.example.com"),
		);
		const error = failureOf(
			await acquireInstructionTreeFromRepository(CONTEXT).catch((e) => e),
		);
		expect(error.type).toBe("STORAGE_FAILED");
		expect(error.details[0]).toEqual({
			commitSha: SHA,
			snapshotId: "snap_1",
		});
		// The run directory is removed on this failure path too, not only on
		// success: the clone populated it before the upload threw, so this is
		// the case a `finally`-skipping refactor would actually miss.
		expect(existsSync(m.cloneTreeless.mock.calls[0]?.[0].cwd)).toBe(false);
	});

	it("maps the disk watchdog to LIMITS_EXCEEDED", async () => {
		m.cloneTreeless.mockRejectedValue(
			new GitCommandError("disk_limit", null, "", "clone"),
		);
		const error = failureOf(
			await acquireInstructionTreeFromRepository(CONTEXT).catch((e) => e),
		);
		expect(error.type).toBe("LIMITS_EXCEEDED");
	});

	it("never lets the token or the credentialed URL reach a result, a failure, a heartbeat or a log above debug (spec §8.3)", async () => {
		serveRepo([{ path: "CLAUDE.md", body: "x" }]);
		const ok = await acquireInstructionTreeFromRepository(CONTEXT);
		m.cloneTreeless.mockRejectedValue(
			new GitCommandError(
				"exit",
				128,
				`fatal: unable to access 'https://x-access-token:${TOKEN}@github.com/': ${TOKEN}`,
				"clone",
			),
		);
		const failed = await acquireInstructionTreeFromRepository(
			CONTEXT,
		).catch((e) => e);
		const outputs = JSON.stringify([
			ok,
			{ message: (failed as Error).message, ...(failed as object) },
			m.heartbeat.mock.calls,
			m.log.info.mock.calls,
			m.log.warn.mock.calls,
			m.log.error.mock.calls,
			m.recordAudit.mock.calls,
		]);
		expect(outputs).not.toContain(TOKEN);
		expect(outputs).not.toContain("x-access-token:");
	});
});

describe("awaitInstructionSnapshotSettled", () => {
	it("is settled once the child execution is closed, and hands back the child's own result", async () => {
		m.describe
			.mockResolvedValueOnce({ status: { name: "RUNNING" } })
			.mockResolvedValueOnce({ status: { name: "COMPLETED" } });
		m.result.mockResolvedValue({
			status: "READY",
			published: false,
			publishReason: "configuration_changed",
		});
		expect(
			await awaitInstructionSnapshotSettled({
				snapshotId: "snap_1",
				maxWaitMs: 1_000,
				pollMs: 1,
			}),
		).toEqual({
			settled: true,
			childResult: {
				status: "READY",
				published: false,
				publishReason: "configuration_changed",
			},
		});
	});

	it("is settled without a result when the child failed", async () => {
		m.describe.mockResolvedValue({ status: { name: "FAILED" } });
		m.result.mockRejectedValue(new Error("child failed"));
		expect(
			await awaitInstructionSnapshotSettled({
				snapshotId: "snap_1",
				maxWaitMs: 1_000,
				pollMs: 1,
			}),
		).toEqual({
			settled: true,
		});
	});

	it("is pending, never a verdict, when the child is still running at the deadline", async () => {
		m.describe.mockResolvedValue({ status: { name: "RUNNING" } });
		expect(
			await awaitInstructionSnapshotSettled({
				snapshotId: "snap_1",
				maxWaitMs: 20,
				pollMs: 5,
			}),
		).toEqual({
			settled: false,
		});
	});
});

describe("recordInstructionRepositorySyncRun (spec §5.4)", () => {
	const base: RecordSyncRunInput = {
		projectId: "proj_1",
		organizationId: "org_1",
		trigger: "MANUAL",
		context: CONTEXT,
		skipped: false,
		unchanged: false,
		snapshotId: "snap_1",
		commitSha: SHA,
		error: null,
		childResult: { status: "READY", published: true },
	};
	const summary = (overrides: Record<string, unknown> = {}) => ({
		id: "snap_1",
		status: "READY",
		publishedAt: new Date(),
		rejection: null,
		sourceCommitSha: SHA,
		...overrides,
	});

	it("writes nothing without a context or a run id (a history from before the run id was passed)", async () => {
		expect(
			await recordInstructionRepositorySyncRun({
				...base,
				context: null,
			}),
		).toEqual({
			recorded: false,
			status: null,
		});
		expect(m.getInstructionRepositorySyncForRun).not.toHaveBeenCalled();
		expect(m.completeInstructionRepositorySyncRun).not.toHaveBeenCalled();
	});

	// Finding 2: `begin` inserts the receipt first, then can still throw (a
	// permission read that exhausts its retries) or be cancelled. The
	// workflow then records with a null context, and `record` must find and
	// complete the receipt by the run key it rebuilds from the run id.
	describe("without a context, by the rebuilt run key", () => {
		const syncRow = {
			id: "sync_1",
			projectId: "proj_1",
			organizationId: "org_1",
			userId: "delegate_1",
			repositoryIntegrationId: "int_1",
			ref: "main",
			rootPath: "agents",
			automatic: true,
			generation: 3,
			automaticPausedReason: null,
			repositoryIntegration: {
				id: "int_1",
				projectId: "proj_1",
				status: "ACTIVE",
			},
		};
		const orphan: RecordSyncRunInput = {
			...base,
			workflowRunId: "run_a",
			context: null,
			snapshotId: null,
			commitSha: null,
			childResult: null,
		};

		beforeEach(() => {
			m.getInstructionRepositorySyncForRun.mockResolvedValue(syncRow);
			m.insertInstructionRepositorySyncRun.mockResolvedValue({
				inserted: true,
				generation: 3,
			});
		});

		it("completes as FAILED the receipt a begin inserted before its permission read threw", async () => {
			m.canCreateProjectInstructions.mockRejectedValue(
				new Error("connection terminated"),
			);
			await expect(
				beginInstructionRepositorySyncRun({
					projectId: "proj_1",
					organizationId: "org_1",
					trigger: "MANUAL",
					requesterUserId: "user_1",
					workflowRunId: "run_a",
				}),
			).rejects.toThrow("connection terminated");
			expect(m.insertInstructionRepositorySyncRun).toHaveBeenCalledWith(
				expect.objectContaining({ id: "sync_1:run_a" }),
			);
			// The receipt as begin inserted it, possibly under an older
			// generation than the configuration's current one.
			m.getInstructionRepositorySyncForRun.mockResolvedValue({
				...syncRow,
				generation: 4,
			});
			m.getInstructionRepositorySyncRunReceipt.mockResolvedValue({
				syncId: "sync_1",
				userId: "user_1",
				generation: 3,
				trigger: "MANUAL",
				finishedAt: null,
			});

			expect(await recordInstructionRepositorySyncRun(orphan)).toEqual({
				recorded: true,
				status: "FAILED",
			});

			expect(
				m.getInstructionRepositorySyncForRun,
			).toHaveBeenLastCalledWith("proj_1");
			expect(
				m.getInstructionRepositorySyncRunReceipt,
			).toHaveBeenCalledWith("sync_1:run_a", "proj_1", "org_1");
			expect(m.completeInstructionRepositorySyncRun).toHaveBeenCalledWith(
				expect.objectContaining({
					runKey: "sync_1:run_a",
					syncId: "sync_1",
					generation: 3,
					projectId: "proj_1",
					organizationId: "org_1",
					userId: "user_1",
					trigger: "MANUAL",
					status: "FAILED",
					error: "CLONE_FAILED",
					commitSha: null,
					snapshotId: null,
					// A manual run never backs the schedule off (Fizzy #2706).
					scheduling: { kind: "none" },
				}),
			);
			// No snapshot can exist without a context: Part A never runs.
			expect(
				m.getInstructionSnapshotWithPublishedPointer,
			).not.toHaveBeenCalled();
		});

		it("is a no-op, and does not throw, when begin failed before inserting the receipt", async () => {
			m.getInstructionRepositorySyncRunReceipt.mockResolvedValue(null);
			expect(await recordInstructionRepositorySyncRun(orphan)).toEqual({
				recorded: false,
				status: null,
			});
			expect(
				m.getInstructionRepositorySyncRunReceipt,
			).toHaveBeenCalledWith("sync_1:run_a", "proj_1", "org_1");
			expect(
				m.completeInstructionRepositorySyncRun,
			).not.toHaveBeenCalled();
		});

		it("leaves an already finished receipt alone", async () => {
			m.getInstructionRepositorySyncRunReceipt.mockResolvedValue({
				syncId: "sync_1",
				userId: "user_1",
				generation: 3,
				trigger: "MANUAL",
				finishedAt: new Date(),
			});
			expect(await recordInstructionRepositorySyncRun(orphan)).toEqual({
				recorded: false,
				status: null,
			});
			expect(
				m.completeInstructionRepositorySyncRun,
			).not.toHaveBeenCalled();
		});

		it.each([
			["no configuration row (NOT_CONFIGURED)", null],
			[
				"a configuration row of another organization",
				{ ...syncRow, organizationId: "org_other" },
			],
		])("reads no receipt for %s", async (_label, row) => {
			m.getInstructionRepositorySyncForRun.mockResolvedValue(row);
			expect(
				await recordInstructionRepositorySyncRun({
					...orphan,
					error: "NOT_CONFIGURED",
				}),
			).toEqual({ recorded: false, status: null });
			expect(
				m.getInstructionRepositorySyncRunReceipt,
			).not.toHaveBeenCalled();
			expect(
				m.completeInstructionRepositorySyncRun,
			).not.toHaveBeenCalled();
		});
	});

	it("completes the run from durable state: this snapshot holds the pointer", async () => {
		m.getInstructionSnapshotWithPublishedPointer.mockResolvedValue({
			snapshot: summary(),
			publishedPointer: { id: "snap_1" },
		});
		expect(await recordInstructionRepositorySyncRun(base)).toEqual({
			recorded: true,
			status: "SUCCEEDED",
		});
		expect(m.completeInstructionRepositorySyncRun).toHaveBeenCalledWith(
			expect.objectContaining({
				runKey: "sync_1:run_a",
				syncId: "sync_1",
				generation: 3,
				userId: "user_1",
				status: "SUCCEEDED",
				commitSha: SHA,
				snapshotId: "snap_1",
				scheduling: { kind: "success", commitSha: SHA },
			}),
		);
	});

	it("Part A abandons a RECEIVING row whose child never started, sweeps its staging, and keeps the acquisition's error", async () => {
		m.getInstructionSnapshotWithPublishedPointer
			.mockResolvedValueOnce({
				snapshot: summary({ status: "RECEIVING", publishedAt: null }),
				publishedPointer: null,
			})
			.mockResolvedValueOnce({
				snapshot: summary({
					status: "REJECTED",
					publishedAt: null,
					rejection: [{ path: "(upload)", reason: "abandoned" }],
				}),
				publishedPointer: null,
			});
		m.rejectAbandonedInstructionSnapshot.mockResolvedValue({
			changed: true,
		});

		expect(
			await recordInstructionRepositorySyncRun({
				...base,
				error: "STORAGE_FAILED",
				childResult: null,
			}),
		).toEqual({ recorded: true, status: "FAILED" });
		expect(m.rejectAbandonedInstructionSnapshot).toHaveBeenCalledWith({
			snapshotId: "snap_1",
			projectId: "proj_1",
			organizationId: "org_1",
			source: "repository_sync",
		});
		expect(m.listObjects).toHaveBeenCalled();
		expect(m.markAbandonedInstructionSnapshotSwept).toHaveBeenCalled();
		expect(m.completeInstructionRepositorySyncRun).toHaveBeenCalledWith(
			expect.objectContaining({
				status: "FAILED",
				error: "STORAGE_FAILED",
				// A manual run never backs the schedule off (Fizzy #2706).
				scheduling: { kind: "none" },
			}),
		);
	});

	it("finds the row by run key when the acquisition timed out after creating it (Review Focus 4)", async () => {
		m.getInstructionSnapshotBySyncRunKey.mockResolvedValue({
			id: "snap_lost",
			status: "RECEIVING",
			sourceCommitSha: SHA,
		});
		m.getInstructionSnapshotWithPublishedPointer.mockResolvedValue({
			snapshot: summary({
				id: "snap_lost",
				status: "RECEIVING",
				publishedAt: null,
			}),
			publishedPointer: null,
		});
		m.rejectAbandonedInstructionSnapshot.mockResolvedValue({
			changed: true,
		});

		await recordInstructionRepositorySyncRun({
			...base,
			snapshotId: null,
			commitSha: null,
			error: "CLONE_FAILED",
			childResult: null,
		});

		expect(m.getInstructionSnapshotBySyncRunKey).toHaveBeenCalledWith(
			"sync_1:run_a",
			"proj_1",
			"org_1",
		);
		expect(m.rejectAbandonedInstructionSnapshot).toHaveBeenCalledWith(
			expect.objectContaining({ snapshotId: "snap_lost" }),
		);
		expect(m.completeInstructionRepositorySyncRun).toHaveBeenCalledWith(
			expect.objectContaining({
				snapshotId: "snap_lost",
				commitSha: SHA,
			}),
		);
	});

	it("leaves a RECEIVING row alone while its child is still running", async () => {
		m.getInstructionSnapshotWithPublishedPointer.mockResolvedValue({
			snapshot: summary({ status: "RECEIVING", publishedAt: null }),
			publishedPointer: null,
		});
		m.describe.mockResolvedValue({ status: { name: "RUNNING" } });
		await recordInstructionRepositorySyncRun({
			...base,
			childResult: null,
		});
		expect(m.rejectAbandonedInstructionSnapshot).not.toHaveBeenCalled();
	});

	it("runs Part A even when the configuration moved on: the snapshot belongs to the run", async () => {
		m.getInstructionSnapshotWithPublishedPointer.mockResolvedValue({
			snapshot: summary({ status: "RECEIVING", publishedAt: null }),
			publishedPointer: null,
		});
		m.rejectAbandonedInstructionSnapshot.mockResolvedValue({
			changed: true,
		});
		m.completeInstructionRepositorySyncRun.mockResolvedValue({
			completed: true,
			configurationCurrent: false,
		});
		await recordInstructionRepositorySyncRun({
			...base,
			childResult: null,
		});
		expect(m.rejectAbandonedInstructionSnapshot).toHaveBeenCalled();
	});

	it("reports recorded: false when an earlier delivery already completed the run", async () => {
		m.getInstructionSnapshotWithPublishedPointer.mockResolvedValue({
			snapshot: summary(),
			publishedPointer: { id: "snap_1" },
		});
		m.completeInstructionRepositorySyncRun.mockResolvedValue({
			completed: false,
			configurationCurrent: false,
		});
		expect(await recordInstructionRepositorySyncRun(base)).toEqual({
			recorded: false,
			status: "SUCCEEDED",
		});
	});
});
