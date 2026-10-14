/**
 * PM-sync status writes made outside a sync run, against a real Postgres.
 *
 *   1. `markPmSyncFailedUnlessPending` (the enqueue's "no usable PM config"
 *      FAILED) must not overwrite a PENDING row, which another user's
 *      in-flight sync owns, and must still mark a NULL row FAILED. In SQL a
 *      bare `last_pm_sync_status <> 'PENDING'` is never true for NULL, so the
 *      predicate has to name NULL explicitly; only a real database shows
 *      which rows it matches.
 *   2. `clearPmSyncConflictFlag` re-arms auto-push only while the row is
 *      still CONFLICT, so it cannot overwrite the PENDING that a conflict
 *      resolution's own enqueue has just stamped.
 *
 * Runs against DATABASE_URL (RUN_DB_INTEGRATION=1); self-skips otherwise.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db, type PmSyncStatus, Prisma } from "../prisma/client";
import {
	clearPmSyncConflictFlag,
	markPmSyncFailedUnlessPending,
} from "../prisma/queries/projects/pm-sync-resolve";
import { hasReachableDatabaseUrl } from "./_helpers/db-availability";

const RUN_ID = `${Date.now()}-${process.pid}`;
const ORG_ID = `test-pm-terminal-org-${RUN_ID}`;
const USER_ID = `test-pm-terminal-user-${RUN_ID}`;

describe.skipIf(!hasReachableDatabaseUrl())(
	"PM-sync status writes outside a run (real Postgres)",
	() => {
		let projectId = "";
		let statusId = "";
		let seq = 0;

		beforeAll(async () => {
			const now = new Date();
			await db.$executeRaw(Prisma.sql`
				INSERT INTO "user" (id, name, email, "emailVerified", "onboardingComplete", "createdAt", "updatedAt")
				VALUES (${USER_ID}, ${"PM Terminal Test User"}, ${`${USER_ID}@example.com`}, true, false, ${now}, ${now})
				ON CONFLICT (id) DO NOTHING
			`);
			await db.$executeRaw(Prisma.sql`
				INSERT INTO "organization" (id, name, slug, "createdAt")
				VALUES (${ORG_ID}, ${"PM Terminal Test Org"}, ${ORG_ID}, ${now})
				ON CONFLICT (id) DO NOTHING
			`);
			const project = await db.project.create({
				data: {
					name: "PM Terminal Test Project",
					userId: USER_ID,
					organizationId: ORG_ID,
				},
			});
			projectId = project.id;
			const status = await db.projectStoryStatus.create({
				data: {
					projectId,
					name: "Backlog",
					color: "#94a3b8",
					order: 0,
					isDefault: true,
				},
			});
			statusId = status.id;
		});

		afterEach(async () => {
			await db.userStory.deleteMany({ where: { projectId } });
		});

		afterAll(async () => {
			await db.projectStoryStatus.deleteMany({ where: { projectId } });
			await db.project.deleteMany({ where: { id: projectId } });
			await db.$executeRaw(
				Prisma.sql`DELETE FROM "organization" WHERE id = ${ORG_ID}`,
			);
			await db.$executeRaw(
				Prisma.sql`DELETE FROM "user" WHERE id = ${USER_ID}`,
			);
		});

		async function story(
			lastPmSyncStatus: PmSyncStatus | null,
			lastPmSyncAttemptId: string | null = null,
		) {
			seq++;
			const row = await db.userStory.create({
				data: {
					projectId,
					statusId,
					identifier: `PMT-${seq}`,
					title: `Story ${seq}`,
					kind: "FEATURE",
					priority: "P2_MEDIUM",
					createdById: USER_ID,
					source: "MANUAL",
					lastPmSyncStatus,
					lastPmSyncAttemptId,
				},
			});
			return row.id;
		}

		async function stateOf(id: string) {
			return db.userStory.findUniqueOrThrow({
				where: { id },
				select: {
					lastPmSyncStatus: true,
					lastPmSyncError: true,
					lastPmSyncAttemptId: true,
				},
			});
		}

		describe("markPmSyncFailedUnlessPending", () => {
			it("leaves a PENDING row (another user's sync) untouched", async () => {
				const id = await story("PENDING", "attempt-other-user");

				const count = await markPmSyncFailedUnlessPending({
					itemId: id,
					error: "No PM config for this user",
				});

				expect(count).toBe(0);
				expect(await stateOf(id)).toEqual({
					lastPmSyncStatus: "PENDING",
					lastPmSyncError: null,
					lastPmSyncAttemptId: "attempt-other-user",
				});
			});

			it.each([null, "SUCCESS", "FAILED", "CONFLICT"] as const)(
				"marks a %s row FAILED",
				async (status) => {
					const id = await story(status);

					const count = await markPmSyncFailedUnlessPending({
						itemId: id,
						error: "No PM config for this user",
					});

					expect(count).toBe(1);
					expect(await stateOf(id)).toMatchObject({
						lastPmSyncStatus: "FAILED",
						lastPmSyncError: "No PM config for this user",
					});
				},
			);
		});

		describe("clearPmSyncConflictFlag", () => {
			it("re-arms a CONFLICT row as SUCCESS", async () => {
				const id = await story("CONFLICT");

				await clearPmSyncConflictFlag({
					itemType: "story",
					itemId: id,
				});

				expect((await stateOf(id)).lastPmSyncStatus).toBe("SUCCESS");
			});

			it.each(["PENDING", "FAILED", null] as const)(
				"leaves a %s row untouched",
				async (status) => {
					const id = await story(status, "attempt-resolve-enqueue");

					await clearPmSyncConflictFlag({
						itemType: "story",
						itemId: id,
					});

					expect((await stateOf(id)).lastPmSyncStatus).toBe(status);
				},
			);
		});
	},
);
