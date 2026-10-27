/**
 * Conversation turn token ledger against a real Postgres.
 *
 * The Advisor's per-turn token allowance used to live only in workflow
 * memory: a dead activity attempt, an SDK retry or a stream whose usage
 * never arrived was charged nothing, and the allowance was whatever the
 * workflow last added up. The ledger (`conversation-turn-ledger.ts`) makes it
 * durable; these cases pin what it promises:
 *
 *   1. concurrent reservations never exceed the allowance (the turn row
 *      lock serializes them);
 *   2. exploration cannot use the finalization reserve; finalization can;
 *   3. a cancel committed before a reservation denies it, and a reservation
 *      committed before a cancel stays charged;
 *   4. settlement is accepted after a cancel, a terminal write or a newer
 *      turn, and is idempotent; UNKNOWN keeps the reservation charged; a
 *      settlement whose write fails commits nothing and leaves the attempt
 *      RESERVED and charged;
 *   4b. the terminal write persists the budget stop with the ledger's totals
 *      under the turn row lock and returns exactly what the row stores, the
 *      first time and on a retry after the ledger moved;
 *   5. a stale or missing generation, another organization, another user
 *      or another execution can neither reserve nor settle;
 *   6. re-admitting the same key never resets the ledger; a new turn gets a
 *      fresh allowance; a turn admitted without a budget is unledgered.
 *
 * A mocked client cannot show a row lock or a conditional transition being
 * honoured, so every case drives the real statements.
 *
 * Runs against DATABASE_URL (RUN_DB_INTEGRATION=1).
 */

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "../prisma/generated/client";
import {
	getConversationTurnLedgerSnapshot,
	type ReserveConversationTurnAttemptInput,
	reserveConversationTurnAttempt,
	settleConversationTurnAttempt,
} from "../prisma/queries/conversation-turn-ledger";
import {
	admitConversationTurn,
	type ConversationTurnScope,
	finalizeConversationTurn,
	requestConversationTurnCancel,
} from "../prisma/queries/conversation-turns";

const IDS = {
	owner: "cledger-owner",
	otherUser: "cledger-other-user",
	org: "cledger-org",
	otherOrg: "cledger-other-org",
	conversation: "cledger-conversation",
};

const ALL_USERS = [IDS.owner, IDS.otherUser];
const ALL_ORGS = [IDS.org, IDS.otherOrg];

const ALLOWANCE = 100_000;
const RESERVE = 8_000;
const BUDGET = {
	contractVersion: 1,
	tokenAllowance: ALLOWANCE,
	finalizationReserveTokens: RESERVE,
};

const fixtures = new PrismaClient({
	adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? "" }),
});

let executionSeq = 0;
function nextExecutionId(): string {
	executionSeq++;
	return `orch-00000000-0000-4000-9000-${String(executionSeq).padStart(12, "0")}`;
}

async function clearTurns() {
	await fixtures.conversationTurn.deleteMany({
		where: { userId: { in: ALL_USERS } },
	});
}

/** Admits a ledgered turn and returns its scope (generation included). */
async function admitLedgeredTurn(
	overrides: Partial<Parameters<typeof admitConversationTurn>[0]> = {},
): Promise<{
	scope: Required<ConversationTurnScope>;
	clientRequestKey: string;
}> {
	const clientRequestKey =
		overrides.clientRequestKey ?? `ledger-key-${nextExecutionId()}`;
	const admitted = await admitConversationTurn({
		userId: IDS.owner,
		organizationId: IDS.org,
		conversationId: IDS.conversation,
		clientRequestKey,
		executionId: nextExecutionId(),
		executionMode: "iterative",
		budget: BUDGET,
		...overrides,
	});
	if (admitted.outcome !== "created") {
		throw new Error(`expected a created turn, got ${admitted.outcome}`);
	}
	const turn = admitted.turn;
	return {
		clientRequestKey,
		scope: {
			turnId: turn.id,
			executionId: turn.executionId as string,
			userId: turn.userId,
			organizationId: turn.organizationId,
			generation: turn.generation,
		},
	};
}

function reserve(
	scope: ConversationTurnScope,
	overrides: Partial<ReserveConversationTurnAttemptInput> = {},
) {
	return reserveConversationTurnAttempt({
		scope,
		kind: "EXPLORATION",
		inputEstimate: 10_000,
		requestedOutputTokens: 5_000,
		minOutputTokens: 1_000,
		enforced: true,
		...overrides,
	});
}

async function turnRow(turnId: string) {
	return fixtures.conversationTurn.findUniqueOrThrow({
		where: { id: turnId },
		select: {
			status: true,
			tokenAllowance: true,
			measuredTokens: true,
			outstandingTokens: true,
			budgetEnforcement: true,
		},
	});
}

describe.skipIf(!process.env.DATABASE_URL)(
	"Conversation turn token ledger (real Postgres)",
	() => {
		beforeAll(async () => {
			for (const id of ALL_USERS) {
				await fixtures.user.upsert({
					where: { id },
					update: {},
					create: {
						id,
						name: id,
						email: `${id}@example.com`,
						emailVerified: true,
						onboardingComplete: false,
						createdAt: new Date(),
						updatedAt: new Date(),
					} as never,
				});
			}
			for (const id of ALL_ORGS) {
				await fixtures.organization.upsert({
					where: { id },
					update: {},
					create: {
						id,
						name: id,
						slug: id,
						createdAt: new Date(),
					} as never,
				});
			}
			await fixtures.agentConversation.upsert({
				where: { id: IDS.conversation },
				update: {},
				create: {
					id: IDS.conversation,
					userId: IDS.owner,
					organizationId: IDS.org,
					agentId: "orchestrator",
				},
			});
			await clearTurns();
		});

		beforeEach(async () => {
			await clearTurns();
		});

		afterAll(async () => {
			await clearTurns();
			await fixtures.agentConversation.deleteMany({
				where: { id: IDS.conversation },
			});
			await fixtures.organization.deleteMany({
				where: { id: { in: ALL_ORGS } },
			});
			await fixtures.user.deleteMany({
				where: { id: { in: ALL_USERS } },
			});
			await fixtures.$disconnect();
			const { db } = await import("../prisma/client");
			await db.$disconnect();
		});

		// ------------------------------------------------------------------
		// 1. Concurrency
		// ------------------------------------------------------------------

		it.each([undefined, null, 90_001])(
			"settles raw input with cache reads %s and charged measured totals",
			async (cacheReadTokens) => {
				const { scope } = await admitLedgeredTurn();
				const attempt = await reserve(scope);
				if (attempt.outcome !== "reserved") {
					throw new Error("expected reservation");
				}
				expect(
					(
						await fixtures.conversationTurnAttempt.findUniqueOrThrow(
							{ where: { id: attempt.attemptId } },
						)
					).cacheReadTokens,
				).toBeNull();
				await settleConversationTurnAttempt({
					scope,
					attemptId: attempt.attemptId,
					settlement: {
						status: "SETTLED",
						inputTokens: 100_000,
						outputTokens: 100,
						...(cacheReadTokens === undefined
							? {}
							: { cacheReadTokens }),
					},
				});
				const row =
					await fixtures.conversationTurnAttempt.findUniqueOrThrow({
						where: { id: attempt.attemptId },
					});
				expect(row.inputTokens).toBe(100_000);
				expect(row.cacheReadTokens).toBe(cacheReadTokens ?? null);
				expect((await turnRow(scope.turnId)).measuredTokens).toBe(
					cacheReadTokens == null ? 100_100n : 19_100n,
				);
				expect((await turnRow(scope.turnId)).outstandingTokens).toBe(
					0n,
				);
			},
		);

		it("never lets concurrent reservations exceed the allowance", async () => {
			const { scope } = await admitLedgeredTurn();
			const results = await Promise.all(
				Array.from({ length: 12 }, () =>
					reserve(scope, {
						inputEstimate: 15_000,
						requestedOutputTokens: 5_000,
					}),
				),
			);
			const reserved = results.filter((r) => r.outcome === "reserved");
			const exhausted = results.filter((r) => r.outcome === "exhausted");
			expect(reserved.length + exhausted.length).toBe(12);
			expect(exhausted.length).toBeGreaterThan(0);
			const total = reserved.reduce(
				(sum, r) =>
					sum + (r.outcome === "reserved" ? r.reservedTokens : 0),
				0,
			);
			// Exploration may use the allowance minus the finalization reserve.
			expect(total).toBeLessThanOrEqual(ALLOWANCE - RESERVE);
			const row = await turnRow(scope.turnId);
			expect(Number(row.outstandingTokens)).toBe(total);
			expect(row.status).toBe("ACTIVE"); // promoted from START_PENDING
			expect(row.budgetEnforcement).toBe("ENFORCED");
			expect(
				await fixtures.conversationTurnAttempt.count({
					where: { turnId: scope.turnId },
				}),
			).toBe(reserved.length);
		});

		it("lowers an enforced request's output cap to the room left, and refuses below the floor", async () => {
			const { scope } = await admitLedgeredTurn();
			// Room for exploration: 92,000. Take 80,000 of it.
			const big = await reserve(scope, {
				inputEstimate: 75_000,
				requestedOutputTokens: 5_000,
			});
			expect(big).toMatchObject({
				outcome: "reserved",
				outputCap: 5_000,
			});
			// 12,000 left: 10,000 input leaves a 2,000 cap (asked for 5,000).
			const lowered = await reserve(scope);
			expect(lowered).toMatchObject({
				outcome: "reserved",
				outputCap: 2_000,
				reservedTokens: 12_000,
			});
			// Nothing left above the 1,000 floor.
			const refused = await reserve(scope, { inputEstimate: 100 });
			expect(refused.outcome).toBe("exhausted");
		});

		// ------------------------------------------------------------------
		// 2. Finalization reserve
		// ------------------------------------------------------------------

		it("holds the finalization reserve back from exploration and auxiliary requests, but not from finalization", async () => {
			const { scope } = await admitLedgeredTurn();
			const spend = await reserve(scope, {
				inputEstimate: 87_000,
				requestedOutputTokens: 5_000,
			});
			expect(spend).toMatchObject({
				outcome: "reserved",
				reservedTokens: 92_000,
			});

			expect(
				(await reserve(scope, { kind: "EXPLORATION" })).outcome,
			).toBe("exhausted");
			expect((await reserve(scope, { kind: "AUXILIARY" })).outcome).toBe(
				"exhausted",
			);
			const finalization = await reserve(scope, {
				kind: "FINALIZATION",
				inputEstimate: 5_000,
				requestedOutputTokens: 16_384,
			});
			expect(finalization).toMatchObject({
				outcome: "reserved",
				outputCap: 3_000,
				reservedTokens: 8_000,
			});
			const row = await turnRow(scope.turnId);
			expect(Number(row.outstandingTokens)).toBe(ALLOWANCE);
		});

		it("records a model that cannot be capped as MEASURED_ONLY and still refuses it once the room is gone", async () => {
			const { scope } = await admitLedgeredTurn();
			const measured = await reserve(scope, {
				enforced: false,
				inputEstimate: 10_000,
				requestedOutputTokens: 16_384,
			});
			expect(measured).toMatchObject({
				outcome: "reserved",
				outputCap: null,
				reservedTokens: 26_384,
			});
			expect((await turnRow(scope.turnId)).budgetEnforcement).toBe(
				"MEASURED_ONLY",
			);
			const attempt =
				await fixtures.conversationTurnAttempt.findFirstOrThrow({
					where: { turnId: scope.turnId },
				});
			expect(attempt.enforced).toBe(false);

			await reserve(scope, {
				inputEstimate: 60_000,
				requestedOutputTokens: 4_000,
			});
			// 92,000 − 26,384 − 64,000 = 1,616 left: under the floor after any input.
			expect(
				(
					await reserve(scope, {
						enforced: false,
						inputEstimate: 1_000,
					})
				).outcome,
			).toBe("exhausted");
		});

		// ------------------------------------------------------------------
		// 3. Cancellation linearization
		// ------------------------------------------------------------------

		it("denies a reservation once a cancel has committed, and records no attempt", async () => {
			const { scope } = await admitLedgeredTurn();
			await requestConversationTurnCancel({
				userId: IDS.owner,
				organizationId: IDS.org,
				source: "USER_STOP",
				executionId: scope.executionId,
			});
			expect(await reserve(scope)).toEqual({
				outcome: "denied",
				reason: "cancelled",
			});
			expect(
				await fixtures.conversationTurnAttempt.count({
					where: { turnId: scope.turnId },
				}),
			).toBe(0);
			expect(
				Number((await turnRow(scope.turnId)).outstandingTokens),
			).toBe(0);
		});

		it("keeps a reservation committed before a cancel charged, and still settles it after the cancel", async () => {
			const { scope } = await admitLedgeredTurn();
			const first = await reserve(scope);
			const second = await reserve(scope);
			if (first.outcome !== "reserved" || second.outcome !== "reserved") {
				throw new Error("expected two reservations");
			}
			await requestConversationTurnCancel({
				userId: IDS.owner,
				organizationId: IDS.org,
				source: "USER_STOP",
				executionId: scope.executionId,
			});
			// The aborted request's usage never arrives: UNKNOWN, still charged.
			expect(
				await settleConversationTurnAttempt({
					scope,
					attemptId: first.attemptId,
					settlement: { status: "UNKNOWN" },
				}),
			).toEqual({ outcome: "settled", status: "UNKNOWN" });
			// The other finished with usage: billed after the cancel.
			await settleConversationTurnAttempt({
				scope,
				attemptId: second.attemptId,
				settlement: {
					status: "SETTLED",
					inputTokens: 9_000,
					outputTokens: 4_000,
				},
			});
			const row = await turnRow(scope.turnId);
			expect(row.status).toBe("CANCEL_REQUESTED");
			expect(Number(row.measuredTokens)).toBe(13_000);
			expect(Number(row.outstandingTokens)).toBe(first.reservedTokens);
		});

		// ------------------------------------------------------------------
		// 4. Settlement
		// ------------------------------------------------------------------

		it("accepts settlement after the turn is terminal and a newer turn exists", async () => {
			const { scope } = await admitLedgeredTurn();
			const attempt = await reserve(scope);
			if (attempt.outcome !== "reserved") {
				throw new Error("expected a reservation");
			}
			await finalizeConversationTurn({
				turnId: scope.turnId,
				executionId: scope.executionId,
				userId: scope.userId,
				organizationId: scope.organizationId,
				outcome: "COMPLETED",
			});
			const newer = await admitLedgeredTurn();
			expect(newer.scope.generation).toBe((scope.generation ?? 0) + 1);

			// A stale turn cannot acquire…
			expect(await reserve(scope)).toEqual({
				outcome: "denied",
				reason: "terminal",
			});
			// …but is billed for what it already sent.
			expect(
				await settleConversationTurnAttempt({
					scope,
					attemptId: attempt.attemptId,
					settlement: {
						status: "SETTLED",
						inputTokens: 20_000,
						outputTokens: 7_000,
					},
				}),
			).toEqual({ outcome: "settled", status: "SETTLED" });
			const row = await turnRow(scope.turnId);
			expect(Number(row.measuredTokens)).toBe(27_000);
			expect(Number(row.outstandingTokens)).toBe(0);
			// The newer turn's ledger is untouched.
			const fresh = await turnRow(newer.scope.turnId);
			expect(Number(fresh.measuredTokens)).toBe(0);
			expect(fresh.tokenAllowance).toBe(ALLOWANCE);
		});

		it("keeps an UNKNOWN attempt charged and makes every second settlement a no-op", async () => {
			const { scope } = await admitLedgeredTurn();
			const attempt = await reserve(scope);
			if (attempt.outcome !== "reserved") {
				throw new Error("expected a reservation");
			}
			await settleConversationTurnAttempt({
				scope,
				attemptId: attempt.attemptId,
				settlement: { status: "UNKNOWN" },
			});
			// A late "complete" settlement cannot refund an UNKNOWN attempt.
			expect(
				await settleConversationTurnAttempt({
					scope,
					attemptId: attempt.attemptId,
					settlement: {
						status: "SETTLED",
						inputTokens: 1,
						outputTokens: 1,
					},
				}),
			).toEqual({ outcome: "already_settled", status: "UNKNOWN" });
			expect(
				await settleConversationTurnAttempt({
					scope,
					attemptId: attempt.attemptId,
					settlement: { status: "RELEASED" },
				}),
			).toEqual({ outcome: "already_settled", status: "UNKNOWN" });
			const row = await turnRow(scope.turnId);
			expect(Number(row.measuredTokens)).toBe(0);
			expect(Number(row.outstandingTokens)).toBe(attempt.reservedTokens);

			// A settled attempt is not settled twice either.
			const other = await reserve(scope);
			if (other.outcome !== "reserved") {
				throw new Error("expected a reservation");
			}
			const settle = () =>
				settleConversationTurnAttempt({
					scope,
					attemptId: other.attemptId,
					settlement: {
						status: "SETTLED",
						inputTokens: 3_000,
						outputTokens: 2_000,
					},
				});
			const [a, b] = await Promise.all([settle(), settle()]);
			expect([a.outcome, b.outcome].sort()).toEqual([
				"already_settled",
				"settled",
			]);
			const after = await turnRow(scope.turnId);
			expect(Number(after.measuredTokens)).toBe(5_000);
			expect(Number(after.outstandingTokens)).toBe(
				attempt.reservedTokens,
			);
		});

		it("refunds a reservation that was never sent", async () => {
			const { scope } = await admitLedgeredTurn();
			const attempt = await reserve(scope);
			if (attempt.outcome !== "reserved") {
				throw new Error("expected a reservation");
			}
			await settleConversationTurnAttempt({
				scope,
				attemptId: attempt.attemptId,
				settlement: { status: "RELEASED" },
			});
			expect(
				Number((await turnRow(scope.turnId)).outstandingTokens),
			).toBe(0);
		});

		it("leaves an attempt RESERVED and charged when its settlement write fails", async () => {
			const { scope } = await admitLedgeredTurn();
			const attempt = await reserve(scope);
			if (attempt.outcome !== "reserved") {
				throw new Error("expected a reservation");
			}
			// An input count no Int column holds: the settlement's first
			// write fails and its transaction commits nothing.
			await expect(
				settleConversationTurnAttempt({
					scope,
					attemptId: attempt.attemptId,
					settlement: {
						status: "SETTLED",
						inputTokens: 3_000_000_000,
						outputTokens: 10,
					},
				}),
			).rejects.toThrow();
			const stored =
				await fixtures.conversationTurnAttempt.findUniqueOrThrow({
					where: { id: attempt.attemptId },
				});
			expect(stored.status).toBe("RESERVED");
			expect(stored.inputTokens).toBeNull();
			const row = await turnRow(scope.turnId);
			expect(Number(row.measuredTokens)).toBe(0);
			expect(Number(row.outstandingTokens)).toBe(attempt.reservedTokens);
		});

		// ------------------------------------------------------------------
		// 4b. The terminal budget-stop payload
		// ------------------------------------------------------------------

		it("persists the budget stop with the ledger totals read under the turn lock, and returns exactly what the row stores", async () => {
			const { scope } = await admitLedgeredTurn();
			const attempt = await reserve(scope);
			if (attempt.outcome !== "reserved") {
				throw new Error("expected a reservation");
			}
			await settleConversationTurnAttempt({
				scope,
				attemptId: attempt.attemptId,
				settlement: {
					status: "SETTLED",
					inputTokens: 40_000,
					outputTokens: 2_000,
				},
			});
			const pending = await reserve(scope);
			if (pending.outcome !== "reserved") {
				throw new Error("expected a reservation");
			}
			const result = await finalizeConversationTurn({
				...scope,
				outcome: "LIMITED",
				responseText: "What I found so far.",
				// The workflow's own (older) reading: replaced by the ledger.
				budgetStop: {
					stopReason: "allowance_exhausted",
					allowance: ALLOWANCE,
					measured: 1,
					outstanding: 2,
					enforcement: null,
				},
			});
			const stored = await fixtures.conversationTurn.findUniqueOrThrow({
				where: { id: scope.turnId },
				select: { status: true, budgetStop: true },
			});
			expect(stored.status).toBe("LIMITED");
			expect(stored.budgetStop).toEqual({
				kind: "token_allowance",
				allowance: ALLOWANCE,
				measured: 42_000,
				outstanding: pending.reservedTokens,
				enforcement: "ENFORCED",
				stopReason: "allowance_exhausted",
			});
			expect(result).toEqual({
				outcome: "finalized",
				status: "LIMITED",
				budgetStop: stored.budgetStop,
			});
			expect(
				JSON.stringify((result as { budgetStop?: unknown }).budgetStop),
			).toBe(JSON.stringify(stored.budgetStop));
		});

		it("returns the originally stored budget stop on a retried terminal write, whatever the ledger says by then", async () => {
			const { scope } = await admitLedgeredTurn();
			const attempt = await reserve(scope);
			if (attempt.outcome !== "reserved") {
				throw new Error("expected a reservation");
			}
			const stop = {
				stopReason: "allowance_exhausted" as const,
				allowance: ALLOWANCE,
				measured: 0,
				outstanding: 0,
				enforcement: null,
			};
			// The first write commits; its response is lost.
			const first = await finalizeConversationTurn({
				...scope,
				outcome: "LIMITED",
				budgetStop: stop,
			});
			// The in-flight attempt settles afterwards: newer totals.
			await settleConversationTurnAttempt({
				scope,
				attemptId: attempt.attemptId,
				settlement: {
					status: "SETTLED",
					inputTokens: 9_000,
					outputTokens: 1_000,
				},
			});
			// The retry of the same terminal write.
			const retry = await finalizeConversationTurn({
				...scope,
				outcome: "LIMITED",
				budgetStop: stop,
			});
			const stored = await fixtures.conversationTurn.findUniqueOrThrow({
				where: { id: scope.turnId },
				select: { budgetStop: true, measuredTokens: true },
			});
			expect(Number(stored.measuredTokens)).toBe(10_000);
			expect(retry).toEqual({
				outcome: "already_terminal",
				status: "LIMITED",
				budgetStop: stored.budgetStop,
			});
			expect(
				JSON.stringify((retry as { budgetStop?: unknown }).budgetStop),
			).toBe(
				JSON.stringify((first as { budgetStop?: unknown }).budgetStop),
			);
			expect(stored.budgetStop).toMatchObject({
				measured: 0,
				outstanding: attempt.reservedTokens,
			});
		});

		// ------------------------------------------------------------------
		// 5. Authorization and the generation fence
		// ------------------------------------------------------------------

		it("denies a reservation for a stale or missing generation", async () => {
			const { scope } = await admitLedgeredTurn();
			expect(
				await reserve({
					...scope,
					generation: (scope.generation ?? 1) - 1,
				}),
			).toEqual({ outcome: "denied", reason: "scope_mismatch" });
			const { generation: _generation, ...withoutGeneration } = scope;
			expect(await reserve(withoutGeneration)).toEqual({
				outcome: "denied",
				reason: "scope_mismatch",
			});
			expect(
				await fixtures.conversationTurnAttempt.count({
					where: { turnId: scope.turnId },
				}),
			).toBe(0);
		});

		it("denies reservation and settlement to another organization, another user or another execution", async () => {
			const { scope } = await admitLedgeredTurn();
			const attempt = await reserve(scope);
			if (attempt.outcome !== "reserved") {
				throw new Error("expected a reservation");
			}
			const strangers: ConversationTurnScope[] = [
				{ ...scope, organizationId: IDS.otherOrg },
				{ ...scope, userId: IDS.otherUser },
				{ ...scope, executionId: nextExecutionId() },
			];
			for (const stranger of strangers) {
				expect(await reserve(stranger)).toEqual({
					outcome: "denied",
					reason: "scope_mismatch",
				});
				expect(
					await settleConversationTurnAttempt({
						scope: stranger,
						attemptId: attempt.attemptId,
						settlement: { status: "RELEASED" },
					}),
				).toEqual({ outcome: "not_found" });
				expect(
					await getConversationTurnLedgerSnapshot(stranger),
				).toBeNull();
			}
			// Another turn of the same owner cannot settle this turn's attempt.
			await finalizeConversationTurn({
				turnId: scope.turnId,
				executionId: scope.executionId,
				userId: scope.userId,
				organizationId: scope.organizationId,
				outcome: "COMPLETED",
			});
			const other = await admitLedgeredTurn();
			expect(
				await settleConversationTurnAttempt({
					scope: other.scope,
					attemptId: attempt.attemptId,
					settlement: { status: "RELEASED" },
				}),
			).toEqual({ outcome: "not_found" });
			const row = await turnRow(scope.turnId);
			expect(Number(row.outstandingTokens)).toBe(attempt.reservedTokens);
			// The attempt's tenant columns come from the turn, not the caller.
			const stored =
				await fixtures.conversationTurnAttempt.findUniqueOrThrow({
					where: { id: attempt.attemptId },
				});
			expect(stored).toMatchObject({
				organizationId: IDS.org,
				userId: IDS.owner,
				generation: scope.generation,
				status: "RESERVED",
			});
		});

		// ------------------------------------------------------------------
		// 6. Admission
		// ------------------------------------------------------------------

		it("never resets the ledger when the same key is admitted again", async () => {
			const { scope, clientRequestKey } = await admitLedgeredTurn();
			const attempt = await reserve(scope);
			if (attempt.outcome !== "reserved") {
				throw new Error("expected a reservation");
			}
			await settleConversationTurnAttempt({
				scope,
				attemptId: attempt.attemptId,
				settlement: {
					status: "SETTLED",
					inputTokens: 30_000,
					outputTokens: 4_000,
				},
			});
			const again = await admitConversationTurn({
				userId: IDS.owner,
				organizationId: IDS.org,
				conversationId: IDS.conversation,
				clientRequestKey,
				executionId: nextExecutionId(),
				executionMode: "iterative",
				budget: { ...BUDGET, tokenAllowance: 999_999 },
			});
			expect(again.outcome).toBe("existing");
			const row = await turnRow(scope.turnId);
			expect(row.tokenAllowance).toBe(ALLOWANCE);
			expect(Number(row.measuredTokens)).toBe(34_000);
			expect(await getConversationTurnLedgerSnapshot(scope)).toEqual({
				contractVersion: 1,
				allowance: ALLOWANCE,
				finalizationReserve: RESERVE,
				measured: 34_000,
				outstanding: 0,
				enforcement: "ENFORCED",
			});
		});

		it("gives a new turn a fresh allowance", async () => {
			const { scope } = await admitLedgeredTurn();
			await reserve(scope, { inputEstimate: 80_000 });
			await finalizeConversationTurn({
				turnId: scope.turnId,
				executionId: scope.executionId,
				userId: scope.userId,
				organizationId: scope.organizationId,
				outcome: "LIMITED",
			});
			const next = await admitLedgeredTurn();
			const snapshot = await getConversationTurnLedgerSnapshot(
				next.scope,
			);
			expect(snapshot).toMatchObject({
				allowance: ALLOWANCE,
				measured: 0,
				outstanding: 0,
				enforcement: null,
			});
			expect((await reserve(next.scope)).outcome).toBe("reserved");
		});

		it("answers unledgered for a turn admitted without a budget, after the same status checks", async () => {
			const { scope } = await admitLedgeredTurn({ budget: undefined });
			expect(await reserve(scope)).toEqual({ outcome: "unledgered" });
			expect((await turnRow(scope.turnId)).status).toBe("ACTIVE");
			expect(await getConversationTurnLedgerSnapshot(scope)).toBeNull();
			await requestConversationTurnCancel({
				userId: IDS.owner,
				organizationId: IDS.org,
				source: "USER_STOP",
				executionId: scope.executionId,
			});
			expect(await reserve(scope)).toEqual({
				outcome: "denied",
				reason: "cancelled",
			});
		});
		it.each([
			{ version: 1, kind: "round_limit", used: 30, limit: 30 },
			{
				version: 1,
				kind: "token_budget",
				used: 992001,
				limit: 992000,
				maxTokens: 1000000,
				reservedTokens: 8000,
			},
		] as const)(
			"stores the local budget envelope %j on the terminal turn",
			async (budgetStop) => {
				const { scope } = await admitLedgeredTurn({
					budget: undefined,
				});
				const result = await finalizeConversationTurn({
					...scope,
					outcome: "LIMITED",
					budgetStop,
				});
				expect(result).toMatchObject({ status: "LIMITED", budgetStop });
				expect(
					await fixtures.conversationTurn.findUniqueOrThrow({
						where: { id: scope.turnId },
						select: { budgetStop: true },
					}),
				).toEqual({ budgetStop });
			},
		);
		it("preserves a pre-change balanced allowance of 500k across a 1M admission retry", async () => {
			const { scope, clientRequestKey } = await admitLedgeredTurn({
				executionMode: "balanced",
				budget: { ...BUDGET, tokenAllowance: 500000 },
			});
			const again = await admitConversationTurn({
				userId: IDS.owner,
				organizationId: IDS.org,
				conversationId: IDS.conversation,
				clientRequestKey,
				executionId: nextExecutionId(),
				executionMode: "balanced",
				budget: { ...BUDGET, tokenAllowance: 1000000 },
			});
			expect(again).toMatchObject({
				outcome: "existing",
				turn: { tokenAllowance: 500000 },
			});
			expect((await turnRow(scope.turnId)).tokenAllowance).toBe(500000);
		});
	},
);
