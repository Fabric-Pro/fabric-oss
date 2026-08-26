import { randomUUID } from "node:crypto";
import { afterAll, expect, it } from "vitest";
import { db } from "../index";
import { createOrGetPublishingCycle } from "../prisma/queries/projects/publishing-suite";

// REAL-DB integration test: createOrGetPublishingCycle has two idempotency guards — the
// active-GENERATING partial-unique index (concurrent dispatches) and, when an occurrenceKey is
// supplied, the (projectId, occurrenceKey) partial-unique index (Codex N2: retries across time,
// recovering the SAME cycle even after the generation workflow terminalized it). Gated on
// RUN_DB_INTEGRATION like the sibling publishing-suite-*.test.ts files, so the no-Postgres unit run
// SKIPS it; it runs only in the db-integration CI job.
const RUN_DB = process.env.RUN_DB_INTEGRATION === "1";
const projectIds: string[] = [];
const createdUserIds: string[] = [];

// Concurrency idempotency: the active-GENERATING partial index means a second
// create while one is in flight reads back the same cycle (created=false).
it.skipIf(!RUN_DB)(
	"returns created=true first, then created=false while a cycle is active, reading back the STORED coveredThrough (F4-producer)",
	async () => {
		// A dedicated user (not db.user.findFirstOrThrow()) — the db-integration CI job runs
		// against a fresh, unseeded Postgres, and sibling suites (rls-isolation.test.ts) delete
		// their own fixture users in afterAll, so relying on "some other row exists" is order-
		// dependent and can 404 in CI even though createOrGetPublishingCycle itself is correct.
		const user = await db.user.create({
			data: {
				id: `pub-coreget-${randomUUID()}`,
				name: "pub-suite-createorget",
				email: `pub-coreget-${randomUUID()}@test.local`,
				emailVerified: false,
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		});
		createdUserIds.push(user.id);
		const project = await db.project.create({
			data: {
				name: "coreget",
				userId: user.id,
				techStack: [],
				features: [],
				tags: [],
			},
		});
		projectIds.push(project.id);
		const firstCoveredThrough = new Date();
		const base = {
			projectId: project.id,
			organizationId: null,
			userId: user.id,
			actorUserId: user.id,
			coveredThrough: firstCoveredThrough,
			executionTimeoutAt: new Date(Date.now() + 3_600_000),
		};
		const first = await createOrGetPublishingCycle(base);
		// A later dispatcher retry computes a DIFFERENT "now" for coveredThrough. The
		// read-back (P2002) path must return the cycle's ORIGINALLY-STORED coveredThrough —
		// not this retry's value — so the dispatcher's workflow-input build (a separate,
		// later fix) uses the real collection boundary, not the retry's current time.
		const retryCoveredThrough = new Date(
			firstCoveredThrough.getTime() + 60_000,
		);
		const second = await createOrGetPublishingCycle({
			...base,
			coveredThrough: retryCoveredThrough,
		});
		expect(first.created).toBe(true);
		expect(second.created).toBe(false);
		expect(second.cycle.id).toBe(first.cycle.id);
		expect(second.cycle.coveredThrough).toEqual(firstCoveredThrough);
		expect(second.cycle.coveredThrough).not.toEqual(retryCoveredThrough);
		expect(second.cycle.executionTimeoutAt).toEqual(
			first.cycle.executionTimeoutAt,
		);
	},
);

// Codex N2 (retry-idempotency): with an occurrenceKey, a retry recovers the SAME cycle by
// (projectId, occurrenceKey) even AFTER it has gone terminal (READY) — the exact gap the
// active-GENERATING index cannot cover (a terminalized cycle frees that slot, so a bare create
// would spawn a SECOND cycle + workflow → duplicate collectors + LLM spend). A second create under
// the same key returns created:false with the same id, and NO duplicate cycle row is created.
it.skipIf(!RUN_DB)(
	"with an occurrenceKey, a second create under the SAME key returns the existing cycle (created:false) even after it is terminalized — no duplicate",
	async () => {
		const user = await db.user.create({
			data: {
				id: `pub-occ-${randomUUID()}`,
				name: "pub-suite-occurrence",
				email: `pub-occ-${randomUUID()}@test.local`,
				emailVerified: false,
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		});
		createdUserIds.push(user.id);
		const project = await db.project.create({
			data: {
				name: "occurrence",
				userId: user.id,
				techStack: [],
				features: [],
				tags: [],
			},
		});
		projectIds.push(project.id);
		const occurrenceKey = `dispatcher-run-${randomUUID()}`;
		const base = {
			projectId: project.id,
			organizationId: null,
			userId: user.id,
			actorUserId: user.id,
			coveredThrough: new Date(),
			executionTimeoutAt: new Date(Date.now() + 3_600_000),
			occurrenceKey,
		};

		const first = await createOrGetPublishingCycle(base);
		expect(first.created).toBe(true);

		// The generation workflow completes and TERMINALIZES the cycle — freeing the
		// active-GENERATING partial-index slot the older idempotency relied on.
		await db.publishingSuggestionCycle.update({
			where: { id: first.cycle.id },
			data: { status: "READY", completedAt: new Date() },
		});

		// The dispatch activity is retried (start landed, completion lost). Same occurrenceKey →
		// recover the SAME (now-terminal) cycle instead of creating a second one.
		const retry = await createOrGetPublishingCycle(base);
		expect(retry.created).toBe(false);
		expect(retry.cycle.id).toBe(first.cycle.id);
		expect(retry.cycle.status).toBe("READY"); // returned regardless of terminal status

		// The decisive assertion: exactly ONE cycle exists for the project — no duplicate.
		const count = await db.publishingSuggestionCycle.count({
			where: { projectId: project.id },
		});
		expect(count).toBe(1);
	},
);

afterAll(async () => {
	await db.project.deleteMany({ where: { id: { in: projectIds } } });
	await db.user.deleteMany({ where: { id: { in: createdUserIds } } });
});
