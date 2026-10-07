/**
 * Saving Advisor turns against a real Postgres (Fizzy #2949).
 *
 * The Advisor used to save a finished turn by reading the conversation and
 * writing the whole message list and metadata back, so two tabs saving into
 * one conversation, or a late save from a stream that outlived its tab,
 * dropped the other writer's turn. `saveConversationTurn` and
 * `updateConversationSettings` make each change to the row as it is under a
 * row lock. These cases pin what that promises with real connections:
 *
 *   1. many saves of different turns racing on one conversation all
 *      survive — every message and every execution record;
 *   2. a settings change racing with turn saves keeps every execution;
 *   3. a late save of an earlier turn lands before the later turn's
 *      messages and execution;
 *   4. a first message removed after a refusal (Fizzy #2958) is not put
 *      back by another tab's later save;
 *   5. an execution id naming a turn in another conversation is refused
 *      and writes nothing;
 *   6. a later turn admitted and saved while an earlier turn's save waits
 *      for the row lock is still seen, so the earlier turn lands first;
 *   7. a turn admitted with no conversation (the chat created its
 *      conversation only when the turn ended) is claimed for the
 *      conversation it is saved into, and when two saves race to claim it
 *      for different conversations only one wins.
 *
 * A mocked client cannot show a row lock being honoured, so every case
 * drives the real statements.
 *
 * Runs against DATABASE_URL (RUN_DB_INTEGRATION=1).
 */

import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "../prisma/generated/client";
import {
	ConversationNotFoundError,
	removeConversationMessage,
	saveConversationTurn,
	updateConversationSettings,
} from "../prisma/queries/agent-conversations";
import { hasReachableDatabaseUrl } from "./_helpers/db-availability";

const IDS = {
	owner: "csave-owner",
	org: "csave-org",
	conversation: "csave-conversation",
	otherConversation: "csave-conversation-2",
};

function client(): PrismaClient {
	return new PrismaClient({
		adapter: new PrismaPg({
			connectionString: process.env.DATABASE_URL ?? "",
		}),
	});
}

/** Fixture writes and assertions; the statements under test use the shared `db`. */
const fixtures = client();

const RACERS = 8;

/**
 * Waits for every racer, then fails if any failed. `Promise.all` would
 * return at the first failure and leave the others writing into the next
 * case.
 */
async function settleAll(promises: Promise<unknown>[]): Promise<void> {
	const results = await Promise.allSettled(promises);
	const failures = results.filter(
		(r): r is PromiseRejectedResult => r.status === "rejected",
	);
	if (failures.length > 0) {
		throw failures[0]?.reason;
	}
}

function turnMessages(n: number | string) {
	return [
		{
			id: `q-${n}`,
			role: "user" as const,
			content: `Question ${n}`,
			timestamp: "2026-10-06T10:00:00.000Z",
		},
		{
			id: `a-${n}`,
			role: "assistant" as const,
			content: `Answer ${n}`,
			timestamp: "2026-10-06T10:00:05.000Z",
		},
	];
}

async function stored() {
	const row = await fixtures.agentConversation.findUniqueOrThrow({
		where: { id: IDS.conversation },
		select: { messages: true, metadata: true },
	});
	const messages = row.messages as Array<{ id: string; role: string }>;
	const metadata = (row.metadata ?? {}) as {
		executions?: Array<{ id: string }>;
		selectedMcpConfigIds?: string[];
	};
	return { messages, metadata };
}

async function createTurn(
	executionId: string,
	generation: number | null,
	conversationId: string | null = IDS.conversation,
	client: Pick<PrismaClient, "conversationTurn"> = fixtures,
) {
	await client.conversationTurn.create({
		data: {
			organizationId: IDS.org,
			userId: IDS.owner,
			conversationId,
			scopeConversationId: conversationId,
			clientRequestKey: `key-${executionId}`,
			executionId,
			generation,
			executionMode: "balanced",
			status: "COMPLETED",
		},
	});
}

/**
 * Resolves once some backend is waiting on a row lock of the conversation
 * table, i.e. a save has reached its `SELECT ... FOR UPDATE` and is blocked.
 */
async function untilASaveWaitsForTheLock(): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt++) {
		const waiting = await fixtures.$queryRaw<Array<{ n: bigint }>>`
			SELECT count(*)::bigint AS n FROM pg_stat_activity
			WHERE wait_event_type = 'Lock'
			AND query LIKE '%FROM "agent_conversation"%FOR UPDATE%'`;
		if (Number(waiting[0]?.n ?? 0) > 0) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error("no save started waiting for the conversation lock");
}

describe.skipIf(!hasReachableDatabaseUrl())(
	"Saving Advisor turns (real Postgres)",
	() => {
		beforeAll(async () => {
			await fixtures.user.upsert({
				where: { id: IDS.owner },
				update: {},
				create: {
					id: IDS.owner,
					name: IDS.owner,
					email: `${IDS.owner}@example.com`,
					emailVerified: true,
					onboardingComplete: false,
					createdAt: new Date(),
					updatedAt: new Date(),
				} as never,
			});
			await fixtures.organization.upsert({
				where: { id: IDS.org },
				update: {},
				create: {
					id: IDS.org,
					name: IDS.org,
					slug: IDS.org,
					createdAt: new Date(),
				} as never,
			});
		});

		beforeEach(async () => {
			await fixtures.conversationTurn.deleteMany({
				where: { userId: IDS.owner },
			});
			for (const id of [IDS.conversation, IDS.otherConversation]) {
				await fixtures.agentConversation.upsert({
					where: { id },
					update: {
						messages: [],
						metadata: { mode: "orchestrator", executions: [] },
					},
					create: {
						id,
						userId: IDS.owner,
						organizationId: IDS.org,
						agentId: "fabric-workspace-assistant",
						messages: [],
						metadata: { mode: "orchestrator", executions: [] },
					},
				});
			}
		});

		afterAll(async () => {
			await fixtures.conversationTurn.deleteMany({
				where: { userId: IDS.owner },
			});
			await fixtures.agentConversation.deleteMany({
				where: {
					id: { in: [IDS.conversation, IDS.otherConversation] },
				},
			});
			await fixtures.organization.deleteMany({ where: { id: IDS.org } });
			await fixtures.user.deleteMany({ where: { id: IDS.owner } });
			await fixtures.$disconnect();
			const { db } = await import("../prisma/client");
			await db.$disconnect();
		});

		it("keeps every turn when many saves race on one conversation", async () => {
			await settleAll(
				Array.from({ length: RACERS }, (_, i) =>
					saveConversationTurn({
						id: IDS.conversation,
						userId: IDS.owner,
						organizationId: IDS.org,
						messages: turnMessages(i),
						execution: { id: `exec-race-${i}`, status: "complete" },
					}),
				),
			);

			const { messages, metadata } = await stored();
			expect(messages).toHaveLength(RACERS * 2);
			expect(new Set(messages.map((m) => m.id)).size).toBe(RACERS * 2);
			expect((metadata.executions ?? []).map((e) => e.id).sort()).toEqual(
				Array.from(
					{ length: RACERS },
					(_, i) => `exec-race-${i}`,
				).sort(),
			);
			// Each turn's question is directly followed by its answer.
			for (let i = 0; i < messages.length; i += 2) {
				expect(messages[i]?.id.replace("q-", "a-")).toBe(
					messages[i + 1]?.id,
				);
			}
		});

		it("keeps every execution when a settings change races with turn saves", async () => {
			await settleAll([
				...Array.from({ length: RACERS }, (_, i) =>
					saveConversationTurn({
						id: IDS.conversation,
						userId: IDS.owner,
						organizationId: IDS.org,
						messages: turnMessages(i),
						execution: { id: `exec-mixed-${i}` },
					}),
				),
				updateConversationSettings({
					id: IDS.conversation,
					userId: IDS.owner,
					organizationId: IDS.org,
					settings: { selectedMcpConfigIds: ["mcp_1"] },
				}),
			]);

			const { messages, metadata } = await stored();
			expect(messages).toHaveLength(RACERS * 2);
			expect(metadata.executions).toHaveLength(RACERS);
			expect(metadata.selectedMcpConfigIds).toEqual(["mcp_1"]);
		});

		it("places a late save of an earlier turn before the later turn", async () => {
			await createTurn("orch-csave-1", 1);
			await createTurn("orch-csave-2", 2);

			// The later turn is saved first.
			await saveConversationTurn({
				id: IDS.conversation,
				userId: IDS.owner,
				organizationId: IDS.org,
				messages: turnMessages(2),
				execution: { id: "orch-csave-2" },
			});
			await saveConversationTurn({
				id: IDS.conversation,
				userId: IDS.owner,
				organizationId: IDS.org,
				messages: turnMessages(1),
				execution: { id: "orch-csave-1" },
			});

			const { messages, metadata } = await stored();
			expect(messages.map((m) => m.id)).toEqual([
				"q-1",
				"a-1",
				"q-2",
				"a-2",
			]);
			expect((metadata.executions ?? []).map((e) => e.id)).toEqual([
				"orch-csave-1",
				"orch-csave-2",
			]);
		});

		it("does not put back a refused first message removed before another tab's save", async () => {
			await fixtures.agentConversation.update({
				where: { id: IDS.conversation },
				data: {
					messages: [
						{
							id: "seed",
							role: "user",
							content: "Refused question",
							timestamp: "2026-10-06T09:59:00.000Z",
						},
					],
				},
			});

			await removeConversationMessage({
				id: IDS.conversation,
				userId: IDS.owner,
				organizationId: IDS.org,
				messageId: "seed",
			});
			await saveConversationTurn({
				id: IDS.conversation,
				userId: IDS.owner,
				organizationId: IDS.org,
				messages: turnMessages("other-tab"),
				execution: { id: "exec-other-tab" },
			});

			const { messages } = await stored();
			expect(messages.map((m) => m.id)).toEqual([
				"q-other-tab",
				"a-other-tab",
			]);
		});

		it("sees a later turn saved while this save waited for the row lock", async () => {
			await createTurn("orch-csave-a", 1);

			// Hold the conversation's row lock, start turn A's save so it
			// blocks on it, and — while it waits — admit turn B and save it
			// (as B's own save would, under the same lock). A's save can
			// only order itself correctly if it looks the turns up after it
			// gets the lock.
			// A's outcome is captured as soon as it starts, and the outer
			// finally waits for it once the fixture transaction has released
			// the lock, so a failed fixture step never leaves A running into
			// the next test.
			let saveA: Promise<PromiseSettledResult<unknown>> | undefined;
			try {
				await fixtures.$transaction(
					async (tx) => {
						await tx.$queryRaw`SELECT id FROM "agent_conversation" WHERE id = ${IDS.conversation} FOR UPDATE`;
						saveA = saveConversationTurn({
							id: IDS.conversation,
							userId: IDS.owner,
							organizationId: IDS.org,
							messages: turnMessages("A"),
							execution: { id: "orch-csave-a" },
						}).then(
							(value) =>
								({ status: "fulfilled", value }) as const,
							(reason: unknown) =>
								({ status: "rejected", reason }) as const,
						);
						await untilASaveWaitsForTheLock();
						await createTurn(
							"orch-csave-b",
							2,
							IDS.conversation,
							tx,
						);
						await tx.agentConversation.update({
							where: { id: IDS.conversation },
							data: {
								messages: turnMessages("B").map((m) => ({
									...m,
									metadata: { executionId: "orch-csave-b" },
								})),
								metadata: {
									mode: "orchestrator",
									executions: [{ id: "orch-csave-b" }],
								},
							},
						});
					},
					{ timeout: 20_000 },
				);
			} finally {
				// Settled results never reject, so this only waits.
				await saveA;
			}
			const outcome = await saveA;
			if (outcome?.status === "rejected") {
				throw outcome.reason;
			}

			const { messages, metadata } = await stored();
			expect(messages.map((m) => m.id)).toEqual([
				"q-A",
				"a-A",
				"q-B",
				"a-B",
			]);
			expect((metadata.executions ?? []).map((e) => e.id)).toEqual([
				"orch-csave-a",
				"orch-csave-b",
			]);
		});

		it("claims a turn admitted with no conversation for the one it is saved into", async () => {
			await createTurn("orch-csave-loose", null, null);

			await saveConversationTurn({
				id: IDS.conversation,
				userId: IDS.owner,
				organizationId: IDS.org,
				messages: turnMessages("loose"),
				execution: { id: "orch-csave-loose" },
			});

			const turn = await fixtures.conversationTurn.findUniqueOrThrow({
				where: { executionId: "orch-csave-loose" },
			});
			expect(turn.conversationId).toBe(IDS.conversation);
			// The conversation it was admitted for (none) is kept.
			expect(turn.scopeConversationId).toBeNull();
			expect((await stored()).messages.map((m) => m.id)).toEqual([
				"q-loose",
				"a-loose",
			]);

			// A retry into the same conversation still saves; another
			// conversation can no longer claim it.
			await saveConversationTurn({
				id: IDS.conversation,
				userId: IDS.owner,
				organizationId: IDS.org,
				messages: turnMessages("loose"),
				execution: { id: "orch-csave-loose" },
			});
			await expect(
				saveConversationTurn({
					id: IDS.otherConversation,
					userId: IDS.owner,
					organizationId: IDS.org,
					messages: turnMessages("loose"),
					execution: { id: "orch-csave-loose" },
				}),
			).rejects.toBeInstanceOf(ConversationNotFoundError);
			expect((await stored()).messages).toHaveLength(2);
		});

		it("lets only one of two saves racing to claim an unattached turn for different conversations win", async () => {
			await createTurn("orch-csave-contested", null, null);

			const results = await Promise.allSettled(
				[IDS.conversation, IDS.otherConversation].map((id) =>
					saveConversationTurn({
						id,
						userId: IDS.owner,
						organizationId: IDS.org,
						messages: turnMessages("contested"),
						execution: { id: "orch-csave-contested" },
					}),
				),
			);

			const won = results.filter((r) => r.status === "fulfilled");
			const lost = results.filter(
				(r): r is PromiseRejectedResult => r.status === "rejected",
			);
			expect(won).toHaveLength(1);
			expect(lost).toHaveLength(1);
			expect(lost[0]?.reason).toBeInstanceOf(ConversationNotFoundError);

			const turn = await fixtures.conversationTurn.findUniqueOrThrow({
				where: { executionId: "orch-csave-contested" },
			});
			const loser =
				turn.conversationId === IDS.conversation
					? IDS.otherConversation
					: IDS.conversation;
			const loserRow = await fixtures.agentConversation.findUniqueOrThrow(
				{ where: { id: loser }, select: { messages: true } },
			);
			expect(loserRow.messages).toEqual([]);
		});

		it("refuses an execution id that names a turn in another conversation, writing nothing", async () => {
			await fixtures.conversationTurn.create({
				data: {
					organizationId: IDS.org,
					userId: IDS.owner,
					conversationId: IDS.otherConversation,
					scopeConversationId: IDS.otherConversation,
					clientRequestKey: "key-elsewhere",
					executionId: "orch-csave-elsewhere",
					generation: 1,
					executionMode: "balanced",
					status: "COMPLETED",
				},
			});

			await expect(
				saveConversationTurn({
					id: IDS.conversation,
					userId: IDS.owner,
					organizationId: IDS.org,
					messages: turnMessages("x"),
					execution: { id: "orch-csave-elsewhere" },
				}),
			).rejects.toBeInstanceOf(ConversationNotFoundError);

			const { messages, metadata } = await stored();
			expect(messages).toEqual([]);
			expect(metadata.executions).toEqual([]);
		});
	},
);
