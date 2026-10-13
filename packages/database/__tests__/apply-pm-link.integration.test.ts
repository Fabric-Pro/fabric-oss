/**
 * Link to existing item (`applyPmLink`), against a real Postgres.
 *
 * The write is one conditional UPDATE that is its own check-then-act guard:
 * the row must still be in the project, unlinked, hold exactly the create
 * claim the caller read (NULL included, which only `IS NULL` matches), not be
 * PENDING with or without an attempt id (a NULL status is not PENDING: SQL
 * `<>` never matches NULL, so the predicate names it), and, for a test case,
 * not be soft-deleted. A held claim must also be older than
 * PM_CREATE_CLAIM_RECOVERY_MIN_AGE_MS by the database clock, and a held claim
 * with no timestamp never is. Another row linked to the same item is refused by the
 * partial unique index on (projectId, externalId), which a mocked client
 * cannot raise.
 *
 * Runs with RUN_DB_INTEGRATION=1 against DATABASE_URL; skipped otherwise.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db, type PmSyncStatus, Prisma } from "../prisma/client";
import { applyPmLink } from "../prisma/queries/apply-pm-link";
import { PM_CREATE_CLAIM_RECOVERY_MIN_AGE_MS } from "../prisma/queries/pm-create-claim-recovery";
import { hasReachableDatabaseUrl } from "./_helpers/db-availability";

const RUN_ID = `${Date.now()}-${process.pid}`;
const ORG_ID = `test-pm-link-org-${RUN_ID}`;
const USER_ID = `test-pm-link-user-${RUN_ID}`;
const SERVER = "srv-active";
const SYNCED_AT = new Date("2026-01-02T03:04:05.000Z");
/** Older than PM_CREATE_CLAIM_RECOVERY_MIN_AGE_MS: clearable. */
const CLAIMED_LONG_AGO = new Date(Date.now() - 60 * 60_000);

describe.skipIf(
	process.env.RUN_DB_INTEGRATION !== "1" || !hasReachableDatabaseUrl(),
)("applyPmLink (real Postgres)", () => {
	let projectId = "";
	let otherProjectId = "";
	let statusId = "";
	let seq = 0;

	beforeAll(async () => {
		const now = new Date();
		await db.$executeRaw(Prisma.sql`
			INSERT INTO "user" (id, name, email, "emailVerified", "onboardingComplete", "createdAt", "updatedAt")
			VALUES (${USER_ID}, ${"PM Link Test User"}, ${`${USER_ID}@example.com`}, true, false, ${now}, ${now})
			ON CONFLICT (id) DO NOTHING
		`);
		await db.$executeRaw(Prisma.sql`
			INSERT INTO "organization" (id, name, slug, "createdAt")
			VALUES (${ORG_ID}, ${"PM Link Test Org"}, ${ORG_ID}, ${now})
			ON CONFLICT (id) DO NOTHING
		`);
		const project = await db.project.create({
			data: {
				name: "PM Link Test Project",
				userId: USER_ID,
				organizationId: ORG_ID,
			},
		});
		projectId = project.id;
		const other = await db.project.create({
			data: {
				name: "PM Link Other Project",
				userId: USER_ID,
				organizationId: ORG_ID,
			},
		});
		otherProjectId = other.id;
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
		await db.pendingPmStateChange.deleteMany({ where: { projectId } });
		await db.pmTicketMissingStreak.deleteMany({ where: { projectId } });
		await db.userStory.deleteMany({ where: { projectId } });
		await db.testCase.deleteMany({ where: { projectId } });
	});

	afterAll(async () => {
		await db.projectStoryStatus.deleteMany({ where: { projectId } });
		await db.project.deleteMany({
			where: { id: { in: [projectId, otherProjectId] } },
		});
		await db.$executeRaw(
			Prisma.sql`DELETE FROM "organization" WHERE id = ${ORG_ID}`,
		);
		await db.$executeRaw(
			Prisma.sql`DELETE FROM "user" WHERE id = ${USER_ID}`,
		);
	});

	type RowState = {
		externalId?: string | null;
		externalUrl?: string | null;
		externalMcpServerId?: string | null;
		pmCreateClaimId?: string | null;
		pmCreateClaimedAt?: Date | null;
		lastPmSyncStatus?: PmSyncStatus | null;
		lastPmSyncError?: string | null;
		lastPmSyncAttemptId?: string | null;
	};

	/** An unlinked story whose create was not confirmed: claim held, FAILED. */
	async function story(state: RowState = {}) {
		seq++;
		const row = await db.userStory.create({
			data: {
				projectId,
				statusId,
				identifier: `PML-${seq}`,
				title: `Story ${seq}`,
				kind: "FEATURE",
				priority: "P2_MEDIUM",
				createdById: USER_ID,
				source: "MANUAL",
				pmCreateClaimId: "claim-read",
				pmCreateClaimedAt: CLAIMED_LONG_AGO,
				lastPmSyncStatus: "FAILED",
				lastPmSyncError: "may already exist; use Unlink & re-create",
				lastSyncedPmHash: "stale-hash",
				lastSyncedAt: SYNCED_AT,
				...state,
			},
		});
		return row.id;
	}

	async function testCase(
		state: RowState & { deletedAt?: Date | null } = {},
	) {
		seq++;
		const row = await db.testCase.create({
			data: {
				projectId,
				organizationId: ORG_ID,
				identifier: `TCL-${seq}`,
				title: `Case ${seq}`,
				createdById: USER_ID,
				pmCreateClaimId: "claim-read",
				pmCreateClaimedAt: CLAIMED_LONG_AGO,
				lastPmSyncStatus: "FAILED",
				lastPmSyncError: "may already exist; use Unlink & re-create",
				lastSyncedPmHash: "stale-hash",
				lastSyncedAt: SYNCED_AT,
				...state,
			},
		});
		return row.id;
	}

	const linkSelect = {
		externalId: true,
		externalUrl: true,
		externalMcpServerId: true,
		pmCreateClaimId: true,
		pmCreateClaimedAt: true,
		lastSyncedPmHash: true,
		lastSyncedAt: true,
		lastPmSyncStatus: true,
		lastPmSyncError: true,
	};
	const readStory = (id: string) =>
		db.userStory.findUniqueOrThrow({ where: { id }, select: linkSelect });
	const readCase = (id: string) =>
		db.testCase.findUniqueOrThrow({ where: { id }, select: linkSelect });

	const link = {
		externalId: "1234",
		externalUrl: "https://pm.example.com/items/1234",
		externalMcpServerId: SERVER,
	};
	const linkedState = {
		...link,
		pmCreateClaimId: null,
		pmCreateClaimedAt: null,
		lastSyncedPmHash: null,
		lastSyncedAt: SYNCED_AT,
		lastPmSyncStatus: null,
		lastPmSyncError: null,
	};

	describe("story", () => {
		it("links an unlinked story holding the claim read, clears the claim and the failure, keeps lastSyncedAt, and drops missing state", async () => {
			const id = await story();
			await db.pmTicketMissingStreak.create({
				data: {
					projectId,
					entityType: "STORY",
					entityId: id,
					externalId: "old-1",
					missStreak: 2,
				},
			});
			const pending = await db.pendingPmStateChange.create({
				data: {
					projectId,
					entityType: "STORY",
					entityId: id,
					externalId: "old-1",
					previousState: "Active",
					newState: "missing",
					proposedAction: "FLAG_MISSING",
				},
			});

			const result = await applyPmLink({
				storyId: id,
				projectId,
				expectedPmCreateClaimId: "claim-read",
				...link,
			});

			expect(result).toEqual({ status: "linked" });
			expect(await readStory(id)).toEqual(linkedState);
			expect(
				await db.pmTicketMissingStreak.count({
					where: { projectId, entityId: id },
				}),
			).toBe(0);
			expect(
				(
					await db.pendingPmStateChange.findUniqueOrThrow({
						where: { id: pending.id },
					})
				).status,
			).toBe("DISMISSED");
		});

		it("links an unlinked, unclaimed story when the caller read no claim (NULL matched exactly)", async () => {
			const id = await story({
				pmCreateClaimId: null,
				lastPmSyncStatus: null,
				lastPmSyncError: null,
			});

			const result = await applyPmLink({
				storyId: id,
				projectId,
				expectedPmCreateClaimId: null,
				...link,
			});

			expect(result).toEqual({ status: "linked" });
			expect((await readStory(id)).externalId).toBe("1234");
		});

		it("refuses a story linked since the read and leaves its link", async () => {
			const id = await story({
				externalId: "999",
				externalUrl: "https://pm.example.com/items/999",
				pmCreateClaimId: "claim-read",
			});
			const before = await readStory(id);

			const result = await applyPmLink({
				storyId: id,
				projectId,
				expectedPmCreateClaimId: "claim-read",
				...link,
			});

			expect(result).toEqual({ status: "stale", reason: "linked" });
			expect(await readStory(id)).toEqual(before);
		});

		it("refuses a story whose claim changed since the read (a push took a new one)", async () => {
			const id = await story({ pmCreateClaimId: "claim-newer" });
			const before = await readStory(id);

			const result = await applyPmLink({
				storyId: id,
				projectId,
				expectedPmCreateClaimId: "claim-read",
				...link,
			});

			expect(result).toEqual({
				status: "stale",
				reason: "claim-changed",
			});
			expect(await readStory(id)).toEqual(before);
		});

		it("refuses a story that took a claim after the caller read none", async () => {
			const id = await story({ pmCreateClaimId: "claim-newer" });

			const result = await applyPmLink({
				storyId: id,
				projectId,
				expectedPmCreateClaimId: null,
				...link,
			});

			expect(result).toEqual({
				status: "stale",
				reason: "claim-changed",
			});
			expect((await readStory(id)).externalId).toBeNull();
		});

		it.each([
			["for an attempt", "attempt-1"],
			["with no attempt id", null],
		])("refuses a story PENDING %s", async (_label, attemptId) => {
			const id = await story({
				lastPmSyncStatus: "PENDING",
				lastPmSyncAttemptId: attemptId,
			});
			const before = await readStory(id);

			const result = await applyPmLink({
				storyId: id,
				projectId,
				expectedPmCreateClaimId: "claim-read",
				...link,
			});

			expect(result).toEqual({ status: "stale", reason: "pending" });
			expect(await readStory(id)).toEqual(before);
		});

		it("refuses a claim younger than the recovery bound, saying when it can be cleared", async () => {
			const claimedAt = new Date(Date.now() - 60_000);
			const id = await story({ pmCreateClaimedAt: claimedAt });
			const before = await readStory(id);

			const result = await applyPmLink({
				storyId: id,
				projectId,
				expectedPmCreateClaimId: "claim-read",
				...link,
			});

			expect(result).toEqual({
				status: "stale",
				reason: "claim-too-recent",
				recoverableAt: new Date(
					claimedAt.getTime() + PM_CREATE_CLAIM_RECOVERY_MIN_AGE_MS,
				),
			});
			expect(await readStory(id)).toEqual(before);
		});

		it("refuses a held claim with no timestamp as too recent", async () => {
			const id = await story({ pmCreateClaimedAt: null });

			const result = await applyPmLink({
				storyId: id,
				projectId,
				expectedPmCreateClaimId: "claim-read",
				...link,
			});

			expect(result).toEqual({
				status: "stale",
				reason: "claim-too-recent",
				recoverableAt: null,
			});
			expect((await readStory(id)).externalId).toBeNull();
		});

		it("refuses a story in another project as missing", async () => {
			const id = await story();

			const result = await applyPmLink({
				storyId: id,
				projectId: otherProjectId,
				expectedPmCreateClaimId: "claim-read",
				...link,
			});

			expect(result).toEqual({ status: "stale", reason: "missing" });
			expect((await readStory(id)).externalId).toBeNull();
		});

		it("refuses an item already linked to another story, naming it, and writes nothing", async () => {
			await story({
				externalId: "1234",
				pmCreateClaimId: null,
				lastPmSyncStatus: "SUCCESS",
			});
			const holder = `PML-${seq}`;
			const id = await story();
			const before = await readStory(id);

			const result = await applyPmLink({
				storyId: id,
				projectId,
				expectedPmCreateClaimId: "claim-read",
				...link,
			});

			expect(result).toEqual({
				status: "taken",
				otherIdentifier: holder,
			});
			expect(await readStory(id)).toEqual(before);
		});
	});

	describe("test case", () => {
		it("links an unlinked case holding the claim read and clears the claim and the failure", async () => {
			const id = await testCase();
			await db.pmTicketMissingStreak.create({
				data: {
					projectId,
					entityType: "TEST_CASE",
					entityId: id,
					externalId: "old-1",
					missStreak: 1,
				},
			});

			const result = await applyPmLink({
				testCaseId: id,
				projectId,
				expectedPmCreateClaimId: "claim-read",
				...link,
			});

			expect(result).toEqual({ status: "linked" });
			expect(await readCase(id)).toEqual(linkedState);
			expect(
				await db.pmTicketMissingStreak.count({
					where: { projectId, entityId: id },
				}),
			).toBe(0);
		});

		it("links a case whose status is NULL with an attempt id (NULL is not PENDING)", async () => {
			const id = await testCase({
				lastPmSyncStatus: null,
				lastPmSyncAttemptId: "attempt-old",
			});

			const result = await applyPmLink({
				testCaseId: id,
				projectId,
				expectedPmCreateClaimId: "claim-read",
				...link,
			});

			expect(result).toEqual({ status: "linked" });
		});

		it("refuses a case whose claim is younger than the recovery bound", async () => {
			const id = await testCase({
				pmCreateClaimedAt: new Date(Date.now() - 60_000),
			});
			const before = await readCase(id);

			const result = await applyPmLink({
				testCaseId: id,
				projectId,
				expectedPmCreateClaimId: "claim-read",
				...link,
			});

			expect(result).toMatchObject({
				status: "stale",
				reason: "claim-too-recent",
			});
			expect(await readCase(id)).toEqual(before);
		});

		it("refuses a soft-deleted case as missing", async () => {
			const id = await testCase({ deletedAt: new Date() });
			const before = await readCase(id);

			const result = await applyPmLink({
				testCaseId: id,
				projectId,
				expectedPmCreateClaimId: "claim-read",
				...link,
			});

			expect(result).toEqual({ status: "stale", reason: "missing" });
			expect(await readCase(id)).toEqual(before);
		});

		it("refuses a case PENDING for an attempt", async () => {
			const id = await testCase({
				lastPmSyncStatus: "PENDING",
				lastPmSyncAttemptId: "attempt-1",
			});
			const before = await readCase(id);

			const result = await applyPmLink({
				testCaseId: id,
				projectId,
				expectedPmCreateClaimId: "claim-read",
				...link,
			});

			expect(result).toEqual({ status: "stale", reason: "pending" });
			expect(await readCase(id)).toEqual(before);
		});

		it("refuses a case whose claim changed since the read", async () => {
			const id = await testCase({ pmCreateClaimId: "claim-newer" });

			const result = await applyPmLink({
				testCaseId: id,
				projectId,
				expectedPmCreateClaimId: "claim-read",
				...link,
			});

			expect(result).toEqual({
				status: "stale",
				reason: "claim-changed",
			});
			expect((await readCase(id)).externalId).toBeNull();
		});

		it("refuses an item already linked to a soft-deleted case (the index still counts it)", async () => {
			await testCase({
				externalId: "1234",
				pmCreateClaimId: null,
				deletedAt: new Date(),
			});
			const holder = `TCL-${seq}`;
			const id = await testCase();
			const before = await readCase(id);

			const result = await applyPmLink({
				testCaseId: id,
				projectId,
				expectedPmCreateClaimId: "claim-read",
				...link,
			});

			expect(result).toEqual({
				status: "taken",
				otherIdentifier: holder,
			});
			expect(await readCase(id)).toEqual(before);
		});
	});
});
