/**
 * The test-case push's create (`createTestCaseInPmWithClaim`) and the
 * test-case Unlink & re-create writes against a real Postgres.
 *
 * The link and this create's SUCCESS commit in one transaction; its status
 * write keeps a case PENDING for another attempt and replaces every other
 * status (NULL included, which only real SQL can prove: `status <> 'PENDING'`
 * is never true for it). A link write after Unlink & re-create cleared the
 * claim is refused; a create orphan is stamped on the case only while it is
 * unlinked and holds this create's claim. The drift baseline lands only on
 * this create's link while it has none. `applyTestCasePmUnlink` and
 * `clearTestCasePmCreateClaim` clear only what the caller read, NULL URL and
 * NULL claim included.
 *
 * Runs with RUN_DB_INTEGRATION=1 against DATABASE_URL; skipped otherwise.
 */

import { randomUUID } from "node:crypto";
import {
	applyTestCasePmUnlink,
	clearTestCasePmCreateClaim,
	db,
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

vi.mock("../src/activities/pm-integration/fetch-pm-ticket", () => ({
	fetchPmTicket: vi.fn(),
}));

vi.mock("../src/activities/pm-integration/record-pm-sync-log", () => ({
	recordPmSyncLog,
}));

const { createTestCaseInPmWithClaim } = await import(
	"../src/activities/pm-integration/create-test-case-in-pm-with-claim"
);
const { executeMcpTool } = await import(
	"../src/activities/orchestrator/execution/execute-mcp-tool"
);
const { fetchPmTicket } = await import(
	"../src/activities/pm-integration/fetch-pm-ticket"
);
const { computePmHash } = await import(
	"../src/activities/pm-integration/pm-sync-hash"
);

const prefix = `pm-create-tc-${randomUUID()}`;
const USER_ID = `${prefix}-user`;
const ORG_ID = `${prefix}-org`;
const CREATED_URL = "https://pm.example.com/cards/1075";

function created(
	body: Record<string, unknown> = { id: "1075", url: CREATED_URL },
) {
	return {
		success: true,
		durationMs: 5,
		output: { content: [{ type: "text", text: JSON.stringify(body) }] },
	};
}

describe.skipIf(process.env.RUN_DB_INTEGRATION !== "1")(
	"createTestCaseInPmWithClaim and test-case Unlink & re-create (real Postgres)",
	() => {
		let projectId = "";
		let seq = 0;

		beforeAll(async () => {
			const now = new Date();
			await db.$executeRaw(Prisma.sql`
				INSERT INTO "user" (id, name, email, "emailVerified", "onboardingComplete", "createdAt", "updatedAt")
				VALUES (${USER_ID}, ${"PM Create TC Test User"}, ${`${prefix}@example.com`}, true, false, ${now}, ${now})
			`);
			await db.$executeRaw(Prisma.sql`
				INSERT INTO "organization" (id, name, slug, "createdAt")
				VALUES (${ORG_ID}, ${"PM Create TC Test Org"}, ${ORG_ID}, ${now})
			`);
			const project = await db.project.create({
				data: {
					name: "PM Create TC Test Project",
					userId: USER_ID,
					organizationId: ORG_ID,
				},
			});
			projectId = project.id;
		});

		beforeEach(() => {
			vi.mocked(executeMcpTool).mockReset();
			vi.mocked(fetchPmTicket).mockReset();
			vi.mocked(fetchPmTicket).mockResolvedValue(null);
			recordPmSyncLog.mockReset();
		});

		afterEach(async () => {
			await db.testCase.deleteMany({ where: { projectId } });
		});

		afterAll(async () => {
			if (projectId) {
				await db.project.deleteMany({ where: { id: projectId } });
			}
			await db.$executeRaw(
				Prisma.sql`DELETE FROM "organization" WHERE id = ${ORG_ID}`,
			);
			await db.$executeRaw(
				Prisma.sql`DELETE FROM "user" WHERE id = ${USER_ID}`,
			);
		});

		async function testCase(
			data: Partial<Prisma.TestCaseUncheckedCreateInput> = {},
		): Promise<string> {
			seq++;
			const row = await db.testCase.create({
				data: {
					projectId,
					organizationId: ORG_ID,
					identifier: `TC-${seq}`,
					title: `Case ${seq}`,
					createdById: USER_ID,
					...data,
				},
			});
			return row.id;
		}

		const read = (id: string) =>
			db.testCase.findUniqueOrThrow({
				where: { id },
				select: {
					externalId: true,
					externalUrl: true,
					externalMcpServerId: true,
					lastSyncedPmHash: true,
					pmCreateClaimId: true,
					pmCreateClaimedAt: true,
					lastSyncedAt: true,
					lastPmSyncStatus: true,
					lastPmSyncError: true,
					lastPmSyncAttemptId: true,
				},
			});

		function run(testCaseId: string, extra: Record<string, unknown> = {}) {
			return createTestCaseInPmWithClaim({
				testCaseId,
				projectId,
				organizationId: ORG_ID,
				userId: USER_ID,
				mcpConfigId: null,
				mcpServerId: "server-1",
				pmTarget: {},
				pmTool: "fizzy",
				toolLabel: "fizzy",
				toolName: "create_card",
				createArgs: { title: "Example" },
				...extra,
			});
		}

		/** Change the case while the create is in flight. */
		function createWhile(
			testCaseId: string,
			state: Prisma.TestCaseUncheckedUpdateInput,
			response = created(),
		) {
			vi.mocked(executeMcpTool).mockImplementation((async () => {
				await db.testCase.update({
					where: { id: testCaseId },
					data: state,
				});
				return response;
			}) as never);
		}

		it("keeps a case PENDING for an attempt while the link lands (run without an attempt id)", async () => {
			const id = await testCase();
			createWhile(id, {
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
				pmCreateClaimedAt: null,
				lastSyncedAt: expect.any(Date),
				lastPmSyncStatus: "PENDING",
				lastPmSyncAttemptId: "attempt-C",
			});
		});

		it.each([
			[
				"a loser's create_unconfirmed FAILED",
				"FAILED",
				"may already exist",
				null,
			],
			["a NULL status that kept its attempt id", null, null, "attempt-R"],
			["a PENDING with no attempt id", "PENDING", null, null],
		] as const)(
			"replaces %s with SUCCESS in the link's commit",
			async (_label, status, error, attemptId) => {
				const id = await testCase();
				createWhile(id, {
					lastPmSyncStatus: status as PmSyncStatus | null,
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
					lastPmSyncStatus: "SUCCESS",
					lastPmSyncError: null,
					lastPmSyncAttemptId: attemptId,
				});
			},
		);

		it("a run with an attempt id writes SUCCESS only while the case names that attempt", async () => {
			const mine = await testCase({
				lastPmSyncStatus: "PENDING",
				lastPmSyncAttemptId: "attempt-A",
			});
			vi.mocked(executeMcpTool).mockResolvedValue(created() as never);
			await run(mine, { pmSyncAttemptId: "attempt-A" });
			expect(await read(mine)).toMatchObject({
				externalId: "1075",
				lastPmSyncStatus: "SUCCESS",
			});

			const newer = await testCase();
			createWhile(
				newer,
				{
					lastPmSyncStatus: "PENDING",
					lastPmSyncAttemptId: "attempt-B",
				},
				created({
					id: "1076",
					url: "https://pm.example.com/cards/1076",
				}),
			);
			await run(newer, { pmSyncAttemptId: "attempt-A" });
			expect(await read(newer)).toMatchObject({
				externalId: "1076",
				pmCreateClaimId: null,
				lastPmSyncStatus: "PENDING",
				lastPmSyncAttemptId: "attempt-B",
			});
		});

		it("a response with no id: FAILED stamped while the case holds this claim, claim kept", async () => {
			const id = await testCase();
			vi.mocked(executeMcpTool).mockResolvedValue(
				created({ ok: true }) as never,
			);

			const result = await run(id);

			expect(result).toMatchObject({
				success: false,
				outcome: "create-orphan",
			});
			expect(await read(id)).toMatchObject({
				externalId: null,
				pmCreateClaimId: expect.any(String),
				lastPmSyncStatus: "FAILED",
				lastPmSyncError: expect.stringContaining("Unlink & re-create"),
			});
		});

		it("the claim cleared by Unlink & re-create while the create was in flight: link refused, case untouched, orphan logged", async () => {
			const id = await testCase();
			createWhile(id, { pmCreateClaimId: null, pmCreateClaimedAt: null });

			const result = await run(id);

			expect(result).toMatchObject({
				success: false,
				outcome: "create-orphan",
				externalId: "1075",
			});
			expect(await read(id)).toMatchObject({
				externalId: null,
				pmCreateClaimId: null,
				lastPmSyncStatus: null,
			});
			expect(recordPmSyncLog).toHaveBeenCalledTimes(1);
			expect(recordPmSyncLog.mock.calls[0]?.[0]).toMatchObject({
				errorPayload: { errorClass: "create_orphan" },
				externalId: "1075",
			});
		});

		it("another create's claim taken after Unlink & re-create: this orphan is not stamped on the case", async () => {
			const id = await testCase();
			createWhile(id, { pmCreateClaimId: "claim-of-another-create" });

			await run(id);

			expect(await read(id)).toMatchObject({
				externalId: null,
				pmCreateClaimId: "claim-of-another-create",
				lastPmSyncStatus: null,
			});
		});

		it("stamps the drift baseline on this link only while it has none", async () => {
			const baseline = {
				mcpConfigId: "config-1",
				capabilities: {
					taskGet: {
						toolName: "get_card",
						idParam: "id",
						allParams: [],
					},
				},
				userId: USER_ID,
				containerId: "board-1",
			};
			const id = await testCase({ lastSyncedPmHash: "an-earlier-link" });
			vi.mocked(executeMcpTool).mockResolvedValue(created() as never);
			vi.mocked(fetchPmTicket).mockResolvedValue({
				title: "t",
				description: "d",
				lastChangedBy: null,
				lastChangedAt: null,
			});
			await run(id, { baseline });
			expect((await read(id)).lastSyncedPmHash).toBe(
				computePmHash("t", "d"),
			);

			const raced = await testCase();
			vi.mocked(executeMcpTool).mockResolvedValue(
				created({
					id: "1077",
					url: "https://pm.example.com/cards/1077",
				}) as never,
			);
			vi.mocked(fetchPmTicket).mockImplementation((async () => {
				await db.testCase.update({
					where: { id: raced },
					data: { lastSyncedPmHash: "newer-push" },
				});
				return {
					title: "t",
					description: "d",
					lastChangedBy: null,
					lastChangedAt: null,
				};
			}) as never);
			await run(raced, { baseline });
			expect((await read(raced)).lastSyncedPmHash).toBe("newer-push");
		});

		it("an item another case in the project is already linked to: the link write is not retried, the orphan is stamped with a short cause, claim kept", async () => {
			await testCase({ externalId: "1075", externalUrl: CREATED_URL });
			const id = await testCase();
			vi.mocked(executeMcpTool).mockResolvedValue(created() as never);

			const result = await run(id);

			expect(result).toMatchObject({
				success: false,
				outcome: "create-orphan",
				error: expect.stringContaining(
					"another test case in this project is already linked to that item",
				),
			});
			expect(result.error).not.toContain("invocation");
			expect(await read(id)).toMatchObject({
				externalId: null,
				pmCreateClaimId: expect.any(String),
				lastPmSyncStatus: "FAILED",
			});
		});

		it("a case another push linked (NULL URL) settles this run's attempt to SUCCESS, and only its attempt", async () => {
			const mine = await testCase({
				externalId: "88",
				externalUrl: null,
				lastPmSyncStatus: "PENDING",
				lastPmSyncAttemptId: "attempt-A",
			});
			const newer = await testCase({
				externalId: "89",
				externalUrl: null,
				lastPmSyncStatus: "PENDING",
				lastPmSyncAttemptId: "attempt-B",
			});

			const result = await run(mine, { pmSyncAttemptId: "attempt-A" });
			await run(newer, { pmSyncAttemptId: "attempt-A" });

			expect(result).toMatchObject({ outcome: "already-linked" });
			expect(executeMcpTool).not.toHaveBeenCalled();
			expect(await read(mine)).toMatchObject({
				lastPmSyncStatus: "SUCCESS",
				lastPmSyncAttemptId: "attempt-A",
			});
			expect(await read(newer)).toMatchObject({
				lastPmSyncStatus: "PENDING",
				lastPmSyncAttemptId: "attempt-B",
			});
		});

		it("a late definite rejection after a newer create linked the case keeps the link's SUCCESS", async () => {
			const id = await testCase();
			createWhile(
				id,
				{
					pmCreateClaimId: null,
					externalId: "88",
					externalUrl: "https://pm.example.com/cards/88",
					lastPmSyncStatus: "SUCCESS",
				},
				{
					success: false,
					durationMs: 5,
					failureKind: "rejected",
					output: { error: "Invalid work item type" },
				} as never,
			);

			const result = await run(id);

			expect(result).toMatchObject({ outcome: "create-rejected" });
			expect(await read(id)).toMatchObject({
				externalId: "88",
				lastPmSyncStatus: "SUCCESS",
				lastPmSyncError: null,
			});
		});

		it("a late ambiguous failure after a newer create took its own claim keeps that create's claim and PENDING", async () => {
			const id = await testCase();
			vi.mocked(executeMcpTool).mockImplementation((async () => {
				await db.testCase.update({
					where: { id },
					data: {
						pmCreateClaimId: "claim-C2",
						lastPmSyncStatus: "PENDING",
						lastPmSyncAttemptId: "attempt-B",
					},
				});
				throw new Error("socket hang up");
			}) as never);

			const result = await run(id);

			expect(result).toMatchObject({ outcome: "create-unconfirmed" });
			expect(await read(id)).toMatchObject({
				pmCreateClaimId: "claim-C2",
				lastPmSyncStatus: "PENDING",
				lastPmSyncAttemptId: "attempt-B",
			});
		});

		it("a claim that kept slipping: the stale caller writes nothing over a newer retry's claim and PENDING", async () => {
			const id = await testCase({ pmCreateClaimId: "claim-C3" });
			// The claim read sees C3 released three times (its owner let go
			// between each missed UPDATE and the read); after the third, a
			// newer retry claims the case (C4) and stamps its PENDING.
			const spy = vi.spyOn(db.testCase, "findUnique");
			for (let i = 0; i < 3; i++) {
				spy.mockImplementationOnce((async () => {
					if (i === 2) {
						await db.testCase.update({
							where: { id },
							data: {
								pmCreateClaimId: "claim-C4",
								lastPmSyncStatus: "PENDING",
								lastPmSyncAttemptId: "attempt-B",
							},
						});
					}
					return {
						externalId: null,
						externalUrl: null,
						pmCreateClaimId: null,
						deletedAt: null,
					};
				}) as never);
			}

			try {
				const result = await run(id);

				expect(result).toMatchObject({ outcome: "claim-held" });
				expect(executeMcpTool).not.toHaveBeenCalled();
				expect(await read(id)).toMatchObject({
					pmCreateClaimId: "claim-C4",
					lastPmSyncStatus: "PENDING",
					lastPmSyncError: null,
					lastPmSyncAttemptId: "attempt-B",
				});
			} finally {
				spy.mockRestore();
			}
		});

		it("acquires no claim on a soft-deleted case and sends nothing", async () => {
			const id = await testCase({ deletedAt: new Date() });

			const result = await run(id);

			expect(result).toMatchObject({ outcome: "not-in-project" });
			expect(executeMcpTool).not.toHaveBeenCalled();
			expect((await read(id)).pmCreateClaimId).toBeNull();
		});

		describe("Unlink & re-create", () => {
			// Older than PM_CREATE_CLAIM_RECOVERY_MIN_AGE_MS: the clears below
			// test the claim fence, not its age (covered in the database
			// package's apply-pm-unlink-claim-age suite).
			const CLAIMED_LONG_AGO = new Date(Date.now() - 60 * 60_000);

			it("applyTestCasePmUnlink clears the link and the claim read, NULL URL included, and refuses a changed URL or claim", async () => {
				const linked = {
					externalId: "88",
					externalUrl: null,
					externalMcpServerId: "server-1",
					lastSyncedPmHash: "h",
					lastPmSyncStatus: "FAILED" as const,
					lastPmSyncError:
						"linked to a ticket in a different PM tool",
				};
				const id = await testCase(linked);
				const expected = {
					projectId,
					testCaseId: id,
					expectedExternalId: "88",
					expectedExternalUrl: null,
					expectedExternalMcpServerId: "server-1",
					expectedPmCreateClaimId: null,
				};

				expect(
					await applyTestCasePmUnlink({
						...expected,
						expectedExternalUrl: "https://pm.example.com/cards/88",
					}),
				).toEqual({ applied: false });
				expect(
					await applyTestCasePmUnlink({
						...expected,
						expectedPmCreateClaimId: "claim-read",
					}),
				).toEqual({ applied: false });
				expect((await read(id)).externalId).toBe("88");

				expect(await applyTestCasePmUnlink(expected)).toEqual({
					applied: true,
				});
				expect(await read(id)).toMatchObject({
					externalId: null,
					externalUrl: null,
					externalMcpServerId: null,
					lastSyncedPmHash: null,
					lastPmSyncStatus: null,
					lastPmSyncError: null,
					pmCreateClaimId: null,
				});
			});

			it("neither clear touches a case PENDING for a retry attempt; a NULL status is not mistaken for one", async () => {
				const linked = await testCase({
					externalId: "88",
					externalMcpServerId: "server-1",
					lastPmSyncStatus: "PENDING",
					lastPmSyncAttemptId: "attempt-A",
				});
				const claimed = await testCase({
					pmCreateClaimId: "claim-read",
					pmCreateClaimedAt: CLAIMED_LONG_AGO,
					lastPmSyncStatus: "PENDING",
					lastPmSyncAttemptId: "attempt-A",
				});
				const nullStatus = await testCase({
					pmCreateClaimId: "claim-read",
					pmCreateClaimedAt: CLAIMED_LONG_AGO,
					lastPmSyncStatus: null,
					lastPmSyncAttemptId: "attempt-A",
				});

				expect(
					await applyTestCasePmUnlink({
						projectId,
						testCaseId: linked,
						expectedExternalId: "88",
						expectedExternalUrl: null,
						expectedExternalMcpServerId: "server-1",
						expectedPmCreateClaimId: null,
					}),
				).toEqual({ applied: false });
				expect(
					await clearTestCasePmCreateClaim({
						projectId,
						testCaseId: claimed,
						claimId: "claim-read",
					}),
				).toEqual({ cleared: false });
				expect(
					await clearTestCasePmCreateClaim({
						projectId,
						testCaseId: nullStatus,
						claimId: "claim-read",
					}),
				).toEqual({ cleared: true });
				expect((await read(linked)).externalId).toBe("88");
				expect((await read(claimed)).pmCreateClaimId).toBe(
					"claim-read",
				);
			});

			it("clearTestCasePmCreateClaim clears only the claim read, on an unlinked case", async () => {
				const id = await testCase({
					pmCreateClaimId: "claim-read",
					pmCreateClaimedAt: CLAIMED_LONG_AGO,
				});

				expect(
					await clearTestCasePmCreateClaim({
						projectId,
						testCaseId: id,
						claimId: "another-claim",
					}),
				).toEqual({ cleared: false });
				expect(
					await clearTestCasePmCreateClaim({
						projectId,
						testCaseId: id,
						claimId: "claim-read",
					}),
				).toEqual({ cleared: true });
				expect((await read(id)).pmCreateClaimId).toBeNull();
			});
		});
	},
);
