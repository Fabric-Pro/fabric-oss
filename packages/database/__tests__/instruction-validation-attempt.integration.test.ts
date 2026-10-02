/**
 * Real-Postgres test for the check-run ownership token
 * (`ProjectInstructionSnapshot.validationAttemptId`).
 *
 * A run the API starts carries a token the API wrote to the row first, and
 * every write the run makes names it. What matters is what a STALE attempt
 * (a zombie of a run that failed, or of one a "Try again" replaced) can no
 * longer do to the row, and that the run that really owns it still can. A
 * mocked client cannot show either: the guarantee is the WHERE clause the
 * database evaluates under the row lock.
 *
 * Self-skips when DATABASE_URL is unset or is the CI placeholder.
 *
 * Run with:
 *   pnpm --filter @repo/database exec dotenv -c -e ../../.env.local -- vitest run __tests__/instruction-validation-attempt.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	claimInstructionSnapshotValidation,
	claimInstructionValidationAttempt,
	db,
	failInstructionSnapshot,
	failStaleValidatingInstructionSnapshot,
	getInstructionSyncRunSnapshotProgress,
	markInstructionSnapshotReady,
	recordInstructionSnapshotProgress,
	recordInstructionSyncRunProgress,
	startInstructionSnapshotValidation,
} from "../index";
import { hasReachableDatabaseUrl } from "./_helpers/db-availability";

const RUN_ID = `${Date.now()}-${process.pid}`;
const ORGANIZATION_ID = `attempt-token-org-${RUN_ID}`;
const USER_ID = `attempt-token-user-${RUN_ID}`;
let projectId = "";
let nextVersion = 1;

async function newSnapshot(
	status: "RECEIVING" | "VALIDATING" | "FAILED",
	validationAttemptId: string | null = null,
) {
	const row = await db.projectInstructionSnapshot.create({
		data: {
			projectId,
			organizationId: ORGANIZATION_ID,
			userId: USER_ID,
			version: nextVersion++,
			source: "UPLOAD",
			status,
			settingsFrozen: {},
			validationAttemptId,
		},
		select: { id: true },
	});
	return row.id;
}

function tenant(snapshotId: string) {
	return { snapshotId, projectId, organizationId: ORGANIZATION_ID };
}

function readRow(snapshotId: string) {
	return db.projectInstructionSnapshot.findUniqueOrThrow({
		where: { id: snapshotId },
		select: { status: true, validationAttemptId: true },
	});
}

function readProgress(snapshotId: string) {
	return db.projectInstructionSnapshot.findUniqueOrThrow({
		where: { id: snapshotId },
		select: {
			progressPhase: true,
			progressDone: true,
			progressTotal: true,
		},
	});
}

const NO_PROGRESS = {
	progressPhase: null,
	progressDone: null,
	progressTotal: null,
};

function ready(snapshotId: string, validationAttemptId?: string) {
	return markInstructionSnapshotReady({
		...tenant(snapshotId),
		fileCount: 0,
		storedBytes: 0,
		digest: "d".repeat(64),
		readyAt: new Date(),
		validationAttemptId,
	});
}

describe.skipIf(!hasReachableDatabaseUrl())(
	"instruction check-run ownership token (real Postgres)",
	() => {
		beforeAll(async () => {
			const now = new Date();
			await db.user.create({
				data: {
					id: USER_ID,
					name: "Attempt Token",
					email: `${USER_ID}@example.com`,
					emailVerified: true,
					createdAt: now,
					updatedAt: now,
				},
			});
			await db.organization.create({
				data: {
					id: ORGANIZATION_ID,
					name: "Attempt Token",
					slug: ORGANIZATION_ID,
					createdAt: now,
				},
			});
			const project = await db.project.create({
				data: {
					name: "Attempt Token",
					userId: USER_ID,
					organizationId: ORGANIZATION_ID,
					techStack: [],
					features: [],
					tags: [],
				},
			});
			projectId = project.id;
		});

		afterAll(async () => {
			if (projectId) {
				await db.projectInstructionRepositorySyncRun.deleteMany({
					where: { projectId },
				});
				await db.projectInstructionSnapshot.deleteMany({
					where: { projectId },
				});
				await db.project.deleteMany({ where: { id: projectId } });
			}
			await db.organization.deleteMany({
				where: { id: ORGANIZATION_ID },
			});
			await db.user.deleteMany({ where: { id: USER_ID } });
			await db.$disconnect();
		});

		it("hands every simultaneous finalize of one RECEIVING row the same token", async () => {
			const id = await newSnapshot("RECEIVING");

			const tokens = await Promise.all(
				Array.from({ length: 8 }, () =>
					claimInstructionValidationAttempt(tenant(id)),
				),
			);

			expect(tokens[0]).toEqual(expect.any(String));
			expect(new Set(tokens).size).toBe(1);
			expect((await readRow(id)).validationAttemptId).toBe(tokens[0]);
		});

		it("keeps the token a start already wrote instead of replacing it", async () => {
			const id = await newSnapshot("FAILED", "attempt-live");

			expect(await claimInstructionValidationAttempt(tenant(id))).toBe(
				"attempt-live",
			);
		});

		it("answers null for a row that is no longer waiting for checks", async () => {
			const id = await newSnapshot("VALIDATING", "attempt-live");

			expect(
				await claimInstructionValidationAttempt(tenant(id)),
			).toBeNull();
		});

		it("clears the token when a run fails, so the next Try again gets a fresh one", async () => {
			const id = await newSnapshot("VALIDATING", "attempt-a");

			expect(
				await failInstructionSnapshot({
					...tenant(id),
					validationAttemptId: "attempt-a",
				}),
			).toEqual({ changed: true });

			expect(await readRow(id)).toEqual({
				status: "FAILED",
				validationAttemptId: null,
			});
			const next = await claimInstructionValidationAttempt(tenant(id));
			expect(next).toEqual(expect.any(String));
			expect(next).not.toBe("attempt-a");
		});

		it("lets a stale attempt neither claim, finish, nor fail a row a newer run owns", async () => {
			const id = await newSnapshot("VALIDATING", "attempt-new");

			expect(
				await claimInstructionSnapshotValidation({
					...tenant(id),
					validationAttemptId: "attempt-old",
				}),
			).toEqual({ changed: false });
			expect(await ready(id, "attempt-old")).toEqual({ changed: false });
			expect(
				await failInstructionSnapshot({
					...tenant(id),
					validationAttemptId: "attempt-old",
				}),
			).toEqual({ changed: false });

			expect(await readRow(id)).toEqual({
				status: "VALIDATING",
				validationAttemptId: "attempt-new",
			});
			expect(await ready(id, "attempt-new")).toEqual({ changed: true });
			expect((await readRow(id)).status).toBe("READY");
		});

		it("does not let a zombie of a failed run take the row back to VALIDATING", async () => {
			const id = await newSnapshot("VALIDATING", "attempt-a");
			await failInstructionSnapshot({
				...tenant(id),
				validationAttemptId: "attempt-a",
			});

			expect(
				await claimInstructionSnapshotValidation({
					...tenant(id),
					validationAttemptId: "attempt-a",
				}),
			).toEqual({ changed: false });
			expect((await readRow(id)).status).toBe("FAILED");
		});

		it("lets the run that owns a FAILED row claim it when the API's status write was lost", async () => {
			const id = await newSnapshot("FAILED", "attempt-b");

			expect(
				await claimInstructionSnapshotValidation({
					...tenant(id),
					validationAttemptId: "attempt-b",
				}),
			).toEqual({ changed: true });
			expect((await readRow(id)).status).toBe("VALIDATING");
		});

		it("still lets a run without a token claim only a RECEIVING row", async () => {
			const received = await newSnapshot("RECEIVING");
			const failed = await newSnapshot("FAILED");

			expect(
				await claimInstructionSnapshotValidation(tenant(received)),
			).toEqual({ changed: true });
			expect(
				await claimInstructionSnapshotValidation(tenant(failed)),
			).toEqual({ changed: false });
		});

		it("fences the API's own status write to the token it started the run with", async () => {
			const id = await newSnapshot("FAILED", "attempt-b");

			expect(
				await startInstructionSnapshotValidation({
					...tenant(id),
					validationAttemptId: "attempt-other",
				}),
			).toEqual({ changed: false });
			expect(
				await startInstructionSnapshotValidation({
					...tenant(id),
					validationAttemptId: "attempt-b",
				}),
			).toEqual({ changed: true });
		});

		it("records progress for the run that owns a VALIDATING row, and for nobody else", async () => {
			const id = await newSnapshot("VALIDATING", "attempt-new");
			const report = (
				validationAttemptId: string | undefined,
				done: number,
			) =>
				recordInstructionSnapshotProgress({
					...tenant(id),
					validationAttemptId,
					phase: "CHECKING",
					done,
					total: 10,
				});

			expect(await report("attempt-old", 7)).toEqual({ changed: false });
			expect(await readProgress(id)).toEqual(NO_PROGRESS);

			expect(await report("attempt-new", 3)).toEqual({ changed: true });
			expect(await readProgress(id)).toEqual({
				progressPhase: "CHECKING",
				progressDone: 3,
				progressTotal: 10,
			});
		});

		it("records no progress on a row nothing is checking", async () => {
			for (const status of ["RECEIVING", "FAILED"] as const) {
				const id = await newSnapshot(status, "attempt-a");

				expect(
					await recordInstructionSnapshotProgress({
						...tenant(id),
						validationAttemptId: "attempt-a",
						phase: "CHECKING",
						done: 1,
						total: 2,
					}),
				).toEqual({ changed: false });
				expect(await readProgress(id)).toEqual(NO_PROGRESS);
			}
		});

		it("clears the progress with every write that ends a run", async () => {
			const readyId = await newSnapshot("VALIDATING", "attempt-a");
			const failedId = await newSnapshot("VALIDATING", "attempt-b");
			for (const [id, token] of [
				[readyId, "attempt-a"],
				[failedId, "attempt-b"],
			] as const) {
				await recordInstructionSnapshotProgress({
					...tenant(id),
					validationAttemptId: token,
					phase: "SAVING",
					done: 4,
					total: 4,
				});
			}

			await ready(readyId, "attempt-a");
			await failInstructionSnapshot({
				...tenant(failedId),
				validationAttemptId: "attempt-b",
			});

			expect(await readProgress(readyId)).toEqual(NO_PROGRESS);
			expect(await readProgress(failedId)).toEqual(NO_PROGRESS);
		});

		it("clears the progress when the API or the claim moves a row into VALIDATING", async () => {
			const id = await newSnapshot("FAILED", "attempt-a");
			await db.projectInstructionSnapshot.update({
				where: { id },
				data: {
					progressPhase: "CHECKING",
					progressDone: 9,
					progressTotal: 9,
				},
			});

			await startInstructionSnapshotValidation({
				...tenant(id),
				validationAttemptId: "attempt-a",
			});

			expect(await readProgress(id)).toEqual(NO_PROGRESS);
		});

		describe("repository sync run progress", () => {
			async function newRun(finished: boolean) {
				const id = `sync-progress:${RUN_ID}:${nextVersion++}`;
				await db.projectInstructionRepositorySyncRun.create({
					data: {
						id,
						syncId: "sync-progress",
						projectId,
						organizationId: ORGANIZATION_ID,
						userId: USER_ID,
						generation: 1,
						trigger: "MANUAL",
						startedAt: new Date(),
						finishedAt: finished ? new Date() : null,
					},
				});
				return id;
			}
			const readRun = (id: string) =>
				db.projectInstructionRepositorySyncRun.findUniqueOrThrow({
					where: { id },
					select: {
						progressPhase: true,
						progressDone: true,
						progressTotal: true,
					},
				});

			it("records a phase with no count, then the copy with one, on the open run", async () => {
				const id = await newRun(false);
				const report = (
					phase: "FETCHING" | "COPYING",
					done: number | null,
					total: number | null,
				) =>
					recordInstructionSyncRunProgress({
						runKey: id,
						projectId,
						organizationId: ORGANIZATION_ID,
						phase,
						done,
						total,
					});

				expect(await report("FETCHING", null, null)).toEqual({
					changed: true,
				});
				expect(await readRun(id)).toEqual({
					progressPhase: "FETCHING",
					progressDone: null,
					progressTotal: null,
				});
				await report("COPYING", 3, 8);
				expect(await readRun(id)).toEqual({
					progressPhase: "COPYING",
					progressDone: 3,
					progressTotal: 8,
				});
			});

			it("writes nothing onto a finished run or another tenant's", async () => {
				const finished = await newRun(true);
				const open = await newRun(false);

				expect(
					await recordInstructionSyncRunProgress({
						runKey: finished,
						projectId,
						organizationId: ORGANIZATION_ID,
						phase: "FETCHING",
						done: null,
						total: null,
					}),
				).toEqual({ changed: false });
				expect(
					await recordInstructionSyncRunProgress({
						runKey: open,
						projectId,
						organizationId: "another-org",
						phase: "FETCHING",
						done: null,
						total: null,
					}),
				).toEqual({ changed: false });
				expect(await readRun(finished)).toEqual({
					progressPhase: null,
					progressDone: null,
					progressTotal: null,
				});
				expect(await readRun(open)).toEqual({
					progressPhase: null,
					progressDone: null,
					progressTotal: null,
				});
			});

			it("finds a run's snapshot by its key, with the snapshot's own progress", async () => {
				const runKey = `sync-progress:${RUN_ID}:snapshot`;
				const row = await db.projectInstructionSnapshot.create({
					data: {
						projectId,
						organizationId: ORGANIZATION_ID,
						userId: USER_ID,
						version: nextVersion++,
						source: "REPOSITORY",
						status: "VALIDATING",
						settingsFrozen: {},
						syncRunKey: runKey,
						progressPhase: "CHECKING",
						progressDone: 2,
						progressTotal: 5,
					},
					select: { id: true },
				});

				expect(
					await getInstructionSyncRunSnapshotProgress(
						runKey,
						projectId,
						ORGANIZATION_ID,
					),
				).toMatchObject({
					id: row.id,
					status: "VALIDATING",
					progressPhase: "CHECKING",
					progressDone: 2,
					progressTotal: 5,
				});
				expect(
					await getInstructionSyncRunSnapshotProgress(
						runKey,
						projectId,
						"another-org",
					),
				).toBeNull();
			});
		});

		it("clears the token when the reaper fails a stranded row", async () => {
			const id = await newSnapshot("VALIDATING", "attempt-a");
			const { updatedAt } =
				await db.projectInstructionSnapshot.findUniqueOrThrow({
					where: { id },
					select: { updatedAt: true },
				});

			expect(
				await failStaleValidatingInstructionSnapshot({
					...tenant(id),
					observedUpdatedAt: updatedAt,
				}),
			).toEqual({ changed: true });

			expect(await readRow(id)).toEqual({
				status: "FAILED",
				validationAttemptId: null,
			});
		});
	},
);
