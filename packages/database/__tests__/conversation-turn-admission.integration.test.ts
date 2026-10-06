/**
 * Conversation turns: admission, cancellation, the dispatch check and
 * terminal ordering against a real Postgres.
 *
 * A chat turn used to exist only as a Temporal workflow. Stop could reach it
 * only once the browser held the execution id, two tabs could start two turns
 * in one conversation, and nothing durable said "this turn was cancelled"
 * when the Temporal cancel itself failed. `ConversationTurn` is that record;
 * these cases pin what it promises:
 *
 *   1. the same client key returns the same turn and execution id, never a
 *      second turn, including when the retries race;
 *   2. two different keys racing in one conversation admit exactly one, and
 *      the loser is told which execution to reconnect to;
 *   3. a cancel by key that lands before the turn exists leaves a tombstone,
 *      so the late creation is refused and no turn ever becomes ACTIVE;
 *   4. a cancel by execution id is recorded durably and is idempotent;
 *   5. another user, another organization or another user's conversation
 *      cannot create, cancel or pass the dispatch check for a turn;
 *   6. terminal ordering: a cancel recorded first ends the turn CANCELLED
 *      (keeping its partial text), a completion recorded first wins, and a
 *      terminal state never changes again;
 *   7. a non-terminal turn whose workflow is gone can be terminalized, after
 *      which the conversation admits a new turn.
 *
 * A mocked client cannot show an advisory lock or a conditional UPDATE being
 * honoured, so every case drives the real statements.
 *
 * Runs against DATABASE_URL (RUN_DB_INTEGRATION=1).
 */

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "../prisma/generated/client";
import {
	abandonConversationTurnStart,
	admitConversationTurn,
	checkConversationTurnDispatchable,
	finalizeConversationTurn,
	finalizeOrphanedConversationTurn,
	markConversationTurnActive,
	markConversationTurnStartFailed,
	requestConversationTurnCancel,
} from "../prisma/queries/conversation-turns";

const IDS = {
	owner: "cturn-owner",
	otherUser: "cturn-other-user",
	org: "cturn-org",
	otherOrg: "cturn-other-org",
	conversation: "cturn-conversation",
	secondConversation: "cturn-conversation-2",
	otherUsersConversation: "cturn-conversation-other-user",
	otherOrgConversation: "cturn-conversation-other-org",
};

const ALL_USERS = [IDS.owner, IDS.otherUser];
const ALL_ORGS = [IDS.org, IDS.otherOrg];

function client(): PrismaClient {
	return new PrismaClient({
		adapter: new PrismaPg({
			connectionString: process.env.DATABASE_URL ?? "",
		}),
	});
}

/** Fixture writes and assertions; the statements under test use the shared `db`. */
const fixtures = client();

let executionSeq = 0;
/** Matches the stream route's `orch-<uuid>` shape closely enough for a row. */
function nextExecutionId(): string {
	executionSeq++;
	return `orch-00000000-0000-4000-8000-${String(executionSeq).padStart(12, "0")}`;
}

async function upsertUser(id: string) {
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

async function upsertOrg(id: string) {
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

async function upsertConversation(
	id: string,
	userId: string,
	organizationId: string,
) {
	await fixtures.agentConversation.upsert({
		where: { id },
		update: {},
		create: { id, userId, organizationId, agentId: "orchestrator" },
	});
}

async function clearTurns() {
	await fixtures.conversationTurn.deleteMany({
		where: { userId: { in: ALL_USERS } },
	});
}

function admit(
	overrides: Partial<Parameters<typeof admitConversationTurn>[0]> = {},
) {
	return admitConversationTurn({
		userId: IDS.owner,
		organizationId: IDS.org,
		conversationId: IDS.conversation,
		clientRequestKey: `key-${executionSeq}-${Math.random()}`,
		executionId: nextExecutionId(),
		executionMode: "iterative",
		...overrides,
	});
}

const RACERS = 8;

describe.skipIf(!process.env.DATABASE_URL)(
	"Conversation turns: admission, cancellation and terminal ordering (real Postgres)",
	() => {
		beforeAll(async () => {
			for (const id of ALL_USERS) {
				await upsertUser(id);
			}
			for (const id of ALL_ORGS) {
				await upsertOrg(id);
			}
			await upsertConversation(IDS.conversation, IDS.owner, IDS.org);
			await upsertConversation(
				IDS.secondConversation,
				IDS.owner,
				IDS.org,
			);
			await upsertConversation(
				IDS.otherUsersConversation,
				IDS.otherUser,
				IDS.org,
			);
			await upsertConversation(
				IDS.otherOrgConversation,
				IDS.owner,
				IDS.otherOrg,
			);
			await clearTurns();
		});

		beforeEach(async () => {
			await clearTurns();
		});

		afterAll(async () => {
			await clearTurns();
			await fixtures.agentConversation.deleteMany({
				where: {
					id: {
						in: [
							IDS.conversation,
							IDS.secondConversation,
							IDS.otherUsersConversation,
							IDS.otherOrgConversation,
						],
					},
				},
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
		// 1. Idempotent creation
		// ------------------------------------------------------------------

		it("returns the same turn and execution id for a retried key, never a second turn", async () => {
			const first = await admit({ clientRequestKey: "retry-key" });
			expect(first.outcome).toBe("created");
			if (first.outcome !== "created") {
				return;
			}
			expect(first.turn.status).toBe("START_PENDING");
			expect(first.turn.generation).toBe(1);

			// The retry carries a fresh execution id candidate (a new request
			// generates one); the stored one must win.
			const retry = await admit({ clientRequestKey: "retry-key" });
			expect(retry.outcome).toBe("existing");
			if (retry.outcome !== "existing") {
				return;
			}
			expect(retry.turn.id).toBe(first.turn.id);
			expect(retry.turn.executionId).toBe(first.turn.executionId);
			expect(
				await fixtures.conversationTurn.count({
					where: { userId: IDS.owner },
				}),
			).toBe(1);
		});

		it("admits one turn when many retries of the same key race", async () => {
			const results = await Promise.all(
				Array.from({ length: RACERS }, () =>
					admit({ clientRequestKey: "racing-retry-key" }),
				),
			);
			expect(results.filter((r) => r.outcome === "created")).toHaveLength(
				1,
			);
			expect(
				results.filter((r) => r.outcome === "existing"),
			).toHaveLength(RACERS - 1);
			const executionIds = new Set(
				results.map((r) =>
					"turn" in r && r.turn ? r.turn.executionId : null,
				),
			);
			expect(executionIds.size).toBe(1);
			expect(
				await fixtures.conversationTurn.count({
					where: { userId: IDS.owner },
				}),
			).toBe(1);
		});

		// ------------------------------------------------------------------
		// 2. One live turn per conversation
		// ------------------------------------------------------------------

		it("admits exactly one of many different keys racing in one conversation", async () => {
			const results = await Promise.all(
				Array.from({ length: RACERS }, (_, i) =>
					admit({ clientRequestKey: `racer-${i}` }),
				),
			);
			const created = results.filter((r) => r.outcome === "created");
			const conflicts = results.filter((r) => r.outcome === "conflict");
			expect(created).toHaveLength(1);
			expect(conflicts).toHaveLength(RACERS - 1);
			const winner = created[0];
			for (const loser of conflicts) {
				// The loser is told which execution to reconnect to.
				if (
					loser.outcome === "conflict" &&
					winner.outcome === "created"
				) {
					expect(loser.turn.executionId).toBe(
						winner.turn.executionId,
					);
				}
			}
		});

		it("numbers generations per conversation and admits the next turn once the live one ends", async () => {
			const first = await admit({ clientRequestKey: "gen-1" });
			if (first.outcome !== "created") {
				throw new Error(`expected created, got ${first.outcome}`);
			}
			await markConversationTurnActive({
				turnId: first.turn.id,
				executionId: first.turn.executionId as string,
			});
			const blocked = await admit({ clientRequestKey: "gen-2" });
			expect(blocked.outcome).toBe("conflict");

			await finalizeConversationTurn({
				turnId: first.turn.id,
				executionId: first.turn.executionId as string,
				userId: IDS.owner,
				organizationId: IDS.org,
				outcome: "COMPLETED",
				responseText: "done",
			});
			const second = await admit({ clientRequestKey: "gen-2" });
			expect(second.outcome).toBe("created");
			if (second.outcome === "created") {
				expect(second.turn.generation).toBe(2);
			}

			// Another conversation numbers independently, and a turn with no
			// conversation skips the one-live-turn rule entirely.
			const elsewhere = await admit({
				clientRequestKey: "gen-other",
				conversationId: IDS.secondConversation,
			});
			expect(elsewhere.outcome).toBe("created");
			if (elsewhere.outcome === "created") {
				expect(elsewhere.turn.generation).toBe(1);
			}
			const loose1 = await admit({
				clientRequestKey: "loose-1",
				conversationId: null,
			});
			const loose2 = await admit({
				clientRequestKey: "loose-2",
				conversationId: null,
			});
			expect(loose1.outcome).toBe("created");
			expect(loose2.outcome).toBe("created");
		});

		it("refuses a retried key that names a different conversation", async () => {
			const first = await admit({ clientRequestKey: "moved-key" });
			expect(first.outcome).toBe("created");
			const moved = await admit({
				clientRequestKey: "moved-key",
				conversationId: IDS.secondConversation,
			});
			expect(moved.outcome).toBe("key_reused");
		});

		// ------------------------------------------------------------------
		// 3. Cancel by key before the turn exists
		// ------------------------------------------------------------------

		it("tombstones a cancel by key that arrives before the turn, and the late creation starts nothing", async () => {
			const cancel = await requestConversationTurnCancel({
				userId: IDS.owner,
				organizationId: IDS.org,
				clientRequestKey: "early-stop",
				conversationId: IDS.conversation,
				source: "CANCELLED_BEFORE_START",
			});
			expect(cancel.outcome).toBe("tombstoned");

			const late = await admit({ clientRequestKey: "early-stop" });
			expect(late.outcome).toBe("existing");
			if (late.outcome === "existing") {
				expect(late.turn.status).toBe("CANCELLED");
				expect(late.turn.cancelSource).toBe("CANCELLED_BEFORE_START");
				expect(late.turn.executionId).toBeNull();
			}
			expect(
				await fixtures.conversationTurn.count({
					where: {
						userId: IDS.owner,
						status: { in: ["ACTIVE", "START_PENDING"] },
					},
				}),
			).toBe(0);

			// The tombstone does not block the conversation's next message.
			const next = await admit({ clientRequestKey: "after-early-stop" });
			expect(next.outcome).toBe("created");
		});

		it("records a cancel by key against a turn that is still starting", async () => {
			const created = await admit({ clientRequestKey: "starting-key" });
			if (created.outcome !== "created") {
				throw new Error(`expected created, got ${created.outcome}`);
			}
			const cancel = await requestConversationTurnCancel({
				userId: IDS.owner,
				organizationId: IDS.org,
				clientRequestKey: "starting-key",
				source: "USER_STOP",
				requestedByUserId: IDS.owner,
			});
			expect(cancel.outcome).toBe("recorded");
			if (cancel.outcome === "recorded") {
				expect(cancel.turn.executionId).toBe(created.turn.executionId);
				expect(cancel.turn.status).toBe("CANCEL_REQUESTED");
			}
			// The route marks ACTIVE after the start returns; a recorded cancel
			// must not be overwritten by that.
			const promoted = await markConversationTurnActive({
				turnId: created.turn.id,
				executionId: created.turn.executionId as string,
			});
			expect(promoted).toBe(false);
			const verdict = await checkConversationTurnDispatchable({
				turnId: created.turn.id,
				executionId: created.turn.executionId as string,
				userId: IDS.owner,
				organizationId: IDS.org,
			});
			expect(verdict).toEqual({ ok: false, reason: "cancelled" });
		});

		// ------------------------------------------------------------------
		// 4. Cancel by execution id
		// ------------------------------------------------------------------

		it("records a cancel by execution id durably and idempotently", async () => {
			const created = await admit({ clientRequestKey: "by-exec" });
			if (created.outcome !== "created") {
				throw new Error(`expected created, got ${created.outcome}`);
			}
			const executionId = created.turn.executionId as string;
			await markConversationTurnActive({
				turnId: created.turn.id,
				executionId,
			});

			const first = await requestConversationTurnCancel({
				userId: IDS.owner,
				organizationId: IDS.org,
				executionId,
				source: "USER_STOP",
				requestedByUserId: IDS.owner,
			});
			expect(first.outcome).toBe("recorded");
			const row = await fixtures.conversationTurn.findUniqueOrThrow({
				where: { id: created.turn.id },
			});
			expect(row.status).toBe("CANCEL_REQUESTED");
			expect(row.cancelRequestedByUserId).toBe(IDS.owner);
			expect(row.cancelSource).toBe("USER_STOP");
			expect(row.cancelRequestedAt).toBeInstanceOf(Date);

			const again = await requestConversationTurnCancel({
				userId: IDS.owner,
				organizationId: IDS.org,
				executionId,
				source: "USER_STOP",
				requestedByUserId: IDS.owner,
			});
			expect(again.outcome).toBe("already_requested");
			const unchanged = await fixtures.conversationTurn.findUniqueOrThrow(
				{
					where: { id: created.turn.id },
				},
			);
			expect(unchanged.cancelRequestedAt?.getTime()).toBe(
				row.cancelRequestedAt?.getTime(),
			);
		});

		// ------------------------------------------------------------------
		// 5. Tenant and owner boundaries
		// ------------------------------------------------------------------

		it("refuses to create a turn in another user's or another organization's conversation", async () => {
			const otherUsers = await admit({
				conversationId: IDS.otherUsersConversation,
			});
			expect(otherUsers.outcome).toBe("conversation_forbidden");
			const otherOrgs = await admit({
				conversationId: IDS.otherOrgConversation,
			});
			expect(otherOrgs.outcome).toBe("conversation_forbidden");
			const missing = await admit({ conversationId: "cturn-no-such" });
			expect(missing.outcome).toBe("conversation_forbidden");
			expect(
				await fixtures.conversationTurn.count({
					where: { userId: IDS.owner },
				}),
			).toBe(0);
		});

		it("does not let another user or organization cancel a turn, by execution id or by key", async () => {
			const created = await admit({ clientRequestKey: "guarded" });
			if (created.outcome !== "created") {
				throw new Error(`expected created, got ${created.outcome}`);
			}
			const executionId = created.turn.executionId as string;

			const byOtherUser = await requestConversationTurnCancel({
				userId: IDS.otherUser,
				organizationId: IDS.org,
				executionId,
				source: "USER_STOP",
				requestedByUserId: IDS.otherUser,
			});
			expect(byOtherUser.outcome).toBe("not_found");
			const byOtherOrg = await requestConversationTurnCancel({
				userId: IDS.owner,
				organizationId: IDS.otherOrg,
				executionId,
				source: "USER_STOP",
				requestedByUserId: IDS.owner,
			});
			expect(byOtherOrg.outcome).toBe("not_found");
			// The same key under another user is that user's own (empty)
			// namespace: it tombstones THEIR key, never this turn.
			const keyByOtherUser = await requestConversationTurnCancel({
				userId: IDS.otherUser,
				organizationId: IDS.org,
				clientRequestKey: "guarded",
				source: "CANCELLED_BEFORE_START",
			});
			expect(keyByOtherUser.outcome).toBe("tombstoned");
			// A key cancel naming a conversation that is not the turn's is
			// refused rather than applied.
			const wrongConversation = await requestConversationTurnCancel({
				userId: IDS.owner,
				organizationId: IDS.org,
				clientRequestKey: "guarded",
				conversationId: IDS.secondConversation,
				source: "USER_STOP",
			});
			expect(wrongConversation.outcome).toBe("scope_mismatch");
			// A tombstone cannot be planted in someone else's conversation.
			const foreignTombstone = await requestConversationTurnCancel({
				userId: IDS.owner,
				organizationId: IDS.org,
				clientRequestKey: "foreign-tombstone",
				conversationId: IDS.otherUsersConversation,
				source: "CANCELLED_BEFORE_START",
			});
			expect(foreignTombstone.outcome).toBe("conversation_forbidden");

			const row = await fixtures.conversationTurn.findUniqueOrThrow({
				where: { id: created.turn.id },
			});
			expect(row.status).toBe("START_PENDING");
			expect(row.cancelRequestedAt).toBeNull();
		});

		it("fails the dispatch check on any scope mismatch and promotes a starting turn on a match", async () => {
			const created = await admit({ clientRequestKey: "dispatch" });
			if (created.outcome !== "created") {
				throw new Error(`expected created, got ${created.outcome}`);
			}
			const scope = {
				turnId: created.turn.id,
				executionId: created.turn.executionId as string,
				userId: IDS.owner,
				organizationId: IDS.org,
			};
			for (const bad of [
				{ ...scope, userId: IDS.otherUser },
				{ ...scope, organizationId: IDS.otherOrg },
				{ ...scope, executionId: nextExecutionId() },
				{ ...scope, turnId: "cturn-no-such-turn" },
			]) {
				expect(await checkConversationTurnDispatchable(bad)).toEqual({
					ok: false,
					reason: "scope_mismatch",
				});
			}
			// A running workflow proves its start succeeded: the first matching
			// check promotes START_PENDING to ACTIVE.
			expect(await checkConversationTurnDispatchable(scope)).toEqual({
				ok: true,
			});
			const row = await fixtures.conversationTurn.findUniqueOrThrow({
				where: { id: created.turn.id },
			});
			expect(row.status).toBe("ACTIVE");

			await finalizeConversationTurn({
				...scope,
				outcome: "COMPLETED",
				responseText: "done",
			});
			expect(await checkConversationTurnDispatchable(scope)).toEqual({
				ok: false,
				reason: "terminal",
			});
		});

		// ------------------------------------------------------------------
		// 6. Terminal ordering
		// ------------------------------------------------------------------

		it("ends a turn CANCELLED when the cancel was recorded before the completion, keeping the partial text", async () => {
			const created = await admit({ clientRequestKey: "cancel-first" });
			if (created.outcome !== "created") {
				throw new Error(`expected created, got ${created.outcome}`);
			}
			const scope = {
				turnId: created.turn.id,
				executionId: created.turn.executionId as string,
				userId: IDS.owner,
				organizationId: IDS.org,
			};
			await markConversationTurnActive(scope);
			await requestConversationTurnCancel({
				userId: IDS.owner,
				organizationId: IDS.org,
				executionId: scope.executionId,
				source: "USER_STOP",
				requestedByUserId: IDS.owner,
			});
			const result = await finalizeConversationTurn({
				...scope,
				outcome: "COMPLETED",
				responseText: "partial answer",
				terminalReason: "completed",
			});
			expect(result.outcome).toBe("finalized");
			const row = await fixtures.conversationTurn.findUniqueOrThrow({
				where: { id: created.turn.id },
			});
			expect(row.status).toBe("CANCELLED");
			expect(row.responseText).toBe("partial answer");
			expect(row.terminalAt).toBeInstanceOf(Date);
		});

		it("keeps a turn COMPLETED when the cancel arrives after the completion", async () => {
			const created = await admit({ clientRequestKey: "complete-first" });
			if (created.outcome !== "created") {
				throw new Error(`expected created, got ${created.outcome}`);
			}
			const scope = {
				turnId: created.turn.id,
				executionId: created.turn.executionId as string,
				userId: IDS.owner,
				organizationId: IDS.org,
			};
			await markConversationTurnActive(scope);
			await finalizeConversationTurn({
				...scope,
				outcome: "COMPLETED",
				responseText: "full answer",
			});
			const cancel = await requestConversationTurnCancel({
				userId: IDS.owner,
				organizationId: IDS.org,
				executionId: scope.executionId,
				source: "USER_STOP",
				requestedByUserId: IDS.owner,
			});
			expect(cancel.outcome).toBe("already_terminal");
			const row = await fixtures.conversationTurn.findUniqueOrThrow({
				where: { id: created.turn.id },
			});
			expect(row.status).toBe("COMPLETED");
			expect(row.cancelRequestedAt).toBeNull();
		});

		it("never changes a terminal state again", async () => {
			const created = await admit({ clientRequestKey: "sticky" });
			if (created.outcome !== "created") {
				throw new Error(`expected created, got ${created.outcome}`);
			}
			const scope = {
				turnId: created.turn.id,
				executionId: created.turn.executionId as string,
				userId: IDS.owner,
				organizationId: IDS.org,
			};
			await markConversationTurnActive(scope);
			const first = await finalizeConversationTurn({
				...scope,
				outcome: "LIMITED",
				responseText: "budget summary",
			});
			expect(first.outcome).toBe("finalized");
			for (const outcome of [
				"COMPLETED",
				"FAILED",
				"CANCELLED",
			] as const) {
				const later = await finalizeConversationTurn({
					...scope,
					outcome,
					responseText: "overwrite attempt",
				});
				expect(later.outcome).toBe("already_terminal");
			}
			expect(
				await markConversationTurnStartFailed({
					...scope,
					startToken: created.turn.startToken as string,
					reason: "late start failure",
				}),
			).toBe(false);
			expect(await markConversationTurnActive(scope)).toBe(false);
			const row = await fixtures.conversationTurn.findUniqueOrThrow({
				where: { id: created.turn.id },
			});
			expect(row.status).toBe("LIMITED");
			expect(row.responseText).toBe("budget summary");
		});

		it("does not finalize a turn for another user or organization", async () => {
			const created = await admit({ clientRequestKey: "foreign-final" });
			if (created.outcome !== "created") {
				throw new Error(`expected created, got ${created.outcome}`);
			}
			const result = await finalizeConversationTurn({
				turnId: created.turn.id,
				executionId: created.turn.executionId as string,
				userId: IDS.otherUser,
				organizationId: IDS.org,
				outcome: "COMPLETED",
			});
			expect(result.outcome).toBe("not_found");
			const row = await fixtures.conversationTurn.findUniqueOrThrow({
				where: { id: created.turn.id },
			});
			expect(row.status).toBe("START_PENDING");
		});

		it("marks a turn whose start definitely failed FAILED, or CANCELLED when a cancel was recorded first", async () => {
			const failed = await admit({ clientRequestKey: "start-fails" });
			if (failed.outcome !== "created") {
				throw new Error(`expected created, got ${failed.outcome}`);
			}
			expect(
				await markConversationTurnStartFailed({
					turnId: failed.turn.id,
					executionId: failed.turn.executionId as string,
					startToken: failed.turn.startToken as string,
					reason: "temporal rejected the start",
				}),
			).toBe(true);
			const failedRow = await fixtures.conversationTurn.findUniqueOrThrow(
				{ where: { id: failed.turn.id } },
			);
			expect(failedRow.status).toBe("FAILED");
			expect(failedRow.terminalReason).toBe(
				"temporal rejected the start",
			);

			const cancelled = await admit({
				clientRequestKey: "start-fails-after-cancel",
			});
			if (cancelled.outcome !== "created") {
				throw new Error(`expected created, got ${cancelled.outcome}`);
			}
			await requestConversationTurnCancel({
				userId: IDS.owner,
				organizationId: IDS.org,
				clientRequestKey: "start-fails-after-cancel",
				source: "DISCONNECT_BEFORE_START",
			});
			await markConversationTurnStartFailed({
				turnId: cancelled.turn.id,
				executionId: cancelled.turn.executionId as string,
				startToken: cancelled.turn.startToken as string,
				reason: "not started",
			});
			const cancelledRow =
				await fixtures.conversationTurn.findUniqueOrThrow({
					where: { id: cancelled.turn.id },
				});
			expect(cancelledRow.status).toBe("CANCELLED");
		});

		// ------------------------------------------------------------------
		// 7. Lazy reconcile of an orphan
		// ------------------------------------------------------------------

		it("terminalizes an orphaned turn whose workflow is gone, after which the conversation admits a new turn", async () => {
			for (const startActive of [false, true]) {
				await clearTurns();
				const orphan = await admit({
					clientRequestKey: `orphan-${startActive}`,
				});
				if (orphan.outcome !== "created") {
					throw new Error(`expected created, got ${orphan.outcome}`);
				}
				if (startActive) {
					await markConversationTurnActive({
						turnId: orphan.turn.id,
						executionId: orphan.turn.executionId as string,
					});
				}
				const blocked = await admit({
					clientRequestKey: "after-orphan",
				});
				expect(blocked.outcome).toBe("conflict");

				// What the web layer does when Temporal says NotFound: a
				// compare-and-set on the state it observed.
				if (blocked.outcome !== "conflict") {
					throw new Error("expected conflict");
				}
				const reconciled = await finalizeOrphanedConversationTurn({
					turnId: orphan.turn.id,
					executionId: orphan.turn.executionId as string,
					userId: IDS.owner,
					organizationId: IDS.org,
					observedStatus: blocked.turn.status,
					observedUpdatedAt: blocked.turn.updatedAt,
					terminalReason: "reconciled: workflow not found",
				});
				expect(reconciled.outcome).toBe("finalized");

				const admitted = await admit({
					clientRequestKey: "after-orphan",
				});
				expect(admitted.outcome).toBe("created");
			}
		});

		// ------------------------------------------------------------------
		// 8. Startup ownership (fresh review, finding 4)
		// ------------------------------------------------------------------

		it("gives the start token only to the request that created the turn", async () => {
			const created = await admit({ clientRequestKey: "owned" });
			if (created.outcome !== "created") {
				throw new Error(`expected created, got ${created.outcome}`);
			}
			expect(typeof created.turn.startToken).toBe("string");
			const retry = await admit({ clientRequestKey: "owned" });
			if (retry.outcome !== "existing") {
				throw new Error(`expected existing, got ${retry.outcome}`);
			}
			expect(retry.turn.startToken).toBeNull();
			const other = await admit({ clientRequestKey: "owned-other" });
			if (other.outcome !== "conflict") {
				throw new Error(`expected conflict, got ${other.outcome}`);
			}
			expect(other.turn.startToken).toBeNull();
		});

		it("lets only the start owner abandon a starting turn, and nobody abandon a promoted one", async () => {
			const created = await admit({ clientRequestKey: "abandon" });
			if (created.outcome !== "created") {
				throw new Error(`expected created, got ${created.outcome}`);
			}
			const base = {
				turnId: created.turn.id,
				executionId: created.turn.executionId as string,
				reason: "client disconnected before start",
			};
			// A duplicate request has no token (or a wrong one).
			expect(
				await abandonConversationTurnStart({
					...base,
					startToken: "not-the-token",
					cancelled: true,
				}),
			).toBe(false);
			expect(
				await markConversationTurnStartFailed({
					...base,
					startToken: "not-the-token",
				}),
			).toBe(false);
			expect(
				(
					await fixtures.conversationTurn.findUniqueOrThrow({
						where: { id: created.turn.id },
					})
				).status,
			).toBe("START_PENDING");

			// Once the turn is ACTIVE, not even the owner's stale cleanup
			// may cancel it.
			await markConversationTurnActive(base);
			expect(
				await abandonConversationTurnStart({
					...base,
					startToken: created.turn.startToken as string,
					cancelled: true,
				}),
			).toBe(false);
			const row = await fixtures.conversationTurn.findUniqueOrThrow({
				where: { id: created.turn.id },
			});
			expect(row.status).toBe("ACTIVE");
			expect(row.cancelRequestedAt).toBeNull();
		});

		it("the owner's disconnect cancels a turn that never started", async () => {
			const created = await admit({ clientRequestKey: "owner-gone" });
			if (created.outcome !== "created") {
				throw new Error(`expected created, got ${created.outcome}`);
			}
			expect(
				await abandonConversationTurnStart({
					turnId: created.turn.id,
					executionId: created.turn.executionId as string,
					startToken: created.turn.startToken as string,
					cancelled: true,
					reason: "client disconnected before start",
				}),
			).toBe(true);
			const row = await fixtures.conversationTurn.findUniqueOrThrow({
				where: { id: created.turn.id },
			});
			expect(row.status).toBe("CANCELLED");
			expect(row.cancelSource).toBe("DISCONNECT_BEFORE_START");
		});

		// ------------------------------------------------------------------
		// 9. Orphan reconcile is a compare-and-set (fresh review, finding 5)
		// ------------------------------------------------------------------

		it("does not terminalize a turn the starter promoted after the reconciler observed it", async () => {
			const created = await admit({ clientRequestKey: "promoted-late" });
			if (created.outcome !== "created") {
				throw new Error(`expected created, got ${created.outcome}`);
			}
			// The reconciler's observation (Temporal said NotFound for this).
			const observed = await fixtures.conversationTurn.findUniqueOrThrow({
				where: { id: created.turn.id },
			});
			// Meanwhile the starter starts the workflow and promotes the turn.
			await markConversationTurnActive({
				turnId: created.turn.id,
				executionId: created.turn.executionId as string,
			});
			const result = await finalizeOrphanedConversationTurn({
				turnId: created.turn.id,
				executionId: created.turn.executionId as string,
				userId: IDS.owner,
				organizationId: IDS.org,
				observedStatus: observed.status,
				observedUpdatedAt: observed.updatedAt,
				terminalReason: "reconciled: workflow not found",
			});
			expect(result.outcome).toBe("changed");
			const row = await fixtures.conversationTurn.findUniqueOrThrow({
				where: { id: created.turn.id },
			});
			expect(row.status).toBe("ACTIVE");
		});

		it("ends an orphan that was cancel-requested as CANCELLED", async () => {
			const created = await admit({ clientRequestKey: "orphan-cancel" });
			if (created.outcome !== "created") {
				throw new Error(`expected created, got ${created.outcome}`);
			}
			await requestConversationTurnCancel({
				userId: IDS.owner,
				organizationId: IDS.org,
				executionId: created.turn.executionId as string,
				source: "USER_STOP",
			});
			const observed = await fixtures.conversationTurn.findUniqueOrThrow({
				where: { id: created.turn.id },
			});
			const result = await finalizeOrphanedConversationTurn({
				turnId: created.turn.id,
				executionId: created.turn.executionId as string,
				userId: IDS.owner,
				organizationId: IDS.org,
				observedStatus: observed.status,
				observedUpdatedAt: observed.updatedAt,
				terminalReason: "reconciled: workflow not found",
			});
			expect(result).toEqual({
				outcome: "finalized",
				status: "CANCELLED",
			});
		});
	},
);
