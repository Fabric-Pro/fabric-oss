/**
 * The bulk story sync's create (`createStoryInPmWithClaim`) against a real
 * Postgres: the link and this create's SUCCESS commit in one transaction.
 *
 * Inside that transaction the status write is `writePmSyncStatusUnattempted`
 * on the transaction client, so a row PENDING for an attempt keeps its status
 * while the link lands, and every other status (a loser's
 * `create_unconfirmed` FAILED, a NULL status that kept its attempt id, a
 * PENDING with no attempt id) becomes SUCCESS. NULL needs a real database:
 * `status <> 'PENDING'` is never true for it in SQL. The real `updateStory`
 * also shows a link write after Unlink & re-create cleared the claim is
 * refused, and that a same-id link on another URL is not taken as this
 * create's. A create orphan is stamped on the row only while it is unlinked
 * and holds this create's claim, checked in the write itself, so a link
 * another push wrote after Unlink & re-create keeps its status.
 *
 * Runs with RUN_DB_INTEGRATION=1 against DATABASE_URL; skipped otherwise.
 */

import { randomUUID } from "node:crypto";
import {
	clearPmCreateClaim,
	db,
	PM_CREATE_CLAIM_RECOVERY_MIN_AGE_MS,
	type PmSyncStatus,
	Prisma,
} from "@repo/database";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

const recordPmSyncLog = vi.hoisted(() => vi.fn());

vi.mock("../src/activities/orchestrator/execution/execute-mcp-tool", () => ({
	executeMcpTool: vi.fn(),
}));

vi.mock("../src/activities/pm-integration/record-pm-sync-log", () => ({
	recordPmSyncLog,
}));

const { createStoryInPmWithClaim } = await import(
	"../src/activities/pm-integration/create-story-in-pm-with-claim"
);
const { executeMcpTool } = await import(
	"../src/activities/orchestrator/execution/execute-mcp-tool"
);
const { acquirePmCreateClaim } = await import(
	"../src/activities/pm-integration/pm-create-claim"
);

const prefix = `pm-create-link-${randomUUID()}`;
const USER_ID = `${prefix}-user`;
const ORG_ID = `${prefix}-org`;
const CREATED_URL = "https://pm.example.com/cards/1075";

function created() {
	return {
		success: true,
		durationMs: 5,
		output: {
			content: [
				{
					type: "text",
					text: JSON.stringify({ id: "1075", url: CREATED_URL }),
				},
			],
		},
	};
}

describe.skipIf(process.env.RUN_DB_INTEGRATION !== "1")(
	"createStoryInPmWithClaim link and status (real Postgres)",
	() => {
		let projectId = "";
		let statusId = "";
		let seq = 0;

		beforeAll(async () => {
			const now = new Date();
			await db.$executeRaw(Prisma.sql`
				INSERT INTO "user" (id, name, email, "emailVerified", "onboardingComplete", "createdAt", "updatedAt")
				VALUES (${USER_ID}, ${"PM Create Link Test User"}, ${`${prefix}@example.com`}, true, false, ${now}, ${now})
			`);
			await db.$executeRaw(Prisma.sql`
				INSERT INTO "organization" (id, name, slug, "createdAt")
				VALUES (${ORG_ID}, ${"PM Create Link Test Org"}, ${ORG_ID}, ${now})
			`);
			const project = await db.project.create({
				data: {
					name: "PM Create Link Test Project",
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

		beforeEach(() => {
			vi.mocked(executeMcpTool).mockReset();
			recordPmSyncLog.mockReset();
		});

		afterEach(async () => {
			await db.userStory.deleteMany({ where: { projectId } });
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

		async function story(): Promise<string> {
			seq++;
			const row = await db.userStory.create({
				data: {
					projectId,
					statusId,
					identifier: `PMC-${seq}`,
					title: `Story ${seq}`,
					kind: "FEATURE",
					priority: "P2_MEDIUM",
					createdById: USER_ID,
					source: "MANUAL",
				},
			});
			return row.id;
		}

		const read = (id: string) =>
			db.userStory.findUniqueOrThrow({
				where: { id },
				select: {
					externalId: true,
					externalUrl: true,
					externalMcpServerId: true,
					pmCreateClaimId: true,
					lastSyncedAt: true,
					lastPmSyncStatus: true,
					lastPmSyncError: true,
					lastPmSyncAttemptId: true,
				},
			});

		function run(storyId: string) {
			return createStoryInPmWithClaim({
				storyId,
				projectId,
				organizationId: ORG_ID,
				userId: USER_ID,
				mcpConfigId: null,
				mcpServerId: "server-1",
				pmTarget: {},
				pmTool: "fizzy",
				toolLabel: "fizzy",
				action: "create",
				toolName: "create_card",
				createArgs: { title: "Example" },
			});
		}

		/** Set the row's status while the create is in flight. */
		function createWhileStamping(
			storyId: string,
			state: {
				lastPmSyncStatus: PmSyncStatus | null;
				lastPmSyncError?: string | null;
				lastPmSyncAttemptId: string | null;
			},
		) {
			vi.mocked(executeMcpTool).mockImplementation((async () => {
				await db.userStory.update({
					where: { id: storyId },
					data: state,
				});
				return created();
			}) as never);
		}

		it("keeps a row PENDING for an attempt while the link lands", async () => {
			const id = await story();
			createWhileStamping(id, {
				lastPmSyncStatus: "PENDING",
				lastPmSyncAttemptId: "attempt-C",
			});

			const result = await run(id);

			expect(result).toMatchObject({ success: true, outcome: "created" });
			expect(await read(id)).toMatchObject({
				externalId: "1075",
				externalUrl: CREATED_URL,
				externalMcpServerId: "server-1",
				pmCreateClaimId: null,
				lastSyncedAt: expect.any(Date),
				lastPmSyncStatus: "PENDING",
				lastPmSyncAttemptId: "attempt-C",
			});
		});

		it.each([
			[
				"a loser's create_unconfirmed FAILED",
				"FAILED",
				"A fizzy item may already exist",
				null,
			],
			["a NULL status that kept its attempt id", null, null, "attempt-R"],
			["a PENDING with no attempt id", "PENDING", null, null],
			["CONFLICT", "CONFLICT", null, "attempt-R"],
		] as const)(
			"replaces %s with SUCCESS in the link's commit",
			async (_label, status, error, attemptId) => {
				const id = await story();
				createWhileStamping(id, {
					lastPmSyncStatus: status,
					lastPmSyncError: error,
					lastPmSyncAttemptId: attemptId,
				});

				const result = await run(id);

				expect(result).toMatchObject({
					success: true,
					outcome: "created",
				});
				expect(await read(id)).toMatchObject({
					externalId: "1075",
					pmCreateClaimId: null,
					lastSyncedAt: expect.any(Date),
					lastPmSyncStatus: "SUCCESS",
					lastPmSyncError: null,
					lastPmSyncAttemptId: attemptId,
				});
			},
		);

		describe("another push links the row after Unlink & re-create cleared this create's claim", () => {
			const OTHER_URL = "https://pm.example.com/cards/88";

			/** Item 88, linked by another push with SUCCESS. */
			const linkOtherItem = (id: string) =>
				db.userStory.update({
					where: { id },
					data: {
						pmCreateClaimId: null,
						pmCreateClaimedAt: null,
						externalId: "88",
						externalUrl: OTHER_URL,
						lastPmSyncStatus: "SUCCESS",
						lastPmSyncError: null,
					},
				});

			async function expectOtherLinkKept(id: string) {
				expect(await read(id)).toMatchObject({
					externalId: "88",
					externalUrl: OTHER_URL,
					lastPmSyncStatus: "SUCCESS",
					lastPmSyncError: null,
				});
			}

			afterEach(() => {
				vi.restoreAllMocks();
			});

			it("a create whose response has no readable id: the orphan goes to the log only", async () => {
				const id = await story();
				vi.mocked(executeMcpTool).mockImplementation((async () => {
					await linkOtherItem(id);
					return {
						success: true,
						durationMs: 5,
						output: {
							content: [
								{
									type: "text",
									text: JSON.stringify({ ok: true }),
								},
							],
						},
					};
				}) as never);

				const result = await run(id);

				expect(result).toMatchObject({
					success: false,
					outcome: "create-orphan",
				});
				await expectOtherLinkKept(id);
				expect(recordPmSyncLog).toHaveBeenCalledTimes(1);
				expect(recordPmSyncLog).toHaveBeenCalledWith(
					expect.objectContaining({
						status: "FAILURE",
						externalId: null,
						externalUrl: null,
					}),
				);
			});

			it("the re-read after the refused link write fails: the orphan goes to the log only", async () => {
				const id = await story();
				let reread: ReturnType<typeof vi.spyOn> | undefined;
				vi.mocked(executeMcpTool).mockImplementation((async () => {
					await linkOtherItem(id);
					// The tenant check has run; the next read is the re-read.
					reread = vi
						.spyOn(db.userStory, "findFirst")
						.mockRejectedValueOnce(new Error("read timeout"));
					return created();
				}) as never);

				const result = await run(id);

				expect(reread).toHaveBeenCalledTimes(1);
				await expect(reread?.mock.results[0]?.value).rejects.toThrow(
					"read timeout",
				);

				expect(result).toMatchObject({
					success: false,
					outcome: "create-orphan",
				});
				await expectOtherLinkKept(id);
				expect(recordPmSyncLog).toHaveBeenCalledTimes(1);
				expect(recordPmSyncLog).toHaveBeenCalledWith(
					expect.objectContaining({
						status: "FAILURE",
						externalId: "1075",
						externalUrl: CREATED_URL,
					}),
				);
			});

			it("the other push links after the re-read saw the row unlinked: the orphan goes to the log only", async () => {
				const id = await story();
				vi.mocked(executeMcpTool).mockImplementation((async () => {
					// Unlink & re-create only; the row is unlinked at the
					// re-read, and the other push links right after it.
					await db.userStory.update({
						where: { id },
						data: {
							pmCreateClaimId: null,
							pmCreateClaimedAt: null,
						},
					});
					const reread = db.userStory.findFirst.bind(db.userStory);
					vi.spyOn(db.userStory, "findFirst").mockImplementationOnce(
						(async (args: Parameters<typeof reread>[0]) => {
							const seen = await reread(args);
							await linkOtherItem(id);
							return seen;
						}) as never,
					);
					return created();
				}) as never);

				const result = await run(id);

				expect(result).toMatchObject({
					success: false,
					outcome: "create-orphan",
				});
				await expectOtherLinkKept(id);
				expect(recordPmSyncLog).toHaveBeenCalledTimes(1);
				expect(recordPmSyncLog).toHaveBeenCalledWith(
					expect.objectContaining({
						status: "FAILURE",
						externalId: "1075",
						externalUrl: CREATED_URL,
					}),
				);
			});
		});

		it("does not stamp this create's orphan on a row that holds another create's claim", async () => {
			const id = await story();
			vi.mocked(executeMcpTool).mockImplementation((async () => {
				// Unlink & re-create, then another push claims the row.
				await db.userStory.update({
					where: { id },
					data: {
						pmCreateClaimId: "claim-of-another-create",
						pmCreateClaimedAt: new Date(),
					},
				});
				return created();
			}) as never);

			const result = await run(id);

			expect(result).toMatchObject({
				success: false,
				outcome: "create-orphan",
			});
			expect(await read(id)).toMatchObject({
				externalId: null,
				pmCreateClaimId: "claim-of-another-create",
				lastPmSyncStatus: null,
			});
			expect(recordPmSyncLog).toHaveBeenCalledWith(
				expect.objectContaining({
					status: "FAILURE",
					externalId: "1075",
					externalUrl: CREATED_URL,
				}),
			);
		});

		it("does not take a same-id link on another URL, written after Unlink & re-create, as this create's", async () => {
			const id = await story();
			const otherUrl = "https://pm-other.example.com/cards/1075";
			vi.mocked(executeMcpTool).mockImplementation((async () => {
				await db.userStory.update({
					where: { id },
					data: {
						pmCreateClaimId: null,
						pmCreateClaimedAt: null,
						externalId: "1075",
						externalUrl: otherUrl,
						externalMcpServerId: "server-1",
						lastPmSyncStatus: "SUCCESS",
					},
				});
				return created();
			}) as never);

			const result = await run(id);

			expect(result).toMatchObject({
				success: false,
				outcome: "create-orphan",
			});
			expect(await read(id)).toMatchObject({
				externalId: "1075",
				externalUrl: otherUrl,
				lastPmSyncStatus: "SUCCESS",
				lastPmSyncError: null,
			});
			expect(recordPmSyncLog).toHaveBeenCalledWith(
				expect.objectContaining({
					status: "FAILURE",
					externalId: "1075",
					externalUrl: CREATED_URL,
				}),
			);
		});

		describe("the claim stamp and a recovery read one clock: the database's", () => {
			it("a claim taken while this process's clock runs an hour behind is stamped by the database: a recovery refuses it as too recent", async () => {
				const id = await story();
				// Only `Date`, advancing with real time, set an hour back.
				vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
				vi.setSystemTime(Date.now() - 60 * 60_000);
				let claim: Awaited<ReturnType<typeof acquirePmCreateClaim>>;
				try {
					claim = await acquirePmCreateClaim({ storyId: id });
				} finally {
					vi.useRealTimers();
				}
				if (!("claimId" in claim)) {
					throw new Error("the claim was not taken");
				}
				const [{ databaseNow }] = await db.$queryRaw<
					{ databaseNow: Date }[]
				>`SELECT now() AS "databaseNow"`;
				const stamped = await db.userStory.findUniqueOrThrow({
					where: { id },
					select: { pmCreateClaimedAt: true },
				});
				// Within a minute of the database's clock, not an hour behind.
				expect(
					Math.abs(
						databaseNow.getTime() -
							(stamped.pmCreateClaimedAt?.getTime() ?? 0),
					),
				).toBeLessThan(60_000);

				const cleared = await clearPmCreateClaim({
					projectId,
					storyId: id,
					claimId: claim.claimId,
				});

				expect(cleared.cleared).toBe(false);
				expect(cleared.claimTooRecent?.recoverableAt?.getTime()).toBe(
					(stamped.pmCreateClaimedAt?.getTime() ?? 0) +
						PM_CREATE_CLAIM_RECOVERY_MIN_AGE_MS,
				);
				expect(await read(id)).toMatchObject({
					pmCreateClaimId: claim.claimId,
				});
			});

			it("a claim aged past the bound in SQL is cleared by a recovery", async () => {
				const id = await story();
				const claim = await acquirePmCreateClaim({ storyId: id });
				if (!("claimId" in claim)) {
					throw new Error("the claim was not taken");
				}
				// Six minutes before the database's now, stored as Prisma
				// stores timestamps (UTC, without a zone).
				await db.$executeRaw(Prisma.sql`
					UPDATE "user_story"
					SET "pmCreateClaimedAt" = (now() AT TIME ZONE 'UTC') - interval '6 minutes'
					WHERE id = ${id}
				`);

				const cleared = await clearPmCreateClaim({
					projectId,
					storyId: id,
					claimId: claim.claimId,
				});

				expect(cleared).toEqual({ cleared: true });
				expect(await read(id)).toMatchObject({ pmCreateClaimId: null });
			});
		});
	},
);
