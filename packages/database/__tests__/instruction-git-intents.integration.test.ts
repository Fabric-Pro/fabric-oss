import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	admitGitIntent,
	claimInstructionSnapshotValidation,
	claimInstructionValidationAttempt,
	claimDueInstructionSyncRows,
	db,
	failInstructionSnapshot,
	loadGitIntent,
	listOpenInstructionProposals,
	publishInstructionSnapshot,
	startInstructionSnapshotValidation,
} from "../index";
import { hasReachableDatabaseUrl } from "./_helpers/db-availability";

const RUN_ID = `${Date.now()}-${process.pid}`;
const ORGANIZATION_ID = `git-intent-org-${RUN_ID}`;
const USER_ID = `git-intent-user-${RUN_ID}`;
const SOURCE_SHA = "a".repeat(40);
const FILE_SHA = "b".repeat(64);
let projectId = "";
const integrationId = `git-intent-integration-${RUN_ID}`;
const syncId = `git-intent-sync-${RUN_ID}`;

function input(snapshotId: string) {
	return {
		snapshotId,
		projectId,
		organizationId: ORGANIZATION_ID,
		userId: USER_ID,
		repositoryIntegrationId: integrationId,
		syncId,
		rootPath: "",
		sourceRef: "main",
		sourceCommitSha: SOURCE_SHA,
		repositoryGeneration: 1,
		settingsFrozen: { syncId: "sync_example", ignoreGlobs: [] },
		delivery: {
			kind: "COMMIT" as const,
			context: { v: 1, syncId },
			message: "Update instructions",
		},
		validated: true,
		entries: [
			{
				op: "PUT" as const,
				path: "CLAUDE.md",
				base: null,
				storageKey: `projects/${projectId}/instructions/staging/${snapshotId}/put`,
				sha256: FILE_SHA,
				size: 12,
				mimeType: "text/markdown",
				isText: true,
				mode: 0o644,
				kind: "INSTRUCTIONS" as const,
			},
			{
				op: "DELETE" as const,
				path: "obsolete.md",
				base: { objectId: "c".repeat(40), mode: 0o644 },
			},
		],
	};
}

describe.skipIf(!hasReachableDatabaseUrl())(
	"native instruction intent admission (real Postgres)",
	() => {
		beforeAll(async () => {
			const now = new Date();
			await db.user.create({
				data: {
					id: USER_ID,
					name: "Native Intent Author",
					email: `${USER_ID}@example.com`,
					emailVerified: true,
					createdAt: now,
					updatedAt: now,
				},
			});
			await db.organization.create({
				data: {
					id: ORGANIZATION_ID,
					name: "Native Intent Organization",
					slug: ORGANIZATION_ID,
					createdAt: now,
				},
			});
			await db.member.create({
				data: {
					organizationId: ORGANIZATION_ID,
					userId: USER_ID,
					role: "owner",
					createdAt: now,
				},
			});
			const project = await db.project.create({
				data: {
					name: "Native Intent Project",
					userId: USER_ID,
					organizationId: ORGANIZATION_ID,
					techStack: [],
					features: [],
					tags: [],
					instructionSettings: { sourceOfTruth: "REPOSITORY" },
				},
			});
			projectId = project.id;
			await db.projectRepositoryIntegration.create({
				data: {
					id: integrationId,
					projectId,
					provider: "GITHUB",
					authMethod: "PAT",
					repositoryUrl:
						"https://example.invalid/fixture/instructions",
					repositoryOwner: "fixture",
					repositoryName: "instructions",
					tokenScopes: [],
				},
			});
			await db.projectInstructionRepositorySync.create({
				data: {
					id: syncId,
					projectId,
					organizationId: ORGANIZATION_ID,
					userId: USER_ID,
					repositoryIntegrationId: integrationId,
					ref: "main",
					rootPath: "",
					generation: 1,
				},
			});
		});

		afterEach(async () => {
			await db.projectInstructionSnapshot.deleteMany({
				where: { projectId, organizationId: ORGANIZATION_ID },
			});
		});

		it("does not claim an overdue native repository on repeated scheduler ticks", async () => {
			const overdue = new Date("2000-01-01T00:00:00Z");
			await db.projectRepositoryIntegration.update({
				where: { id: integrationId },
				data: { status: "ACTIVE" },
			});
			await db.projectInstructionRepositorySync.update({
				where: { id: syncId },
				data: { automatic: true, nextCheckAt: overdue },
			});
			try {
				for (let tick = 0; tick < 3; tick++) {
					const claimed = await db.$transaction((tx) =>
						claimDueInstructionSyncRows(tx, {
							limit: 100,
							leaseMs: 16 * 60 * 1000,
						}),
					);
					expect(claimed.some((row) => row.id === syncId)).toBe(
						false,
					);
				}
				const sync =
					await db.projectInstructionRepositorySync.findUniqueOrThrow(
						{ where: { id: syncId } },
					);
				expect(sync.nextCheckAt).toEqual(overdue);
				expect(
					await db.projectInstructionSnapshot.count({
						where: { projectId },
					}),
				).toBe(0);
				expect(
					await db.projectInstructionRepositorySyncRun.count({
						where: { projectId },
					}),
				).toBe(0);
			} finally {
				await db.projectInstructionRepositorySync.update({
					where: { id: syncId },
					data: { automatic: false },
				});
			}
		});

		afterAll(async () => {
			if (projectId) {
				await db.project.deleteMany({ where: { id: projectId } });
			}
			await db.organization.deleteMany({
				where: { id: ORGANIZATION_ID },
			});
			await db.user.deleteMany({ where: { id: USER_ID } });
			await db.$disconnect();
		});

		it("stores only sealed PUT and DELETE intent rows, never a file tree", async () => {
			const snapshotId = `native-intent-${RUN_ID}`;
			const admitted = await admitGitIntent(input(snapshotId));

			expect(admitted).toMatchObject({
				ok: true,
				snapshotId,
				version: 1,
				changeSetDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
			});
			const intent = await loadGitIntent({
				snapshotId,
				projectId,
				organizationId: ORGANIZATION_ID,
			});
			expect(intent).toMatchObject({
				id: snapshotId,
				status: "READY",
				repositoryGeneration: 1,
				repositoryBaseSha: SOURCE_SHA,
				proposalDestination: "REPOSITORY_COMMIT",
				gitIntentEntries: [
					{
						operation: "PUT",
						path: "CLAUDE.md",
						sha256: FILE_SHA,
					},
					{
						operation: "DELETE",
						path: "obsolete.md",
						storageKey: null,
						sha256: null,
					},
				],
			});
			expect(
				await db.projectInstructionFile.count({
					where: { snapshotId },
				}),
			).toBe(0);
			await expect(
				db.projectInstructionGitIntentEntry.create({
					data: {
						snapshotId,
						projectId,
						organizationId: ORGANIZATION_ID,
						userId: USER_ID,
						operation: "DELETE",
						path: "later.md",
					},
				}),
			).rejects.toThrow("GIT_INTENT_SEALED");
		});

		it("keeps native intents out of snapshot validation and failure transitions", async () => {
			const snapshotId = `native-unvalidated-${RUN_ID}`;
			expect(
				await admitGitIntent({
					...input(snapshotId),
					validated: false,
				}),
			).toMatchObject({ ok: true });
			const scope = {
				snapshotId,
				projectId,
				organizationId: ORGANIZATION_ID,
			};
			expect(await claimInstructionValidationAttempt(scope)).toBeNull();
			expect(await claimInstructionSnapshotValidation(scope)).toEqual({
				changed: false,
			});
			expect(await startInstructionSnapshotValidation(scope)).toEqual({
				changed: false,
			});
			expect(await failInstructionSnapshot(scope)).toEqual({
				changed: false,
			});
			expect(
				await db.projectInstructionSnapshot.findUnique({
					where: { id: snapshotId },
				}),
			).toMatchObject({
				status: "RECEIVING",
				validationAttemptId: null,
			});
		});

		it("cannot publish a native operation as a copied snapshot", async () => {
			const snapshotId = `native-not-publishable-${RUN_ID}`;
			expect(await admitGitIntent(input(snapshotId))).toMatchObject({
				ok: true,
			});
			expect(
				await publishInstructionSnapshot({
					snapshotId,
					projectId,
					organizationId: ORGANIZATION_ID,
				}),
			).toEqual({
				published: false,
				changed: false,
				reason: "not_found",
			});
			expect(
				await db.project.findUnique({ where: { id: projectId } }),
			).toMatchObject({ publishedInstructionSnapshotId: null });
		});

		it("lists only the caller's native changes without full snapshot file rows", async () => {
			const snapshotId = `native-open-${RUN_ID}`;
			await admitGitIntent({
				...input(snapshotId),
				delivery: {
					kind: "PROPOSAL",
					context: { v: 1 },
					operationId: `native-open-op-${RUN_ID}`,
					note: null,
				},
			});
			const naming = {
				repositoryIdentity: () => ({
					provider: "GITHUB" as const,
					owner: "fixture",
					repo: "instructions",
				}),
				repositoryKey: () => "github:fixture/instructions",
			};
			const rows = await listOpenInstructionProposals({
				projectId,
				organizationId: ORGANIZATION_ID,
				userId: USER_ID,
				naming,
			});
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({
				candidate: {
					snapshotId,
					baseSnapshotId: null,
					nativeBase: { generation: 1, commitSha: SOURCE_SHA },
				},
				changes: [
					{ path: "CLAUDE.md", op: "put", sha256: FILE_SHA },
					{ path: "obsolete.md", op: "delete", sha256: null },
				],
			});
			expect(
				await listOpenInstructionProposals({
					projectId,
					organizationId: ORGANIZATION_ID,
					userId: "other-member",
					naming,
				}),
			).toEqual([]);
			expect(
				await db.projectInstructionFile.count({
					where: { snapshotId },
				}),
			).toBe(0);
		});

		it("refuses admission once the project is not repository-backed", async () => {
			await db.project.update({
				where: { id: projectId },
				data: { instructionSettings: { sourceOfTruth: "UPLOAD" } },
			});
			expect(
				await admitGitIntent(input(`native-intent-upload-${RUN_ID}`)),
			).toEqual({ ok: false, reason: "direct_repository_required" });
			expect(
				await db.projectInstructionSnapshot.count({
					where: { projectId, organizationId: ORGANIZATION_ID },
				}),
			).toBe(0);
			await db.project.update({
				where: { id: projectId },
				data: { instructionSettings: { sourceOfTruth: "REPOSITORY" } },
			});
		});

		it("returns one receipt for concurrent retries with different staging keys", async () => {
			const calls = await Promise.all(
				[1, 2, 3].map((attempt) =>
					admitGitIntent(input(`native-retry-${RUN_ID}-${attempt}`)),
				),
			);
			const accepted = calls.filter((result) => result.ok);
			expect(accepted).toHaveLength(3);
			expect(
				new Set(accepted.map((result) => result.snapshotId)).size,
			).toBe(1);
			expect(accepted.filter((result) => !result.existing)).toHaveLength(
				1,
			);
			expect(
				await db.projectInstructionSnapshot.count({
					where: { projectId },
				}),
			).toBe(1);
		});

		it("refuses a changed configuration while retaining the caller's pin", async () => {
			await db.projectInstructionRepositorySync.update({
				where: { id: syncId },
				data: { generation: 2 },
			});
			try {
				expect(
					await admitGitIntent(input(`native-stale-${RUN_ID}`)),
				).toEqual({ ok: false, reason: "configuration_changed" });
			} finally {
				await db.projectInstructionRepositorySync.update({
					where: { id: syncId },
					data: { generation: 1 },
				});
			}
		});

		it("project Read-only refuses direct commits but still accepts suggestions", async () => {
			await db.project.update({
				where: { id: projectId },
				data: { readOnlyMode: true },
			});
			try {
				expect(
					await admitGitIntent(input(`native-readonly-${RUN_ID}`)),
				).toEqual({ ok: false, reason: "read_only" });
				expect(
					await admitGitIntent({
						...input(`native-suggestion-${RUN_ID}`),
						delivery: {
							kind: "PROPOSAL",
							context: { v: 2 },
							operationId: `native-op-${RUN_ID}`,
							note: null,
						},
					}),
				).toMatchObject({ ok: true, existing: false });
			} finally {
				await db.project.update({
					where: { id: projectId },
					data: { readOnlyMode: false },
				});
			}
		});
	},
);
