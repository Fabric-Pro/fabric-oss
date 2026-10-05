/**
 * The writes of a move from uploads into a repository on a real Postgres
 * (Fizzy #2878 §9). The contract is the project row lock, the sync row's
 * pause and the settings JSON they write together, so a mocked client cannot
 * hold it:
 *
 * - starting creates the sync row paused `MIGRATING` WITHOUT flipping
 *   `sourceOfTruth`, and writes the `PROPOSING` pointer in the same
 *   transaction; every refusal writes nothing;
 * - completing (the pull request merged) is the one write that flips
 *   `sourceOfTruth`, clears the pause and delegates to the member who started
 *   the move, and is idempotent;
 * - abandoning deletes the sync row WITHOUT an UPLOAD write and clears the
 *   pointer;
 * - the poll never claims a paused row, and claims it once the move cleared
 *   the pause.
 *
 * Self-skips when DATABASE_URL is unset or is the CI placeholder.
 */
import { createHash } from "node:crypto";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "vitest";
import { memberBranchRef } from "../../instructions/src/proposal-branch-ref";
import {
	abandonInstructionMigration,
	approveInstructionProposal,
	attachInstructionMigrationProposal,
	claimDueInstructionSyncRows,
	completeInstructionMigration,
	createDerivedInstructionSnapshot,
	db,
	deleteInstructionRepositorySync,
	expediteMigrationBranch,
	getOpenMigrationOfBranch,
	getProjectInstructionSettings,
	InstructionMigrationOpenError,
	joinProposalBranch,
	publishInstructionSnapshot,
	settleInstructionMigrationAfterSync,
	startInstructionMigration,
	updateProjectInstructionSettings,
	upsertInstructionRepositorySync,
} from "../index";
import { hasReachableDatabaseUrl } from "./_helpers/db-availability";

const RUN_ID = `${Date.now()}-${process.pid}`;
const ORGANIZATION_ID = `migration-org-${RUN_ID}`;
const OWNER_ID = `migration-owner-${RUN_ID}`;
const ADMIN_ID = `migration-admin-${RUN_ID}`;
const REPO = `migration-${RUN_ID}`;

let projectId = "";
let integrationId = "";
let publishedId = "";

const tenant = () => ({ projectId, organizationId: ORGANIZATION_ID });

function start(over: { userId?: string } = {}) {
	return startInstructionMigration({
		...tenant(),
		userId: over.userId ?? ADMIN_ID,
		repositoryIntegrationId: integrationId,
		ref: "main",
		rootPath: ".claude",
	});
}

async function syncRows() {
	return db.projectInstructionRepositorySync.findMany({
		where: { projectId, organizationId: ORGANIZATION_ID },
	});
}

async function rawSettings(): Promise<Record<string, unknown>> {
	const project = await db.project.findUniqueOrThrow({
		where: { id: projectId },
		select: { instructionSettings: true },
	});
	return (project.instructionSettings ?? {}) as Record<string, unknown>;
}

async function auditActions(resourceId: string): Promise<string[]> {
	const rows = await db.auditLog.findMany({
		where: { organizationId: ORGANIZATION_ID, resourceId },
		select: { action: true },
	});
	return rows.map((row) => row.action).sort();
}

describe.skipIf(!hasReachableDatabaseUrl())(
	"moving uploaded coding instructions into a repository (real Postgres)",
	() => {
		beforeAll(async () => {
			const now = new Date();
			for (const id of [OWNER_ID, ADMIN_ID]) {
				await db.user.create({
					data: {
						id,
						name: "Dev Example",
						email: `${id}@example.com`,
						emailVerified: true,
						createdAt: now,
						updatedAt: now,
					},
				});
			}
			await db.organization.create({
				data: {
					id: ORGANIZATION_ID,
					name: "Migration Integration",
					slug: ORGANIZATION_ID,
					createdAt: now,
				},
			});
			await db.member.create({
				data: {
					organizationId: ORGANIZATION_ID,
					userId: OWNER_ID,
					role: "owner",
					createdAt: now,
				},
			});
			const project = await db.project.create({
				data: {
					name: "Migration Integration",
					userId: OWNER_ID,
					organizationId: ORGANIZATION_ID,
					techStack: [],
					features: [],
					tags: [],
				},
			});
			projectId = project.id;
			const integration = await db.projectRepositoryIntegration.create({
				data: {
					projectId,
					provider: "GITHUB",
					authMethod: "OAUTH",
					repositoryUrl: `https://github.com/example-org/${REPO}`,
					repositoryOwner: "example-org",
					repositoryName: REPO,
				},
			});
			integrationId = integration.id;
		});

		beforeEach(async () => {
			publishedId = `migration-published-${RUN_ID}-${Math.random().toString(36).slice(2, 8)}`;
			const version =
				((
					await db.projectInstructionSnapshot.findFirst({
						where: { projectId },
						orderBy: { version: "desc" },
						select: { version: true },
					})
				)?.version ?? 0) + 1;
			await db.projectInstructionSnapshot.create({
				data: {
					id: publishedId,
					projectId,
					organizationId: ORGANIZATION_ID,
					userId: OWNER_ID,
					version,
					source: "UPLOAD",
					status: "READY",
					settingsFrozen: {},
					fileCount: 0,
					readyAt: new Date(),
					publishedAt: new Date(),
				},
			});
			await db.project.update({
				where: { id: projectId },
				data: {
					publishedInstructionSnapshotId: publishedId,
					instructionSettings: { sourceOfTruth: "UPLOAD" },
				},
			});
		});

		afterEach(async () => {
			await db.projectInstructionRepositorySyncRun.deleteMany({
				where: { projectId },
			});
			await db.projectInstructionRepositorySync.deleteMany({
				where: { projectId },
			});
			await db.project.update({
				where: { id: projectId },
				data: { publishedInstructionSnapshotId: null },
			});
			await db.projectInstructionSnapshot.deleteMany({
				where: { projectId },
			});
			await db.projectInstructionProposalBranch.deleteMany({
				where: { projectId },
			});
			await db.projectInstructionProposalRefReservation.deleteMany({
				where: { organizationId: ORGANIZATION_ID },
			});
			await db.$transaction([
				db.$executeRawUnsafe("SET LOCAL app.audit_allow_delete = 'on'"),
				db.$executeRaw`DELETE FROM "audit_log" WHERE "organizationId" = ${ORGANIZATION_ID}`,
			]);
		});

		afterAll(async () => {
			if (projectId) {
				await db.project.deleteMany({ where: { id: projectId } });
			}
			await db.organization.deleteMany({
				where: { id: ORGANIZATION_ID },
			});
			await db.user.deleteMany({
				where: { id: { in: [OWNER_ID, ADMIN_ID] } },
			});
			await db.$disconnect();
		});

		describe("start", () => {
			it("creates the sync row paused MIGRATING, leaves uploads as the source of truth and writes the PROPOSING pointer", async () => {
				const result = await start();

				expect(result.ok).toBe(true);
				if (!result.ok) {
					return;
				}
				expect(result.publishedSnapshotId).toBe(publishedId);
				const [row] = await syncRows();
				expect(row).toMatchObject({
					id: result.sync.id,
					userId: ADMIN_ID,
					repositoryIntegrationId: integrationId,
					ref: "main",
					rootPath: ".claude",
					automatic: true,
					automaticPausedReason: "MIGRATING",
					generation: result.sync.generation,
				});
				expect(row?.automaticPausedAt).not.toBeNull();
				const settings = await rawSettings();
				expect(settings.sourceOfTruth).toBe("UPLOAD");
				expect(settings.migration).toMatchObject({
					v: 1,
					state: "PROPOSING",
					branchId: null,
					snapshotId: null,
					syncId: result.sync.id,
					pullRequestUrl: null,
					userId: ADMIN_ID,
				});
				expect(result.pointer).toEqual(settings.migration);
			});

			it("is visible to the settings reader every surface uses", async () => {
				const result = await start();

				const settings = await getProjectInstructionSettings(
					projectId,
					ORGANIZATION_ID,
				);
				expect(result.ok && settings.migration?.syncId).toBe(
					result.ok ? result.sync.id : undefined,
				);
				expect(settings.sourceOfTruth).toBe("UPLOAD");
			});

			it("refuses a second move while one is open and writes nothing", async () => {
				const first = await start();
				const before = await syncRows();

				const second = await start({ userId: OWNER_ID });

				expect(first.ok).toBe(true);
				expect(second).toEqual({ ok: false, reason: "migration_open" });
				expect(await syncRows()).toEqual(before);
			});

			it("refuses a repository-backed project", async () => {
				await db.project.update({
					where: { id: projectId },
					data: {
						instructionSettings: { sourceOfTruth: "REPOSITORY" },
					},
				});

				const result = await start();

				expect(result).toEqual({
					ok: false,
					reason: "not_upload_sourced",
				});
				expect(await syncRows()).toHaveLength(0);
			});

			it("refuses a project with nothing published", async () => {
				await db.project.update({
					where: { id: projectId },
					data: { publishedInstructionSnapshotId: null },
				});

				const result = await start();

				expect(result).toEqual({
					ok: false,
					reason: "nothing_published",
				});
				expect(await syncRows()).toHaveLength(0);
				expect((await rawSettings()).migration).toBeUndefined();
			});

			it("refuses a project that already has a sync row", async () => {
				await db.projectInstructionRepositorySync.create({
					data: {
						projectId,
						organizationId: ORGANIZATION_ID,
						userId: OWNER_ID,
						repositoryIntegrationId: integrationId,
						ref: "main",
						rootPath: "",
					},
				});

				const result = await start();

				expect(result).toEqual({ ok: false, reason: "sync_exists" });
				expect((await rawSettings()).migration).toBeUndefined();
			});

			it("does not find a project in another organization", async () => {
				const result = await startInstructionMigration({
					projectId,
					organizationId: `${ORGANIZATION_ID}-other`,
					userId: ADMIN_ID,
					repositoryIntegrationId: integrationId,
					ref: "main",
					rootPath: "",
				});

				expect(result).toEqual({
					ok: false,
					reason: "project_not_found",
				});
				expect(await syncRows()).toHaveLength(0);
			});
		});

		describe("the schedule", () => {
			it("is not claimed by the poll while the move is paused, and is once the pause is cleared", async () => {
				const started = await start();
				if (!started.ok) {
					throw new Error("start was refused");
				}
				await db.projectInstructionRepositorySync.update({
					where: { id: started.sync.id },
					data: { nextCheckAt: new Date(Date.now() - 60_000) },
				});

				const whilePaused = await db.$transaction((tx) =>
					claimDueInstructionSyncRows(tx, {
						limit: 50,
						leaseMs: 60_000,
					}),
				);

				expect(
					whilePaused.map((row) => row.id),
					"a MIGRATING row is never due",
				).not.toContain(started.sync.id);
				await db.projectInstructionRepositorySync.update({
					where: { id: started.sync.id },
					data: {
						automaticPausedReason: null,
						automaticPausedAt: null,
					},
				});
				const afterwards = await db.$transaction((tx) =>
					claimDueInstructionSyncRows(tx, {
						limit: 50,
						leaseMs: 60_000,
					}),
				);
				expect(afterwards.map((row) => row.id)).toContain(
					started.sync.id,
				);
			});
		});

		describe("attach", () => {
			it("records the proposal and the branch on a proposing pointer", async () => {
				const started = await start();
				if (!started.ok) {
					throw new Error("start was refused");
				}

				const snapshot = await attachInstructionMigrationProposal({
					...tenant(),
					syncId: started.sync.id,
					snapshotId: "snapshot-1",
				});
				const branch = await attachInstructionMigrationProposal({
					...tenant(),
					syncId: started.sync.id,
					branchId: "branch-1",
				});

				expect(snapshot).toBe(true);
				expect(branch).toBe(true);
				expect((await rawSettings()).migration).toMatchObject({
					state: "PROPOSING",
					snapshotId: "snapshot-1",
					branchId: "branch-1",
				});
			});

			it("writes nothing for another sync row or when no move is open", async () => {
				expect(
					await attachInstructionMigrationProposal({
						...tenant(),
						syncId: "nothing",
						snapshotId: "snapshot-1",
					}),
				).toBe(false);
				const started = await start();
				if (!started.ok) {
					throw new Error("start was refused");
				}

				expect(
					await attachInstructionMigrationProposal({
						...tenant(),
						syncId: "another",
						snapshotId: "snapshot-1",
					}),
				).toBe(false);
				expect((await rawSettings()).migration).toMatchObject({
					snapshotId: null,
				});
			});
		});

		describe("complete", () => {
			async function startedOnBranch() {
				const started = await start();
				if (!started.ok) {
					throw new Error("start was refused");
				}
				await attachInstructionMigrationProposal({
					...tenant(),
					syncId: started.sync.id,
					snapshotId: "snapshot-1",
					branchId: "branch-1",
				});
				return started;
			}

			it("flips the source of truth, clears the pause and delegates to the member who started the move, keeping the generation", async () => {
				const started = await startedOnBranch();
				await db.projectInstructionRepositorySync.update({
					where: { id: started.sync.id },
					data: {
						userId: OWNER_ID,
						failureCount: 3,
						nextCheckAt: null,
					},
				});

				const result = await completeInstructionMigration({
					...tenant(),
					branchId: "branch-1",
					pullRequestUrl: "https://github.com/example-org/x/pull/9",
				});

				expect(result).toBe("completed");
				const [row] = await syncRows();
				expect(row).toMatchObject({
					userId: ADMIN_ID,
					automatic: true,
					automaticPausedReason: null,
					automaticPausedAt: null,
					failureCount: 0,
					generation: started.sync.generation,
				});
				expect(row?.nextCheckAt).not.toBeNull();
				const settings = await rawSettings();
				expect(settings.sourceOfTruth).toBe("REPOSITORY");
				expect(settings.migration).toMatchObject({
					state: "SWITCHING",
					branchId: "branch-1",
					pullRequestUrl: "https://github.com/example-org/x/pull/9",
				});
			});

			it("is idempotent: a repeat finds the switch done and writes nothing", async () => {
				await startedOnBranch();
				await completeInstructionMigration({
					...tenant(),
					branchId: "branch-1",
					pullRequestUrl: null,
				});
				const before = await syncRows();
				const settingsBefore = await rawSettings();

				const again = await completeInstructionMigration({
					...tenant(),
					branchId: "branch-1",
					pullRequestUrl: "https://example.com/other",
				});

				expect(again).toBe("already_completed");
				expect(await syncRows()).toEqual(before);
				expect(await rawSettings()).toEqual(settingsBefore);
			});

			it("does nothing for a branch the move does not name, or when no move is open", async () => {
				expect(
					await completeInstructionMigration({
						...tenant(),
						branchId: "branch-1",
						pullRequestUrl: null,
					}),
				).toBe("not_applicable");
				await startedOnBranch();

				const result = await completeInstructionMigration({
					...tenant(),
					branchId: "someone-elses-branch",
					pullRequestUrl: null,
				});

				expect(result).toBe("not_applicable");
				const settings = await rawSettings();
				expect(settings.sourceOfTruth).toBe("UPLOAD");
				expect((await syncRows())[0]?.automaticPausedReason).toBe(
					"MIGRATING",
				);
			});

			it("names the branch through the proposal when the pointer has not recorded it yet", async () => {
				const started = await start();
				if (!started.ok) {
					throw new Error("start was refused");
				}
				const proposal = await db.projectInstructionSnapshot.create({
					data: {
						projectId,
						organizationId: ORGANIZATION_ID,
						userId: ADMIN_ID,
						version: 900,
						source: "UPLOAD",
						status: "READY",
						settingsFrozen: {},
						fileCount: 0,
					},
				});
				const branch = await db.projectInstructionProposalBranch.create(
					{
						data: {
							organizationId: ORGANIZATION_ID,
							projectId,
							userId: ADMIN_ID,
							repositoryKey: `github.com/example-org/${REPO}`,
							number: 1,
							ref: `fabric/instructions/${RUN_ID}`,
							destination: {},
						},
					},
				);
				await db.projectInstructionSnapshot.update({
					where: { id: proposal.id },
					data: { proposalBranchId: branch.id },
				});
				await attachInstructionMigrationProposal({
					...tenant(),
					syncId: started.sync.id,
					snapshotId: proposal.id,
				});

				const result = await completeInstructionMigration({
					...tenant(),
					branchId: branch.id,
					pullRequestUrl: null,
				});

				expect(result).toBe("completed");
				await db.projectInstructionSnapshot.deleteMany({
					where: { proposalBranchId: branch.id },
				});
				await db.projectInstructionProposalBranch.delete({
					where: { id: branch.id },
				});
			});
		});

		describe("settle after the first sync", () => {
			it("clears the pointer once, and only for a switching move", async () => {
				const started = await start();
				if (!started.ok) {
					throw new Error("start was refused");
				}
				await attachInstructionMigrationProposal({
					...tenant(),
					syncId: started.sync.id,
					branchId: "branch-1",
				});
				const early = await settleInstructionMigrationAfterSync({
					...tenant(),
					syncId: started.sync.id,
					snapshotId: "snapshot-9",
				});
				await completeInstructionMigration({
					...tenant(),
					branchId: "branch-1",
					pullRequestUrl: null,
				});

				const settled = await settleInstructionMigrationAfterSync({
					...tenant(),
					syncId: started.sync.id,
					snapshotId: "snapshot-9",
				});
				const again = await settleInstructionMigrationAfterSync({
					...tenant(),
					syncId: started.sync.id,
					snapshotId: "snapshot-9",
				});

				expect(early, "a move still proposing is not over").toBe(false);
				expect(settled).toBe(true);
				expect(again).toBe(false);
				const settings = await rawSettings();
				expect(settings.migration).toBeUndefined();
				expect(settings.sourceOfTruth).toBe("REPOSITORY");
				expect(await auditActions(started.sync.id)).toEqual([
					"project.instructions.repository_migration_completed",
					"project.instructions.repository_migration_completed",
				]);
				const stages = (
					await db.auditLog.findMany({
						where: {
							organizationId: ORGANIZATION_ID,
							resourceId: started.sync.id,
							action: "project.instructions.repository_migration_completed",
						},
						select: { metadata: true },
					})
				)
					.map((row) => (row.metadata as { stage?: string }).stage)
					.sort();
				expect(
					stages,
					"one row when the project switched, one when its first sync from the repository succeeded",
				).toEqual(["switched", "synced"]);
			});

			it("records the switch at the flip, before any sync has run", async () => {
				const started = await start();
				if (!started.ok) {
					throw new Error("start was refused");
				}
				await attachInstructionMigrationProposal({
					...tenant(),
					syncId: started.sync.id,
					branchId: "branch-1",
				});

				await completeInstructionMigration({
					...tenant(),
					branchId: "branch-1",
					pullRequestUrl: null,
				});
				await completeInstructionMigration({
					...tenant(),
					branchId: "branch-1",
					pullRequestUrl: null,
				});

				const rows = await db.auditLog.findMany({
					where: {
						organizationId: ORGANIZATION_ID,
						resourceId: started.sync.id,
					},
					select: { action: true, metadata: true, userId: true },
				});
				expect(rows).toHaveLength(1);
				expect(rows[0]).toMatchObject({
					action: "project.instructions.repository_migration_completed",
					userId: ADMIN_ID,
					metadata: { stage: "switched" },
				});
			});
		});

		describe("abandon", () => {
			it("deletes the sync row without writing UPLOAD, clears the pointer and records the cancellation", async () => {
				const started = await start();
				if (!started.ok) {
					throw new Error("start was refused");
				}

				const abandoned = await abandonInstructionMigration({
					...tenant(),
					syncId: started.sync.id,
					reason: "pull_request_closed",
				});

				expect(abandoned).toBe("abandoned");
				expect(await syncRows()).toHaveLength(0);
				const settings = await rawSettings();
				expect(settings.migration).toBeUndefined();
				expect(settings.sourceOfTruth).toBe("UPLOAD");
				expect(await auditActions(started.sync.id)).toEqual([
					"project.instructions.repository_migration_canceled",
				]);
			});

			it("leaves a project whose settings had no source of truth key without one", async () => {
				await db.project.update({
					where: { id: projectId },
					data: { instructionSettings: {} },
				});
				const started = await start();
				if (!started.ok) {
					throw new Error("start was refused");
				}

				await abandonInstructionMigration({
					...tenant(),
					syncId: started.sync.id,
					reason: "canceled",
					actorUserId: ADMIN_ID,
				});

				expect(await rawSettings()).toEqual({});
			});

			it("writes no audit row for a move that never opened", async () => {
				const started = await start();
				if (!started.ok) {
					throw new Error("start was refused");
				}

				await abandonInstructionMigration({
					...tenant(),
					syncId: started.sync.id,
					reason: "start_failed",
				});

				expect(await auditActions(started.sync.id)).toEqual([]);
				expect(await syncRows()).toHaveLength(0);
			});

			it("cannot abandon a move that has switched, or one it does not name, and is safe to repeat", async () => {
				const started = await start();
				if (!started.ok) {
					throw new Error("start was refused");
				}
				await attachInstructionMigrationProposal({
					...tenant(),
					syncId: started.sync.id,
					branchId: "branch-1",
				});

				expect(
					await abandonInstructionMigration({
						...tenant(),
						syncId: "another",
						reason: "canceled",
					}),
				).toBe("not_applicable");
				await completeInstructionMigration({
					...tenant(),
					branchId: "branch-1",
					pullRequestUrl: null,
				});
				expect(
					await abandonInstructionMigration({
						...tenant(),
						syncId: started.sync.id,
						reason: "pull_request_closed",
					}),
				).toBe("not_applicable");
				expect(await syncRows()).toHaveLength(1);
				expect((await rawSettings()).sourceOfTruth).toBe("REPOSITORY");
			});

			it("leaves the sync row and the pointer alone when the project was flipped to the repository behind the move's back, and says so", async () => {
				const started = await start();
				if (!started.ok) {
					throw new Error("start was refused");
				}
				const pointer = (await rawSettings()).migration;
				await db.project.update({
					where: { id: projectId },
					data: {
						instructionSettings: {
							sourceOfTruth: "REPOSITORY",
							migration: pointer as object,
						},
					},
				});

				const result = await abandonInstructionMigration({
					...tenant(),
					syncId: started.sync.id,
					reason: "pull_request_closed",
				});

				expect(result).toBe("source_flipped");
				expect(
					await syncRows(),
					"the row now belongs to whatever flipped the project",
				).toHaveLength(1);
				const settings = await rawSettings();
				expect(settings.migration).toEqual(pointer);
				expect(settings.sourceOfTruth).toBe("REPOSITORY");
				expect(await auditActions(started.sync.id)).toEqual([]);
			});
		});

		describe("the move's proposal", () => {
			const LIMITS = { maxFiles: 5_000, maxTotalBytes: 52_428_800 };
			const PUBLISHED_PATHS = ["CLAUDE.md", "rules/a.md", "rules/b.md"];
			const SHA = "a".repeat(40);
			const REPOSITORY = {
				provider: "GITHUB" as const,
				owner: "example-org",
				repo: REPO,
			};

			const basePrefix = () =>
				`projects/${projectId}/instructions/snapshots/${publishedId}/`;

			/** The published version holds `PUBLISHED_PATHS`, as a promoted upload does. */
			async function publishFiles(): Promise<void> {
				await db.projectInstructionFile.createMany({
					data: PUBLISHED_PATHS.map((path, index) => ({
						snapshotId: publishedId,
						projectId,
						organizationId: ORGANIZATION_ID,
						userId: OWNER_ID,
						path,
						kind: "INSTRUCTIONS" as const,
						storageKey: `${basePrefix()}file-${index}`,
						sha256: createHash("sha256").update(path).digest("hex"),
						size: 10 + index,
						mimeType: "text/markdown",
						isText: true,
					})),
				});
				await db.projectInstructionSnapshot.update({
					where: { id: publishedId },
					data: { fileCount: PUBLISHED_PATHS.length },
				});
			}

			function destination(syncId: string, generation: number) {
				return {
					kind: "REPOSITORY" as const,
					operationId: `move-${RUN_ID}-${generation}`,
					syncId,
					syncGeneration: generation,
					context: {
						v: 2,
						integrationId,
						syncId,
						syncGeneration: generation,
						provider: "GITHUB",
						targetRef: "main",
						rootPath: ".claude",
						baseCommitSha: SHA,
						repository: REPOSITORY,
						author: {
							name: "Dev Example",
							email: "noreply@example.com",
						},
						committer: {
							name: "Fabric",
							email: "noreply@example.com",
						},
						message: "Move coding instructions into the repository",
						committedAt: "2026-10-03T10:00:00Z",
					},
					uploadStartedAudit: {
						actor: { type: "user" as const, userId: ADMIN_ID },
						organizationId: ORGANIZATION_ID,
						projectId,
						metadata: {
							mode: "proposal" as const,
							baseSnapshotId: publishedId,
							baseVersion: 1,
							putCount: PUBLISHED_PATHS.length,
							deleteCount: 0,
							via: "migration",
						},
					},
				};
			}

			async function startAndDerive(
				over: Partial<
					Parameters<typeof createDerivedInstructionSnapshot>[0]
				> = {},
			) {
				const started = await start();
				if (!started.ok) {
					throw new Error("start was refused");
				}
				const created = await createDerivedInstructionSnapshot({
					...tenant(),
					userId: ADMIN_ID,
					baseSnapshotId: publishedId,
					publishOnReady: false,
					proposal: true,
					migration: true,
					changes: [],
					limits: LIMITS,
					baseKeyPrefix: basePrefix(),
					note: {
						title: "Move coding instructions into the repository",
					},
					destination: destination(
						started.sync.id,
						started.sync.generation,
					),
					...over,
				});
				return { started, created };
			}

			it("carries every published path and nothing else, inherited from the published rows, with no base", async () => {
				await publishFiles();

				const { created } = await startAndDerive();

				expect(created).toMatchObject({
					ok: true,
					fileCount: PUBLISHED_PATHS.length,
					inheritedCount: PUBLISHED_PATHS.length,
					staged: [],
				});
				if (!created.ok) {
					return;
				}
				const row =
					await db.projectInstructionSnapshot.findUniqueOrThrow({
						where: { id: created.id },
						select: {
							baseSnapshotId: true,
							baseVersion: true,
							proposalDestination: true,
							proposalStatus: true,
							pullRequestState: true,
							publishOnReady: true,
							userId: true,
							files: {
								select: {
									path: true,
									sha256: true,
									inheritedFromFileId: true,
								},
								orderBy: { path: "asc" },
							},
						},
					});
				const published = await db.projectInstructionFile.findMany({
					where: { snapshotId: publishedId },
					select: { id: true, path: true, sha256: true },
					orderBy: { path: "asc" },
				});
				expect(row).toMatchObject({
					baseSnapshotId: null,
					proposalDestination: "REPOSITORY",
					proposalStatus: "PENDING",
					pullRequestState: "QUEUED",
					publishOnReady: false,
					userId: ADMIN_ID,
				});
				const base =
					await db.projectInstructionSnapshot.findUniqueOrThrow({
						where: { id: publishedId },
						select: { version: true },
					});
				expect(row.baseVersion).toBe(base.version);
				expect(row.files.map((f) => f.path)).toEqual(PUBLISHED_PATHS);
				expect(row.files.map((f) => f.sha256)).toEqual(
					published.map((f) => f.sha256),
				);
				expect(row.files.map((f) => f.inheritedFromFileId)).toEqual(
					published.map((f) => f.id),
				);
			});

			it("writes the proposal's upload_started audit with the row", async () => {
				await publishFiles();

				const { created } = await startAndDerive();

				expect(created.ok).toBe(true);
				if (!created.ok) {
					return;
				}
				const audits = await db.auditLog.findMany({
					where: {
						organizationId: ORGANIZATION_ID,
						action: "project.instructions.upload_started",
						resourceId: created.id,
					},
					select: { userId: true, metadata: true },
				});
				expect(audits).toHaveLength(1);
				expect(audits[0]).toMatchObject({
					userId: ADMIN_ID,
					metadata: { mode: "proposal", via: "migration" },
				});
			});

			it("is refused when the published version moved since the move read it", async () => {
				await publishFiles();
				const started = await start();
				if (!started.ok) {
					throw new Error("start was refused");
				}
				await db.project.update({
					where: { id: projectId },
					data: { publishedInstructionSnapshotId: null },
				});

				const created = await createDerivedInstructionSnapshot({
					...tenant(),
					userId: ADMIN_ID,
					baseSnapshotId: publishedId,
					publishOnReady: false,
					proposal: true,
					migration: true,
					changes: [],
					limits: LIMITS,
					baseKeyPrefix: basePrefix(),
					note: null,
					destination: destination(
						started.sync.id,
						started.sync.generation,
					),
				});

				expect(created).toEqual({
					ok: false,
					reason: "base_not_published",
				});
			});

			it("refuses a published version with no files", async () => {
				const { created } = await startAndDerive();

				expect(created).toEqual({ ok: false, reason: "empty_result" });
			});

			it.each([
				[
					"carries changes",
					{ changes: [{ op: "delete" as const, path: "CLAUDE.md" }] },
				],
				["is not a proposal", { proposal: false }],
				["has no destination", { destination: undefined }],
			])(
				"is a programming error for a move that %s",
				async (_label, over) => {
					await publishFiles();
					const started = await start();
					if (!started.ok) {
						throw new Error("start was refused");
					}

					await expect(
						createDerivedInstructionSnapshot({
							...tenant(),
							userId: ADMIN_ID,
							baseSnapshotId: publishedId,
							publishOnReady: false,
							proposal: true,
							migration: true,
							changes: [],
							limits: LIMITS,
							baseKeyPrefix: basePrefix(),
							note: null,
							destination: destination(
								started.sync.id,
								started.sync.generation,
							),
							...over,
						}),
					).rejects.toThrow(/proposal|migration/);
				},
			);

			describe("joined to a member branch while the project is still upload-backed", () => {
				const naming = {
					memberBranchRef,
					repositoryIdentity: (provider: string, url: string) => {
						const found =
							/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/.exec(
								url,
							);
						return provider === "GITHUB" && found
							? {
									provider: "GITHUB" as const,
									owner: found[1] as string,
									repo: found[2] as string,
								}
							: null;
					},
					repositoryKey: (r: { owner?: string; repo?: string }) =>
						`github:${r.owner?.toLowerCase()}/${r.repo?.toLowerCase()}`,
				};

				it("joins the move's proposal to the admin's branch, since the move's sync row stands in for a destination", async () => {
					await publishFiles();
					const { created } = await startAndDerive();
					if (!created.ok) {
						throw new Error("the proposal was refused");
					}

					const joined = await joinProposalBranch({
						snapshotId: created.id,
						organizationId: ORGANIZATION_ID,
						naming: naming as never,
					});

					expect(joined.kind).toBe("joined");
					const settings = await rawSettings();
					expect(settings.sourceOfTruth).toBe("UPLOAD");
					if (joined.kind === "joined") {
						const proposal =
							await db.projectInstructionSnapshot.findUniqueOrThrow(
								{
									where: { id: created.id },
									select: { proposalBranchId: true },
								},
							);
						expect(proposal.proposalBranchId).toBe(joined.branchId);
					}
				});

				it("does not join it once the move is over: an upload-backed project has no destination", async () => {
					await publishFiles();
					const { started, created } = await startAndDerive();
					if (!created.ok) {
						throw new Error("the proposal was refused");
					}
					await abandonInstructionMigration({
						...tenant(),
						syncId: started.sync.id,
						reason: "canceled",
					});

					const joined = await joinProposalBranch({
						snapshotId: created.id,
						organizationId: ORGANIZATION_ID,
						naming: naming as never,
					});

					expect(joined.kind).not.toBe("joined");
				});

				it("does not join it for a pointer that names another sync row", async () => {
					await publishFiles();
					const { created } = await startAndDerive();
					if (!created.ok) {
						throw new Error("the proposal was refused");
					}
					const project = await db.project.findUniqueOrThrow({
						where: { id: projectId },
						select: { instructionSettings: true },
					});
					const settings = project.instructionSettings as {
						migration: Record<string, unknown>;
					};
					await db.project.update({
						where: { id: projectId },
						data: {
							instructionSettings: {
								...settings,
								migration: {
									...settings.migration,
									syncId: "another",
								},
							},
						},
					});

					const joined = await joinProposalBranch({
						snapshotId: created.id,
						organizationId: ORGANIZATION_ID,
						naming: naming as never,
					});

					expect(joined.kind).not.toBe("joined");
				});
			});
		});

		describe("expediting a branch that is waiting out a backoff", () => {
			it("makes a branch still opening due now, at the attempt the caller read, and only then", async () => {
				const branch = await db.projectInstructionProposalBranch.create(
					{
						data: {
							organizationId: ORGANIZATION_ID,
							projectId,
							userId: ADMIN_ID,
							repositoryKey: `github:example-org/${REPO}`,
							number: 1,
							ref: `fabric/instructions/members/example/${RUN_ID}`,
							state: "PENDING",
							attempt: 2,
							destination: {},
							nextAttemptAt: new Date(Date.now() + 60 * 60_000),
						},
					},
				);

				const stale = await expediteMigrationBranch({
					branchId: branch.id,
					organizationId: ORGANIZATION_ID,
					expectedAttempt: 1,
				});
				const due = await expediteMigrationBranch({
					branchId: branch.id,
					organizationId: ORGANIZATION_ID,
					expectedAttempt: 2,
				});

				expect(stale).toBe(false);
				expect(due).toBe(true);
				const after =
					await db.projectInstructionProposalBranch.findUniqueOrThrow(
						{ where: { id: branch.id } },
					);
				expect(after.attempt).toBe(2);
				expect(after.state).toBe("PENDING");
				expect(
					after.nextAttemptAt?.getTime() ?? Number.POSITIVE_INFINITY,
				).toBeLessThanOrEqual(Date.now() + 1_000);
			});

			it("leaves a branch that is not opening alone", async () => {
				const branch = await db.projectInstructionProposalBranch.create(
					{
						data: {
							organizationId: ORGANIZATION_ID,
							projectId,
							userId: ADMIN_ID,
							repositoryKey: `github:example-org/${REPO}`,
							number: 2,
							ref: `fabric/instructions/members/example/${RUN_ID}-2`,
							state: "OPEN",
							attempt: 2,
							destination: {},
						},
					},
				);

				expect(
					await expediteMigrationBranch({
						branchId: branch.id,
						organizationId: ORGANIZATION_ID,
						expectedAttempt: 2,
					}),
				).toBe(false);
			});
		});

		describe("which branch carries the move", () => {
			it("answers the pointer for the branch it names, and for the branch its proposal is on now, and for no other", async () => {
				const started = await start();
				if (!started.ok) {
					throw new Error("start was refused");
				}
				const proposal = await db.projectInstructionSnapshot.create({
					data: {
						projectId,
						organizationId: ORGANIZATION_ID,
						userId: ADMIN_ID,
						version: 950,
						source: "UPLOAD",
						status: "READY",
						settingsFrozen: {},
						fileCount: 0,
					},
				});
				// One live branch per member, so the second belongs to another one.
				const mkBranch = (number: number, userId: string) =>
					db.projectInstructionProposalBranch.create({
						data: {
							organizationId: ORGANIZATION_ID,
							projectId,
							userId,
							repositoryKey: `github:example-org/${REPO}`,
							number,
							ref: `fabric/instructions/members/example/${RUN_ID}-${number}`,
							destination: {},
						},
					});
				const first = await mkBranch(10, ADMIN_ID);
				const second = await mkBranch(11, OWNER_ID);
				await attachInstructionMigrationProposal({
					...tenant(),
					syncId: started.sync.id,
					snapshotId: proposal.id,
					branchId: first.id,
				});

				const named = await getOpenMigrationOfBranch({
					...tenant(),
					branchId: first.id,
				});
				const before = await getOpenMigrationOfBranch({
					...tenant(),
					branchId: second.id,
				});
				await db.projectInstructionSnapshot.update({
					where: { id: proposal.id },
					data: { proposalBranchId: second.id },
				});
				const rehomed = await getOpenMigrationOfBranch({
					...tenant(),
					branchId: second.id,
				});

				expect(named?.syncId).toBe(started.sync.id);
				expect(before, "a branch the proposal is not on").toBeNull();
				expect(
					rehomed?.syncId,
					"a start over moved the proposal: the new branch carries the move",
				).toBe(started.sync.id);
				expect(
					await completeInstructionMigration({
						...tenant(),
						branchId: second.id,
						pullRequestUrl: null,
					}),
				).toBe("completed");
			});
		});

		describe("the freeze, decided under the project lock", () => {
			const configure = () =>
				upsertInstructionRepositorySync({
					...tenant(),
					userId: OWNER_ID,
					repositoryIntegrationId: integrationId,
					ref: "main",
					rootPath: "docs",
				});

			async function seedSnapshot(
				over: {
					source?: "UPLOAD" | "REPOSITORY";
					settingsFrozen?: object;
					proposalStatus?: "PENDING";
					baseSnapshotId?: string;
				} = {},
			): Promise<string> {
				const id = `migration-snap-${RUN_ID}-${Math.random().toString(36).slice(2, 8)}`;
				const latest = await db.projectInstructionSnapshot.findFirst({
					where: { projectId },
					orderBy: { version: "desc" },
					select: { version: true },
				});
				await db.projectInstructionSnapshot.create({
					data: {
						id,
						projectId,
						organizationId: ORGANIZATION_ID,
						userId: OWNER_ID,
						version: (latest?.version ?? 0) + 1,
						source: over.source ?? "UPLOAD",
						status: "READY",
						settingsFrozen: over.settingsFrozen ?? {},
						fileCount: 0,
						readyAt: new Date(),
						...(over.proposalStatus
							? {
									proposalStatus: over.proposalStatus,
									baseSnapshotId:
										over.baseSnapshotId ?? publishedId,
									baseVersion: 1,
								}
							: {}),
					},
				});
				return id;
			}

			async function openMove() {
				const started = await start();
				if (!started.ok) {
					throw new Error("start was refused");
				}
				return started;
			}

			it("refuses a configure whose pre-check ran before the move started, and leaves the move's sync row exactly as it was", async () => {
				const started = await openMove();
				const [before] = await syncRows();

				await expect(configure()).rejects.toBeInstanceOf(
					InstructionMigrationOpenError,
				);

				const [after] = await syncRows();
				expect(after).toEqual(before);
				expect(after).toMatchObject({
					id: started.sync.id,
					rootPath: ".claude",
					generation: started.sync.generation,
					automaticPausedReason: "MIGRATING",
				});
				const settings = await rawSettings();
				expect(settings.sourceOfTruth).toBe("UPLOAD");
				expect(settings.migration).toMatchObject({
					syncId: started.sync.id,
					state: "PROPOSING",
				});
			});

			it("carries the pointer it found, for the caller to say what the move is waiting for", async () => {
				const started = await openMove();

				const error = await configure().catch((e: unknown) => e);

				expect(error).toBeInstanceOf(InstructionMigrationOpenError);
				expect(
					(error as InstructionMigrationOpenError).pointer,
				).toMatchObject({
					state: "PROPOSING",
					syncId: started.sync.id,
				});
			});

			it("refuses new ignore rules, which would bump the move's sync generation", async () => {
				const started = await openMove();

				await expect(
					updateProjectInstructionSettings(
						projectId,
						ORGANIZATION_ID,
						{
							ignoreGlobs: ["generated/**"],
						},
					),
				).rejects.toBeInstanceOf(InstructionMigrationOpenError);

				const [row] = await syncRows();
				expect(row?.generation).toBe(started.sync.generation);
				expect((await rawSettings()).ignoreGlobs).toBeUndefined();
			});

			it("takes a configure and a move that race to completion one way or the other, never both", async () => {
				const outcomes = new Set<string>();
				for (let round = 0; round < 6; round++) {
					const [moved, configured] = await Promise.allSettled([
						start(),
						configure(),
					]);

					const movedOk =
						moved.status === "fulfilled" && moved.value.ok;
					const configuredOk = configured.status === "fulfilled";
					expect(
						movedOk && configuredOk,
						"a move and a configure cannot both succeed",
					).toBe(false);
					const settings = await rawSettings();
					const rows = await syncRows();
					if (movedOk) {
						outcomes.add("move");
						expect(settings.sourceOfTruth).toBe("UPLOAD");
						expect(settings.migration).toBeDefined();
						expect(rows[0]).toMatchObject({
							automaticPausedReason: "MIGRATING",
							rootPath: ".claude",
						});
					} else {
						outcomes.add("configure");
						expect(settings.sourceOfTruth).toBe("REPOSITORY");
						expect(settings.migration).toBeUndefined();
						expect(rows[0]?.automaticPausedReason).toBeNull();
					}
					await db.projectInstructionRepositorySync.deleteMany({
						where: { projectId },
					});
					await db.project.update({
						where: { id: projectId },
						data: {
							instructionSettings: { sourceOfTruth: "UPLOAD" },
						},
					});
				}
				expect(outcomes.size).toBeGreaterThan(0);
			}, 60_000);

			it("refuses to publish an upload that got past the API's check before the move started, and leaves the pointer", async () => {
				await openMove();
				const snapshotId = await seedSnapshot();

				const result = await publishInstructionSnapshot({
					snapshotId,
					...tenant(),
					requireBaseUnmoved: true,
				});

				expect(result).toMatchObject({
					published: false,
					reason: "migration_open",
					migration: { state: "PROPOSING" },
				});
				const project = await db.project.findUniqueOrThrow({
					where: { id: projectId },
					select: { publishedInstructionSnapshotId: true },
				});
				expect(project.publishedInstructionSnapshotId).toBe(
					publishedId,
				);
			});

			it("refuses a History publish too: choosing a version would change what the move was made from", async () => {
				await openMove();
				const snapshotId = await seedSnapshot();

				const result = await publishInstructionSnapshot({
					snapshotId,
					...tenant(),
					allowRollback: true,
				});

				expect(result).toMatchObject({
					published: false,
					reason: "migration_open",
				});
			});

			it("refuses to approve a pending proposal", async () => {
				await openMove();
				const snapshotId = await seedSnapshot({
					proposalStatus: "PENDING",
				});

				const result = await approveInstructionProposal({
					snapshotId,
					...tenant(),
					reviewerUserId: OWNER_ID,
					audit: {
						action: "project.instructions.proposal_approved",
						category: "project",
						actor: { type: "user", userId: OWNER_ID },
						organizationId: ORGANIZATION_ID,
						projectId,
						resource: {
							type: "project_instruction_snapshot",
							id: snapshotId,
						},
					},
				});

				expect(result).toMatchObject({
					ok: false,
					reason: "migration_open",
					migration: { state: "PROPOSING" },
				});
				const proposal =
					await db.projectInstructionSnapshot.findUniqueOrThrow({
						where: { id: snapshotId },
						select: { proposalStatus: true },
					});
				expect(proposal.proposalStatus).toBe("PENDING");
			});

			it("lets the move's own first sync publish what it produced, while the move is switching", async () => {
				const started = await openMove();
				await attachInstructionMigrationProposal({
					...tenant(),
					syncId: started.sync.id,
					branchId: "branch-1",
				});
				await completeInstructionMigration({
					...tenant(),
					branchId: "branch-1",
					pullRequestUrl: null,
				});
				const synced = await seedSnapshot({
					source: "REPOSITORY",
					settingsFrozen: {
						syncId: started.sync.id,
						syncGeneration: started.sync.generation,
					},
				});

				const result = await publishInstructionSnapshot({
					snapshotId: synced,
					...tenant(),
					requireBaseUnmoved: true,
				});

				expect(result).toEqual({ published: true, changed: true });
			});

			it("refuses a repository snapshot that is not the move's own sync row's", async () => {
				const started = await openMove();
				await attachInstructionMigrationProposal({
					...tenant(),
					syncId: started.sync.id,
					branchId: "branch-1",
				});
				await completeInstructionMigration({
					...tenant(),
					branchId: "branch-1",
					pullRequestUrl: null,
				});
				const other = await seedSnapshot({
					source: "REPOSITORY",
					settingsFrozen: {
						syncId: "another-sync-row",
						syncGeneration: 1,
					},
				});

				const result = await publishInstructionSnapshot({
					snapshotId: other,
					...tenant(),
					requireBaseUnmoved: true,
				});

				expect(result).toMatchObject({
					published: false,
					reason: "migration_open",
				});
			});

			it("publishes as it always did once the move is over", async () => {
				const started = await openMove();
				await abandonInstructionMigration({
					...tenant(),
					syncId: started.sync.id,
					reason: "canceled",
				});
				const snapshotId = await seedSnapshot();

				const result = await publishInstructionSnapshot({
					snapshotId,
					...tenant(),
					requireBaseUnmoved: true,
				});

				expect(result).toEqual({ published: true, changed: true });
			});
		});

		describe("disabling the repository sync", () => {
			it("clears the pointer with the row it names", async () => {
				const started = await start();
				if (!started.ok) {
					throw new Error("start was refused");
				}

				const deleted = await deleteInstructionRepositorySync({
					...tenant(),
				});

				expect(deleted?.deleted).toBe(true);
				expect(await syncRows()).toHaveLength(0);
				const settings = await rawSettings();
				expect(settings.migration).toBeUndefined();
				expect(settings.sourceOfTruth).toBe("UPLOAD");
			});

			it.each([
				["a move that is still proposing", false],
				["a move that has switched", true],
			])(
				"records %s as canceled by the member who switched back to uploads",
				async (_label, switched) => {
					const started = await start();
					if (!started.ok) {
						throw new Error("start was refused");
					}
					if (switched) {
						await attachInstructionMigrationProposal({
							...tenant(),
							syncId: started.sync.id,
							branchId: "branch-1",
						});
						await completeInstructionMigration({
							...tenant(),
							branchId: "branch-1",
							pullRequestUrl: null,
						});
					}

					await deleteInstructionRepositorySync({
						...tenant(),
						actorUserId: ADMIN_ID,
					});

					const rows = await db.auditLog.findMany({
						where: {
							organizationId: ORGANIZATION_ID,
							resourceId: started.sync.id,
							action: "project.instructions.repository_migration_canceled",
						},
						select: { userId: true, metadata: true },
					});
					expect(rows).toHaveLength(1);
					expect(rows[0]).toMatchObject({
						userId: ADMIN_ID,
						metadata: {
							reason: "switched_to_uploads",
							state: switched ? "SWITCHING" : "PROPOSING",
						},
					});
					const settings = await rawSettings();
					expect(settings.sourceOfTruth).toBe("UPLOAD");
					expect(settings.migration).toBeUndefined();
					expect(await syncRows()).toHaveLength(0);
				},
			);

			it("writes no cancellation for a project with no move open", async () => {
				await db.project.update({
					where: { id: projectId },
					data: {
						instructionSettings: { sourceOfTruth: "REPOSITORY" },
					},
				});

				await deleteInstructionRepositorySync({ ...tenant() });

				const rows = await db.auditLog.count({
					where: {
						organizationId: ORGANIZATION_ID,
						action: "project.instructions.repository_migration_canceled",
					},
				});
				expect(rows).toBe(0);
			});
		});
	},
);
