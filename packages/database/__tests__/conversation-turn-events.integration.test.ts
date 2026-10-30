import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { db } from "../prisma/client";
import {
	appendConversationTurnEventFromWorker as append,
	type ConversationEventScope,
	purgeExpiredConversationTurnEvents,
	readConversationTurnEvents as read,
} from "../prisma/queries/conversation-turn-events";

const scope: ConversationEventScope = {
	turnId: "example-replay-turn",
	executionId: "orch-example-replay",
	userId: "example-replay-user",
	organizationId: "example-replay-org",
	runId: "example-run",
};
const event = (sourceKey: string) => ({
	executionId: scope.executionId,
	runId: scope.runId,
	sourceKey,
	event: "execution.text_delta",
	data: { text: sourceKey },
});

describe.skipIf(
	!process.env.DATABASE_URL || process.env.RUN_DB_INTEGRATION !== "1",
)("conversation replay journal in Postgres", () => {
	beforeAll(async () => {
		await db.$executeRawUnsafe(
			"CREATE ROLE example_chat_replay_reader NOLOGIN NOSUPERUSER NOBYPASSRLS",
		);
		await db.$executeRawUnsafe(
			"GRANT USAGE ON SCHEMA public TO example_chat_replay_reader",
		);
		await db.$executeRawUnsafe(
			"GRANT SELECT ON conversation_turn_event TO example_chat_replay_reader",
		);
		await db.user.create({
			data: {
				id: scope.userId,
				name: "Example",
				email: "replay@example.com",
				emailVerified: true,
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		});
		await db.organization.create({
			data: {
				id: scope.organizationId,
				name: "Example",
				slug: "example-replay-org",
				createdAt: new Date(),
			},
		});
	});
	beforeEach(async () => {
		await db.conversationTurn.deleteMany({ where: { id: scope.turnId } });
		await db.conversationTurn.create({
			data: {
				id: scope.turnId,
				userId: scope.userId,
				organizationId: scope.organizationId,
				executionId: scope.executionId,
				clientRequestKey: "example-replay-key",
				status: "ACTIVE",
			},
		});
	});
	afterAll(async () => {
		await db.conversationTurn.deleteMany({ where: { id: scope.turnId } });
		await db.organization.deleteMany({
			where: { id: scope.organizationId },
		});
		await db.user.deleteMany({ where: { id: scope.userId } });
		await db.$executeRawUnsafe(
			"REVOKE SELECT ON conversation_turn_event FROM example_chat_replay_reader",
		);
		await db.$executeRawUnsafe(
			"REVOKE USAGE ON SCHEMA public FROM example_chat_replay_reader",
		);
		await db.$executeRawUnsafe("DROP ROLE example_chat_replay_reader");
		await db.$disconnect();
	});

	it("serializes concurrent appends and returns each committed event once after a cursor", async () => {
		await Promise.all(
			Array.from({ length: 20 }, (_, i) => append(event(`source-${i}`))),
		);
		const rows = await read({ scope });
		expect(rows).toHaveLength(20);
		expect(new Set(rows.map((row) => row.cursor.sequence)).size).toBe(20);
		for (let i = 1; i < rows.length; i++) {
			expect(
				BigInt(rows[i].cursor.sequence) >
					BigInt(rows[i - 1].cursor.sequence),
			).toBe(true);
		}
		expect(await read({ scope, after: rows[9].cursor })).toEqual(
			rows.slice(10),
		);
	});

	it("is idempotent for a retried physical publication", async () => {
		const cursors = await Promise.all([
			append(event("same")),
			append(event("same")),
		]);
		expect(cursors[0]).toEqual(cursors[1]);
		expect(await read({ scope })).toHaveLength(1);
	});

	it("does not expose a later sequence while an earlier append is uncommitted", async () => {
		let release: () => void = () => {};
		let locked: () => void = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const ready = new Promise<void>((resolve) => {
			locked = resolve;
		});
		const first = db.$transaction(async (tx) => {
			await tx.$queryRaw`SELECT "id" FROM "conversation_turn" WHERE "id" = ${scope.turnId} FOR UPDATE`;
			await tx.conversationTurnEvent.create({
				data: {
					turnId: scope.turnId,
					organizationId: scope.organizationId,
					userId: scope.userId,
					runId: scope.runId,
					sourceKey: "held",
					event: "execution.text_delta",
					data: { text: "First" },
					expiresAt: new Date(Date.now() + 60_000),
				},
			});
			locked();
			await held;
		});
		await ready;
		const second = append(event("second"));
		try {
			await vi.waitFor(async () => {
				const [row] = await db.$queryRaw<
					{ waiting: bigint }[]
				>`SELECT COUNT(*) AS waiting FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%conversation_turn%'`;
				expect(Number(row.waiting)).toBeGreaterThan(0);
			});
			expect(await read({ scope })).toEqual([]);
		} finally {
			release();
			await Promise.all([first, second]);
		}
		const rows = await read({ scope });
		expect(rows.map((row) => row.data)).toEqual([
			{ text: "First" },
			{ text: "second" },
		]);
	});

	it("caps ordinary output while preserving one durable gap marker", async () => {
		await db.conversationTurnEvent.createMany({
			data: Array.from({ length: 20_000 }, (_, i) => ({
				turnId: scope.turnId,
				userId: scope.userId,
				organizationId: scope.organizationId,
				runId: scope.runId,
				sourceKey: `full-${i}`,
				event: "execution.text_delta",
				data: { text: "x" },
				expiresAt: new Date(Date.now() + 60_000),
			})),
		});
		await expect(append(event("overflow"))).rejects.toThrow("output limit");
		const marker = {
			...event("replay-unavailable"),
			event: "execution.replay_unavailable",
			data: { text: "Output unavailable" },
		};
		expect(await append(marker)).not.toBeNull();
		await append(marker);
		expect(
			await db.conversationTurnEvent.count({
				where: { turnId: scope.turnId },
			}),
		).toBe(20_001);
	});

	it.each([
		[scope.userId, scope.organizationId, "organization", 1],
		["example-other", scope.organizationId, "organization", 0],
		[scope.userId, "example-other", "organization", 0],
		[scope.userId, scope.organizationId, "personal", 0],
	])(
		"enforces row-level isolation for %s / %s / %s",
		async (userId, organizationId, tenantType, count) => {
			await append(event("one"));
			const rows = await db.$transaction(async (tx) => {
				await tx.$executeRaw`SELECT set_config('app.user_id', ${userId}, true), set_config('app.tenant_id', ${organizationId}, true), set_config('app.tenant_type', ${tenantType}, true)`;
				await tx.$executeRawUnsafe(
					"SET LOCAL ROLE example_chat_replay_reader",
				);
				return tx.$queryRaw<
					{ id: bigint }[]
				>`SELECT "id" FROM "conversation_turn_event"`;
			});
			expect(rows).toHaveLength(count);
		},
	);

	it.each([
		"organizationId",
		"userId",
		"executionId",
		"turnId",
		"runId",
	] as const)("never reads output with another %s", async (field) => {
		const cursor = await append(event("one"));
		expect(cursor).not.toBeNull();
		const wrong = { ...scope, [field]: "example-other" };
		expect(await read({ scope: wrong })).toEqual([]);
		await expect(
			read({ scope: wrong, after: cursor ?? undefined }),
		).rejects.toThrow();
	});

	it("redacts credential fields before persisting or replaying tool arguments", async () => {
		await append({
			...event("tool"),
			data: {
				toolCall: {
					args: {
						apiKey: "example-sensitive-value",
						query: "Example",
					},
				},
			},
		});
		const [row] = await read({ scope });
		expect(row.data).toEqual({
			toolCall: { args: { apiKey: "[REDACTED]", query: "Example" } },
		});
	});

	it("preserves ordinary tool fields while redacting nested credentials", async () => {
		await append({
			...event("ordinary-fields"),
			data: {
				mapping: { apiKey: "example-secret", value: "Example" },
				shipping: "Example",
				opinion: "Example",
				maxTokens: 100,
			},
		});
		const [row] = await read({ scope });
		expect(row.data).toEqual({
			mapping: { apiKey: "[REDACTED]", value: "Example" },
			shipping: "Example",
			opinion: "Example",
			maxTokens: 100,
		});
	});
	it("rejects oversized events without allocating a resumable entry", async () => {
		await expect(
			append({
				...event("oversized"),
				data: { text: "x".repeat(1024 * 1024) },
			}),
		).rejects.toThrow("output limit");
		expect(await read({ scope })).toEqual([]);
	});

	it("refuses expired cursors, hides expired output, and purges it in bounded batches", async () => {
		const cursor = await append(event("expired"));
		await db.conversationTurnEvent.updateMany({
			where: { turnId: scope.turnId },
			data: { expiresAt: new Date(0) },
		});
		expect(await read({ scope })).toEqual([]);
		await expect(
			read({ scope, after: cursor ?? undefined }),
		).rejects.toThrow("expired");
		expect(await purgeExpiredConversationTurnEvents()).toBe(1);
	});

	it("uses a composite foreign key to reject a forged tenant copy", async () => {
		await expect(
			db.conversationTurnEvent.create({
				data: {
					turnId: scope.turnId,
					organizationId: "example-other-org",
					userId: scope.userId,
					runId: scope.runId,
					sourceKey: "forged",
					event: "execution.text_delta",
					data: {},
					expiresAt: new Date(),
				},
			}),
		).rejects.toThrow();
	});

	it("cascades replay output when its parent turn is erased", async () => {
		await append(event("one"));
		await db.conversationTurn.delete({ where: { id: scope.turnId } });
		expect(
			await db.conversationTurnEvent.count({
				where: { turnId: scope.turnId },
			}),
		).toBe(0);
	});

	it("ignores a publication that has no server-admitted turn", async () => {
		expect(
			await append({
				...event("unknown"),
				executionId: "orch-example-missing",
			}),
		).toBeNull();
	});
});
