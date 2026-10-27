/**
 * Real Postgres coverage for the explicit insert and owner-scoped row lock.
 * Opt in with RUN_DB_INTEGRATION=1 and a non-placeholder DATABASE_URL pointing
 * to a disposable local database with the migration applied. Unit runs exclude
 * this file in vitest.config.ts; no database is needed to collect unit tests.
 */
import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "../prisma/generated/client";
import {
	type CreateEpisodeInput,
	createEpisodicMemory,
} from "../prisma/queries/orchestrator-memory";
import { hasReachableDatabaseUrl } from "./_helpers/db-availability";

const suffix = randomUUID();
const ids = {
	owner: `episode-owner-${suffix}`,
	otherOwner: `episode-other-${suffix}`,
	org: `episode-org-${suffix}`,
	conversation: `episode-conversation-${suffix}`,
};
let fixtures: PrismaClient;
const input: CreateEpisodeInput = {
	userId: ids.owner,
	organizationId: ids.org,
	conversationId: ids.conversation,
	executionId: "execution-example-1",
	title: "Compare the five newest features and pick two",
	summary: "Initial comparison",
	keyTopics: [],
	userIntents: [],
	outcome: "success",
	turnCount: 1,
	messageCount: 2,
	toolsUsed: [],
	agentsUsed: [],
	conversationStartedAt: new Date("2026-10-01"),
};
async function settleCalls(calls: Array<Promise<unknown>>) {
	const results = await Promise.allSettled(calls);
	const failure = results.find((result) => result.status === "rejected");
	if (failure?.status === "rejected") {
		throw failure.reason;
	}
}

/** Counts SELECT and UPDATE waiters, including waiters queued behind a waiter. */
async function waitForEpisodeWaiters(holderPid: number): Promise<void> {
	const deadline = performance.now() + 5000;
	let lastCount = 0;
	while (performance.now() < deadline) {
		const [row] = await fixtures.$queryRaw<Array<{ waiters: number }>>`
   WITH RECURSIVE blocked(pid) AS (
    SELECT ${holderPid}::integer
    UNION
    SELECT activity.pid FROM pg_stat_activity AS activity
    JOIN blocked ON blocked.pid = ANY(pg_blocking_pids(activity.pid))
    WHERE activity.datname = current_database() AND activity.wait_event_type = 'Lock'
   )
   SELECT count(*)::integer AS waiters
   FROM blocked JOIN pg_stat_activity AS activity ON activity.pid = blocked.pid
   WHERE blocked.pid <> ${holderPid}
    AND activity.query LIKE '%episodic_memory%'
    AND activity.query ~* '(^|[^a-z])(SELECT|UPDATE)([^a-z]|$)'`;
		lastCount = row?.waiters ?? 0;
		if (lastCount === 2) {
			return;
		}
	}
	throw new Error(
		`Expected two episode SELECT/UPDATE waiters; observed ${lastCount}`,
	);
}

describe.skipIf(
	process.env.RUN_DB_INTEGRATION !== "1" || !hasReachableDatabaseUrl(),
)("episode creation and retry contention (real Postgres)", () => {
	beforeAll(async () => {
		fixtures = new PrismaClient({
			adapter: new PrismaPg({
				connectionString: process.env.DATABASE_URL ?? "",
			}),
		});
		for (const id of [ids.owner, ids.otherOwner]) {
			await fixtures.user.create({
				data: {
					id,
					name: "Example contributor",
					email: `${id}@example.com`,
					emailVerified: true,
					createdAt: new Date(),
					updatedAt: new Date(),
				},
			});
		}
		await fixtures.organization.create({
			data: {
				id: ids.org,
				name: "Example organization",
				slug: ids.org,
				createdAt: new Date(),
			},
		});
	});
	beforeEach(async () => {
		await fixtures.episodicMemory.deleteMany({
			where: { conversationId: ids.conversation },
		});
	});
	afterAll(async () => {
		await fixtures.episodicMemory.deleteMany({
			where: { conversationId: ids.conversation },
		});
		await fixtures.organization.deleteMany({ where: { id: ids.org } });
		await fixtures.user.deleteMany({
			where: { id: { in: [ids.owner, ids.otherOwner] } },
		});
		await fixtures.$disconnect();
		const { db } = await import("../prisma/client");
		await db.$disconnect();
	});
	it("keeps both turns when two callers create the same conversation", async () => {
		await settleCalls([
			createEpisodicMemory(input),
			createEpisodicMemory({
				...input,
				executionId: "execution-example-2",
				summary: "Follow-up comparison",
				conversationStartedAt: new Date("2026-10-02"),
			}),
		]);
		const rows = await fixtures.episodicMemory.findMany({
			where: { conversationId: ids.conversation },
		});
		expect(rows).toHaveLength(1);
		expect(rows[0].recordedExecutionIds).toHaveLength(2);
		expect(rows[0].recordedExecutionIds).toEqual(
			expect.arrayContaining([input.executionId, "execution-example-2"]),
		);
		expect(rows[0]).toMatchObject({ turnCount: 2, messageCount: 4 });
		expect(rows[0].turnSections).toMatchObject({
			turnCount: 2,
			sections: expect.arrayContaining([
				expect.objectContaining({ executionId: input.executionId }),
				expect.objectContaining({ executionId: "execution-example-2" }),
			]),
		});
		expect(rows[0].summary).toContain("Initial comparison");
		expect(rows[0].summary).toContain("Follow-up comparison");
	});
	it("records a concurrent retry of one execution once", async () => {
		await settleCalls([
			createEpisodicMemory(input),
			createEpisodicMemory(input),
		]);
		const rows = await fixtures.episodicMemory.findMany({
			where: { conversationId: ids.conversation },
		});
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			recordedExecutionIds: [input.executionId],
			turnCount: 1,
			messageCount: 2,
		});
		expect(rows[0].turnSections).toMatchObject({
			sections: [
				expect.objectContaining({ executionId: input.executionId }),
			],
		});
		expect(rows[0].summary.match(/Initial comparison/g)).toHaveLength(1);
	});
	it.each(["title and body boundary", "summary trim boundary"])(
		"stores well-formed Unicode in Postgres (%s)",
		async (boundary) => {
			const prefix = "Compare the five newest features ";
			const title =
				boundary === "title and body boundary"
					? `${prefix + "x".repeat(199 - prefix.length)}😀 trailing`
					: input.title;
			const header = `First request: ${input.title}\n\nTurn 1\n`;
			const summary =
				boundary === "title and body boundary"
					? `${"x".repeat(1999)}😀 trailing`
					: `${"x".repeat(2000 - header.length - 1)}😀 trailing`;
			await createEpisodicMemory({ ...input, title, summary });
			const row = await fixtures.episodicMemory.findUniqueOrThrow({
				where: { conversationId: ids.conversation },
			});
			function check(value: unknown): void {
				if (typeof value === "string") {
					expect(value).not.toMatch(/[\uD800-\uDFFF]/u);
				} else if (value && typeof value === "object") {
					Object.values(value).forEach(check);
				}
			}
			check(row);
			expect(row.summary.length).toBeLessThanOrEqual(2000);
			expect(row.title.length).toBeLessThanOrEqual(200);
		},
	);
	it("keeps both completions racing on an existing episode row", async () => {
		const episode = await createEpisodicMemory(input);
		let signalHeld!: (pid: number) => void;
		let releaseFixtureLock!: () => void;
		const held = new Promise<number>((resolve) => {
			signalHeld = resolve;
		});
		const release = new Promise<void>((resolve) => {
			releaseFixtureLock = resolve;
		});
		const holder = fixtures.$transaction(
			async (tx) => {
				await tx.$queryRaw`SELECT id FROM episodic_memory WHERE id = ${episode.id} FOR UPDATE`;
				const [backend] = await tx.$queryRaw<
					Array<{ pid: number }>
				>`SELECT pg_backend_pid() AS pid`;
				signalHeld(backend.pid);
				await release;
			},
			{ timeout: 15000 },
		);
		let racing: Array<Promise<unknown>> = [];
		try {
			const holderPid = await Promise.race([
				held,
				holder.then(() => {
					throw new Error(
						"Fixture transaction ended before announcing its lock",
					);
				}),
			]);
			racing = [
				createEpisodicMemory({
					...input,
					executionId: "execution-late-example",
					summary: "Late completion",
					conversationStartedAt: new Date("2026-10-02"),
				}),
				createEpisodicMemory({
					...input,
					executionId: "execution-next-example",
					summary: "Next turn",
					conversationStartedAt: new Date("2026-10-03"),
				}),
			];
			// With the production lock these are SELECT waiters. Removing it allows
			// both callers to compute stale updates, which then wait here as UPDATEs.
			await waitForEpisodeWaiters(holderPid);
			releaseFixtureLock();
			await holder;
			await settleCalls(racing);
			const row = await fixtures.episodicMemory.findUniqueOrThrow({
				where: { conversationId: ids.conversation },
			});
			expect(row).toMatchObject({ turnCount: 3, messageCount: 6 });
			expect(row.recordedExecutionIds).toHaveLength(3);
			expect(row.recordedExecutionIds).toEqual(
				expect.arrayContaining([
					input.executionId,
					"execution-late-example",
					"execution-next-example",
				]),
			);
			expect(row.turnSections).toMatchObject({
				turnCount: 3,
				sections: expect.arrayContaining([
					expect.objectContaining({
						executionId: "execution-late-example",
					}),
					expect.objectContaining({
						executionId: "execution-next-example",
					}),
				]),
			});
			expect(row.summary).toContain("Initial comparison");
			expect(row.summary).toContain("Late completion");
			expect(row.summary).toContain("Next turn");
			expect(row.summary.indexOf("Late completion")).toBeLessThan(
				row.summary.indexOf("Next turn"),
			);
		} finally {
			releaseFixtureLock();
			// Drain writers before the next case's fixture cleanup, including on failure.
			await Promise.allSettled([holder, ...racing]);
		}
	});

	it("rejects another owner through the locked owner filter", async () => {
		await createEpisodicMemory(input);
		const snapshot = await fixtures.episodicMemory.findUniqueOrThrow({
			where: { conversationId: ids.conversation },
		});
		await expect(
			createEpisodicMemory({ ...input, userId: ids.otherOwner }),
		).rejects.toThrow("Episodic memory owner mismatch");
		expect(
			await fixtures.episodicMemory.findUniqueOrThrow({
				where: { conversationId: ids.conversation },
			}),
		).toEqual(snapshot);
	});
});
