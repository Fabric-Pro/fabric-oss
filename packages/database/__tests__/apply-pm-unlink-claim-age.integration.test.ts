/**
 * Unlink & re-create's claim clears, against a real Postgres: a held PM
 * create claim is cleared only once it is older than
 * PM_CREATE_CLAIM_RECOVERY_MIN_AGE_MS by the database clock, because until
 * then the push that holds it may still be sending its create. A held claim
 * with no timestamp never qualifies (SQL `NULL <= x` is not true). A miss on
 * the age alone is reported as `claimTooRecent` with the time the claim can
 * be cleared; the row is left as it was.
 *
 * Runs with RUN_DB_INTEGRATION=1 against DATABASE_URL; skipped otherwise.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db, Prisma } from "../prisma/client";
import {
	applyPmUnlink,
	applyTestCasePmUnlink,
	clearPmCreateClaim,
	clearTestCasePmCreateClaim,
} from "../prisma/queries/apply-pm-unlink";
import { PM_CREATE_CLAIM_RECOVERY_MIN_AGE_MS } from "../prisma/queries/pm-create-claim-recovery";
import { hasReachableDatabaseUrl } from "./_helpers/db-availability";

const RUN_ID = `${Date.now()}-${process.pid}`;
const ORG_ID = `test-pm-unlink-age-org-${RUN_ID}`;
const USER_ID = `test-pm-unlink-age-user-${RUN_ID}`;

/** Inside the bound: its holder may still be sending. */
const recent = () => new Date(Date.now() - 60_000);
/** Past the bound: clearable. */
const old = () =>
	new Date(Date.now() - PM_CREATE_CLAIM_RECOVERY_MIN_AGE_MS - 60_000);

type Age = "recent" | "old" | "none";
const claimedAtFor = (age: Age) =>
	age === "recent" ? recent() : age === "old" ? old() : null;

describe.skipIf(
	process.env.RUN_DB_INTEGRATION !== "1" || !hasReachableDatabaseUrl(),
)("PM create claim age on Unlink & re-create (real Postgres)", () => {
	let projectId = "";
	let statusId = "";
	let seq = 0;

	beforeAll(async () => {
		const now = new Date();
		await db.$executeRaw(Prisma.sql`
			INSERT INTO "user" (id, name, email, "emailVerified", "onboardingComplete", "createdAt", "updatedAt")
			VALUES (${USER_ID}, ${"PM Unlink Age User"}, ${`${USER_ID}@example.com`}, true, false, ${now}, ${now})
			ON CONFLICT (id) DO NOTHING
		`);
		await db.$executeRaw(Prisma.sql`
			INSERT INTO "organization" (id, name, slug, "createdAt")
			VALUES (${ORG_ID}, ${"PM Unlink Age Org"}, ${ORG_ID}, ${now})
			ON CONFLICT (id) DO NOTHING
		`);
		const project = await db.project.create({
			data: {
				name: "PM Unlink Age Project",
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
		await db.projectStoryStatus.deleteMany({ where: { projectId } });
		await db.project.deleteMany({ where: { id: projectId } });
		await db.$executeRaw(
			Prisma.sql`DELETE FROM "organization" WHERE id = ${ORG_ID}`,
		);
		await db.$executeRaw(
			Prisma.sql`DELETE FROM "user" WHERE id = ${USER_ID}`,
		);
	});

	async function story(age: Age, externalId: string | null = null) {
		seq++;
		const row = await db.userStory.create({
			data: {
				projectId,
				statusId,
				identifier: `PMA-${seq}`,
				title: `Story ${seq}`,
				kind: "FEATURE",
				priority: "P2_MEDIUM",
				createdById: USER_ID,
				source: "MANUAL",
				externalId,
				externalMcpServerId: externalId ? "srv-1" : null,
				pmCreateClaimId: "claim-read",
				pmCreateClaimedAt: claimedAtFor(age),
			},
		});
		return { id: row.id, claimedAt: row.pmCreateClaimedAt };
	}

	async function testCase(age: Age, externalId: string | null = null) {
		seq++;
		const row = await db.testCase.create({
			data: {
				projectId,
				organizationId: ORG_ID,
				identifier: `TCA-${seq}`,
				title: `Case ${seq}`,
				createdById: USER_ID,
				externalId,
				externalMcpServerId: externalId ? "srv-1" : null,
				pmCreateClaimId: "claim-read",
				pmCreateClaimedAt: claimedAtFor(age),
			},
		});
		return { id: row.id, claimedAt: row.pmCreateClaimedAt };
	}

	const storyClaim = async (id: string) =>
		(await db.userStory.findUniqueOrThrow({ where: { id } }))
			.pmCreateClaimId;
	const caseClaim = async (id: string) =>
		(await db.testCase.findUniqueOrThrow({ where: { id } }))
			.pmCreateClaimId;

	const recoverableAt = (claimedAt: Date | null) =>
		claimedAt
			? new Date(
					claimedAt.getTime() + PM_CREATE_CLAIM_RECOVERY_MIN_AGE_MS,
				)
			: null;

	/**
	 * Each helper, run against a row whose claim has the given age; returns
	 * the helper's result and the claim left on the row.
	 */
	const helpers = {
		clearPmCreateClaim: async (age: Age) => {
			const row = await story(age);
			const result = await clearPmCreateClaim({
				projectId,
				storyId: row.id,
				claimId: "claim-read",
			});
			return { result, claim: await storyClaim(row.id), row };
		},
		applyPmUnlink: async (age: Age) => {
			const row = await story(age, "77");
			const result = await applyPmUnlink({
				projectId,
				entityType: "STORY",
				entityId: row.id,
				expectedExternalId: "77",
				expectedExternalMcpServerId: "srv-1",
				expectedPmCreateClaimId: "claim-read",
			});
			return { result, claim: await storyClaim(row.id), row };
		},
		clearTestCasePmCreateClaim: async (age: Age) => {
			const row = await testCase(age);
			const result = await clearTestCasePmCreateClaim({
				projectId,
				testCaseId: row.id,
				claimId: "claim-read",
			});
			return { result, claim: await caseClaim(row.id), row };
		},
		applyTestCasePmUnlink: async (age: Age) => {
			const row = await testCase(age, "77");
			const result = await applyTestCasePmUnlink({
				projectId,
				testCaseId: row.id,
				expectedExternalId: "77",
				expectedExternalUrl: null,
				expectedExternalMcpServerId: "srv-1",
				expectedPmCreateClaimId: "claim-read",
			});
			return { result, claim: await caseClaim(row.id), row };
		},
	};
	const done = (name: string) =>
		name.startsWith("clear") ? { cleared: true } : { applied: true };
	const notDone = (name: string) =>
		name.startsWith("clear") ? { cleared: false } : { applied: false };

	describe.each(Object.keys(helpers) as (keyof typeof helpers)[])(
		"%s",
		(name) => {
			it("refuses a claim younger than the bound, saying when it can be cleared", async () => {
				const { result, claim, row } = await helpers[name]("recent");

				expect(result).toEqual({
					...notDone(name),
					claimTooRecent: {
						recoverableAt: recoverableAt(row.claimedAt),
					},
				});
				expect(claim).toBe("claim-read");
			});

			it("refuses a held claim with no timestamp", async () => {
				const { result, claim } = await helpers[name]("none");

				expect(result).toEqual({
					...notDone(name),
					claimTooRecent: { recoverableAt: null },
				});
				expect(claim).toBe("claim-read");
			});

			it("clears a claim older than the bound", async () => {
				const { result, claim } = await helpers[name]("old");

				expect(result).toEqual(done(name));
				expect(claim).toBeNull();
			});
		},
	);

	it("a linked story with no claim unlinks with no age to check", async () => {
		seq++;
		const row = await db.userStory.create({
			data: {
				projectId,
				statusId,
				identifier: `PMA-${seq}`,
				title: `Story ${seq}`,
				kind: "FEATURE",
				priority: "P2_MEDIUM",
				createdById: USER_ID,
				source: "MANUAL",
				externalId: "78",
				externalMcpServerId: "srv-1",
			},
		});

		const result = await applyPmUnlink({
			projectId,
			entityType: "STORY",
			entityId: row.id,
			expectedExternalId: "78",
			expectedExternalMcpServerId: "srv-1",
			expectedPmCreateClaimId: null,
		});

		expect(result).toEqual({ applied: true });
	});
});
