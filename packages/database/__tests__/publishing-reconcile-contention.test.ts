import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	claimDeferredPublishingEmailDelivery,
	claimPublishingEmailDelivery,
	db,
	PUBLISHING_DELIVERY_ATTEMPT_BOUND,
	PUBLISHING_RECLAIM_REASON_ATTEMPT_BOUND,
	PUBLISHING_RECLAIM_REASON_EXPIRED,
	PUBLISHING_RECLAIM_REASON_LEASE_RECLAIMED,
	PUBLISHING_RECLAIM_STATEMENTS,
	reclaimClockFrom,
	reclaimPublishingDeliveryStates,
} from "../index";

/**
 * Publishing Suite 1C-2d-2b-1 — pass 1 under genuine contention. Fizzy #2213.
 *
 * ## Why this is its own file
 *
 * Every other case in the reconcile suite runs one actor at a time inside a
 * transaction that is rolled back. The hazard the reconciler's overlap
 * introduces needs THREE, and the third is production code pass 1 does not
 * otherwise touch: `claimPublishingEmailDelivery`.
 *
 *   1. transaction A runs RECONCILE_SENDING with one clock and HOLDS its locks
 *   2. transaction B runs the same statement with a different clock and BLOCKS
 *   3. a third connection reads pg_stat_activity to CONFIRM the block
 *   4. A commits, B unblocks and re-evaluates its outer WHERE
 *   5. the real claim runs -- BEFORE any cleanup tick
 *   6. only then, the cleanup tick
 *
 * Step 3 is not decoration. Without it "the second transaction blocked" is an
 * assumption, and a case that merely sequences two statements proves what the
 * single-connection convergence case in the sweep suite already proves.
 *
 * Three connections cannot come from one rolled-back transaction, and the claim
 * opens its own `db.$transaction` besides -- so this file COMMITS and cleans up
 * by prefix, and lives apart so the sweep suite's rollback discipline is not
 * diluted by an exception sitting next to it.
 *
 * ## The clock is anchored to REAL time, and that is a requirement
 *
 * The sweep takes an injectable `now`. The claim does not: its expiry term is
 * `"expiresAt" > (clock_timestamp() AT TIME ZONE 'UTC')`, evaluated by the
 * server. So the row's expiry has to be genuinely past by the time step 5 runs,
 * or the claim refuses -- or fails to refuse -- for a reason this case is not
 * about. Everything below is an offset from an instant one minute in the past.
 */

const RUN_DB = process.env.RUN_DB_INTEGRATION === "1";

const RUN = `reccontend_${randomUUID().replaceAll("-", "")}`;
const ORG_ID = `${RUN}_org`;
const ACTOR_ID = `${RUN}_actor`;
const PROJECT_ID = `${RUN}_proj`;
const CYCLE_ID = `${RUN}_cycle`;

/** The instant both rows expire at. One minute in the past, so it is past for the claim too. */
const T = new Date(Date.now() - 60_000);
/** Earlier execution: both rows are still INSIDE their expiry. */
const CLOCK_A = new Date(T.getTime() - 5 * 60_000);
/** Later execution: both rows are PAST it. */
const CLOCK_B = new Date(T.getTime() + 5 * 60_000);
/** Dead under both clocks -- `leaseCutoff` is derived from the sweep's own `now`. */
const CLAIMED_AT = new Date(T.getTime() - 60 * 60_000);

// Resolved inside an IIFE so the throw NARROWS the type. A module-level
// `if (!x) throw` does not propagate into the closures below, and the four
// resulting `possibly undefined` errors are invisible to vitest -- which strips
// types -- and fatal to `tsc --noEmit`.
const SENDING_STATEMENT = (() => {
	const found = PUBLISHING_RECLAIM_STATEMENTS.find(
		(statement) => statement.key === "RECONCILE_SENDING",
	);
	if (!found) {
		throw new Error(
			"RECONCILE_SENDING is not among the exported statements",
		);
	}
	return found;
})();

const TENANT = {
	projectId: PROJECT_ID,
	organizationId: ORG_ID,
	userId: null,
};

beforeAll(async () => {
	if (!RUN_DB) {
		return;
	}

	await db.organization.create({
		data: {
			id: ORG_ID,
			name: `Contention Fixture ${RUN}`,
			slug: `contention-fixture-${RUN}`,
			createdAt: new Date(),
		},
	});
	await db.user.create({
		data: {
			id: ACTOR_ID,
			name: "Contention Fixture Actor",
			email: `${ACTOR_ID}@example.com`,
			emailVerified: true,
			createdAt: new Date(),
			updatedAt: new Date(),
		},
	});
	// `status: "ACTIVE"` EXPLICITLY. Project.status defaults to DRAFT, and the
	// claim's tenant fence takes the project row FOR UPDATE and refuses anything
	// that is not ACTIVE -- so a DRAFT fixture answers TENANT_CHANGED for every
	// row, whatever state the sweep left it in. The reconcile sweep's own fixture
	// omits this and is right to: the sweep has no fence. A fixture that satisfies
	// one path is not evidence about another.
	await db.project.create({
		data: {
			id: PROJECT_ID,
			name: `Contention Fixture ${RUN}`,
			organizationId: ORG_ID,
			userId: ACTOR_ID,
			status: "ACTIVE",
			techStack: [],
			features: [],
			tags: [],
		},
	});
	// PENDING explicitly: the claim's creation fence refuses a cycle whose
	// notification outcome is already terminal, and it would refuse for that
	// reason rather than for the row's expiry -- which is what this file is about.
	await db.publishingSuggestionCycle.create({
		data: {
			id: CYCLE_ID,
			projectId: PROJECT_ID,
			organizationId: ORG_ID,
			userId: null,
			actorUserId: ACTOR_ID,
			coveredThrough: new Date(),
			status: "READY",
			completedAt: new Date(),
			notificationOutcome: "PENDING",
		},
	});
}, 180_000);

afterAll(async () => {
	if (!RUN_DB) {
		return;
	}
	// This file COMMITS, so teardown is the only thing between it and the next
	// run. The backslash escapes LIKE's wildcard meaning of "_"; order follows the
	// foreign keys.
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
}, 180_000);

async function seedSendingRow(
	id: string,
	attemptCount: number,
	expiresAt: Date = T,
): Promise<string> {
	await db.$executeRawUnsafe(
		`INSERT INTO "user" ("id","name","email","emailVerified","createdAt","updatedAt")
		 VALUES ($1, 'Contention Recipient', $1 || '@example.com', true, now(), now())`,
		`${id}_r`,
	);
	await db.$executeRawUnsafe(
		`INSERT INTO "publishing_notification_delivery"
		   ("id","cycleId","projectId","organizationId","userId","recipientUserId",
		    "channel","status","createdAt","claimedAt","claimToken","expiresAt","attemptCount")
		 VALUES ($1,$2,$3,$4,NULL,$5,'EMAIL','SENDING',now(),$6,$7,$8,$9)`,
		id,
		CYCLE_ID,
		PROJECT_ID,
		ORG_ID,
		`${id}_r`,
		CLAIMED_AT,
		`${id}_tok`,
		expiresAt,
		attemptCount,
	);
	return id;
}

async function readRow(id: string): Promise<{
	status: string;
	reason: string | null;
	claimToken: string | null;
}> {
	const rows = (await db.$queryRawUnsafe(
		`SELECT "status","reason","claimToken" FROM "publishing_notification_delivery" WHERE "id" = $1`,
		id,
	)) as Array<{
		status: string;
		reason: string | null;
		claimToken: string | null;
	}>;
	if (rows.length !== 1) {
		throw new Error(
			`Expected exactly one row for ${id}, got ${rows.length}`,
		);
	}
	return rows[0];
}

/**
 * THE PRECONDITION THIS FILE RESTS ON, asserted rather than assumed.
 *
 * The sweep's statements carry no cycle or project predicate by design, and this
 * file COMMITS. If another suite has left dead-leased SENDING rows behind, this
 * case terminalizes them for real. Counting first means the day that happens is
 * reported as its own cause instead of as somebody else's mysterious data loss.
 */
async function assertGlobalReclaimableSending(expected: number): Promise<void> {
	const [{ n }] = (await db.$queryRawUnsafe(
		`SELECT count(*)::int AS n
		   FROM "publishing_notification_delivery"
		  WHERE "status" = 'SENDING' AND "claimedAt" < $1 AND "expiresAt" IS NOT NULL`,
		reclaimClockFrom(CLOCK_B).leaseCutoff,
	)) as Array<{ n: number }>;
	expect(n).toBe(expected);
}

async function until<T>(
	label: string,
	probe: () => Promise<T> | T,
	done: (value: T) => boolean,
	budgetMs = 10_000,
): Promise<T> {
	const deadline = Date.now() + budgetMs;
	let last = await probe();
	while (!done(last) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 25));
		last = await probe();
	}
	if (!done(last)) {
		throw new Error(
			`Timed out waiting for ${label}; last saw ${String(last)}`,
		);
	}
	return last;
}

/**
 * Backends parked on a ROW lock, read from a THIRD connection.
 *
 * `wait_event = 'transactionid'` and not merely `wait_event_type = 'Lock'`: a
 * backend waiting on a relation lock behind a DDL statement is also a Lock wait,
 * and counting it would let this observation go green on contention that has
 * nothing to do with the two rows. `transactionid` is specifically "waiting for
 * another transaction to end so I can take its row" -- which is the claim.
 */
async function backendsWaitingOnRowLocks(): Promise<number> {
	const [{ n }] = (await db.$queryRawUnsafe(
		`SELECT count(*)::int AS n
		   FROM pg_stat_activity
		  WHERE "datname" = current_database()
		    AND "state" = 'active'
		    AND "wait_event_type" = 'Lock'
		    AND "wait_event" = 'transactionid'
		    AND "pid" <> pg_backend_pid()`,
	)) as Array<{ n: number }>;
	return n;
}

interface ContentionOutcome {
	firstMoved: number;
	secondMoved: number;
	blockedBackends: number;
	race: { status: string; reason: string | null };
	bound: { status: string; reason: string | null };
}

/**
 * Two overlapping executions of the SAME statement on separate connections, the
 * second observed blocking on the first's row lock.
 *
 * Both rows expire at T. `race` has one attempt spent; `bound` is AT the attempt
 * bound. The earlier clock sees both as still inside their expiry, the later
 * clock sees both as past it, and the row lock decides which one gets to
 * classify.
 */
async function runContention(
	first: Date,
	second: Date,
	tag: string,
): Promise<ContentionOutcome> {
	const raceId = await seedSendingRow(`${RUN}_${tag}_race`, 1);
	const boundId = await seedSendingRow(
		`${RUN}_${tag}_bound`,
		PUBLISHING_DELIVERY_ATTEMPT_BOUND,
	);
	await assertGlobalReclaimableSending(2);

	let firstMoved = -1;
	let secondMoved = -1;
	let release: () => void = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});

	const holder = db.$transaction(
		async (tx) => {
			const moved = (await tx.$queryRawUnsafe(
				SENDING_STATEMENT.sql,
				...SENDING_STATEMENT.params(reclaimClockFrom(first)),
			)) as unknown[];
			firstMoved = moved.length;
			// HOLD. The locks this UPDATE took are not released until commit, which
			// is what gives the second execution something to block on.
			await held;
		},
		{ timeout: 60_000, maxWait: 60_000 },
	);

	// Do not start the waiter until the holder has actually taken its locks --
	// otherwise the "block" may just be the two statements running in either
	// order with no contention at all, which is the failure mode this whole file
	// exists to avoid.
	await until(
		"the holder to take its locks",
		() => firstMoved,
		(n) => n >= 0,
	);

	const waiter = db.$transaction(
		async (tx) => {
			const moved = (await tx.$queryRawUnsafe(
				SENDING_STATEMENT.sql,
				...SENDING_STATEMENT.params(reclaimClockFrom(second)),
			)) as unknown[];
			secondMoved = moved.length;
		},
		{ timeout: 60_000, maxWait: 60_000 },
	);

	const blockedBackends = await until(
		"a backend to park on a row lock",
		backendsWaitingOnRowLocks,
		(n) => n > 0,
	);

	release();
	await holder;
	await waiter;

	const race = await readRow(raceId);
	const bound = await readRow(boundId);
	return {
		firstMoved,
		secondMoved,
		blockedBackends,
		race: { status: race.status, reason: race.reason },
		bound: { status: bound.status, reason: bound.reason },
	};
}

describe("three actors: two overlapping sweeps and the real claim", () => {
	it.skipIf(!RUN_DB)(
		"the EARLIER clock wins the row lock: a transient the claim must refuse, and an at-bound row it discharges",
		async () => {
			const outcome = await runContention(CLOCK_A, CLOCK_B, "a_first");

			// The block was REAL, not assumed.
			expect(outcome.blockedBackends).toBeGreaterThan(0);
			expect(outcome.firstMoved).toBe(2);
			// THE OUTER WHERE RE-ASSERTION, doing its job. Under READ COMMITTED the
			// unblocked UPDATE re-evaluates its predicate against the committed
			// newer row version, finds neither row is SENDING any more, and writes
			// nothing. A statement without the re-assertion would clobber both.
			expect(outcome.secondMoved).toBe(0);

			// THE TRANSIENT: non-terminal, with an expiry ALREADY PAST. This is the
			// exact row claimPublishingEmailDelivery must refuse, and asserting it
			// here -- before any cleanup tick -- is what makes the claim assertion
			// below about something.
			expect(outcome.race).toEqual({
				status: "DEFERRED",
				reason: PUBLISHING_RECLAIM_REASON_LEASE_RECLAIMED,
			});

			// DECISION 38, UNDER A REAL ROW LOCK. 1C-2d-2a measured EXPIRED here,
			// because its candidate predicate excluded an at-bound row still inside
			// its expiry and the earlier execution simply skipped it, leaving the
			// later one to expire it. This slice ships the arm, so the earlier
			// execution now classifies it -- and reaches a DIFFERENT terminal state
			// than the later one would have. Both are terminal, neither sends mail,
			// and both are reached in one tick rather than after a 14-day wait.
			expect(outcome.bound).toEqual({
				status: "FAILED",
				reason: PUBLISHING_RECLAIM_REASON_ATTEMPT_BOUND,
			});

			// ACTOR THREE, before any cleanup tick.
			const claim = await claimPublishingEmailDelivery({
				cycleId: CYCLE_ID,
				tenant: TENANT,
				recipientUserId: `${RUN}_a_first_race_r`,
			});
			expect(claim.outcome).toBe("ALREADY_TERMINAL");
			// ALREADY_TERMINAL and the row UNCHANGED are two different claims. A
			// claim that refused the caller and still wrote SENDING would satisfy
			// the first and destroy the convergence asserted below.
			expect(await readRow(`${RUN}_a_first_race`)).toMatchObject({
				status: "DEFERRED",
				claimToken: null,
			});

			// ONLY NOW the next scheduled tick, which closes the transient.
			await reclaimPublishingDeliveryStates({ now: CLOCK_B });
			expect(await readRow(`${RUN}_a_first_race`)).toMatchObject({
				status: "EXPIRED",
				reason: PUBLISHING_RECLAIM_REASON_EXPIRED,
			});
			expect(await readRow(`${RUN}_a_first_bound`)).toMatchObject({
				status: "FAILED",
			});
		},
		180_000,
	);

	it.skipIf(!RUN_DB)(
		"the LATER clock wins the row lock: both rows expire outright, and there is no transient to refuse",
		async () => {
			const outcome = await runContention(CLOCK_B, CLOCK_A, "b_first");

			expect(outcome.blockedBackends).toBeGreaterThan(0);
			expect(outcome.firstMoved).toBe(2);
			expect(outcome.secondMoved).toBe(0);

			// EXPIRY FIRST. The at-bound row is past its deadline under this clock,
			// and the obligation's own deadline is the stronger fact -- so it is
			// EXPIRED, not FAILED, even though the at-bound arm also matches.
			expect(outcome.race).toEqual({
				status: "EXPIRED",
				reason: PUBLISHING_RECLAIM_REASON_EXPIRED,
			});
			expect(outcome.bound).toEqual({
				status: "EXPIRED",
				reason: PUBLISHING_RECLAIM_REASON_EXPIRED,
			});

			const claim = await claimPublishingEmailDelivery({
				cycleId: CYCLE_ID,
				tenant: TENANT,
				recipientUserId: `${RUN}_b_first_race_r`,
			});
			// Refused for a DIFFERENT reason than in the case above -- there the
			// status was claimable and the expiry was not, here the status itself is
			// terminal. Same verdict, and the pair is what says the claim is not
			// resting on one of the two terms.
			expect(claim.outcome).toBe("ALREADY_TERMINAL");
			expect(await readRow(`${RUN}_b_first_race`)).toMatchObject({
				status: "EXPIRED",
			});

			await reclaimPublishingDeliveryStates({ now: CLOCK_B });
			expect(await readRow(`${RUN}_b_first_race`)).toMatchObject({
				status: "EXPIRED",
			});
			expect(await readRow(`${RUN}_b_first_bound`)).toMatchObject({
				status: "EXPIRED",
			});
		},
		180_000,
	);
});

/**
 * THE THIRD ACTOR, AGAIN, AND THIS TIME IT IS THE RECONCILER'S OWN CLAIM
 * (1C-2d-2b-2). The block above ran the primary path's claim, which is the one
 * that existed when it was written.
 *
 * WHAT THIS FOUND, AND IT IS NOT WHAT THE CASE WAS WRITTEN TO FIND. The first
 * draft asserted the drain's claim PARKS on the sweep's row lock, the same way
 * the second sweep execution does. It does not, and the reason is the claim's own
 * predicate: it narrows to `status = 'DEFERRED'`, and under READ COMMITTED an
 * UPDATE whose WHERE does not match the row's VISIBLE version takes no lock and
 * waits for nothing. While the sweep holds an uncommitted reclaim the row is
 * still SENDING to everyone else, so the claim simply does not match it — it
 * returns at once rather than blocking, and it takes nothing.
 *
 * THE PROPERTY THAT REPLACES THE ASSUMPTION IS STRONGER, not weaker: pass 1 and
 * pass 3 DO NOT SERIALIZE ON THE ROW LOCK, and they do not need to. A row the
 * sweep is midway through returning is invisible to the drain, which reports it
 * as still owed, consumes no attempt, and picks it up on the next tick — or, in
 * the same run, on a later page. Convergence rather than coordination, which is
 * the same shape every other transition on this ledger has.
 */
async function claimAroundHeldSweep(
	tag: string,
	expiresAt: Date,
	sweepClock: Date,
): Promise<{
	during: string;
	after: string;
	status: string;
	attemptCount: number;
}> {
	const id = await seedSendingRow(`${RUN}_${tag}`, 1, expiresAt);
	let swept = -1;
	let release: () => void = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});

	const holder = db.$transaction(
		async (tx) => {
			const moved = (await tx.$queryRawUnsafe(
				SENDING_STATEMENT.sql,
				...SENDING_STATEMENT.params(reclaimClockFrom(sweepClock)),
			)) as unknown[];
			swept = moved.length;
			await held;
		},
		{ timeout: 60_000, maxWait: 60_000 },
	);

	await until(
		"the sweep to take its locks",
		() => swept,
		(n) => n >= 0,
	);

	// DURING the hold. This must RETURN rather than hang — if it ever starts
	// blocking, this call is what times out, and that is the signal that the
	// claim's predicate has been widened to match a row mid-reclaim.
	const during = (await claimDeferredPublishingEmailDelivery({ id })).outcome;

	release();
	await holder;

	// AFTER the commit, which is the state the next tick — or the next page —
	// actually sees.
	const after = (await claimDeferredPublishingEmailDelivery({ id })).outcome;
	const row = await db.$queryRawUnsafe<
		Array<{ status: string; attemptCount: number }>
	>(
		`SELECT "status","attemptCount" FROM "publishing_notification_delivery" WHERE "id" = $1`,
		id,
	);
	return {
		during,
		after,
		status: row[0].status,
		attemptCount: row[0].attemptCount,
	};
}

describe("the sweep's uncommitted reclaim and the RECONCILER's claim", () => {
	it.skipIf(!RUN_DB)(
		"does not take a row the sweep has not committed, then takes it once it has",
		async () => {
			// A dead-leased SENDING row still INSIDE its expiry: the sweep's ELSE arm
			// returns it to DEFERRED. The claim sees SENDING until that commits.
			const out = await claimAroundHeldSweep(
				"claim_live",
				new Date(Date.now() + 60 * 60_000),
				CLOCK_A,
			);
			// STILL OWED, never terminal — the row belongs to whoever holds it, and
			// reporting it as discharged is the error that loses an obligation.
			expect(out.during).toBe("HELD");
			expect(out.after).toBe("CLAIMED");
			expect(out.status).toBe("SENDING");
			// ONE increment, from the successful claim alone. The refused call
			// consumed nothing, which is what makes a missed row cost a tick rather
			// than an attempt.
			expect(out.attemptCount).toBe(2);
		},
		120_000,
	);

	it.skipIf(!RUN_DB)(
		"refuses the row the sweep returned to DEFERRED with an expiry already past",
		async () => {
			// THE TRANSIENT THE SWEEP MODULE DOCUMENTS, now pinned for the
			// reconciler's own claim. When the earlier clock wins, the sweep commits
			// the row as DEFERRED with an expiry that is ALREADY PAST in real time — a
			// legal state the next tick's expiry statement clears. A claim that
			// evaluated its expiry on the caller's clock, or before the sweep
			// committed, would send mail for an obligation whose deadline has gone.
			// This one reads `clock_timestamp()` inside the statement that decides.
			const out = await claimAroundHeldSweep("claim_overdue", T, CLOCK_A);
			// NOT_CLAIMABLE ON BOTH SIDES OF THE COMMIT, and the contrast with the
			// case above is the whole distinction the two verdicts carry. There, the
			// row was still owed and somebody had it: HELD. Here it is PAST ITS OWN
			// DEADLINE, and an expired obligation is not owed at all — by anybody,
			// whatever state a concurrent sweep has it in. The first draft expected
			// HELD during the hold and learned otherwise from the run: the still-owed
			// probe carries the same `clock_timestamp()` expiry term the claim does,
			// so it answers about the OBLIGATION rather than about the lock.
			expect(out.during).toBe("NOT_CLAIMABLE");
			expect(out.after).toBe("NOT_CLAIMABLE");
			expect(out.status).toBe("DEFERRED");
			// No attempt consumed on an obligation nothing may send.
			expect(out.attemptCount).toBe(1);
		},
		120_000,
	);
});
