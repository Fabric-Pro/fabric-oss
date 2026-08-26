import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "pg";
import { afterAll, expect, it } from "vitest";
import { db } from "../index";
import {
	claimPublishingEmailDelivery,
	publishingEmailClaimableSql,
} from "../prisma/queries/projects/publishing-notification-delivery";
import {
	abandonStalePublishingCycleOutcomes,
	enrolNullClockPendingCycles,
} from "../prisma/queries/projects/publishing-notification-reconcile";

const RUN_DB = process.env.RUN_DB_INTEGRATION === "1";

/**
 * 1C-2d-2a Decision 33 — THE CLOCK RULE, and the only file that can demonstrate it.
 *
 * A decision whose wrong answer is terminal is evaluated by the DATABASE, in the statement that
 * does the deciding. Everything else keeps the injectable application clock, because a test has to
 * be able to move time.
 *
 * Its own file, and named for the RULE rather than for the claim, because:
 *
 *   - it needs THREE connections — one holding a row lock, one blocked behind it, one seeding and
 *     reading — and the claim opens its own `db.$transaction`, so none of this can ride the
 *     rollback harness the other real-Postgres suites use;
 *   - a second pair (an enrolment blocked past the staleness bound) is added here by the sweep,
 *     under the same rule.
 *
 * Every case here is a genuine LOCK WAIT. Two statements in a row prove nothing: without
 * contention the instant a caller captures its clock and the instant its predicate is evaluated
 * are the same instant, and both the rule and the shape it replaces answer identically.
 */

const projectIds: string[] = [];
const createdUserIds: string[] = [];
const createdOrgIds: string[] = [];

/**
 * How long the lock is held, and how far out the obligation's deadline is.
 *
 * The hold has a CEILING that is not negotiable: the claim runs inside a Prisma interactive
 * transaction, whose default timeout is **5 s** (nothing in this package sets `transactionOptions`,
 * and neither the pool config nor the session sets `statement_timeout` or `lock_timeout`), and the
 * lock wait happens inside it. A hold anywhere near 5 s turns a refusal into a transaction timeout
 * — a different verdict reached for a different reason, which would pass an assertion written only
 * against "not CLAIMED".
 *
 * SO THE NUMBER IS BOUNDED ON BOTH SIDES, and neither bound is taste. Raise it toward 5 s and the
 * case stops testing the predicate; drop it below EXPIRY_OFFSET_SQL and the claim is decided while
 * the row is still inside its deadline, so the case goes green under BOTH clocks and proves
 * nothing. Anything between those two is fine; the published measurement used a 6 s hold from a
 * psql session, which has no such ceiling.
 */
const LOCK_HOLD_MS = 2_500;
const EXPIRY_OFFSET_SQL = "interval '1 second'";

type Fixture = {
	projectId: string;
	cycleId: string;
	recipientUserId: string;
	deliveryId: string;
	tenant: { projectId: string; organizationId: string | null; userId: null };
};

/**
 * One org project, one READY cycle, and ONE delivery row in the shape only a crash produces: still
 * `SENDING`, its lease an hour dead, an expiry a second out, and nothing delivered.
 *
 * Every term of the claim predicate except the expiry positively ADMITS this row. That is what
 * makes the case attributable — the expiry is the only thing left that can refuse it.
 */
async function seedDeadLeasedRowAboutToExpire(): Promise<Fixture> {
	const orgId = `org-${randomUUID()}`;
	await db.organization.create({
		data: {
			id: orgId,
			name: "clock-rule org",
			slug: `slug-${randomUUID()}`,
			createdAt: new Date(),
		},
	});
	createdOrgIds.push(orgId);

	const owner = await db.user.create({
		data: {
			id: `user-${randomUUID()}`,
			name: "Owner",
			email: `${randomUUID()}@example.com`,
			emailVerified: true,
			createdAt: new Date(),
			updatedAt: new Date(),
		},
	});
	createdUserIds.push(owner.id);

	const recipient = await db.user.create({
		data: {
			id: `user-${randomUUID()}`,
			name: "Recipient",
			email: `${randomUUID()}@example.com`,
			emailVerified: true,
			createdAt: new Date(),
			updatedAt: new Date(),
		},
	});
	createdUserIds.push(recipient.id);

	// ACTIVE explicitly: the claim's fence re-reads the project FOR UPDATE and filters on
	// eligibility, so a project at the model default would answer TENANT_CHANGED and the case
	// would never reach the predicate under test.
	const project = await db.project.create({
		data: {
			name: "clock-rule project",
			userId: owner.id,
			organizationId: orgId,
			status: "ACTIVE",
		},
	});
	projectIds.push(project.id);

	const cycle = await db.publishingSuggestionCycle.create({
		data: {
			projectId: project.id,
			organizationId: orgId,
			status: "READY",
			actorUserId: owner.id,
			coveredThrough: new Date(),
			notificationOutcome: "PENDING",
		},
	});

	const deliveryId = `del_clock_${randomUUID().replaceAll("-", "")}`;
	// Raw, because `expiresAt` has no production writer yet — 1C-2d-3 is the slice that starts
	// producing it — and because every timestamp here must come from the DATABASE clock, which is
	// the clock the predicate under test reads.
	await db.$executeRawUnsafe(
		`INSERT INTO "publishing_notification_delivery"
		   ("id","cycleId","projectId","organizationId","userId",
		    "recipientUserId","channel","status","claimedAt","claimToken",
		    "lastAttemptAt","expiresAt","attemptCount")
		 VALUES ($1,$2,$3,$4,NULL,$5,'EMAIL','SENDING',
		    (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 hour', $6,
		    (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 hour',
		    (clock_timestamp() AT TIME ZONE 'UTC') + ${EXPIRY_OFFSET_SQL}, 0)`,
		deliveryId,
		cycle.id,
		project.id,
		orgId,
		recipient.id,
		"crashed-attempt-token",
	);

	return {
		projectId: project.id,
		cycleId: cycle.id,
		recipientUserId: recipient.id,
		deliveryId,
		tenant: { projectId: project.id, organizationId: orgId, userId: null },
	};
}

/**
 * Session L: a connection of its own, holding the PROJECT row — the same row
 * `creationFenceVerdict` takes as the claim's first statement, which is what puts the wait between
 * the caller's captured clock and its predicate.
 *
 * A raw `pg` client rather than a second Prisma transaction: the hold has to outlive the statement
 * that takes it and be released on command, and `db.$transaction` owns its own lifetime.
 */
async function holdProjectRow(projectId: string): Promise<() => Promise<void>> {
	const client = new Client({ connectionString: process.env.DATABASE_URL });
	await client.connect();
	await client.query("BEGIN");
	await client.query('SELECT 1 FROM "project" WHERE "id" = $1 FOR UPDATE', [
		projectId,
	]);
	return async () => {
		await client.query("COMMIT");
		await client.end();
	};
}

function readDelivery(deliveryId: string) {
	return db.publishingNotificationDelivery.findUniqueOrThrow({
		where: { id: deliveryId },
	});
}

afterAll(async () => {
	if (!RUN_DB) {
		return;
	}
	await db.publishingNotificationDelivery.deleteMany({
		where: { projectId: { in: projectIds } },
	});
	await db.publishingSuggestionCycle.deleteMany({
		where: { projectId: { in: projectIds } },
	});
	await db.project.deleteMany({ where: { id: { in: projectIds } } });
	await db.organization.deleteMany({ where: { id: { in: createdOrgIds } } });
	await db.user.deleteMany({ where: { id: { in: createdUserIds } } });
});

it.skipIf(!RUN_DB)(
	"a claim that waits behind the project lock past its own expiry is refused, and the row is untouched",
	async () => {
		const fixture = await seedDeadLeasedRowAboutToExpire();
		const before = await readDelivery(fixture.deliveryId);

		// L takes the lock FIRST, so the claim below cannot get past its own first statement.
		const release = await holdProjectRow(fixture.projectId);

		// The clock the caller captures OUTSIDE the transaction, exactly as production does.
		// Passed explicitly so the case can assert the premise rather than assume it.
		const preLockNow = new Date();
		// THE PREMISE. At the instant this claim reads its clock the obligation is still inside
		// its deadline — so a predicate evaluated against `preLockNow` would admit the row, and
		// only the instant of EVALUATION can change the answer. Without this the whole case could
		// pass against a row that was already overdue when the claim started.
		expect(before.expiresAt).not.toBeNull();
		expect((before.expiresAt as Date).getTime()).toBeGreaterThan(
			preLockNow.getTime(),
		);

		let settledAt: Date | null = null;
		const claim = claimPublishingEmailDelivery({
			cycleId: fixture.cycleId,
			tenant: fixture.tenant,
			recipientUserId: fixture.recipientUserId,
			now: preLockNow,
		}).then((result) => {
			settledAt = new Date();
			return result;
		});

		await delay(LOCK_HOLD_MS);
		await release();
		const result = await claim;

		// THE CONTENTION, asserted rather than assumed. An unblocked claim settles in
		// milliseconds; this one cannot have settled before the hold elapsed. Delete the lock and
		// this is the assertion that goes red first — which is what stops the case decaying into
		// two statements in a row, where the captured clock and the evaluation instant coincide
		// and both predicates agree.
		expect(settledAt).not.toBeNull();
		expect(
			(settledAt as unknown as Date).getTime() - preLockNow.getTime(),
		).toBeGreaterThanOrEqual(LOCK_HOLD_MS);
		// And by the time it was decided, the deadline had passed.
		expect((settledAt as unknown as Date).getTime()).toBeGreaterThan(
			(before.expiresAt as Date).getTime(),
		);

		// Not merely "not CLAIMED": a dated obligation past its own date is not owed by anyone, so
		// the refusal classifier answers ALREADY_TERMINAL rather than HELD.
		expect(result.outcome).toBe("ALREADY_TERMINAL");

		// READ THE ROW BACK. A refusal that still cleared the token, or re-stamped the lease with
		// the stale pre-lock clock, would pass a verdict-only assertion and would still be the
		// defect: the next attempt would find a fresh-looking claim it did not make.
		const after = await readDelivery(fixture.deliveryId);
		expect(after.status).toBe("SENDING");
		expect(after.claimToken).toBe("crashed-attempt-token");
		expect(after.claimedAt).toEqual(before.claimedAt);
		expect(after.lastAttemptAt).toEqual(before.lastAttemptAt);
		expect(after.deliveredAt).toBeNull();
	},
	30_000,
);

it.skipIf(!RUN_DB)(
	"the same interleaving decided on the PRE-LOCK application clock takes the row after its deadline",
	async () => {
		// THE PERTURBATION, run in-suite against the same fixture shape — the shipped shape, with
		// the expiry compared to the clock the caller captured before it waited. It is here rather
		// than in a delete-a-guard checklist because a rule nobody can watch fail is a rule nobody
		// can bound: this case is the evidence that the case above is decided by WHICH CLOCK and
		// not by anything else in the fixture.
		const fixture = await seedDeadLeasedRowAboutToExpire();
		const before = await readDelivery(fixture.deliveryId);

		const release = await holdProjectRow(fixture.projectId);
		const preLockNow = new Date();
		expect(before.expiresAt).not.toBeNull();
		expect((before.expiresAt as Date).getTime()).toBeGreaterThan(
			preLockNow.getTime(),
		);

		const leaseCutoff = new Date(preLockNow.getTime() - 5 * 60_000);
		let settledAt: Date | null = null;
		const racer = db
			.$transaction(async (tx) => {
				// The claim's first statement, reproduced: this is where the wait happens.
				await tx.$queryRawUnsafe(
					'SELECT 1 FROM "project" WHERE "id" = $1 FOR UPDATE',
					fixture.projectId,
				);
				// THE PERTURBATION, DERIVED from the real predicate rather than retyped, with
				// `$4::timestamp` swapped in for clock_timestamp() — the ONE term this case
				// changes. Deriving it (instead of retyping the whole WHERE clause by hand) is
				// what makes "everything else is identical" true BY CONSTRUCTION: a term added
				// to publishingEmailClaimableSql tomorrow is added here too, automatically, so
				// nothing but the clock can ever account for the difference in outcome. A
				// hand-retyped copy has no such guarantee — it mirrors the predicate only for as
				// long as someone remembers to update both places.
				const preLockClockPredicate = publishingEmailClaimableSql({
					leaseCutoffParam: "$5",
				}).replace(
					"(clock_timestamp() AT TIME ZONE 'UTC')",
					"$4::timestamp",
				);
				return tx.$queryRawUnsafe<Array<{ id: string }>>(
					`UPDATE "publishing_notification_delivery"
					    SET "status" = 'SENDING', "claimedAt" = $2, "claimToken" = $3,
					        "lastAttemptAt" = $2, "reason" = NULL, "errorMessage" = NULL
					  WHERE "id" = $1
					    AND ${preLockClockPredicate}
					  RETURNING "id"`,
					fixture.deliveryId,
					preLockNow,
					"pre-lock-clock-token",
					preLockNow,
					leaseCutoff,
				);
			})
			.then((rows) => {
				settledAt = new Date();
				return rows;
			});

		await delay(LOCK_HOLD_MS);
		await release();
		const claimed = await racer;

		expect(settledAt).not.toBeNull();
		expect(
			(settledAt as unknown as Date).getTime() - preLockNow.getTime(),
		).toBeGreaterThanOrEqual(LOCK_HOLD_MS);
		expect((settledAt as unknown as Date).getTime()).toBeGreaterThan(
			(before.expiresAt as Date).getTime(),
		);

		// IT TOOK THE ROW, after the deadline, and stamped the stale clock into the lease. A send
		// follows this, and the recipient gets mail the system had already decided was too late.
		expect(claimed).toHaveLength(1);
		const after = await readDelivery(fixture.deliveryId);
		expect(after.claimToken).toBe("pre-lock-clock-token");
		expect(after.claimedAt).toEqual(preLockNow);
		expect((after.claimedAt as Date).getTime()).toBeLessThan(
			(before.expiresAt as Date).getTime(),
		);
	},
	30_000,
);

/**
 * The second pair, under the same rule (Decision 33 clause 4).
 *
 * Every case in the sweep suite runs one actor at a time, and one actor can never observe this
 * defect: it needs the enrolment statement to WAIT between choosing the floor it writes and
 * committing it. PostgreSQL PROJECTS an UPDATE's new tuple BEFORE it takes the row lock, so
 * `clock_timestamp()` in a SET clause does not observe the wait either — the floor is chosen at
 * statement start and committed however many seconds later. `FOR UPDATE SKIP LOCKED` in the
 * candidate subquery is what removes the wait rather than shortening it.
 *
 * The staleness bound is compressed to seconds and the lock held past it, so the case runs in
 * seconds; what it pins is the RELATION between the floor and the abandon pass's clock, not the
 * size of the bound.
 */
const ENROL_STALE_AFTER_MS = 5_000;

/**
 * Held PAST the bound, and that is the whole reason for the number. A blocking enrolment would
 * write a floor dated from statement start and commit it this long afterwards — by which time the
 * abandon pass, running immediately after in the same activity, reads it as stale. Shorten the
 * hold below `ENROL_STALE_AFTER_MS` and the perturbation stops being visible: the backdated floor
 * would still be inside the window, and the case would go green with SKIP LOCKED deleted.
 */
const ENROL_LOCK_HOLD_MS = 8_000;

const NULL_CLOCK_CYCLE_COUNT = 3;

/**
 * Three PENDING cycles with NO activation clock, whose `updatedAt` is already an hour past the
 * compressed bound — the lagging-worker shape. Every timestamp comes from the DATABASE clock,
 * because the database is what decides staleness.
 */
async function seedNullClockCycles(): Promise<{
	projectId: string;
	cycleIds: string[];
}> {
	const orgId = `org-${randomUUID()}`;
	await db.organization.create({
		data: {
			id: orgId,
			name: "clock-rule enrolment org",
			slug: `slug-${randomUUID()}`,
			createdAt: new Date(),
		},
	});
	createdOrgIds.push(orgId);

	const owner = await db.user.create({
		data: {
			id: `user-${randomUUID()}`,
			name: "Owner",
			email: `${randomUUID()}@example.com`,
			emailVerified: true,
			createdAt: new Date(),
			updatedAt: new Date(),
		},
	});
	createdUserIds.push(owner.id);

	const project = await db.project.create({
		data: {
			name: "clock-rule enrolment project",
			userId: owner.id,
			organizationId: orgId,
			status: "ACTIVE",
		},
	});
	projectIds.push(project.id);

	const cycleIds: string[] = [];
	for (let i = 0; i < NULL_CLOCK_CYCLE_COUNT; i += 1) {
		const id = `cyc_enrol_${randomUUID().replaceAll("-", "")}`;
		// Raw: `notificationOutcomeAt` must stay NULL (the rolling-deploy shape) while `updatedAt`
		// carries a value an hour old, and @updatedAt is a client-side behaviour of the Prisma
		// query engine that would overwrite it.
		await db.$executeRawUnsafe(
			`INSERT INTO "publishing_suggestion_cycle"
			   ("id","projectId","organizationId","userId","status","actorUserId",
			    "startedAt","completedAt","coveredThrough","notificationOutcome",
			    "notificationOutcomeVersion","notificationOutcomeAt","createdAt","updatedAt")
			 VALUES ($1,$2,$3,NULL,'READY',$4,
			    (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 hour',
			    (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 hour',
			    (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 hour',
			    'PENDING',0,NULL,
			    (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 hour',
			    (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 hour')`,
			id,
			project.id,
			orgId,
			owner.id,
		);
		cycleIds.push(id);
	}

	return { projectId: project.id, cycleIds };
}

/**
 * Session L for the cycle table: a connection of its own, holding ONE cycle row, released on
 * command. Returns its backend pid so the precondition can be asserted against that pid rather
 * than against "somebody, somewhere".
 */
async function holdCycleRow(cycleId: string): Promise<{
	pid: number;
	release: () => Promise<void>;
}> {
	const client = new Client({ connectionString: process.env.DATABASE_URL });
	await client.connect();
	const pidRows = await client.query<{ pid: number }>(
		"SELECT pg_backend_pid() AS pid",
	);
	await client.query("BEGIN");
	await client.query(
		'SELECT 1 FROM "publishing_suggestion_cycle" WHERE "id" = $1 FOR UPDATE',
		[cycleId],
	);
	return {
		pid: pidRows.rows[0].pid,
		release: async () => {
			await client.query("COMMIT");
			await client.end();
		},
	};
}

/**
 * THE PRECONDITION, read out of the lock manager rather than assumed.
 *
 * `SELECT ... FOR UPDATE` takes a RowShareLock on the RELATION, which is what pg_locks records —
 * the row-level lock itself lives on the tuple and never appears there. Asserted against session
 * L's own backend pid, so "the row is held" is attributable to L and not to any other connection
 * in the pool.
 *
 * Without this a skip caused by a broken predicate would be indistinguishable from a skip caused
 * by the lock, and the case would stay green if SKIP LOCKED were replaced by a typo that selected
 * nothing.
 */
async function heldRelationLocks(pid: number): Promise<number> {
	const [{ n }] = (await db.$queryRawUnsafe(
		`SELECT count(*)::int AS n
		   FROM pg_locks l
		   JOIN pg_class c ON c.oid = l.relation
		  WHERE c.relname = 'publishing_suggestion_cycle'
		    AND l.locktype = 'relation'
		    AND l.mode = 'RowShareLock'
		    AND l.granted
		    AND l.pid = $1`,
		pid,
	)) as Array<{ n: number }>;
	return n;
}

async function readCycleClock(cycleId: string): Promise<{
	outcome: string;
	clockIsNull: boolean;
	clockIsFresh: boolean;
}> {
	const [row] = (await db.$queryRawUnsafe(
		`SELECT "notificationOutcome" AS outcome,
		        "notificationOutcomeAt" IS NULL AS "clockIsNull",
		        coalesce("notificationOutcomeAt"
		                 >= (clock_timestamp() AT TIME ZONE 'UTC') - interval '30 seconds',
		                 false) AS "clockIsFresh"
		   FROM "publishing_suggestion_cycle" WHERE "id" = $1`,
		cycleId,
	)) as Array<{
		outcome: string;
		clockIsNull: boolean;
		clockIsFresh: boolean;
	}>;
	return row;
}

it.skipIf(!RUN_DB)(
	"does not backdate a floor when it blocks, and does not terminalize the row",
	async () => {
		const { cycleIds } = await seedNullClockCycles();
		const [heldId, ...unheldIds] = cycleIds;

		const holder = await holdCycleRow(heldId);
		let released = false;
		try {
			// Step 3 of the structure, and it is what makes this a concurrency test rather than
			// three statements in a row.
			expect(await heldRelationLocks(holder.pid)).toBeGreaterThanOrEqual(
				1,
			);

			const startedAt = Date.now();
			// The two calls the activity makes, in the order it makes them, started WHILE the row
			// is held.
			const run = (async () => {
				const enrolment = await enrolNullClockPendingCycles();
				await abandonStalePublishingCycleOutcomes({
					staleAfterMs: ENROL_STALE_AFTER_MS,
				});
				return { enrolment, settledAt: Date.now() };
			})();

			await delay(ENROL_LOCK_HOLD_MS);
			await holder.release();
			released = true;
			const { enrolment, settledAt } = await run;

			// WAIT-FREE, asserted rather than described. Drop SKIP LOCKED and this statement blocks
			// for the holder's whole hold, which is the mechanism every assertion below depends on.
			expect(settledAt - startedAt).toBeLessThan(ENROL_LOCK_HOLD_MS);

			const held = await readCycleClock(heldId);
			// Skipped, not adopted with a stale floor. It keeps its NULL clock, so the abandon pass
			// that ran immediately afterwards could not see it either — and ABANDONED is
			// irreversible, which is why "skipped" is the only acceptable answer.
			expect(held.clockIsNull).toBe(true);
			expect(held.outcome).toBe("PENDING");
			// NOT LOST — reported. The bounded residual counts locked rows too.
			expect(enrolment.residual).toBeGreaterThanOrEqual(1);

			// And the page was not simply empty: the other two ARE enrolled by the same run.
			for (const id of unheldIds) {
				const other = await readCycleClock(id);
				expect(other.clockIsNull).toBe(false);
				expect(other.clockIsFresh).toBe(true);
			}

			// THE NEXT TICK, after the holder committed. The row is adopted with a FRESH floor and
			// is still not terminalized — the cost the floor buys, stated as an assertion: the
			// alert is DELAYED by one bound, never manufactured.
			await enrolNullClockPendingCycles();
			await abandonStalePublishingCycleOutcomes({
				staleAfterMs: ENROL_STALE_AFTER_MS,
			});

			const adopted = await readCycleClock(heldId);
			expect(adopted.clockIsNull).toBe(false);
			expect(adopted.clockIsFresh).toBe(true);
			expect(adopted.outcome).toBe("PENDING");
		} finally {
			// A failed assertion above must not leave a connection holding a row lock for the rest
			// of the file.
			if (!released) {
				await holder.release().catch(() => undefined);
			}
		}
	},
	60_000,
);

it.skipIf(!RUN_DB)(
	"POSITIVE CONTROL: the same row with no holder is enrolled by the same run",
	async () => {
		// The precondition control. Same fixture, same statement, no session L — the row IS
		// enrolled. Without it, "the row was skipped" is compatible with a predicate that never
		// matched it, and the case above would stay green if SKIP LOCKED were replaced by a typo
		// that selected nothing.
		const { cycleIds } = await seedNullClockCycles();

		await enrolNullClockPendingCycles();

		for (const id of cycleIds) {
			const row = await readCycleClock(id);
			expect(row.clockIsNull).toBe(false);
			expect(row.clockIsFresh).toBe(true);
			expect(row.outcome).toBe("PENDING");
		}
	},
	60_000,
);
