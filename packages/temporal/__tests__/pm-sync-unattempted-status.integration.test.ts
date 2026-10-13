/**
 * A PM-sync run that carries no attempt id must not overwrite a row that is
 * PENDING for an attempt, against a real Postgres.
 *
 * `writePmSyncStatusUnattempted` keeps such a write off a row whose
 * `lastPmSyncStatus` is PENDING and whose `lastPmSyncAttemptId` is set, and
 * lands it on every other row. In SQL `status <> 'PENDING'` is never true for
 * a NULL status, and a leaked-PENDING clear leaves a NULL status with the
 * attempt id kept, so only a real database shows the predicate matches that
 * row. Runs both tables the sync writes (`user_story`, `test_case`).
 *
 * Runs with RUN_DB_INTEGRATION=1 against DATABASE_URL; skipped otherwise.
 */

import { randomUUID } from "node:crypto";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { db, type PmSyncStatus, Prisma } from "../../database/prisma/client";

vi.mock("@repo/database", async () => {
	const { db } = await import("../../database/prisma/client");
	return { db };
});

const { writePmSyncRunStatus, writePmSyncStatusUnattempted } = await import(
	"../src/activities/pm-integration/pm-sync-attempt-fence"
);

const prefix = `pm-unattempted-${randomUUID()}`;
const USER_ID = `${prefix}-user`;
const ORG_ID = `${prefix}-org`;

const FAILED = {
	lastPmSyncStatus: "FAILED" as const,
	lastPmSyncError: "batch push failed",
	lastPmSyncAttemptAt: new Date("2026-02-01T00:00:00Z"),
};

describe.skipIf(process.env.RUN_DB_INTEGRATION !== "1")(
	"PM-sync status writes from a run without an attempt id (real Postgres)",
	() => {
		let projectId = "";
		let statusId = "";
		let seq = 0;

		beforeAll(async () => {
			const now = new Date();
			await db.$executeRaw(Prisma.sql`
				INSERT INTO "user" (id, name, email, "emailVerified", "onboardingComplete", "createdAt", "updatedAt")
				VALUES (${USER_ID}, ${"PM Unattempted Test User"}, ${`${prefix}@example.com`}, true, false, ${now}, ${now})
			`);
			await db.$executeRaw(Prisma.sql`
				INSERT INTO "organization" (id, name, slug, "createdAt")
				VALUES (${ORG_ID}, ${"PM Unattempted Test Org"}, ${ORG_ID}, ${now})
			`);
			const project = await db.project.create({
				data: {
					name: "PM Unattempted Test Project",
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
			await db.testCase.deleteMany({ where: { projectId } });
		});

		afterAll(async () => {
			if (projectId) {
				await db.projectStoryStatus.deleteMany({
					where: { projectId },
				});
				await db.project.deleteMany({ where: { id: projectId } });
			}
			await db.$executeRaw(
				Prisma.sql`DELETE FROM "organization" WHERE id = ${ORG_ID}`,
			);
			await db.$executeRaw(
				Prisma.sql`DELETE FROM "user" WHERE id = ${USER_ID}`,
			);
		});

		async function story(
			lastPmSyncStatus: PmSyncStatus | null,
			lastPmSyncAttemptId: string | null,
		) {
			seq++;
			const row = await db.userStory.create({
				data: {
					projectId,
					statusId,
					identifier: `PMU-${seq}`,
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

		async function testCase(
			lastPmSyncStatus: PmSyncStatus | null,
			lastPmSyncAttemptId: string | null,
		) {
			seq++;
			const row = await db.testCase.create({
				data: {
					projectId,
					organizationId: ORG_ID,
					identifier: `TC-${seq}`,
					title: `Case ${seq}`,
					createdById: USER_ID,
					lastPmSyncStatus,
					lastPmSyncAttemptId,
				},
			});
			return row.id;
		}

		const pmState = {
			lastPmSyncStatus: true,
			lastPmSyncError: true,
			lastPmSyncAttemptId: true,
		} as const;

		describe.each([
			{
				itemType: "story" as const,
				create: story,
				read: (id: string) =>
					db.userStory.findUniqueOrThrow({
						where: { id },
						select: pmState,
					}),
			},
			{
				itemType: "testCase" as const,
				create: testCase,
				read: (id: string) =>
					db.testCase.findUniqueOrThrow({
						where: { id },
						select: pmState,
					}),
			},
		])("$itemType", ({ itemType, create, read }) => {
			it("leaves a row that is PENDING for an attempt untouched", async () => {
				const id = await create("PENDING", "attempt-R");

				const wrote = await writePmSyncStatusUnattempted({
					itemType,
					itemId: id,
					projectId,
					data: FAILED,
				});

				expect(wrote).toBe(false);
				expect(await read(id)).toEqual({
					lastPmSyncStatus: "PENDING",
					lastPmSyncError: null,
					lastPmSyncAttemptId: "attempt-R",
				});
			});

			it.each([
				["a NULL status that kept its attempt id", null, "attempt-R"],
				["a NULL status with no attempt id", null, null],
				["a PENDING with no attempt id", "PENDING", null],
				["SUCCESS", "SUCCESS", "attempt-R"],
				["FAILED", "FAILED", "attempt-R"],
				["CONFLICT", "CONFLICT", "attempt-R"],
			] as const)("writes over %s", async (_, status, attemptId) => {
				const id = await create(status, attemptId);

				const wrote = await writePmSyncStatusUnattempted({
					itemType,
					itemId: id,
					projectId,
					data: FAILED,
				});

				expect(wrote).toBe(true);
				expect(await read(id)).toEqual({
					lastPmSyncStatus: "FAILED",
					lastPmSyncError: "batch push failed",
					lastPmSyncAttemptId: attemptId,
				});
			});

			it("writePmSyncRunStatus with the attempt id still lands on that attempt's PENDING", async () => {
				const id = await create("PENDING", "attempt-R");

				const wrote = await writePmSyncRunStatus({
					itemType,
					itemId: id,
					attemptId: "attempt-R",
					data: FAILED,
				});

				expect(wrote).toBe(true);
				expect((await read(id)).lastPmSyncStatus).toBe("FAILED");
			});

			it("writePmSyncRunStatus without an attempt id skips it", async () => {
				const id = await create("PENDING", "attempt-R");

				const wrote = await writePmSyncRunStatus({
					itemType,
					itemId: id,
					attemptId: undefined,
					data: FAILED,
				});

				expect(wrote).toBe(false);
				expect((await read(id)).lastPmSyncStatus).toBe("PENDING");
			});
		});
	},
);
