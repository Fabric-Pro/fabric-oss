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

// The error `createInstructionSnapshot` throws when an inherited source is
// refused; the real class lives in `@repo/database`, which is mocked here.
const databaseErrors = vi.hoisted(() => ({
	InstructionInheritedSourceError: class InstructionInheritedSourceError extends Error {},
}));

const m = vi.hoisted(() => ({
	getInstructionRepositorySyncForRun: vi.fn(),
	clearInstructionSyncPause: vi.fn(),
	listUnfinishedInstructionRepositorySyncRunReceipts: vi.fn(),
	insertInstructionRepositorySyncRun: vi.fn(),
	canCreateProjectInstructions: vi.fn(),
	getInstructionSnapshotBySyncRunKey: vi.fn(),
	getProjectRepoIntegration: vi.fn(),
	getPublishedInstructionTree: vi.fn(),
	getProjectInstructionSettings: vi.fn(),
	createInstructionSnapshot: vi.fn(),
	claimInstructionFileStagingKeys: vi.fn(),
	recordInstructionSyncRunProgress: vi.fn(),
	recordAudit: vi.fn(),
	getInstructionSnapshotWithPublishedPointer: vi.fn(),
	rejectAbandonedInstructionSnapshot: vi.fn(),
	markAbandonedInstructionSnapshotSwept: vi.fn(),
	rotateAbandonedInstructionSnapshot: vi.fn(),
	completeInstructionRepositorySyncRun: vi.fn(),
	settleInstructionMigrationAfterSync: vi.fn(),
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
	activityContext: vi.fn(),
	cloneTreeless: vi.fn(),
	fetchPinnedCommit: vi.fn(),
	revParseHead: vi.fn(),
	revParseRootTree: vi.fn(),
	readRepositoryBlobSizes: vi.fn(),
	listTree: vi.fn(),
	readBlobCapped: vi.fn(),
	sparseCheckout: vi.fn(),
	log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@repo/database", async () => {
	const { instructionRepositoryImportAllowed } = await vi.importActual<
		typeof import("@repo/database/prisma/queries/instruction-migration-pointer")
	>("@repo/database/prisma/queries/instruction-migration-pointer");
	return {
		InstructionInheritedSourceError:
			databaseErrors.InstructionInheritedSourceError,
		getInstructionRepositorySyncForRun:
			m.getInstructionRepositorySyncForRun,
		clearInstructionSyncPause: m.clearInstructionSyncPause,
		listUnfinishedInstructionRepositorySyncRunReceipts:
			m.listUnfinishedInstructionRepositorySyncRunReceipts,
		insertInstructionRepositorySyncRun:
			m.insertInstructionRepositorySyncRun,
		canCreateProjectInstructions: m.canCreateProjectInstructions,
		getInstructionSnapshotBySyncRunKey:
			m.getInstructionSnapshotBySyncRunKey,
		getProjectRepoIntegration: m.getProjectRepoIntegration,
		getPublishedInstructionTree: m.getPublishedInstructionTree,
		getProjectInstructionSettings: m.getProjectInstructionSettings,
		createInstructionSnapshot: m.createInstructionSnapshot,
		claimInstructionFileStagingKeys: m.claimInstructionFileStagingKeys,
		recordInstructionSyncRunProgress: m.recordInstructionSyncRunProgress,
		recordAudit: m.recordAudit,
		getInstructionSnapshotWithPublishedPointer:
			m.getInstructionSnapshotWithPublishedPointer,
		rejectAbandonedInstructionSnapshot:
			m.rejectAbandonedInstructionSnapshot,
		markAbandonedInstructionSnapshotSwept:
			m.markAbandonedInstructionSnapshotSwept,
		rotateAbandonedInstructionSnapshot:
			m.rotateAbandonedInstructionSnapshot,
		completeInstructionRepositorySyncRun:
			m.completeInstructionRepositorySyncRun,
		deleteInstructionSnapshot: m.deleteInstructionSnapshot,
		listPrunableInstructionSnapshots: m.listPrunableInstructionSnapshots,
		settleInstructionMigrationAfterSync:
			m.settleInstructionMigrationAfterSync,
		instructionRepositoryImportAllowed,
	};
});
vi.mock("@repo/connectors", () => ({
	readRepositoryBlobSizes: m.readRepositoryBlobSizes,
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
		current: () => m.activityContext(),
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
			revParseRootTree: m.revParseRootTree,
			listTree: m.listTree,
			readBlobCapped: m.readBlobCapped,
			sparseCheckout: m.sparseCheckout,
		};
	},
);

import {
	GitCommandError,
	MAX_CLONE_BYTES,
	MAX_INVENTORY_ENTRIES,
} from "../src/activities/lib/instruction-sync-git";
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

const SWITCHING_SETTINGS = {
	ignoreGlobs: null,
	sourceOfTruth: "REPOSITORY",
	migration: {
		v: 1,
		state: "SWITCHING",
		branchId: "branch_1",
		snapshotId: "snap_move",
		syncId: "sync_1",
		pullRequestUrl: null,
		startedAt: "2026-10-03T10:00:00.000Z",
		userId: "user_1",
	},
} as const;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** A published snapshot this sync (integration `int_1`, branch `main`) published. */
const PUBLISHED_HERE = {
	source: "REPOSITORY",
	repositoryIntegrationId: "int_1",
	sourceRef: "main",
} as const;

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
	m.readRepositoryBlobSizes.mockResolvedValue({ ok: false });
	m.revParseRootTree.mockResolvedValue("t".repeat(40));
	m.getPublishedInstructionTree.mockResolvedValue(null);
	m.getProjectInstructionSettings.mockResolvedValue(SWITCHING_SETTINGS);
	m.createInstructionSnapshot.mockImplementation(
		async ({
			files,
			validationAttemptId,
		}: {
			files: Array<{ path: string; storageKey: string }>;
			validationAttemptId?: string;
		}) => ({
			id: "snap_1",
			version: 4,
			validationAttemptId: validationAttemptId ?? null,
			files: files.map((f, i) => ({
				id: `file_${i}`,
				path: f.path,
				storageKey: f.storageKey,
			})),
		}),
	);
	m.recordInstructionSyncRunProgress.mockResolvedValue({ changed: true });
	m.claimInstructionFileStagingKeys.mockImplementation(
		async ({ claims }: { claims: readonly unknown[] }) => ({
			moved: claims.length,
		}),
	);
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
	// No other receipt for the workflow run unless a test says so.
	m.listUnfinishedInstructionRepositorySyncRunReceipts.mockResolvedValue([]);
	m.describe.mockRejectedValue(
		Object.assign(new Error("not found"), {
			name: "WorkflowNotFoundError",
		}),
	);
	m.activityContext.mockImplementation(() => {
		throw new Error("not in an activity");
	});
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

	it("refuses a direct repository before creating a receipt or touching its provider", async () => {
		m.getProjectInstructionSettings.mockResolvedValue({
			ignoreGlobs: null,
			sourceOfTruth: "REPOSITORY",
			migration: null,
		});

		expect(await beginInstructionRepositorySyncRun(input)).toEqual({
			ok: false,
			error: "CONFIGURATION_CHANGED",
		});
		// A lookup permits an already-admitted legacy run to recover. This
		// new direct-repository run has none, so it cannot allocate work.
		expect(m.getInstructionSnapshotBySyncRunKey).toHaveBeenCalledWith(
			"sync_1:run_a",
			"proj_1",
			"org_1",
		);
		expect(m.insertInstructionRepositorySyncRun).not.toHaveBeenCalled();
		expect(m.resolveFreshRepoToken).not.toHaveBeenCalled();
		expect(m.createInstructionSnapshot).not.toHaveBeenCalled();
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

	describe("a merge-triggered run (Fizzy #2563 spec §9)", () => {
		const merged = {
			...input,
			trigger: "PULL_REQUEST_MERGED" as const,
			requesterUserId: undefined,
		};

		it("runs with automatic sync off: the toggle does not apply", async () => {
			m.getInstructionRepositorySyncForRun.mockResolvedValue({
				...row,
				automatic: false,
			});
			expect(
				await beginInstructionRepositorySyncRun(merged),
			).toMatchObject({
				ok: true,
				context: {
					actingUserId: "delegate_1",
					trigger: "PULL_REQUEST_MERGED",
				},
			});
			expect(m.canCreateProjectInstructions).toHaveBeenCalledWith(
				"proj_1",
				"delegate_1",
			);
		});

		it("is skipped while the sync is paused", async () => {
			m.getInstructionRepositorySyncForRun.mockResolvedValue({
				...row,
				automatic: false,
				automaticPausedReason: "PERMISSION_REVOKED",
			});
			expect(
				await beginInstructionRepositorySyncRun(merged),
			).toMatchObject({
				ok: false,
				skipped: "paused",
				context: { trigger: "PULL_REQUEST_MERGED" },
			});
			expect(m.canCreateProjectInstructions).not.toHaveBeenCalled();
		});
	});

	describe("a commit-triggered run (Fizzy #2878 §10)", () => {
		const pushed = {
			...input,
			trigger: "COMMIT_PUSHED" as const,
			requesterUserId: undefined,
		};

		it("runs with automatic sync off: the toggle does not apply", async () => {
			m.getInstructionRepositorySyncForRun.mockResolvedValue({
				...row,
				automatic: false,
			});

			expect(
				await beginInstructionRepositorySyncRun(pushed),
			).toMatchObject({
				ok: true,
				context: {
					actingUserId: "delegate_1",
					trigger: "COMMIT_PUSHED",
				},
			});
			expect(m.canCreateProjectInstructions).toHaveBeenCalledWith(
				"proj_1",
				"delegate_1",
			);
		});

		describe("a pause the push itself proved is over", () => {
			beforeEach(() => {
				m.clearInstructionSyncPause.mockResolvedValue(true);
			});

			it.each(["REF_MISSING", "PERMISSION_REVOKED"] as const)(
				"clears a %s pause and runs: the commit reached the branch with the integration's credential",
				async (reason) => {
					m.getInstructionRepositorySyncForRun.mockResolvedValue({
						...row,
						automaticPausedReason: reason,
					});

					const result = await beginInstructionRepositorySyncRun({
						...pushed,
						expected: { syncId: "sync_1", generation: 3 },
					});

					expect(result).toMatchObject({
						ok: true,
						context: { trigger: "COMMIT_PUSHED" },
					});
					expect(m.clearInstructionSyncPause).toHaveBeenCalledWith({
						syncId: "sync_1",
						organizationId: "org_1",
						generation: 3,
						reason,
					});
				},
			);

			it("clears the pause even with automatic sync off: the toggle does not apply to a commit's own run", async () => {
				m.getInstructionRepositorySyncForRun.mockResolvedValue({
					...row,
					automatic: false,
					automaticPausedReason: "REF_MISSING",
				});

				expect(
					await beginInstructionRepositorySyncRun(pushed),
				).toMatchObject({ ok: true });
			});

			it("keeps a PERMISSION_REVOKED pause while the delegate still cannot write: the push proves the credential, not the delegate", async () => {
				m.getInstructionRepositorySyncForRun.mockResolvedValue({
					...row,
					automaticPausedReason: "PERMISSION_REVOKED",
				});
				m.canCreateProjectInstructions.mockResolvedValue(false);

				expect(
					await beginInstructionRepositorySyncRun(pushed),
				).toMatchObject({
					ok: false,
					skipped: "paused",
					context: { trigger: "COMMIT_PUSHED" },
				});
				expect(m.clearInstructionSyncPause).not.toHaveBeenCalled();
			});

			it("is skipped when the pause was lifted or replaced between the read and the write", async () => {
				m.getInstructionRepositorySyncForRun.mockResolvedValue({
					...row,
					automaticPausedReason: "REF_MISSING",
				});
				m.clearInstructionSyncPause.mockResolvedValue(false);

				expect(
					await beginInstructionRepositorySyncRun(pushed),
				).toMatchObject({ ok: false, skipped: "paused" });
			});

			it("never clears a pause for a row the commit was not made against", async () => {
				m.getInstructionRepositorySyncForRun.mockResolvedValue({
					...row,
					automaticPausedReason: "REF_MISSING",
				});

				expect(
					await beginInstructionRepositorySyncRun({
						...pushed,
						expected: { syncId: "sync_1", generation: 2 },
					}),
				).toMatchObject({ ok: false, skipped: "paused" });
				expect(m.clearInstructionSyncPause).not.toHaveBeenCalled();
			});

			it("is a pause only a COMMIT_PUSHED run lifts: a merged proposal's run still waits for a member", async () => {
				m.getInstructionRepositorySyncForRun.mockResolvedValue({
					...row,
					automaticPausedReason: "REF_MISSING",
				});

				expect(
					await beginInstructionRepositorySyncRun({
						...pushed,
						trigger: "PULL_REQUEST_MERGED",
					}),
				).toMatchObject({ ok: false, skipped: "paused" });
				expect(m.clearInstructionSyncPause).not.toHaveBeenCalled();
			});
		});
	});

	describe("while the project is being moved from uploads into this repository (Fizzy #2878 §9)", () => {
		it.each([
			["MANUAL", input],
			[
				"POLL",
				{
					...input,
					trigger: "POLL" as const,
					requesterUserId: undefined,
				},
			],
			[
				"WEBHOOK",
				{
					...input,
					trigger: "WEBHOOK" as const,
					requesterUserId: undefined,
				},
			],
			[
				"PULL_REQUEST_MERGED",
				{
					...input,
					trigger: "PULL_REQUEST_MERGED" as const,
					requesterUserId: undefined,
				},
			],
			[
				"COMMIT_PUSHED",
				{
					...input,
					trigger: "COMMIT_PUSHED" as const,
					requesterUserId: undefined,
				},
			],
		])(
			"skips a %s run as paused: the folder holds nothing yet, and publishing from it would replace the uploads with an empty tree",
			async (_trigger, started) => {
				m.getInstructionRepositorySyncForRun.mockResolvedValue({
					...row,
					automatic: true,
					automaticPausedReason: "MIGRATING",
				});

				const result = await beginInstructionRepositorySyncRun(started);

				expect(result).toMatchObject({ ok: false, skipped: "paused" });
				expect(m.canCreateProjectInstructions).not.toHaveBeenCalled();
				expect(
					m.clearInstructionSyncPause,
					"a pushed commit never lifts the move's own pause",
				).not.toHaveBeenCalled();
				expect(
					m.insertInstructionRepositorySyncRun,
					"the receipt still goes in first, so the tab can show the skip",
				).toHaveBeenCalledTimes(1);
			},
		);

		it("runs again once the move cleared the pause", async () => {
			m.getInstructionRepositorySyncForRun.mockResolvedValue({
				...row,
				automatic: true,
				automaticPausedReason: null,
			});

			expect(
				await beginInstructionRepositorySyncRun(input),
			).toMatchObject({
				ok: true,
			});
		});
	});

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
			validationAttemptId: expect.any(String),
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
			validationAttemptId: expect.any(String),
			publishOnReady: true,
			promotedKeyFor: expect.any(Function),
			excludedCount: 0,
			excludedPaths: [],
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
		expect(m.claimInstructionFileStagingKeys).toHaveBeenCalledWith({
			snapshotId: "snap_1",
			projectId: "proj_1",
			organizationId: "org_1",
			claims: [
				{
					fileId: "file_0",
					from: stagingKey("proj_1", "pending", "0"),
					to: stagingKey("proj_1", "snap_1", "file_0"),
				},
				{
					fileId: "file_1",
					from: stagingKey("proj_1", "pending", "1"),
					to: stagingKey("proj_1", "snap_1", "file_1"),
				},
			],
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
			...PUBLISHED_HERE,
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
			...PUBLISHED_HERE,
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
			...PUBLISHED_HERE,
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
			...PUBLISHED_HERE,
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

	/**
	 * A sync that changed one file of N stages one file. The unchanged ones
	 * are INHERITED from the published version: same bytes, so the new
	 * snapshot's rows point at the published promoted objects and nothing is
	 * uploaded or re-downloaded for them.
	 */
	describe("a changed tree inherits what did not change", () => {
		const publishedRow = (
			id: string,
			filePath: string,
			body: string,
			mode: number | null = null,
		) => ({
			id,
			path: filePath,
			sha256: sha256(body),
			mode,
			size: Buffer.byteLength(body),
			mimeType: "text/markdown",
			isText: true,
			storageKey: `projects/proj_1/instructions/snapshots/snap_0/${id}`,
		});

		function publish(
			files: ReturnType<typeof publishedRow>[],
			overrides: Record<string, unknown> = {},
		) {
			m.getPublishedInstructionTree.mockResolvedValue({
				snapshotId: "snap_0",
				...PUBLISHED_HERE,
				sourceCommitSha: OLD_SHA,
				settingsFrozen: { syncId: "sync_1", syncGeneration: 3 },
				files,
				...overrides,
			});
		}

		const unchangedFiles = Array.from({ length: 6 }, (_, i) => ({
			path: `rules/r${i}.md`,
			body: `# rule ${i}`,
		}));

		it("uploads exactly one object to staging when one of seven files changed, and the snapshot still holds all seven", async () => {
			serveRepo([
				...unchangedFiles,
				{ path: "CLAUDE.md", body: "# edited" },
			]);
			publish([
				...unchangedFiles.map((f, i) =>
					publishedRow(`pub_${i}`, f.path, f.body),
				),
				publishedRow("pub_claude", "CLAUDE.md", "# before"),
			]);

			const result = await acquireInstructionTreeFromRepository(CONTEXT);

			expect(result.outcome).toBe("staged");
			expect(m.uploadFile).toHaveBeenCalledTimes(1);
			expect(m.uploadFile).toHaveBeenCalledWith(
				expect.stringContaining("/instructions/staging/snap_1/"),
				Buffer.from("# edited"),
				expect.objectContaining({ bucket: "skills" }),
			);
			const created = m.createInstructionSnapshot.mock.calls[0]?.[0] as {
				files: Array<{
					path: string;
					storageKey: string;
					inheritedFromFileId?: string;
					sha256: string;
				}>;
			};
			expect(created.files).toHaveLength(7);
			const inherited = created.files.filter(
				(f) => f.inheritedFromFileId,
			);
			expect(inherited).toHaveLength(6);
			for (const f of inherited) {
				expect(f.storageKey).toBe(
					`projects/proj_1/instructions/snapshots/snap_0/${f.inheritedFromFileId}`,
				);
			}
			expect(
				created.files.find((f) => f.path === "CLAUDE.md")
					?.inheritedFromFileId,
			).toBeUndefined();
		});

		it("publishes the real tree after a direct commit landed on a tip that moved past its base, staging both the commit's file and the teammate's", async () => {
			// The commit changed rules/r0.md; a teammate changed rules/r1.md
			// before it. The published version still names the base commit, so
			// the run must read the tree instead of answering "unchanged".
			serveRepo(
				[
					{ path: "rules/r0.md", body: "# rule 0 from the commit" },
					{ path: "rules/r1.md", body: "# rule 1 from a teammate" },
					...unchangedFiles.slice(2),
				],
				{ head: SHA },
			);
			publish(
				unchangedFiles.map((f, i) =>
					publishedRow(`pub_${i}`, f.path, f.body),
				),
			);

			const result = await acquireInstructionTreeFromRepository({
				...CONTEXT,
				trigger: "COMMIT_PUSHED",
			});

			expect(result).toMatchObject({ outcome: "staged", commitSha: SHA });
			const created = m.createInstructionSnapshot.mock.calls[0]?.[0] as {
				sourceCommitSha: string;
				files: Array<{ path: string; inheritedFromFileId?: string }>;
			};
			expect(created.sourceCommitSha).toBe(SHA);
			expect(
				created.files
					.filter((f) => f.inheritedFromFileId === undefined)
					.map((f) => f.path)
					.sort(),
			).toEqual(["rules/r0.md", "rules/r1.md"]);
			expect(m.uploadFile).toHaveBeenCalledTimes(2);
		});

		it("never sets a base on a sync snapshot: the tab reads that as 'edited from vN'", async () => {
			serveRepo([
				...unchangedFiles,
				{ path: "CLAUDE.md", body: "# new" },
			]);
			publish(
				unchangedFiles.map((f, i) =>
					publishedRow(`pub_${i}`, f.path, f.body),
				),
			);

			await acquireInstructionTreeFromRepository(CONTEXT);

			const created = m.createInstructionSnapshot.mock.calls[0]?.[0];
			expect(created).not.toHaveProperty("baseSnapshotId");
			expect(created).not.toHaveProperty("baseVersion");
		});

		it("stages a file whose bytes match but whose mode changed", async () => {
			serveRepo([
				{ path: "run.sh", body: "#!/bin/sh\n", mode: "100755" },
				{ path: "CLAUDE.md", body: "# edited" },
			]);
			publish([
				publishedRow("pub_run", "run.sh", "#!/bin/sh\n", 0o644),
				publishedRow("pub_claude", "CLAUDE.md", "# before"),
			]);

			await acquireInstructionTreeFromRepository(CONTEXT);

			expect(m.uploadFile).toHaveBeenCalledTimes(2);
		});

		it("inherits nothing from a published version another source produced", async () => {
			serveRepo([
				...unchangedFiles,
				{ path: "CLAUDE.md", body: "# new" },
			]);
			publish(
				unchangedFiles.map((f, i) =>
					publishedRow(`pub_${i}`, f.path, f.body),
				),
				{ sourceRef: "release" },
			);

			await acquireInstructionTreeFromRepository(CONTEXT);

			expect(m.uploadFile).toHaveBeenCalledTimes(7);
			const created = m.createInstructionSnapshot.mock.calls[0]?.[0] as {
				files: Array<{ inheritedFromFileId?: string }>;
			};
			expect(created.files.some((f) => f.inheritedFromFileId)).toBe(
				false,
			);
		});

		it("stages the whole tree instead when the database refuses an inherited source", async () => {
			serveRepo([
				{ path: "rules/a.md", body: "# a" },
				{ path: "CLAUDE.md", body: "# edited" },
			]);
			publish([
				publishedRow("pub_a", "rules/a.md", "# a"),
				publishedRow("pub_claude", "CLAUDE.md", "# before"),
			]);
			const real = m.createInstructionSnapshot.getMockImplementation();
			m.createInstructionSnapshot.mockRejectedValueOnce(
				new databaseErrors.InstructionInheritedSourceError(),
			);
			m.createInstructionSnapshot.mockImplementation(
				real as NonNullable<typeof real>,
			);

			const result = await acquireInstructionTreeFromRepository(CONTEXT);

			expect(result.outcome).toBe("staged");
			expect(m.createInstructionSnapshot).toHaveBeenCalledTimes(2);
			expect(m.uploadFile).toHaveBeenCalledTimes(2);
		});

		it("an adopted retry stages only the rows that are not inherited", async () => {
			serveRepo([
				{ path: "rules/a.md", body: "# a" },
				{ path: "CLAUDE.md", body: "# edited" },
			]);
			m.revParseHead.mockResolvedValue(OLD_SHA);
			m.getInstructionSnapshotBySyncRunKey.mockResolvedValue({
				id: "snap_9",
				version: 9,
				status: "RECEIVING",
				sourceCommitSha: OLD_SHA,
				files: [
					{
						id: "file_a",
						path: "rules/a.md",
						sha256: sha256("# a"),
						mode: 0o644,
						size: 3,
						storageKey:
							"projects/proj_1/instructions/snapshots/snap_0/pub_a",
						mimeType: "text/markdown",
						inheritedFromFileId: "pub_a",
					},
					{
						id: "file_c",
						path: "CLAUDE.md",
						sha256: sha256("# edited"),
						mode: 0o644,
						size: 8,
						storageKey: stagingKey("proj_1", "snap_9", "file_c"),
						mimeType: "text/markdown",
						inheritedFromFileId: null,
					},
				],
			});

			await acquireInstructionTreeFromRepository(CONTEXT);

			expect(m.uploadFile).toHaveBeenCalledTimes(1);
			expect(m.uploadFile).toHaveBeenCalledWith(
				stagingKey("proj_1", "snap_9", "file_c"),
				Buffer.from("# edited"),
				expect.anything(),
			);
		});
	});

	/**
	 * Fizzy #2708 review: identical bytes are "unchanged" only when the
	 * published snapshot came from THIS sync's integration and branch;
	 * otherwise its provenance is stale (`current: false`, or not
	 * repository-built at all) and a new snapshot must carry the new one.
	 */
	describe("the same bytes from a different source", () => {
		const SAME = [
			{ path: "CLAUDE.md", sha256: sha256("same"), mode: null },
		];

		it.each([
			["the branch changed", { ...PUBLISHED_HERE, sourceRef: "release" }],
			[
				"the integration changed",
				{ ...PUBLISHED_HERE, repositoryIntegrationId: "int_0" },
			],
			[
				"the published snapshot was an upload",
				{
					source: "UPLOAD",
					repositoryIntegrationId: null,
					sourceRef: null,
				},
			],
		])("stages a new snapshot when %s", async (_label, provenance) => {
			serveRepo([{ path: "CLAUDE.md", body: "same" }]);
			m.getPublishedInstructionTree.mockResolvedValue({
				snapshotId: "snap_0",
				...provenance,
				sourceCommitSha: OLD_SHA,
				settingsFrozen: { syncId: "sync_1", syncGeneration: 3 },
				files: SAME,
			});

			expect(
				await acquireInstructionTreeFromRepository(CONTEXT),
			).toMatchObject({ outcome: "staged" });
			expect(m.createInstructionSnapshot).toHaveBeenCalledWith(
				expect.objectContaining({
					source: "REPOSITORY",
					repositoryIntegrationId: "int_1",
					sourceRef: "main",
					sourceCommitSha: SHA,
				}),
			);
		});

		it("stages a new snapshot for the same commit when the branch changed", async () => {
			serveRepo([{ path: "CLAUDE.md", body: "same" }]);
			m.getPublishedInstructionTree.mockResolvedValue({
				snapshotId: "snap_0",
				...PUBLISHED_HERE,
				sourceRef: "release",
				sourceCommitSha: SHA,
				settingsFrozen: { syncId: "sync_1", syncGeneration: 3 },
				files: SAME,
			});

			expect(
				await acquireInstructionTreeFromRepository(CONTEXT),
			).toMatchObject({ outcome: "staged" });
		});

		it("stays unchanged with the same integration and branch", async () => {
			serveRepo([{ path: "CLAUDE.md", body: "same" }]);
			m.getPublishedInstructionTree.mockResolvedValue({
				snapshotId: "snap_0",
				...PUBLISHED_HERE,
				sourceCommitSha: OLD_SHA,
				settingsFrozen: { syncId: "sync_1", syncGeneration: 3 },
				files: SAME,
			});

			expect(await acquireInstructionTreeFromRepository(CONTEXT)).toEqual(
				{
					outcome: "unchanged",
					commitSha: SHA,
				},
			);
			expect(m.createInstructionSnapshot).not.toHaveBeenCalled();
		});
	});

	it("stages a mode-only change, which the digest cannot see", async () => {
		serveRepo([{ path: "run.sh", body: "#!/bin/sh\n", mode: "100755" }]);
		m.getPublishedInstructionTree.mockResolvedValue({
			snapshotId: "snap_0",
			...PUBLISHED_HERE,
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
		expect(error.details[0]).toEqual({
			commitSha: SHA,
			limit: { kind: "inventory", max: MAX_INVENTORY_ENTRIES },
		});
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
			limit: {
				kind: "fileCount",
				actual: SNAPSHOT_LIMITS.maxFiles + 1,
				max: SNAPSHOT_LIMITS.maxFiles,
			},
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
		expect(error.details[0]).toEqual({
			commitSha: SHA,
			limit: {
				kind: "fileSize",
				actual: SNAPSHOT_LIMITS.maxFileBytes + 1,
				max: SNAPSHOT_LIMITS.maxFileBytes,
			},
		});
		expect(m.createInstructionSnapshot).not.toHaveBeenCalled();
	});

	it("names the largest file when several are over the per-file cap, not the first", async () => {
		serveRepo([
			{
				path: "a.md",
				body: "x".repeat(SNAPSHOT_LIMITS.maxFileBytes + 10),
			},
			{ path: "small.md", body: "x" },
			{
				path: "b.md",
				body: "x".repeat(SNAPSHOT_LIMITS.maxFileBytes + 500),
			},
		]);
		const error = failureOf(
			await acquireInstructionTreeFromRepository(CONTEXT).catch((e) => e),
		);
		expect(error.details[0]).toMatchObject({
			limit: {
				kind: "fileSize",
				actual: SNAPSHOT_LIMITS.maxFileBytes + 500,
			},
		});
	});

	it("reports the full total, not where the scan stopped, when the folder is over the total cap", async () => {
		const each = SNAPSHOT_LIMITS.maxFileBytes;
		const count = Math.floor(SNAPSHOT_LIMITS.maxTotalBytes / each) + 3;
		serveRepo(
			Array.from({ length: count }, (_, i) => ({
				path: `f${i}.md`,
				body: "x".repeat(each),
			})),
		);
		const error = failureOf(
			await acquireInstructionTreeFromRepository(CONTEXT).catch((e) => e),
		);
		expect(error.type).toBe("LIMITS_EXCEEDED");
		expect(error.details[0]).toEqual({
			commitSha: SHA,
			limit: {
				kind: "totalSize",
				actual: count * each,
				max: SNAPSHOT_LIMITS.maxTotalBytes,
			},
		});
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
		// No rule left it out, so there is no rule to name: the count says
		// more than the list does.
		expect(created.excludedPaths).toEqual([]);
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

	it("names the files the ignore rules left out, with the rule that left each one out", async () => {
		serveRepo([
			{ path: ".fabricignore", body: "drafts/**\n" },
			{ path: "CLAUDE.md", body: "keep" },
			{ path: "drafts/x.md", body: "drop" },
			{ path: ".git/HEAD", body: "drop" },
		]);

		await acquireInstructionTreeFromRepository(CONTEXT);

		const created = m.createInstructionSnapshot.mock.calls[0]?.[0];
		expect(created.excludedCount).toBe(2);
		expect(created.excludedPaths).toEqual([
			{ path: "drafts/x.md", rule: "drafts/**" },
			{ path: ".git/HEAD", rule: "**/.git/**" },
		]);
	});

	it("stores no more than 500 names while the count keeps the whole number", async () => {
		serveRepo([
			{ path: ".fabricignore", body: "drafts/**\n" },
			{ path: "CLAUDE.md", body: "keep" },
			...Array.from({ length: 520 }, (_, i) => ({
				path: `drafts/note-${i}.md`,
				body: "drop",
			})),
		]);

		await acquireInstructionTreeFromRepository(CONTEXT);

		const created = m.createInstructionSnapshot.mock.calls[0]?.[0];
		expect(created.excludedCount).toBe(520);
		expect(created.excludedPaths).toHaveLength(500);
		expect(created.excludedPaths[0]).toEqual({
			path: "drafts/note-0.md",
			rule: "drafts/**",
		});
	});

	it("stores an empty list when nothing was left out by a rule", async () => {
		serveRepo([{ path: "CLAUDE.md", body: "keep" }]);

		await acquireInstructionTreeFromRepository(CONTEXT);

		const created = m.createInstructionSnapshot.mock.calls[0]?.[0];
		expect(created.excludedCount).toBe(0);
		expect(created.excludedPaths).toEqual([]);
	});

	it("freezes no rules from a .fabricignore that is not UTF-8 text, and keeps the file for the gate to refuse", async () => {
		serveRepo([
			{ path: ".fabricignore", body: "drafts/**\n" },
			{ path: "CLAUDE.md", body: "keep" },
			{ path: "drafts/x.md", body: "kept: no rules were read" },
		]);
		m.readBlobCapped.mockResolvedValue(Buffer.from("drafts/**\n\0"));

		await acquireInstructionTreeFromRepository(CONTEXT);

		const created = m.createInstructionSnapshot.mock.calls[0]?.[0];
		expect(created.settingsFrozen.layer).toBe("default");
		expect(
			created.files.map((f: { path: string }) => f.path).sort(),
		).toEqual([".fabricignore", "CLAUDE.md", "drafts/x.md"]);
		expect(created.excludedCount).toBe(0);
	});

	it("hands the child workflow the token the staged row carries, a new row's and an adopted one's", async () => {
		serveRepo([{ path: "CLAUDE.md", body: "x" }]);
		const created = await acquireInstructionTreeFromRepository(CONTEXT);
		const token = (
			m.createInstructionSnapshot.mock.calls[0]?.[0] as {
				validationAttemptId: string;
			}
		).validationAttemptId;
		expect(created).toMatchObject({ validationAttemptId: token });

		m.getInstructionSnapshotBySyncRunKey.mockResolvedValue({
			id: "snap_9",
			version: 9,
			status: "VALIDATING",
			sourceCommitSha: SHA,
			validationAttemptId: "attempt_adopted",
			files: [],
		});
		expect(await acquireInstructionTreeFromRepository(CONTEXT)).toEqual({
			outcome: "staged",
			snapshotId: "snap_9",
			commitSha: SHA,
			validationAttemptId: "attempt_adopted",
		});
	});

	it("reports the run's phases: fetching, preparing, then the copy counted in files uploaded", async () => {
		serveRepo([
			{ path: "CLAUDE.md", body: "# rules\n" },
			{ path: "AGENTS.md", body: "# agents\n" },
		]);

		await acquireInstructionTreeFromRepository(CONTEXT);

		const written = m.recordInstructionSyncRunProgress.mock.calls.map(
			([input]) => input,
		);
		expect(written[0]).toEqual({
			runKey: "sync_1:run_a",
			projectId: "proj_1",
			organizationId: "org_1",
			phase: "FETCHING",
			done: null,
			total: null,
		});
		expect(written[1]).toMatchObject({
			phase: "PREPARING",
			done: null,
			total: null,
		});
		const copying = written.filter((w) => w.phase === "COPYING");
		expect(copying[0]).toMatchObject({ done: 0, total: 2 });
		expect(copying.at(-1)).toMatchObject({ done: 2, total: 2 });
		expect(written.map((w) => w.phase)).toEqual(
			[...written.map((w) => w.phase)].sort(
				(a, b) =>
					["FETCHING", "PREPARING", "COPYING"].indexOf(a) -
					["FETCHING", "PREPARING", "COPYING"].indexOf(b),
			),
		);
	});

	it("never counts a file whose upload failed, and a failed progress write does not fail the acquisition", async () => {
		serveRepo([
			{ path: "CLAUDE.md", body: "# rules\n" },
			{ path: "AGENTS.md", body: "# agents\n" },
		]);
		m.recordInstructionSyncRunProgress.mockRejectedValue(
			new Error("database unavailable"),
		);

		await expect(
			acquireInstructionTreeFromRepository(CONTEXT),
		).resolves.toMatchObject({ outcome: "staged" });
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
		expect(m.claimInstructionFileStagingKeys).toHaveBeenCalledWith({
			snapshotId: "snap_9",
			projectId: "proj_1",
			organizationId: "org_1",
			claims: [
				{
					fileId: "file_a",
					from: stagingKey("proj_1", "snap_9", "file_a"),
					to: stagingKey("proj_1", "snap_9", "file_a"),
				},
			],
		});
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

	it("stops credential recovery after cancellation instead of flagging reauthentication", async () => {
		const controller = new AbortController();
		const cancelled = new Error("activity cancelled");
		m.activityContext.mockReturnValue({
			cancellationSignal: controller.signal,
		});
		m.cloneTreeless.mockRejectedValueOnce(
			new GitCommandError(
				"exit",
				128,
				"fatal: Authentication failed for 'https://github.com/'",
				"clone",
			),
		);
		m.forceReExchangeRepoCredentials.mockImplementation(
			async ({ signal }: { signal: AbortSignal }) => {
				controller.abort(cancelled);
				expect(signal.aborted).toBe(true);
				return { refreshed: false };
			},
		);

		await expect(
			acquireInstructionTreeFromRepository(CONTEXT),
		).rejects.toBe(cancelled);
		expect(m.markRepoReauthRequired).not.toHaveBeenCalled();
		expect(m.resolveFreshRepoToken).toHaveBeenCalledTimes(1);
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

	it("drains an upload already in flight before a storage failure returns for retry", async () => {
		serveRepo([
			{ path: "CLAUDE.md", body: "first" },
			{ path: "AGENTS.md", body: "second" },
		]);
		let releaseSecondUpload: (() => void) | undefined;
		let secondUploadStarted = false;
		m.uploadFile.mockImplementation(async () => {
			if (m.uploadFile.mock.calls.length === 1) {
				throw new Error("storage unavailable");
			}
			secondUploadStarted = true;
			await new Promise<void>((resolve) => {
				releaseSecondUpload = resolve;
			});
		});

		let settled = false;
		const acquisition = acquireInstructionTreeFromRepository(CONTEXT)
			.catch((error) => error)
			.finally(() => {
				settled = true;
			});
		await vi.waitFor(() => expect(secondUploadStarted).toBe(true));
		expect(settled).toBe(false);

		releaseSecondUpload?.();
		const error = failureOf(await acquisition);
		expect(error.type).toBe("STORAGE_FAILED");
		expect(m.uploadFile).toHaveBeenCalledTimes(2);
	});

	it("stops before reading or uploading when cancellation arrives while a staging claim is pending", async () => {
		serveRepo([{ path: "CLAUDE.md", body: "first" }]);
		const controller = new AbortController();
		m.activityContext.mockReturnValue({
			cancellationSignal: controller.signal,
		});
		let releaseClaim: (() => void) | undefined;
		m.claimInstructionFileStagingKeys.mockImplementation(
			async () =>
				await new Promise<{ moved: number }>((resolve) => {
					releaseClaim = () => resolve({ moved: 1 });
				}),
		);

		const acquisition = acquireInstructionTreeFromRepository(CONTEXT);
		await vi.waitFor(() =>
			expect(m.claimInstructionFileStagingKeys).toHaveBeenCalledTimes(1),
		);
		controller.abort(new Error("cancelled while claiming"));
		releaseClaim?.();

		await expect(acquisition).rejects.toThrow("cancelled while claiming");
		expect(m.uploadFile).not.toHaveBeenCalled();
	});

	it("maps the disk watchdog to LIMITS_EXCEEDED", async () => {
		m.cloneTreeless.mockRejectedValue(
			new GitCommandError("disk_limit", null, "", "clone"),
		);
		const error = failureOf(
			await acquireInstructionTreeFromRepository(CONTEXT).catch((e) => e),
		);
		expect(error.type).toBe("LIMITS_EXCEEDED");
		expect(error.details[0]).toEqual({
			limit: { kind: "repositorySize", max: MAX_CLONE_BYTES },
		});
	});

	/**
	 * The watchdog counts the clone and the checkout together, so a kept set
	 * past the snapshot's limits trips it mid-checkout. Serve the repository
	 * as usual, let the checkout write what it got to, then trip the watchdog.
	 */
	function tripWatchdogAfterCheckout() {
		const writeKept = m.sparseCheckout.getMockImplementation();
		m.sparseCheckout.mockImplementation(async (input: unknown) => {
			await writeKept?.(input);
			throw new GitCommandError("disk_limit", null, "", "checkout");
		});
	}

	it("reports a kept file over the per-file cap that trips the disk watchdog as a file size, not a repository size", async () => {
		serveRepo([
			{
				path: "big.md",
				body: "x".repeat(SNAPSHOT_LIMITS.maxFileBytes + 1),
			},
		]);
		tripWatchdogAfterCheckout();

		const error = failureOf(
			await acquireInstructionTreeFromRepository(CONTEXT).catch((e) => e),
		);

		expect(error.type).toBe("LIMITS_EXCEEDED");
		expect(error.details[0]).toEqual({
			commitSha: SHA,
			limit: {
				kind: "fileSize",
				max: SNAPSHOT_LIMITS.maxFileBytes,
				actual: SNAPSHOT_LIMITS.maxFileBytes + 1,
				atLeast: true,
			},
		});
	});

	it("reports the exact size of the largest kept file when the provider's tree lists it", async () => {
		serveRepo([
			{
				path: "big.md",
				body: "x".repeat(SNAPSHOT_LIMITS.maxFileBytes + 1),
			},
			{ path: "small.md", body: "s" },
		]);
		tripWatchdogAfterCheckout();
		m.readRepositoryBlobSizes.mockResolvedValue({
			ok: true,
			complete: true,
			sizes: new Map([
				["agents/big.md", SNAPSHOT_LIMITS.maxFileBytes + 1024],
				["agents/small.md", 1],
			]),
		});

		const error = failureOf(
			await acquireInstructionTreeFromRepository(CONTEXT).catch((e) => e),
		);

		expect(error.details[0]).toEqual({
			commitSha: SHA,
			limit: {
				kind: "fileSize",
				max: SNAPSHOT_LIMITS.maxFileBytes,
				actual: SNAPSHOT_LIMITS.maxFileBytes + 1024,
			},
		});
		expect(m.readRepositoryBlobSizes).toHaveBeenCalledWith(
			expect.objectContaining({ commitSha: SHA, token: TOKEN }),
		);
	});

	it("falls back to the lower bound, marked as one, when the provider's listing is truncated", async () => {
		serveRepo([
			{
				path: "big.md",
				body: "x".repeat(SNAPSHOT_LIMITS.maxFileBytes + 1),
			},
		]);
		tripWatchdogAfterCheckout();
		m.readRepositoryBlobSizes.mockResolvedValue({
			ok: true,
			complete: false,
			sizes: new Map([
				["agents/big.md", SNAPSHOT_LIMITS.maxFileBytes + 1],
			]),
		});

		const error = failureOf(
			await acquireInstructionTreeFromRepository(CONTEXT).catch((e) => e),
		);

		expect(error.details[0]).toMatchObject({
			limit: { kind: "fileSize", atLeast: true },
		});
	});

	it("keeps the repository-size limit when the provider's exact sizes are within the snapshot limits", async () => {
		serveRepo([{ path: "a.md", body: "a" }]);
		tripWatchdogAfterCheckout();
		m.readRepositoryBlobSizes.mockResolvedValue({
			ok: true,
			complete: true,
			sizes: new Map([["agents/a.md", 1]]),
		});

		const error = failureOf(
			await acquireInstructionTreeFromRepository(CONTEXT).catch((e) => e),
		);

		expect(error.details[0]).toEqual({
			commitSha: SHA,
			limit: { kind: "repositorySize", max: MAX_CLONE_BYTES },
		});
	});

	it("reports a kept set over the total cap that trips the disk watchdog as a total size, not a repository size", async () => {
		const each = SNAPSHOT_LIMITS.maxFileBytes;
		const count = Math.floor(SNAPSHOT_LIMITS.maxTotalBytes / each) + 3;
		serveRepo(
			Array.from({ length: count }, (_, i) => ({
				path: `f${i}.md`,
				body: "x".repeat(each),
			})),
		);
		tripWatchdogAfterCheckout();

		const error = failureOf(
			await acquireInstructionTreeFromRepository(CONTEXT).catch((e) => e),
		);

		expect(error.details[0]).toEqual({
			commitSha: SHA,
			limit: {
				kind: "totalSize",
				max: SNAPSHOT_LIMITS.maxTotalBytes,
				actual: each * count,
				atLeast: true,
			},
		});
	});

	it("keeps the repository-size limit when the watchdog trips with a small kept set", async () => {
		serveRepo([{ path: "a.md", body: "a" }]);
		tripWatchdogAfterCheckout();

		const error = failureOf(
			await acquireInstructionTreeFromRepository(CONTEXT).catch((e) => e),
		);

		expect(error.details[0]).toEqual({
			commitSha: SHA,
			limit: { kind: "repositorySize", max: MAX_CLONE_BYTES },
		});
	});

	it("maps the disk watchdog after the clone to the repository-size limit too", async () => {
		serveRepo([{ path: "a.md", body: "a" }]);
		m.listTree.mockRejectedValue(
			new GitCommandError("disk_limit", null, "", "ls-tree"),
		);
		const error = failureOf(
			await acquireInstructionTreeFromRepository(CONTEXT).catch((e) => e),
		);
		expect(error.type).toBe("LIMITS_EXCEEDED");
		expect(error.details[0]).toEqual({
			commitSha: SHA,
			limit: { kind: "repositorySize", max: MAX_CLONE_BYTES },
		});
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

	describe("the first sync after a move from uploads into this repository (Fizzy #2878 §9)", () => {
		const switching = {
			ignoreGlobs: null,
			sourceOfTruth: "REPOSITORY",
			migration: {
				v: 1,
				state: "SWITCHING",
				branchId: "branch_1",
				snapshotId: "snap_move",
				syncId: "sync_1",
				pullRequestUrl: null,
				startedAt: "2026-10-03T10:00:00.000Z",
				userId: "user_1",
			},
		};

		beforeEach(() => {
			m.completeInstructionRepositorySyncRun.mockResolvedValue({
				completed: true,
				configurationCurrent: true,
			});
			m.getInstructionSnapshotWithPublishedPointer.mockResolvedValue({
				snapshot: summary(),
				publishedPointer: { id: "snap_1" },
			});
		});

		it("completes the move when the run succeeded, and says which snapshot it published", async () => {
			m.getProjectInstructionSettings.mockResolvedValue(switching);

			await recordInstructionRepositorySyncRun(base);

			expect(m.settleInstructionMigrationAfterSync).toHaveBeenCalledWith({
				projectId: "proj_1",
				organizationId: "org_1",
				syncId: "sync_1",
				snapshotId: "snap_1",
			});
		});

		it("completes it too when the run found the tree unchanged", async () => {
			m.getProjectInstructionSettings.mockResolvedValue(switching);

			await recordInstructionRepositorySyncRun({
				...base,
				unchanged: true,
				snapshotId: null,
				childResult: null,
			});

			expect(m.settleInstructionMigrationAfterSync).toHaveBeenCalledWith(
				expect.objectContaining({ syncId: "sync_1", snapshotId: null }),
			);
		});

		it.each([
			[
				"failed",
				{
					error: "CLONE_FAILED" as const,
					snapshotId: null,
					childResult: null,
				},
			],
			[
				"was skipped",
				{
					skipped: true,
					snapshotId: null,
					childResult: null,
				},
			],
		])(
			"leaves the move switching when the run %s",
			async (_label, over) => {
				m.getProjectInstructionSettings.mockResolvedValue(switching);

				await recordInstructionRepositorySyncRun({ ...base, ...over });

				expect(
					m.settleInstructionMigrationAfterSync,
				).not.toHaveBeenCalled();
			},
		);

		it("leaves the move switching when the scan refused the tree: nothing was published", async () => {
			m.getProjectInstructionSettings.mockResolvedValue(switching);
			m.getInstructionSnapshotWithPublishedPointer.mockResolvedValue({
				snapshot: summary({
					status: "REJECTED",
					publishedAt: null,
					rejection: [{ path: "CLAUDE.md", reason: "secret" }],
				}),
				publishedPointer: null,
			});

			await recordInstructionRepositorySyncRun({
				...base,
				childResult: { status: "REJECTED", published: false },
			});

			expect(
				m.settleInstructionMigrationAfterSync,
			).not.toHaveBeenCalled();
		});

		it("ignores a run of another sync row, and a project whose move is still proposing or gone", async () => {
			m.getProjectInstructionSettings.mockResolvedValue({
				...switching,
				migration: { ...switching.migration, syncId: "sync_other" },
			});
			await recordInstructionRepositorySyncRun(base);
			m.getProjectInstructionSettings.mockResolvedValue({
				...switching,
				migration: { ...switching.migration, state: "PROPOSING" },
			});
			await recordInstructionRepositorySyncRun(base);
			m.getProjectInstructionSettings.mockResolvedValue({
				ignoreGlobs: null,
				sourceOfTruth: "REPOSITORY",
				migration: null,
			});
			await recordInstructionRepositorySyncRun(base);

			expect(
				m.settleInstructionMigrationAfterSync,
			).not.toHaveBeenCalled();
		});

		it("does nothing when the configuration moved on and the run's own bookkeeping did not complete", async () => {
			m.getProjectInstructionSettings.mockResolvedValue(switching);
			m.completeInstructionRepositorySyncRun.mockResolvedValue({
				completed: false,
				configurationCurrent: false,
			});

			await recordInstructionRepositorySyncRun(base);

			expect(
				m.settleInstructionMigrationAfterSync,
			).not.toHaveBeenCalled();
		});
	});

	it("passes the recorded limit to the run row, and none when the run carries none", async () => {
		m.completeInstructionRepositorySyncRun.mockResolvedValue({
			completed: true,
			configurationCurrent: true,
		});
		const limit = { kind: "fileCount", actual: 6000, max: 5000 } as const;
		await recordInstructionRepositorySyncRun({
			...base,
			snapshotId: null,
			childResult: null,
			error: "LIMITS_EXCEEDED",
			limit,
		});
		await recordInstructionRepositorySyncRun({
			...base,
			snapshotId: null,
			childResult: null,
			error: "LIMITS_EXCEEDED",
		});
		expect(m.completeInstructionRepositorySyncRun).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({ error: "LIMITS_EXCEEDED", limit }),
		);
		expect(m.completeInstructionRepositorySyncRun).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ error: "LIMITS_EXCEEDED", limit: null }),
		);
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
	// complete every receipt the run began, by its workflow run id.
	describe("without a context, by the workflow run id", () => {
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
		const receipt = (syncId: string, generation: number) => ({
			id: `${syncId}:run_a`,
			syncId,
			userId: "user_1",
			generation,
			trigger: "MANUAL" as const,
		});

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
			m.listUnfinishedInstructionRepositorySyncRunReceipts.mockResolvedValue(
				[receipt("sync_1", 3)],
			);

			expect(await recordInstructionRepositorySyncRun(orphan)).toEqual({
				recorded: true,
				status: "FAILED",
			});

			expect(
				m.getInstructionRepositorySyncForRun,
			).toHaveBeenLastCalledWith("proj_1");
			expect(
				m.listUnfinishedInstructionRepositorySyncRunReceipts,
			).toHaveBeenCalledWith("run_a", "proj_1", "org_1");
			expect(
				m.completeInstructionRepositorySyncRun,
			).toHaveBeenCalledTimes(1);
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
					// The unlocked read above is the caller's belief only: under
					// its lock the completion records a receipt whose
					// (syncId, generation) is no longer current, as this one's
					// generation 3 is not, as CONFIGURATION_CHANGED.
					classifyStaleAsConfigurationChanged: true,
				}),
			);
			// No snapshot can exist without a context: Part A never runs.
			expect(
				m.getInstructionSnapshotWithPublishedPointer,
			).not.toHaveBeenCalled();
		});

		it("is a no-op, and does not throw, when begin failed before inserting the receipt or every receipt is already finished", async () => {
			expect(await recordInstructionRepositorySyncRun(orphan)).toEqual({
				recorded: false,
				status: null,
			});
			expect(
				m.listUnfinishedInstructionRepositorySyncRunReceipts,
			).toHaveBeenCalledWith("run_a", "proj_1", "org_1");
			expect(
				m.completeInstructionRepositorySyncRun,
			).not.toHaveBeenCalled();
		});

		it("reads no receipt for a configuration row of another organization", async () => {
			m.getInstructionRepositorySyncForRun.mockResolvedValue({
				...syncRow,
				organizationId: "org_other",
			});
			expect(
				await recordInstructionRepositorySyncRun({
					...orphan,
					error: "NOT_CONFIGURED",
				}),
			).toEqual({ recorded: false, status: null });
			expect(
				m.listUnfinishedInstructionRepositorySyncRunReceipts,
			).not.toHaveBeenCalled();
			expect(
				m.completeInstructionRepositorySyncRun,
			).not.toHaveBeenCalled();
		});

		it("is a no-op with no configuration row and no receipt (NOT_CONFIGURED: begin inserted nothing)", async () => {
			m.getInstructionRepositorySyncForRun.mockResolvedValue(null);
			expect(
				await recordInstructionRepositorySyncRun({
					...orphan,
					error: "NOT_CONFIGURED",
				}),
			).toEqual({ recorded: false, status: null });
			expect(
				m.listUnfinishedInstructionRepositorySyncRunReceipts,
			).toHaveBeenCalledWith("run_a", "proj_1", "org_1");
			expect(
				m.completeInstructionRepositorySyncRun,
			).not.toHaveBeenCalled();
		});

		// Fizzy #2672: the receipt outlives a disable or disconnect, so a
		// "no configuration" answer no longer means "nothing to record".
		it("completes the receipt of a run whose sync was switched off after begin inserted it, as CONFIGURATION_CHANGED", async () => {
			m.getInstructionRepositorySyncForRun.mockResolvedValue(null);
			m.listUnfinishedInstructionRepositorySyncRunReceipts.mockResolvedValue(
				[receipt("sync_1", 3)],
			);
			m.completeInstructionRepositorySyncRun.mockResolvedValue({
				completed: true,
				configurationCurrent: false,
			});

			expect(
				await recordInstructionRepositorySyncRun({
					...orphan,
					// A begin retry that found the row gone.
					error: "NOT_CONFIGURED",
				}),
			).toEqual({ recorded: true, status: "FAILED" });

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
					error: "CONFIGURATION_CHANGED",
					commitSha: null,
					snapshotId: null,
					scheduling: { kind: "none" },
					classifyStaleAsConfigurationChanged: true,
				}),
			);
		});

		// Codex review of Fizzy #2672: `begin` keys its receipt on the row it
		// reads, so attempt 1 inserts `sync_1:run_a` and throws, the sync is
		// switched off and set up again, and the retry inserts
		// `sync_2:run_a`. Both receipts belong to this run.
		describe("a begin retry that inserted a second receipt under a new configuration", () => {
			beforeEach(() => {
				m.getInstructionRepositorySyncForRun.mockResolvedValue({
					...syncRow,
					id: "sync_2",
					generation: 1,
				});
			});

			it("closes both: the current configuration's with the run's own error, the stale one as CONFIGURATION_CHANGED", async () => {
				m.listUnfinishedInstructionRepositorySyncRunReceipts.mockResolvedValue(
					[receipt("sync_2", 1), receipt("sync_1", 3)],
				);

				expect(
					await recordInstructionRepositorySyncRun(orphan),
				).toEqual({ recorded: true, status: "FAILED" });

				expect(
					m.completeInstructionRepositorySyncRun,
				).toHaveBeenCalledTimes(2);
				expect(
					m.completeInstructionRepositorySyncRun,
				).toHaveBeenCalledWith(
					expect.objectContaining({
						runKey: "sync_2:run_a",
						syncId: "sync_2",
						generation: 1,
						status: "FAILED",
						error: "CLONE_FAILED",
						// A manual run never backs the schedule off (Fizzy #2706).
						scheduling: { kind: "none" },
						classifyStaleAsConfigurationChanged: true,
					}),
				);
				expect(
					m.completeInstructionRepositorySyncRun,
				).toHaveBeenCalledWith(
					expect.objectContaining({
						runKey: "sync_1:run_a",
						syncId: "sync_1",
						generation: 3,
						status: "FAILED",
						error: "CONFIGURATION_CHANGED",
						scheduling: { kind: "none" },
					}),
				);
			});

			it("still closes the stale one when the current configuration's receipt is already finished, and leaves that one alone", async () => {
				// The finished sync_2 receipt is not listed: only unfinished
				// receipts are.
				m.listUnfinishedInstructionRepositorySyncRunReceipts.mockResolvedValue(
					[receipt("sync_1", 3)],
				);

				expect(
					await recordInstructionRepositorySyncRun(orphan),
				).toEqual({ recorded: true, status: "FAILED" });

				expect(
					m.completeInstructionRepositorySyncRun,
				).toHaveBeenCalledTimes(1);
				expect(
					m.completeInstructionRepositorySyncRun,
				).toHaveBeenCalledWith(
					expect.objectContaining({
						runKey: "sync_1:run_a",
						syncId: "sync_1",
						status: "FAILED",
						error: "CONFIGURATION_CHANGED",
						scheduling: { kind: "none" },
					}),
				);
			});
		});
	});

	// Fizzy #2672: a run in flight when its sync is switched off. The child's
	// publish is fenced, and `record` completes the receipt that now survives
	// the delete, without reading the configuration at all.
	it("records NOT_PUBLISHED / CONFIGURATION_CHANGED for a run whose sync row is gone, without reading the configuration", async () => {
		m.getInstructionSnapshotWithPublishedPointer.mockResolvedValue({
			snapshot: summary({ publishedAt: null }),
			publishedPointer: { id: "snap_older" },
		});
		m.completeInstructionRepositorySyncRun.mockResolvedValue({
			completed: true,
			configurationCurrent: false,
		});

		expect(
			await recordInstructionRepositorySyncRun({
				...base,
				childResult: {
					status: "READY",
					published: false,
					publishReason: "configuration_changed",
				},
			}),
		).toEqual({ recorded: true, status: "NOT_PUBLISHED" });

		expect(m.getInstructionRepositorySyncForRun).not.toHaveBeenCalled();
		expect(m.completeInstructionRepositorySyncRun).toHaveBeenCalledWith(
			expect.objectContaining({
				runKey: "sync_1:run_a",
				syncId: "sync_1",
				generation: 3,
				status: "NOT_PUBLISHED",
				error: "CONFIGURATION_CHANGED",
				snapshotId: "snap_1",
				scheduling: { kind: "none" },
			}),
		);
		// The run's own receipt is judged by its snapshot and its own fence:
		// never reclassified under the lock.
		expect(
			m.completeInstructionRepositorySyncRun.mock.calls[0][0],
		).not.toHaveProperty("classifyStaleAsConfigurationChanged");
	});

	// Codex review of Fizzy #2672: a begin attempt that inserted a receipt
	// under an earlier configuration and threw, before the retry that gave
	// this run its context under the current one. The run closes it too.
	it("after completing its own receipt, closes any other unfinished receipt of the same workflow run as FAILED / CONFIGURATION_CHANGED", async () => {
		const contextOnSync2: SyncRunContext = {
			...CONTEXT,
			syncId: "sync_2",
			generation: 1,
			runKey: "sync_2:run_a",
		};
		m.getInstructionSnapshotWithPublishedPointer.mockResolvedValue({
			snapshot: summary(),
			publishedPointer: { id: "snap_1" },
		});
		m.listUnfinishedInstructionRepositorySyncRunReceipts.mockResolvedValue([
			// Its own receipt, were it still listed, is never touched twice.
			{
				id: "sync_2:run_a",
				syncId: "sync_2",
				userId: "user_1",
				generation: 1,
				trigger: "MANUAL",
			},
			{
				id: "sync_1:run_a",
				syncId: "sync_1",
				userId: "delegate_1",
				generation: 3,
				trigger: "MANUAL",
			},
		]);

		expect(
			await recordInstructionRepositorySyncRun({
				...base,
				workflowRunId: "run_a",
				context: contextOnSync2,
			}),
		).toEqual({ recorded: true, status: "SUCCEEDED" });

		expect(
			m.listUnfinishedInstructionRepositorySyncRunReceipts,
		).toHaveBeenCalledWith("run_a", "proj_1", "org_1");
		expect(m.completeInstructionRepositorySyncRun).toHaveBeenCalledTimes(2);
		// Its own receipt first, as before.
		expect(m.completeInstructionRepositorySyncRun).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				runKey: "sync_2:run_a",
				syncId: "sync_2",
				status: "SUCCEEDED",
			}),
		);
		expect(m.completeInstructionRepositorySyncRun).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				runKey: "sync_1:run_a",
				syncId: "sync_1",
				generation: 3,
				userId: "delegate_1",
				trigger: "MANUAL",
				status: "FAILED",
				error: "CONFIGURATION_CHANGED",
				note: null,
				commitSha: null,
				snapshotId: null,
				scheduling: { kind: "none" },
				classifyStaleAsConfigurationChanged: true,
			}),
		);
		// A publish that succeeded under its own fence stays SUCCEEDED even
		// if the configuration changes before the completion's lock.
		expect(
			m.completeInstructionRepositorySyncRun.mock.calls[0][0],
		).not.toHaveProperty("classifyStaleAsConfigurationChanged");
	});

	it("derives the workflow run id from the run key for a history that never passed it", async () => {
		m.getInstructionSnapshotWithPublishedPointer.mockResolvedValue({
			snapshot: summary(),
			publishedPointer: { id: "snap_1" },
		});
		await recordInstructionRepositorySyncRun(base);
		expect(
			m.listUnfinishedInstructionRepositorySyncRunReceipts,
		).toHaveBeenCalledWith("run_a", "proj_1", "org_1");
		expect(m.completeInstructionRepositorySyncRun).toHaveBeenCalledTimes(1);
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
