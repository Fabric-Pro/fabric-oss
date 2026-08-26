import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	claimDeferredPublishingEmailDelivery,
	db,
	deferredPublishingEmailWorkRemains,
	type Prisma,
	PUBLISHING_DEFERRED_SKIP_NOTIFICATIONS_OFF,
	PUBLISHING_DEFERRED_SKIP_TENANT_CHANGED,
	PUBLISHING_DELIVERY_ATTEMPT_BOUND,
	PUBLISHING_DRAIN_BATCH_SIZE,
	PUBLISHING_DRAIN_CURSOR_START,
	PUBLISHING_DRAIN_PAGE_SQL,
	PUBLISHING_DRAIN_REMAINING_SQL,
	PUBLISHING_EMAIL_LEASE_MS,
	PUBLISHING_RECLAIM_REASON_ATTEMPT_BOUND,
	readDeferredPublishingEmailPage,
	reclaimPublishingDeliveryStates,
	recordPublishingDeferredEmailFailure,
	skipDeferredPublishingEmailDelivery,
} from "../index";

const RUN_DB = process.env.RUN_DB_INTEGRATION === "1";

// Every row this suite creates carries this prefix, so cleanup is exact and a
// leak is identifiable. Not a real identifier of anything.
const RUN = `drain_${randomUUID().replaceAll("-", "")}`;
const ORG_ID = `${RUN}_org`;
const ACTOR_ID = `${RUN}_actor`;
const PROJECT_ID = `${RUN}_proj`;
const CYCLE_ID = `${RUN}_cyc`;

// REAL TIME. The claim's expiry term is `clock_timestamp()` in the database and
// is not injectable, so a fixture instant in the future would make the claim
// refuse — or fail to refuse — for a reason no case here is about. Every case
// seeds an OFFSET from this.
const NOW = new Date();
const FUTURE = new Date(NOW.getTime() + 14 * 24 * 60 * 60_000);
const PAST = new Date(NOW.getTime() - 60_000);

let rowSeq = 0;

beforeAll(async () => {
	if (!RUN_DB) {
		return;
	}
	await db.organization.create({
		data: {
			id: ORG_ID,
			name: `Drain Fixture ${RUN}`,
			slug: `drain-fixture-${RUN}`,
			createdAt: new Date(),
		},
	});
	await db.user.create({
		data: {
			id: ACTOR_ID,
			name: "Drain Fixture Actor",
			email: `${ACTOR_ID}@example.com`,
			emailVerified: true,
			createdAt: new Date(),
			updatedAt: new Date(),
		},
	});
	await db.project.create({
		data: {
			id: PROJECT_ID,
			name: `Drain Fixture ${RUN}`,
			organizationId: ORG_ID,
			userId: ACTOR_ID,
			techStack: [],
			features: [],
			tags: [],
		},
	});
	await db.$executeRawUnsafe(
		`INSERT INTO "publishing_suggestion_cycle"
		   ("id","projectId","organizationId","userId","status","actorUserId",
		    "startedAt","completedAt","coveredThrough","notificationOutcome",
		    "notificationOutcomeVersion","notificationOutcomeAt","createdAt","updatedAt")
		 VALUES ($1,$2,$3,NULL,'READY',$4,$5,$5,$5,'MAIL_NOT_CONFIGURED',1,$5,$5,$5)`,
		CYCLE_ID,
		PROJECT_ID,
		ORG_ID,
		ACTOR_ID,
		NOW,
	);
}, 180_000);

// Explicit timeout: afterAll would otherwise run under vitest's default 10 s
// hookTimeout, and this teardown deletes with cascade checks against every table
// referencing user. A timed-out afterAll fails red AND leaves the fixture behind.
afterAll(async () => {
	if (!RUN_DB) {
		return;
	}
	// The backslash escapes LIKE's wildcard meaning of "_". Every statement names
	// a non-empty literal prefix, so the worst a half-built fixture can do is
	// delete nothing. Order follows the foreign keys.
	const prefix = `${RUN}\\_%`;
	await db.$executeRawUnsafe(
		`DELETE FROM "publishing_notification_delivery" WHERE "id" LIKE $1`,
		prefix,
	);
	await db.$executeRawUnsafe(
		`DELETE FROM "publishing_suggestion_cycle" WHERE "id" LIKE $1`,
		prefix,
	);
	await db.$executeRawUnsafe(
		`DELETE FROM "project" WHERE "id" LIKE $1`,
		prefix,
	);
	await db.$executeRawUnsafe(`DELETE FROM "user" WHERE "id" LIKE $1`, prefix);
	await db.$executeRawUnsafe(
		`DELETE FROM "organization" WHERE "id" LIKE $1`,
		prefix,
	);

	// A ROLLED-BACK TRANSACTION DOES NOT UNDO THE PHYSICAL WRITES, and this suite
	// is the only one here that seeds at a scale where that matters. Measured on
	// this fixture: after the cost case, `publishing_notification_delivery` held
	// ONE live row and 366,749 dead ones across 3.2 GB, and
	// `publishing_suggestion_cycle` 879 MB. The rows are gone; the PAGES are not.
	//
	// Nothing in this suite notices — every case here reaches an index. The
	// NEIGHBOURS do: the reconciliation suite's teardown deletes by `LIKE` prefix,
	// which is a sequential scan, and against that bloat it exceeded its 180-second
	// hook budget and failed the FILE while reporting every test passed. That is
	// the "a red that is not a test failure" shape, produced here by a fixture two
	// files away.
	//
	// PLAIN, NOT FULL, and the choice was measured rather than reasoned. FULL
	// rewrites the relation and reclaims everything — and on the 3.2 GB this
	// suite's first draft produced it ran for more than ten minutes, which in a
	// 180-second hook is a second way to fail the file. Plain VACUUM truncates
	// TRAILING empty pages, and the pages an aborted bulk INSERT leaves are
	// exactly that: appended, then never committed. It costs a fraction of a
	// second here and returns the file to the size the neighbours expect.
	//
	// The other half of the fix is upstream: the fixture is now a tenth of what it
	// was, so the bloat is tens of megabytes rather than gigabytes. A cleanup that
	// has to be heroic is a fixture that is too big.
	//
	// In afterAll rather than at the end of the case, so a failing assertion
	// cannot skip it.
	await db.$executeRawUnsafe(
		`VACUUM (ANALYZE) "publishing_notification_delivery"`,
	);
	await db.$executeRawUnsafe(
		`VACUUM (ANALYZE) "publishing_suggestion_cycle"`,
	);
	await db.$disconnect();
}, 180_000);

const describeDb = RUN_DB ? describe : describe.skip;

/**
 * Seed one DEFERRED obligation and COMMIT it.
 *
 * Committed rather than staged inside a rolled-back transaction, because the
 * writers under test call the module-level client: they cannot be handed a
 * transaction, and the concurrency cases need two connections to see each other.
 * Cleanup is by prefix.
 */
async function seedDeferred(row: {
	expiresAt?: Date;
	attemptCount?: number;
	lastAttemptAt?: Date | null;
	status?: string;
	claimedAt?: Date | null;
	claimToken?: string | null;
}): Promise<{ id: string; cycleId: string; recipientUserId: string }> {
	rowSeq += 1;
	const id = `${RUN}_row_${String(rowSeq).padStart(6, "0")}`;
	const recipientUserId = ACTOR_ID;
	// The unique triple is (cycleId, recipientUserId, channel), so rows sharing a
	// cycle need their own cycle. One cycle per row keeps every case independent.
	const cycleId = `${RUN}_cyc_${String(rowSeq).padStart(6, "0")}`;
	await db.$executeRawUnsafe(
		`INSERT INTO "publishing_suggestion_cycle"
		   ("id","projectId","organizationId","userId","status","actorUserId",
		    "startedAt","completedAt","coveredThrough","notificationOutcome",
		    "notificationOutcomeVersion","notificationOutcomeAt","createdAt","updatedAt")
		 VALUES ($1,$2,$3,NULL,'READY',$4,$5,$5,$5,'MAIL_NOT_CONFIGURED',1,$5,$5,$5)`,
		cycleId,
		PROJECT_ID,
		ORG_ID,
		ACTOR_ID,
		NOW,
	);
	await db.$executeRawUnsafe(
		`INSERT INTO "publishing_notification_delivery"
		   ("id","cycleId","projectId","organizationId","userId","recipientUserId",
		    "channel","status","expiresAt","attemptCount","lastAttemptAt",
		    "claimedAt","claimToken","createdAt")
		 VALUES ($1,$2,$3,$4,NULL,$5,'EMAIL',$6,$7::timestamp,$8::int,
		         $9::timestamp,$10::timestamp,$11::text,$12::timestamp)`,
		id,
		cycleId,
		PROJECT_ID,
		ORG_ID,
		recipientUserId,
		row.status ?? "DEFERRED",
		row.expiresAt ?? FUTURE,
		row.attemptCount ?? 0,
		row.lastAttemptAt ?? null,
		row.claimedAt ?? null,
		row.claimToken ?? null,
		NOW,
	);
	return { id, cycleId, recipientUserId };
}

async function readRow(id: string): Promise<{
	status: string;
	reason: string | null;
	attemptCount: number;
	claimedAt: Date | null;
	claimToken: string | null;
	lastAttemptAt: Date | null;
	expiresAt: Date | null;
}> {
	const rows = (await db.$queryRawUnsafe(
		`SELECT "status","reason","attemptCount","claimedAt","claimToken",
		        "lastAttemptAt","expiresAt"
		   FROM "publishing_notification_delivery" WHERE "id" = $1`,
		id,
	)) as Array<{
		status: string;
		reason: string | null;
		attemptCount: number;
		claimedAt: Date | null;
		claimToken: string | null;
		lastAttemptAt: Date | null;
		expiresAt: Date | null;
	}>;
	return rows[0];
}

/**
 * Run a statement under `EXPLAIN (ANALYZE, BUFFERS)` and return the plan as one
 * string.
 *
 * BUFFERS, NOT MILLISECONDS. A buffer count is a property of the plan; a
 * millisecond is a property of the machine and the moment, and this module's
 * neighbour already carries a comment recording a timing floor that a second
 * session measured BELOW.
 */
async function explain(
	tx: Prisma.TransactionClient,
	sql: string,
	params: unknown[],
): Promise<string> {
	const rows = (await tx.$queryRawUnsafe(
		`EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF) ${sql}`,
		...params,
	)) as Array<Record<string, string>>;
	return rows.map((r) => Object.values(r)[0]).join("\n");
}

/**
 * The most buffers any EXECUTION node touched — `hit` and `read` together.
 *
 * TWO CORRECTIONS TO EARLIER DRAFTS OF THIS HELPER, both of which made it measure
 * something other than what it names:
 *
 *   THE `Planning:` SECTION IS CUT FIRST. `EXPLAIN (ANALYZE, BUFFERS)` reports
 *   planner buffers too, and those track catalog and statistics work rather than
 *   the statement: on this fixture execution touched 7 while planning touched 67,
 *   so the un-cut helper returned the planner's number and the case compared two
 *   planning costs while claiming to compare two execution costs.
 *
 *   `read` COUNTS, NOT ONLY `hit`. A page served from disk is reported as
 *   `read=N`, and a helper matching `hit` alone reports a COLD run as cheaper
 *   than a warm one — the wrong direction for a ceiling, because the run that
 *   would breach it is exactly the one whose pages are not cached.
 */
function buffersOf(plan: string): number {
	const execution = plan.split(/\nPlanning:/)[0];
	return [...execution.matchAll(/shared (?:hit|read)=(\d+)/g)].reduce(
		(max, m) => Math.max(max, Number(m[1])),
		0,
	);
}

/**
 * The expiry the bulk fixture starts from, and it is deliberately ANCIENT.
 *
 * THE PAGE HAS NO PROJECT PREDICATE — the sweep is global by design — so every
 * DEFERRED row in the database competes for the first page, including rows any
 * other suite left behind. Seeded at a realistic expiry, the fixture INTERLEAVES
 * with whatever else is there and the page's heap visits become a function of the
 * database's history rather than of the statement. That is what made the first
 * draft of the cost case flaky: it passed, failed on an unchanged tree, and
 * passed again.
 *
 * Anchored below every row the product can write, the fixture is unambiguously
 * the head of the order and the page reads only its own rows. A DEFERRED row with
 * a past expiry is a perfectly legal shape — the page predicate says nothing
 * about expiry, which is exactly why pass 1 is the statement that terminalizes
 * one.
 */
const BULK_EPOCH = new Date("2001-01-01T00:00:00.000Z");

/**
 * Seed `count` DEFERRED rows inside a transaction the caller will roll back.
 *
 * One `generate_series` rather than `count` round trips: the population is the
 * subject, and the executor under test is not involved in creating it. Every
 * parameter is cast explicitly — an untyped parameter inside an
 * `INSERT ... SELECT` resolves before the target column is consulted.
 *
 * Each batch INTERLEAVES with the previous one — the same expiry range, later ids
 * — because a real ledger receives deferrals from different cycles at different
 * times, and a fixture inserted in index order flatters the heap visits by
 * putting a whole page onto a handful of shared pages.
 */
async function seedBulk(
	tx: Prisma.TransactionClient,
	count: number,
	offset: number,
): Promise<void> {
	const prefix = `${RUN}_blk_${String(offset).padStart(3, "0")}_`;
	await tx.$executeRawUnsafe(
		`INSERT INTO "publishing_suggestion_cycle"
		   ("id","projectId","organizationId","userId","status","actorUserId",
		    "startedAt","completedAt","coveredThrough","notificationOutcome",
		    "notificationOutcomeVersion","notificationOutcomeAt","createdAt","updatedAt")
		 SELECT $1 || lpad(g::text, 7, '0'), $2::text, $3::text, NULL,
		        'READY'::publishing_cycle_status, $4::text,
		        $5::timestamp, $5::timestamp, $5::timestamp, 'MAIL_NOT_CONFIGURED', 1,
		        $5::timestamp, $5::timestamp, $5::timestamp
		   FROM generate_series(1, $6::int) g`,
		prefix,
		PROJECT_ID,
		ORG_ID,
		ACTOR_ID,
		NOW,
		count,
	);
	await tx.$executeRawUnsafe(
		`INSERT INTO "publishing_notification_delivery"
		   ("id","cycleId","projectId","organizationId","userId","recipientUserId",
		    "channel","status","expiresAt","attemptCount","createdAt")
		 SELECT $1 || lpad(g::text, 7, '0'), $1 || lpad(g::text, 7, '0'),
		        $2::text, $3::text, NULL, $4::text, 'EMAIL', 'DEFERRED',
		        $5::timestamp + (g || ' seconds')::interval, 0, $5::timestamp
		   FROM generate_series(1, $6::int) g`,
		prefix,
		PROJECT_ID,
		ORG_ID,
		ACTOR_ID,
		BULK_EPOCH,
		count,
	);
	await tx.$executeRawUnsafe(`ANALYZE "publishing_notification_delivery"`);
}

describeDb("the drain page is bounded by the PAGE, not by the backlog", () => {
	it("walks the drain index, and its cost stays bounded by the PAGE across a hundredfold backlog", async () => {
		// One transaction, rolled back: 333,000 rows seeded and thrown away. The
		// measurement is the subject, the rows are not.
		//
		// TWO SIZES, A TENFOLD STEP APART, AND AN ABSOLUTE BOUND RATHER THAN A
		// DELTA. A delta between two points cannot tell "does not scale" from
		// "scaled by less than the tolerance I chose" — which is why the first
		// draft of this case reached for a third point at 300,000. The absolute
		// bound makes two points sufficient and the third point unaffordable:
		// a page ceiling of BATCH_SIZE + 20 is a claim a sequential scan cannot
		// satisfy at EITHER size (it reads ~371 buffers at 30,000 and ten times
		// that at 300,000), so the plan and the bound are pinned without seeding a
		// third of a million rows whose pages outlive the transaction that made
		// them — see this suite's afterAll for what that cost the file next door.
		const plans: string[] = [];
		await db
			.$transaction(
				async (tx) => {
					for (const [batch, count] of [
						[1, 3_000],
						[2, 27_000],
					] as const) {
						await seedBulk(tx, count, batch);
						plans.push(
							await explain(tx, PUBLISHING_DRAIN_PAGE_SQL, [
								PUBLISHING_DRAIN_CURSOR_START.expiresAt,
								PUBLISHING_DRAIN_CURSOR_START.id,
							]),
						);
					}
					throw new Error("rollback");
				},
				// Prisma's interactive transactions default to a 5-second ceiling and
				// this one seeds a third of a million rows. Not a hint: an expired
				// transaction fails the NEXT statement, so the case would fail inside
				// the fixture rather than at an assertion — a red that says nothing
				// about the subject.
				{ maxWait: 15_000, timeout: 170_000 },
			)
			.catch((error: Error) => {
				if (error.message !== "rollback") {
					throw error;
				}
			});

		// The bound: one index descent plus at most one heap page per row of the
		// page. A sequential scan cannot satisfy it at the second size, let alone
		// the third — at 30,000 rows it reads ~371 buffers and at 300,000 it reads
		// ten times that, which is precisely the failure this index exists to
		// prevent and the reason the number is asserted rather than described.
		const PAGE_BOUND = PUBLISHING_DRAIN_BATCH_SIZE + 20;
		for (const plan of plans) {
			// `Index Scan`, not `Index Only Scan`: the page projects the tenant
			// tuple and the cycle, none of which the index covers, so it visits the
			// heap for each row. Asserting the form the statement ACTUALLY takes,
			// rather than a form measured on a simplified probe — the substring
			// below does not match "Index Only Scan using", so a change that made
			// this index-only would go red and be re-decided rather than absorbed.
			expect(plan).toContain(
				"Index Scan using publishing_notification_delivery_deferred_drain_idx",
			);
			expect(plan).not.toContain("Seq Scan");
			expect(plan).not.toContain("Sort");
			// The plan travels with the failure. A bare number tells a future
			// reader that a ceiling moved and nothing about which node moved it.
			expect(
				buffersOf(plan),
				`page read more than ${PAGE_BOUND} buffers:\n${plan}`,
			).toBeLessThanOrEqual(PAGE_BOUND);
		}
	}, 180_000);

	it("returns rows in expiry order, and the cursor resumes exactly after the last one", async () => {
		const early = await seedDeferred({
			expiresAt: new Date(FUTURE.getTime() + 1_000),
		});
		const middle = await seedDeferred({
			expiresAt: new Date(FUTURE.getTime() + 2_000),
		});
		const late = await seedDeferred({
			expiresAt: new Date(FUTURE.getTime() + 3_000),
		});

		const page = await readDeferredPublishingEmailPage(
			PUBLISHING_DRAIN_CURSOR_START,
		);
		const ours = page.filter((r) => r.id.startsWith(RUN));
		expect(ours.map((r) => r.id)).toEqual([early.id, middle.id, late.id]);

		// The cursor is the LAST ROW READ, not the last row acted on. Resuming from
		// the middle must return the late row and nothing before it.
		const rest = await readDeferredPublishingEmailPage({
			expiresAt: ours[1].expiresAt,
			id: ours[1].id,
		});
		expect(
			rest.filter((r) => r.id.startsWith(RUN)).map((r) => r.id),
		).toEqual([late.id]);
	});

	it("the residual probe answers from the FINAL cursor, not from the head", async () => {
		const only = await seedDeferred({
			expiresAt: new Date(FUTURE.getTime() + 4_000),
		});
		expect(
			await deferredPublishingEmailWorkRemains({
				expiresAt: new Date(FUTURE.getTime() + 3_999),
				id: "",
			}),
		).toBe(true);
		expect(
			await deferredPublishingEmailWorkRemains({
				expiresAt: (await readRow(only.id)).expiresAt as Date,
				id: only.id,
			}),
		).toBe(false);
	});
});

describeDb("the page statement's text, which no plan can prove", () => {
	it("emits every status as a LITERAL, never as a bind parameter", () => {
		// A generic plan cannot prove `status = $1` implies `status = 'DEFERRED'`,
		// so a parameterized status loses the partial index and the page becomes a
		// sequential scan of the whole ledger — silently, and worst exactly when
		// the backlog is largest.
		for (const sql of [
			PUBLISHING_DRAIN_PAGE_SQL,
			PUBLISHING_DRAIN_REMAINING_SQL,
		]) {
			expect(sql).toContain(`"status" = 'DEFERRED'`);
			expect(sql).not.toMatch(/"status"\s*=\s*\$\d/);
		}
	});

	it("orders by URGENCY and not by recency", () => {
		// `ORDER BY "id"` looks equivalent — for a cuid it is approximately
		// creation order — and is the starvation bug: a capped run would serve
		// newer rows repeatedly while the oldest reach EXPIRED with the key
		// already restored.
		expect(PUBLISHING_DRAIN_PAGE_SQL).toContain(
			`ORDER BY "expiresAt" ASC, "id" ASC`,
		);
	});

	it("binds exactly as many parameters as it has placeholders, in both directions", () => {
		const highest = (sql: string): number =>
			[...sql.matchAll(/\$(\d+)/g)].reduce(
				(max, m) => Math.max(max, Number(m[1])),
				0,
			);
		// The cursor is two values and both statements take exactly it. The guard
		// that would have caught a probe handed its update's parameter list, at
		// authoring time rather than only under budget exhaustion.
		expect(highest(PUBLISHING_DRAIN_PAGE_SQL)).toBe(2);
		expect(highest(PUBLISHING_DRAIN_REMAINING_SQL)).toBe(2);
	});
});

describeDb("the atomic claim", () => {
	it("claims a deferred row, increments the attempt count and returns the PREVIOUS attempt instant", async () => {
		const before = new Date(NOW.getTime() - 3 * 60 * 60_000);
		const row = await seedDeferred({
			attemptCount: 2,
			lastAttemptAt: before,
		});

		const claim = await claimDeferredPublishingEmailDelivery({
			id: row.id,
		});
		expect(claim.outcome).toBe("CLAIMED");
		if (claim.outcome !== "CLAIMED") {
			return;
		}
		// From the claim's own statement, never from a read taken before it: a
		// pre-claim read can be arbitrarily old, because a timed-out attempt keeps
		// running.
		expect(claim.previousAttemptAt?.toISOString()).toBe(
			before.toISOString(),
		);

		const after = await readRow(row.id);
		expect(after.status).toBe("SENDING");
		expect(after.attemptCount).toBe(3);
		expect(after.claimToken).toBe(claim.claimToken);
		expect(after.claimedAt).not.toBeNull();
		// The claim CLEARS a stale reason so a retried row does not carry the
		// previous attempt's classification into this one.
		expect(after.reason).toBeNull();
	});

	it("two concurrent claims: exactly one CLAIMED, and attemptCount moves by ONE", async () => {
		// The structural property a naive implementation gets wrong. A
		// read-then-write passes the first assertion and fails the second, burning
		// the bound at twice the rate.
		const row = await seedDeferred({ attemptCount: 0 });
		const [a, b] = await Promise.all([
			claimDeferredPublishingEmailDelivery({ id: row.id }),
			claimDeferredPublishingEmailDelivery({ id: row.id }),
		]);
		const outcomes = [a.outcome, b.outcome].sort();
		expect(outcomes).toEqual(["CLAIMED", "HELD"]);
		expect((await readRow(row.id)).attemptCount).toBe(1);
	});

	it("a row AT the bound is DISCHARGED to FAILED with the reclaim reason, not claimed", async () => {
		const row = await seedDeferred({
			attemptCount: PUBLISHING_DELIVERY_ATTEMPT_BOUND,
		});
		expect(
			await claimDeferredPublishingEmailDelivery({ id: row.id }),
		).toEqual({
			outcome: "AT_BOUND",
		});
		const after = await readRow(row.id);
		expect(after.status).toBe("FAILED");
		// The SECOND writer of this constant, not a second constant carrying the
		// same string.
		expect(after.reason).toBe(PUBLISHING_RECLAIM_REASON_ATTEMPT_BOUND);
		expect(after.claimedAt).toBeNull();
		expect(after.claimToken).toBeNull();
		// The discharge does not touch the counter — it records that the bound was
		// reached, it does not consume another attempt.
		expect(after.attemptCount).toBe(PUBLISHING_DELIVERY_ATTEMPT_BOUND);
	});

	it("a row past its expiry, UNDER the bound, is NOT_CLAIMABLE and is not discharged", async () => {
		const row = await seedDeferred({ expiresAt: PAST, attemptCount: 1 });
		expect(
			await claimDeferredPublishingEmailDelivery({ id: row.id }),
		).toEqual({
			outcome: "NOT_CLAIMABLE",
		});
		expect((await readRow(row.id)).status).toBe("DEFERRED");
	});

	it("a row AT the bound AND past its expiry is left for pass 1, never FAILED (F1)", async () => {
		// THE PRECEDENCE INVERSION the discharge's expiry term exists to prevent,
		// and it is reachable in one run: pass 1's expiry statement has a batch
		// ceiling, so a spent budget leaves expired DEFERRED rows for this page to
		// find. Delete `AND "expiresAt" > clock_timestamp()` from the discharge and
		// this is the case that goes red.
		const row = await seedDeferred({
			expiresAt: PAST,
			attemptCount: PUBLISHING_DELIVERY_ATTEMPT_BOUND,
		});
		expect(
			await claimDeferredPublishingEmailDelivery({ id: row.id }),
		).toEqual({
			outcome: "NOT_CLAIMABLE",
		});
		expect((await readRow(row.id)).status).toBe("DEFERRED");

		// And what pass 1 then makes of it is EXPIRED, which is the whole point:
		// the obligation's own deadline is the stronger fact.
		await reclaimPublishingDeliveryStates({ now: new Date() });
		expect((await readRow(row.id)).status).toBe("EXPIRED");
	});

	it("a live lease is HELD — still owed, never terminal", async () => {
		const row = await seedDeferred({
			status: "SENDING",
			claimedAt: NOW,
			claimToken: `${RUN}_tok`,
		});
		// The claim refuses on its DEFERRED literal and the discharge refuses on
		// the same one, so the verdict comes from the still-owed probe — which does
		// NOT narrow to DEFERRED, on purpose. HELD is the honest answer: the
		// obligation is still owed and another attempt owns it. Answering
		// NOT_CLAIMABLE here would tell the drain the obligation was discharged
		// when it is merely taken, which is the "HELD is not terminal" invariant
		// this ledger has already paid for once.
		expect(
			await claimDeferredPublishingEmailDelivery({ id: row.id }),
		).toEqual({
			outcome: "HELD",
		});
		// And the row is untouched — no verdict path writes to a row it refused.
		expect((await readRow(row.id)).claimToken).toBe(`${RUN}_tok`);
		expect((await readRow(row.id)).status).toBe("SENDING");
	});

	it("a DEAD lease on a DEFERRED row is re-takeable", async () => {
		const row = await seedDeferred({
			claimedAt: new Date(
				NOW.getTime() - PUBLISHING_EMAIL_LEASE_MS - 1_000,
			),
			claimToken: `${RUN}_dead`,
		});
		const claim = await claimDeferredPublishingEmailDelivery({
			id: row.id,
		});
		expect(claim.outcome).toBe("CLAIMED");
	});

	it("a DEFERRED row with a null expiry is rejected by the CHECK, not by the claim", async () => {
		// The design asks this claim to have no `expiresAt IS NULL OR ...`, because
		// such a row would be claimed forever and never expire. The imported
		// predicate DOES carry that disjunct, for the legacy primary-path rows it
		// has always served — and the composition removes it: the deferred_shape
		// CHECK means `status = 'DEFERRED'` IMPLIES a non-null expiry, so the state
		// cannot exist. Asserted against the CONSTRAINT rather than the application
		// path, because the application path is not the only writer.
		const row = await seedDeferred({});
		await expect(
			db.$executeRawUnsafe(
				`UPDATE "publishing_notification_delivery"
				    SET "expiresAt" = NULL WHERE "id" = $1`,
				row.id,
			),
		).rejects.toThrow(/publishing_notification_delivery_deferred_shape/);
	});
});

describeDb("the deferral-aware failure recorder", () => {
	it("five attempts: DEFERRED after each of the first four, FAILED after the fifth (F3)", async () => {
		// THE OFF-BY-ONE GUARD. The claim increments inside its own statement, so
		// the recorder compares the count THIS attempt already consumed. Comparing
		// the pre-increment value returns a spent row to DEFERRED for one more
		// tick — one attempt more than the bound the design names, and invisible
		// unless the case asserts attemptCount at every step and not only status.
		const row = await seedDeferred({ attemptCount: 0 });
		for (let n = 1; n <= PUBLISHING_DELIVERY_ATTEMPT_BOUND; n++) {
			const claim = await claimDeferredPublishingEmailDelivery({
				id: row.id,
			});
			expect(claim.outcome).toBe("CLAIMED");
			if (claim.outcome !== "CLAIMED") {
				return;
			}
			const verdict = await recordPublishingDeferredEmailFailure({
				cycleId: row.cycleId,
				recipientUserId: row.recipientUserId,
				claimToken: claim.claimToken,
				reason: "PROVIDER_REJECTED",
			});
			const after = await readRow(row.id);
			expect(after.attemptCount).toBe(n);
			const last = n === PUBLISHING_DELIVERY_ATTEMPT_BOUND;
			expect(verdict).toBe(last ? "FAILED_AT_BOUND" : "RETURNED");
			expect(after.status).toBe(last ? "FAILED" : "DEFERRED");
			// The lease is released either way — that is what makes the row
			// claimable again rather than stranded.
			expect(after.claimedAt).toBeNull();
			expect(after.claimToken).toBeNull();
			// PRESERVED, both of them. `expiresAt` is what keeps the keyset cursor
			// valid; `lastAttemptAt` is what stops a returned row reading as
			// never-attempted and being re-sent past the provider's dedupe window.
			expect(after.expiresAt).not.toBeNull();
			expect(after.lastAttemptAt).not.toBeNull();
		}
	});

	it("a stale token can neither return nor fail a row a newer attempt holds", async () => {
		const row = await seedDeferred({});
		const first = await claimDeferredPublishingEmailDelivery({
			id: row.id,
		});
		expect(first.outcome).toBe("CLAIMED");
		if (first.outcome !== "CLAIMED") {
			return;
		}
		// The lease expires and a newer attempt takes the row.
		await db.$executeRawUnsafe(
			`UPDATE "publishing_notification_delivery"
			    SET "status" = 'DEFERRED', "claimedAt" = NULL, "claimToken" = NULL
			  WHERE "id" = $1`,
			row.id,
		);
		const second = await claimDeferredPublishingEmailDelivery({
			id: row.id,
		});
		expect(second.outcome).toBe("CLAIMED");

		expect(
			await recordPublishingDeferredEmailFailure({
				cycleId: row.cycleId,
				recipientUserId: row.recipientUserId,
				claimToken: first.claimToken,
				reason: "PROVIDER_ERROR",
			}),
		).toBe("LOST");
		expect((await readRow(row.id)).status).toBe("SENDING");
	});

	it("throws rather than widening the fence when the token is empty", () => {
		// Prisma drops an `undefined` where-predicate instead of matching nothing,
		// and raw SQL with an empty string would match no row but says nothing
		// about why. This is the activity boundary where deserialized JSON meets
		// the writer, so the absent token is refused loudly.
		return expect(
			recordPublishingDeferredEmailFailure({
				cycleId: CYCLE_ID,
				recipientUserId: ACTOR_ID,
				claimToken: "",
				reason: "PROVIDER_ERROR",
			}),
		).rejects.toThrow(/claimToken is required/);
	});
});

describeDb("the row-scoped skip writer", () => {
	it("terminalizes a DEFERRED row with the gate's own reason", async () => {
		const row = await seedDeferred({});
		expect(
			await skipDeferredPublishingEmailDelivery({
				id: row.id,
				reason: PUBLISHING_DEFERRED_SKIP_NOTIFICATIONS_OFF,
			}),
		).toBe("SKIPPED");
		const after = await readRow(row.id);
		expect(after.status).toBe("SKIPPED");
		expect(after.reason).toBe(PUBLISHING_DEFERRED_SKIP_NOTIFICATIONS_OFF);
	});

	it("does NOT terminalize a row another attempt claimed after the gate passed (F2)", async () => {
		// The interleaving, not the happy path. The shipped creating writer's
		// terminalizing update is fenced on a DENY-LIST OF ONE, which admits
		// SENDING: reached from a gate refusal it would terminalize a row a live
		// attempt holds and clear its lease, after which that attempt's
		// confirmation fails for a message the provider already accepted.
		const row = await seedDeferred({});
		const claim = await claimDeferredPublishingEmailDelivery({
			id: row.id,
		});
		expect(claim.outcome).toBe("CLAIMED");

		expect(
			await skipDeferredPublishingEmailDelivery({
				id: row.id,
				reason: PUBLISHING_DEFERRED_SKIP_TENANT_CHANGED,
			}),
		).toBe("LOST");

		const after = await readRow(row.id);
		expect(after.status).toBe("SENDING");
		if (claim.outcome === "CLAIMED") {
			expect(after.claimToken).toBe(claim.claimToken);
		}
	});
});
