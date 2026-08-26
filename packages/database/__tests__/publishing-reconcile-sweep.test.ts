import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	abandonStalePublishingCycleOutcomes,
	activateCycleNotificationLifecycle,
	db,
	enrolNullClockPendingCycles,
	type Prisma,
	PUBLISHING_ABANDON_BATCH_SIZE,
	PUBLISHING_ABANDON_MAX_BATCHES,
	PUBLISHING_DELIVERY_ATTEMPT_BOUND,
	PUBLISHING_EMAIL_LEASE_MS,
	PUBLISHING_NULL_CLOCK_ENROL_SQL,
	PUBLISHING_NULL_CLOCK_RESIDUAL_SQL,
	PUBLISHING_RECLAIM_BATCH_SIZE,
	PUBLISHING_RECLAIM_MAX_BATCHES,
	PUBLISHING_RECLAIM_REASON_ATTEMPT_BOUND,
	PUBLISHING_RECLAIM_REASON_EXPIRED,
	PUBLISHING_RECLAIM_REASON_LEASE_RECLAIMED,
	PUBLISHING_RECLAIM_STATEMENTS,
	PUBLISHING_STALE_PENDING_CYCLE_REMAINING_SQL,
	PUBLISHING_STALE_PENDING_CYCLE_SQL,
	persistCycleTerminal,
	type ReclaimStatement,
	type ReclaimStatementKey,
	reclaimClockFrom,
	reclaimPublishingDeliveryStates,
	writeCycleNotificationOutcome,
} from "../index";
import {
	type PrismaQueryObserver,
	setPrismaQueryObserver,
} from "../prisma/client";

const RUN_DB = process.env.RUN_DB_INTEGRATION === "1";

// Every row this suite creates carries this prefix in its id, so cleanup is
// exact and a leak is identifiable. Not a real identifier of anything. The FULL
// uuid, not a slice: teardown deletes by prefix across five tables, so a prefix
// collision with a leaked fixture would delete rows this run did not create.
const RUN = `recsweep_${randomUUID().replaceAll("-", "")}`;
const ORG_ID = `${RUN}_org`;
const ACTOR_ID = `${RUN}_actor`;
const PROJECT_ID = `${RUN}_proj`;

// REAL TIME, not a frozen instant. The ledger half of this sweep freezes its
// clock because its rows are compared against a `now` the caller passes in; the
// cycle sweep computes its cutoff IN THE DATABASE, inside the deciding statement
// (Decision 33 clause 2), so a case that wants a stale cycle has to seed a clock
// that is old relative to the database's own `now()`. A frozen constant would be
// in the FUTURE on the day it was written and drift further from the bound every
// day after, and the sweep would match nothing.
//
// The cases below seed OFFSETS from it and the database computes the cutoff.
const NOW = new Date();

// The staleness BOUND in milliseconds, not a cutoff instant. The cutoff is
// computed by the database inside the deciding statement (Decision 33), so
// every case seeds an OFFSET from this file's NOW -- which is real time, set at
// module load -- and lets the database decide what is past the bound. Nothing
// here passes a cutoff Date into the sweep.
const STALE_AFTER_MS = 2 * 60 * 60_000;

// A dead lease, expressed against the same constant the claim and the reclaim
// both read, so a change to the lease budget moves this case with them.
const DEAD_LEASE_AT = new Date(
	NOW.getTime() - PUBLISHING_EMAIL_LEASE_MS - 1_000,
);

let cycleSeq = 0;
let bulkSeq = 0;
let rowSeq = 0;

beforeAll(async () => {
	if (!RUN_DB) {
		return;
	}

	await db.organization.create({
		data: {
			id: ORG_ID,
			name: `Reconcile Fixture ${RUN}`,
			slug: `reconcile-fixture-${RUN}`,
			createdAt: new Date(),
		},
	});

	await db.user.create({
		data: {
			id: ACTOR_ID,
			name: "Reconcile Fixture Actor",
			email: `${ACTOR_ID}@example.com`,
			emailVerified: true,
			createdAt: new Date(),
			updatedAt: new Date(),
		},
	});

	// Project.userId is REQUIRED and is the owner, present on organization
	// projects too -- it is NOT the tenant-XOR column. The XOR lives on the
	// denormalized copies downstream, which is why the cycle rows the cases seed
	// carry userId NULL while this project does not.
	await db.project.create({
		data: {
			id: PROJECT_ID,
			name: `Reconcile Fixture ${RUN}`,
			organizationId: ORG_ID,
			userId: ACTOR_ID,
			techStack: [],
			features: [],
			tags: [],
		},
	});
}, 180_000);

// Explicit timeout: afterAll would otherwise run under vitest's default 10s
// hookTimeout, and this teardown deletes with cascade checks against every table
// referencing user. A timed-out afterAll fails red AND leaves the fixture behind
// for the next run.
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
}, 180_000);

class Rollback extends Error {}

/**
 * Run a case against a real transaction and throw it away.
 *
 * The sweep's statements are deliberately global -- they carry no cycle or
 * project predicate -- so a behaviour case that committed would move rows other
 * cases can see and make this file order-dependent. Rolling back gives each case
 * the whole table to itself and needs no teardown. It also exercises the
 * `client` parameter both executors accept.
 *
 * "THE WHOLE TABLE TO ITSELF" IS A CLAIM ABOUT THE DATABASE, NOT ABOUT THIS
 * FILE, and rolling back only buys the half of it that is about this file. A
 * suite running CONCURRENTLY against the same Postgres can commit a PENDING
 * cycle this file's uncommitted transaction will happily read. That is why
 * `fileParallelism` is off for RUN_DB_INTEGRATION runs (vitest.config.ts) and
 * why the two exact-global-count cases assert the precondition below.
 */
async function inRolledBackTransaction<T>(
	body: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
	let captured: T | undefined;
	try {
		await db.$transaction(
			async (tx) => {
				captured = await body(tx);
				throw new Rollback();
			},
			{ timeout: 30_000, maxWait: 30_000 },
		);
	} catch (error) {
		if (!(error instanceof Rollback)) {
			throw error;
		}
	}
	return captured as T;
}

/**
 * THE PRECONDITION E4 AND E5 REST ON, asserted rather than assumed.
 *
 * `enrolNullClockPendingCycles` carries no project predicate, so `enrolled` and
 * `residual` are counts over the WHOLE table. `residual === 100` is arithmetic
 * on the number of null-clock PENDING cycles in EXISTENCE, not on the number
 * this case seeded, and a row committed by any other suite is simply the
 * hundred-and-first.
 *
 * Not hypothetical: run this file in one parallel vitest invocation with
 * `publishing-clock-rule.test.ts`, which commits three null-clock PENDING
 * cycles and holds one of them under FOR UPDATE past the bound, and both cases
 * fail with `expected 101 to be 100`. Reproduced 3 runs out of 3.
 *
 * `fileParallelism` is off for RUN_DB_INTEGRATION runs, so that cannot happen
 * in CI. This assertion is the other half: it makes the day somebody turns
 * parallelism back on -- or runs two of these files by hand -- report ITS OWN
 * CAUSE, instead of presenting as an unexplained off-by-one inside a bounded
 * pass. A guard whose failure names something else is how this took a review
 * round to attribute.
 *
 * Asserted AFTER seeding and against the seeded count, so the same call also
 * catches a seeding helper that inserted the wrong number of rows.
 *
 * An unbounded `count(*)` is what the sweep's own residual statement exists to
 * avoid; it is correct HERE precisely because this is not the sweep -- the
 * question is "is anything else in this table", which a capped count cannot
 * answer, and the table under test holds at most a few thousand fixture rows.
 */
async function assertGlobalNullClockPendingCycles(
	tx: Prisma.TransactionClient,
	seeded: number,
): Promise<void> {
	const [{ n }] = (await tx.$queryRawUnsafe(
		`SELECT count(*)::int AS n
		   FROM "publishing_suggestion_cycle"
		  WHERE "notificationOutcome" = 'PENDING'
		    AND "notificationOutcomeAt" IS NULL`,
	)) as Array<{ n: number }>;
	expect(
		n,
		`this case seeded ${seeded} null-clock PENDING cycles and the sweep can see ${n}. The sweep carries NO project predicate, so the exact counts asserted below are arithmetic over the whole table: another suite committing a PENDING cycle concurrently breaks them. Check that fileParallelism is off for RUN_DB_INTEGRATION runs (packages/database/vitest.config.ts) and that no earlier suite leaked a fixture.`,
	).toBe(seeded);
}

/**
 * The same guard for the ABANDON pass's candidate predicate: the sweep carries
 * no project predicate, so a case asserting `scanned` or the SHAPE of the page
 * (short versus full) is doing arithmetic over the whole table.
 *
 * It is the page shape that makes this worth its own helper rather than an
 * assertion on `result.scanned` alone. A single foreign stale row turns a
 * deliberately SHORT page into a longer one, and a case whose subject is the
 * short-page exit would then quietly exercise a different branch and still
 * pass — which is the failure mode this file has already recorded once, for a
 * mistyped model name.
 */
async function assertGlobalStalePendingCycles(
	tx: Prisma.TransactionClient,
	seeded: number,
): Promise<void> {
	const [{ n }] = (await tx.$queryRawUnsafe(
		`SELECT count(*)::int AS n
		   FROM "publishing_suggestion_cycle"
		  WHERE "notificationOutcome" = 'PENDING'
		    AND "notificationOutcomeAt" IS NOT NULL
		    AND "notificationOutcomeAt" < (now() AT TIME ZONE 'UTC') - ($1::bigint * interval '1 millisecond')`,
		STALE_AFTER_MS,
	)) as Array<{ n: number }>;
	expect(
		n,
		`this case seeded ${seeded} stale PENDING cycles and the sweep can see ${n}. The sweep carries NO project predicate, so both the counts and the PAGE SHAPE asserted below are arithmetic over the whole table: an earlier case that committed a stale PENDING cycle, or another suite running concurrently, breaks them. Check that fileParallelism is off for RUN_DB_INTEGRATION runs (packages/database/vitest.config.ts) and that this case is declared before the two contention cases, which commit their fixtures deliberately.`,
	).toBe(seeded);
}

/**
 * Did the observer just see the residual probe go out?
 *
 * The probe is a `$queryRawUnsafe`, so the observer is handed `model:
 * undefined` and the statement itself inside `args`. Matched against the
 * module's own exported constant rather than a substring, so a change to the
 * statement moves this helper with it instead of silently counting nothing —
 * and the case that expects ONE probe is what proves the matcher fires at all,
 * without which the case that expects NONE could not fail.
 */
function isResidualProbe(operation: string, args: unknown): boolean {
	if (operation !== "$queryRawUnsafe") {
		return false;
	}
	const statement = Array.isArray(args) ? args[0] : args;
	return statement === PUBLISHING_STALE_PENDING_CYCLE_REMAINING_SQL;
}

/**
 * The observer is MODULE state — `setPrismaQueryObserver` replaces the single
 * registered function — so it must be restored in a `finally`, or every later
 * case in this file runs under the injecting observer. This file registers no
 * observer of its own at module load, so the restore target is a pass-through,
 * which is behaviourally what "no observer" is.
 */
const passThroughObserver: PrismaQueryObserver = ({ args, query }) =>
	query(args);

async function withQueryObserver<T>(
	observer: PrismaQueryObserver,
	body: () => Promise<T>,
): Promise<T> {
	setPrismaQueryObserver(observer);
	try {
		return await body();
	} finally {
		setPrismaQueryObserver(passThroughObserver);
	}
}

/**
 * `createdAt` is when the cycle row was inserted; `activatedAt` is when the
 * notification lifecycle entered PENDING, and lands in `notificationOutcomeAt`
 * — the column the sweep actually reads. Passing `activatedAt: null`
 * seeds the rolling-deploy shape: PENDING with no clock at all.
 *
 * They default to the same instant because that is the common case, and they are
 * SEPARATE parameters because the interesting case is the one where they differ:
 * dispatch inserts the row before `client.workflow.start`, start failures retry,
 * and activation happens later still, so a live cycle can carry a `createdAt`
 * already past the staleness bound.
 *
 * `updatedAt` is still written explicitly, even though nothing reads it any
 * more: this insert is raw SQL, @updatedAt is a client-side behaviour of the
 * Prisma query engine rather than a database default, and the column is NOT
 * NULL. It is deliberately set to `createdAt` and NEVER to `activatedAt`, so
 * that a regression back to the implicit clock cannot accidentally pass.
 */
async function seedCycle(
	tx: Prisma.TransactionClient,
	cycle: {
		outcome: string;
		createdAt: Date;
		activatedAt?: Date | null;
		version?: number;
	},
): Promise<string> {
	cycleSeq += 1;
	const id = `${RUN}_cyc_${String(cycleSeq).padStart(6, "0")}`;
	await tx.$executeRawUnsafe(
		`INSERT INTO "publishing_suggestion_cycle"
		   ("id","projectId","organizationId","userId","status","actorUserId",
		    "startedAt","completedAt","coveredThrough","notificationOutcome",
		    "notificationOutcomeVersion","notificationOutcomeAt","createdAt","updatedAt")
		 VALUES ($1,$2,$3,NULL,'READY',$4,$5,$5,$5,$6,$7,$8,$5,$5)`,
		id,
		PROJECT_ID,
		ORG_ID,
		ACTOR_ID,
		cycle.createdAt,
		cycle.outcome,
		cycle.version ?? 0,
		cycle.activatedAt === undefined ? cycle.createdAt : cycle.activatedAt,
	);
	return id;
}

/**
 * The same row shape as `seedCycle`, in ONE statement, for the cases whose whole
 * subject is a population larger than a page. Two thousand round-trips is not a
 * more faithful fixture than one `generate_series`, it is the same fixture and
 * ninety seconds of wall clock — and the executor under test still issues its
 * own two thousand compare-and-swaps, which is the part that has to be real.
 *
 * Every parameter is cast explicitly: an untyped parameter inside an
 * `INSERT ... SELECT` resolves before the target column is consulted, so a null
 * activation clock would otherwise arrive as `text`.
 */
async function seedCycles(
	tx: Prisma.TransactionClient,
	count: number,
	cycle: { outcome: string; createdAt: Date; activatedAt?: Date | null },
): Promise<string> {
	bulkSeq += 1;
	const prefix = `${RUN}_blk_${String(bulkSeq).padStart(3, "0")}_`;
	await tx.$executeRawUnsafe(
		`INSERT INTO "publishing_suggestion_cycle"
		   ("id","projectId","organizationId","userId","status","actorUserId",
		    "startedAt","completedAt","coveredThrough","notificationOutcome",
		    "notificationOutcomeVersion","notificationOutcomeAt","createdAt","updatedAt")
		 SELECT $1 || lpad(g::text, 7, '0'), $2::text, $3::text, NULL,
		        'READY'::publishing_cycle_status, $4::text,
		        $5::timestamp, $5::timestamp, $5::timestamp, $6::text, 0,
		        $7::timestamp, $5::timestamp, $5::timestamp
		   FROM generate_series(1, $8::int) g`,
		prefix,
		PROJECT_ID,
		ORG_ID,
		ACTOR_ID,
		cycle.createdAt,
		cycle.outcome,
		cycle.activatedAt === undefined ? cycle.createdAt : cycle.activatedAt,
		count,
	);
	return prefix;
}

async function readCycle(
	tx: Prisma.TransactionClient,
	id: string,
): Promise<{
	notificationOutcome: string;
	notificationOutcomeVersion: number;
	notificationOutcomeAt: Date | null;
	updatedAt: Date;
}> {
	const rows = (await tx.$queryRawUnsafe(
		`SELECT "notificationOutcome","notificationOutcomeVersion","notificationOutcomeAt","updatedAt"
		   FROM "publishing_suggestion_cycle" WHERE "id" = $1`,
		id,
	)) as Array<{
		notificationOutcome: string;
		notificationOutcomeVersion: number;
		notificationOutcomeAt: Date | null;
		updatedAt: Date;
	}>;
	return rows[0];
}

/**
 * The database's own clock, as a STRING, truncated to the precision of the
 * column it will be compared against.
 *
 * Both halves matter. A string, because routing the instant through a JS `Date`
 * and back re-introduces the driver's own rounding into an assertion about
 * rounding. Truncated to milliseconds, because `notificationOutcomeAt` is
 * `timestamp(3)` and PostgreSQL ROUNDS on store — so a floor written a few
 * hundred microseconds after this reading can legitimately land below a
 * microsecond-precision copy of it, and the case would fail for the storage
 * precision rather than for the floor. Truncating is safe in the direction that
 * matters: `round(later) >= round(earlier) >= trunc(earlier)`.
 */
async function dbClock(tx: Prisma.TransactionClient): Promise<string> {
	const [{ t }] = (await tx.$queryRawUnsafe(
		`SELECT to_char(date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC'),
		                'YYYY-MM-DD HH24:MI:SS.MS') AS t`,
	)) as Array<{ t: string }>;
	return t;
}

/**
 * Compare the enrolled clock against the database's own values, IN the database.
 * Same reason as `dbClock`: the properties under test are about a rounding
 * boundary, and a JS round-trip is the one thing that can move one.
 */
async function clockFacts(
	tx: Prisma.TransactionClient,
	id: string,
	sinceClock: string,
): Promise<{
	isNull: boolean;
	atOrAfterSince: boolean;
	aboveUpdatedAt: boolean;
	equalsUpdatedAt: boolean;
}> {
	const [row] = (await tx.$queryRawUnsafe(
		`SELECT "notificationOutcomeAt" IS NULL AS "isNull",
		        coalesce("notificationOutcomeAt" >= $2::timestamp, false) AS "atOrAfterSince",
		        coalesce("notificationOutcomeAt" > "updatedAt", false) AS "aboveUpdatedAt",
		        coalesce("notificationOutcomeAt" = "updatedAt", false) AS "equalsUpdatedAt"
		   FROM "publishing_suggestion_cycle" WHERE "id" = $1`,
		id,
		sinceClock,
	)) as Array<{
		isNull: boolean;
		atOrAfterSince: boolean;
		aboveUpdatedAt: boolean;
		equalsUpdatedAt: boolean;
	}>;
	return row;
}

/**
 * The one ledger-shaped helper this slice needs. The residue case is the only
 * case in 2a that touches `publishing_notification_delivery` at all — it seeds
 * one row to assert a NON-write. It takes the cycle as a parameter rather than
 * reading a fixture cycle, because 2a's cases each seed their own.
 */
async function seedRowForCycle(
	tx: Prisma.TransactionClient,
	cycleId: string,
	row: {
		status: string;
		expiresAt: Date | null;
		attemptCount: number;
		claimedAt?: Date | null;
		claimToken?: string | null;
	},
): Promise<string> {
	rowSeq += 1;
	const id = `${RUN}_case_${String(rowSeq).padStart(6, "0")}`;
	// A dedicated recipient per row: the ledger's unique
	// (cycleId, recipientUserId, channel) triple means one cycle needs one user
	// per row. The teardown prefix covers it.
	await tx.$executeRawUnsafe(
		`INSERT INTO "user" ("id","name","email","emailVerified","createdAt","updatedAt")
		 VALUES ($1, 'Case Recipient', $1 || '@example.com', true, now(), now())`,
		`${id}_r`,
	);
	await tx.$executeRawUnsafe(
		`INSERT INTO "publishing_notification_delivery"
		   ("id","cycleId","projectId","organizationId","userId","recipientUserId",
		    "channel","status","createdAt","claimedAt","claimToken","expiresAt","attemptCount")
		 VALUES ($1,$2,$3,$4,NULL,$5,'EMAIL',$6,now(),$7,$8,$9,$10)`,
		id,
		cycleId,
		PROJECT_ID,
		ORG_ID,
		`${id}_r`,
		row.status,
		row.claimedAt ?? null,
		row.claimToken ?? null,
		row.expiresAt,
		row.attemptCount,
	);
	return id;
}

/**
 * WIDENED BY 1C-2d-2b-1 from the two columns 1C-2d-2a's single residue case
 * needed. The ledger cases below assert on `reason`, on the lease pair being
 * cleared and on `attemptCount` being left alone, and every one of those is a
 * durable write with no other reader.
 *
 * It also now THROWS on a row count other than one. The old form returned
 * `rows[0]`, so a case whose seed silently failed read `undefined` and every
 * assertion after it failed on a property of undefined -- a real defect
 * reported as a type error three lines away from its cause.
 */
async function readRow(
	tx: Prisma.TransactionClient,
	id: string,
): Promise<{
	status: string;
	reason: string | null;
	claimedAt: Date | null;
	claimToken: string | null;
	expiresAt: Date | null;
	attemptCount: number;
}> {
	const rows = (await tx.$queryRawUnsafe(
		`SELECT "status","reason","claimedAt","claimToken","expiresAt","attemptCount"
		   FROM "publishing_notification_delivery" WHERE "id" = $1`,
		id,
	)) as Array<{
		status: string;
		reason: string | null;
		claimedAt: Date | null;
		claimToken: string | null;
		expiresAt: Date | null;
		attemptCount: number;
	}>;
	if (rows.length !== 1) {
		throw new Error(
			`Expected exactly one row for ${id}, got ${rows.length}`,
		);
	}
	return rows[0];
}

const REPO_ROOT = join(__dirname, "..", "..", "..");
const SCAN_ROOTS = ["packages", "apps", "agents"];
const SCAN_SKIP_DIRS = new Set([
	"node_modules",
	"dist",
	".next",
	".turbo",
	"build",
	"coverage",
	"__tests__",
	// The generated client restates every column of every model, so including
	// it would make this guard fail on its own regeneration. Generated code has
	// no writers, so nothing is lost.
	"generated",
]);

function walkSources(dir: string, out: string[]): void {
	for (const entry of readdirSync(dir)) {
		if (SCAN_SKIP_DIRS.has(entry)) {
			continue;
		}
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			walkSources(full, out);
		} else if (
			(entry.endsWith(".ts") ||
				entry.endsWith(".tsx") ||
				entry.endsWith(".prisma")) &&
			!entry.endsWith(".d.ts") &&
			!entry.includes(".test.")
		) {
			out.push(full);
		}
	}
}

/**
 * Every non-test source file whose CONTENTS contain this identifier.
 *
 * A string search, deliberately — not a parse. The previous round's guard tried
 * to enumerate every Prisma mutation of a whole table and read a fence out of
 * each `where` clause, and it was shown to miss delegate aliases, bracket
 * access, schema-qualified SQL and dynamically composed SQL, and to accept an
 * OR/NOT predicate or a COMMENT as a fence. Its failure mode was a false green.
 *
 * This one fails CLOSED in the direction that matters: anything that names the
 * column — a Prisma `data` key, `data["notificationOutcomeAt"]`, a raw
 * `UPDATE ... SET "notificationOutcomeAt"`, a schema-qualified statement, even a
 * comment — appears in the file's text and fails the frozen list. The only thing
 * it cannot see is a dynamically composed column name, which nothing in this
 * repository does and which no source-level guard of any shape catches.
 */
function filesMentioning(identifier: string): string[] {
	const files: string[] = [];
	for (const root of SCAN_ROOTS) {
		walkSources(join(REPO_ROOT, root), files);
	}
	return files
		.filter((file) => readFileSync(file, "utf8").includes(identifier))
		.map((file) => relative(REPO_ROOT, file).split(sep).join("/"))
		.sort();
}

describe("PENDING cycles with no activation clock are enrolled with a floor", () => {
	it.skipIf(!RUN_DB)(
		"E1 null-clock PENDING cycle is enrolled, never earlier than the enrolment instant",
		async () => {
			await inRolledBackTransaction(async (tx) => {
				const id = await seedCycle(tx, {
					outcome: "PENDING",
					createdAt: new Date(NOW.getTime() - 3 * 60 * 60_000),
					// Activated by a build that predates the column.
					activatedAt: null,
				});
				const since = await dbClock(tx);

				const result = await enrolNullClockPendingCycles({}, tx);

				expect(result.enrolled).toBeGreaterThanOrEqual(1);
				const facts = await clockFacts(tx, id, since);
				expect(facts.isNull).toBe(false);
				// THE FLOOR. Not `updatedAt`, which is three hours old, and not
				// anything earlier than the moment this pass first saw the row.
				expect(facts.atOrAfterSince).toBe(true);
				expect(facts.aboveUpdatedAt).toBe(true);
			});
		},
		120_000,
	);

	it.skipIf(!RUN_DB)(
		"E2 an already-clocked PENDING cycle is not re-stamped",
		async () => {
			await inRolledBackTransaction(async (tx) => {
				const activatedAt = new Date(NOW.getTime() - 10 * 60_000);
				const id = await seedCycle(tx, {
					outcome: "PENDING",
					createdAt: new Date(NOW.getTime() - 3 * 60 * 60_000),
					activatedAt,
				});

				await enrolNullClockPendingCycles({}, tx);

				const after = await readCycle(tx, id);
				// The pass writes ONCE, into a null. An explicit clock is the
				// activation writer's answer and nothing may move it — which is
				// the whole reason the column exists rather than a COALESCE.
				expect(after.notificationOutcomeAt?.toISOString()).toBe(
					activatedAt.toISOString(),
				);
			});
		},
		120_000,
	);

	it.skipIf(!RUN_DB)(
		"E3 a non-PENDING cycle with a null clock is left alone",
		async () => {
			await inRolledBackTransaction(async (tx) => {
				const id = await seedCycle(tx, {
					outcome: "NOT_APPLICABLE",
					createdAt: new Date(NOW.getTime() - 3 * 60 * 60_000),
					activatedAt: null,
				});

				await enrolNullClockPendingCycles({}, tx);

				const after = await readCycle(tx, id);
				// A cycle that never entered the lifecycle has no activation to
				// date, and handing it one would make it a sweep candidate the
				// moment somebody widened the outcome predicate.
				expect(after.notificationOutcome).toBe("NOT_APPLICABLE");
				expect(after.notificationOutcomeAt).toBeNull();
			});
		},
		120_000,
	);

	it.skipIf(!RUN_DB)(
		"E4 the pass is bounded and emits a non-zero residual",
		async () => {
			await inRolledBackTransaction(async (tx) => {
				await seedCycles(
					tx,
					PUBLISHING_ABANDON_BATCH_SIZE *
						PUBLISHING_ABANDON_MAX_BATCHES +
						PUBLISHING_ABANDON_BATCH_SIZE,
					{
						outcome: "PENDING",
						createdAt: new Date(NOW.getTime() - 3 * 60 * 60_000),
						activatedAt: null,
					},
				);

				await assertGlobalNullClockPendingCycles(
					tx,
					PUBLISHING_ABANDON_BATCH_SIZE *
						PUBLISHING_ABANDON_MAX_BATCHES +
						PUBLISHING_ABANDON_BATCH_SIZE,
				);

				const result = await enrolNullClockPendingCycles({}, tx);

				expect(result.enrolled).toBe(
					PUBLISHING_ABANDON_BATCH_SIZE *
						PUBLISHING_ABANDON_MAX_BATCHES,
				);
				expect(result.batches).toBe(PUBLISHING_ABANDON_MAX_BATCHES);
				expect(result.usedBatchBudget).toBe(true);
				// THE SIGNAL. What is still invisible to the sweep after this run
				// — read unconditionally, not inferred from the batch count, and
				// bounded so it can never become a count(*) on a live table.
				expect(result.residual).toBe(PUBLISHING_ABANDON_BATCH_SIZE);
				expect(result.residualCapped).toBe(false);
			});
		},
		120_000,
	);

	it.skipIf(!RUN_DB)(
		"E5 a second run drains the remainder and the residual falls to zero",
		async () => {
			await inRolledBackTransaction(async (tx) => {
				await seedCycles(
					tx,
					PUBLISHING_ABANDON_BATCH_SIZE *
						PUBLISHING_ABANDON_MAX_BATCHES +
						PUBLISHING_ABANDON_BATCH_SIZE,
					{
						outcome: "PENDING",
						createdAt: new Date(NOW.getTime() - 3 * 60 * 60_000),
						activatedAt: null,
					},
				);

				await assertGlobalNullClockPendingCycles(
					tx,
					PUBLISHING_ABANDON_BATCH_SIZE *
						PUBLISHING_ABANDON_MAX_BATCHES +
						PUBLISHING_ABANDON_BATCH_SIZE,
				);

				await enrolNullClockPendingCycles({}, tx);
				const second = await enrolNullClockPendingCycles({}, tx);

				// CONVERGENCE, and it is the null fence that buys it: without
				// `notificationOutcomeAt IS NULL` the pass re-stamps the same page
				// forever and the residual never falls.
				expect(second.enrolled).toBe(PUBLISHING_ABANDON_BATCH_SIZE);
				expect(second.usedBatchBudget).toBe(false);
				expect(second.residual).toBe(0);
			});
		},
		120_000,
	);

	it.skipIf(!RUN_DB)(
		"E6 a LAGGING worker's clock cannot make a live cycle look stale",
		async () => {
			await inRolledBackTransaction(async (tx) => {
				// Activated moments ago by a worker three hours behind: the only
				// trace it left is an `updatedAt` already past the staleness bound.
				// @updatedAt is CLIENT-side, so nothing floors it.
				const id = await seedCycle(tx, {
					outcome: "PENDING",
					createdAt: new Date(NOW.getTime() - 3 * 60 * 60_000),
					activatedAt: null,
				});
				const since = await dbClock(tx);

				// The two calls the activity makes, in the order it makes them.
				await enrolNullClockPendingCycles({}, tx);
				await abandonStalePublishingCycleOutcomes(
					{ staleAfterMs: STALE_AFTER_MS },
					tx,
				);

				const facts = await clockFacts(tx, id, since);
				// The enrolled value is NOT `updatedAt`. Take the floor away and it
				// is, and the cycle is stale the instant it is adopted.
				expect(facts.aboveUpdatedAt).toBe(true);
				expect(facts.atOrAfterSince).toBe(true);

				const after = await readCycle(tx, id);
				// A LIVE cycle. ABANDONED is terminal and irreversible, so the
				// floor's cost — the alert is delayed by one bound — is the cheap
				// side of the trade.
				expect(after.notificationOutcome).toBe("PENDING");
				expect(after.notificationOutcomeVersion).toBe(0);
			});
		},
		120_000,
	);

	it.skipIf(!RUN_DB)(
		"E7 a worker whose clock RUNS AHEAD keeps its later value",
		async () => {
			await inRolledBackTransaction(async (tx) => {
				// The other skew direction. GREATEST, not the database clock alone:
				// overwriting a future `updatedAt` with a smaller value would move
				// the abandonment deadline EARLIER, which is the direction that
				// manufactures alerts.
				const id = await seedCycle(tx, {
					outcome: "PENDING",
					createdAt: new Date(NOW.getTime() + 3 * 60 * 60_000),
					activatedAt: null,
				});
				const since = await dbClock(tx);

				await enrolNullClockPendingCycles({}, tx);

				const facts = await clockFacts(tx, id, since);
				expect(facts.isNull).toBe(false);
				expect(facts.equalsUpdatedAt).toBe(true);
				expect(facts.atOrAfterSince).toBe(true);
			});
		},
		120_000,
	);

	// Two of this statement's properties cannot be seen behaviourally in a
	// single-process suite (Decision 33, clauses 1 and 4). `clock_timestamp()`
	// versus `now()` is invisible once SKIP LOCKED means the statement never
	// waits — the two are microseconds apart — and SKIP LOCKED's own absence is
	// only visible with a second connection holding a row, which is
	// publishing-clock-rule.test.ts rather than this file.
	it("E8 writes its floor from the volatile clock and takes its page without waiting", () => {
		// Clause 1: the value WRITTEN reads clock_timestamp(). now() would date the
		// floor from transaction start.
		expect(PUBLISHING_NULL_CLOCK_ENROL_SQL).toContain(
			`GREATEST("updatedAt", (clock_timestamp() AT TIME ZONE 'UTC'))`,
		);
		// Clause 4: and the statement cannot WAIT between projecting that value and
		// committing it, because PostgreSQL projects the new tuple BEFORE it takes
		// the row lock — so the volatile clock alone buys nothing. The clock-rule
		// suite holds a row and measures it.
		expect(PUBLISHING_NULL_CLOCK_ENROL_SQL).toContain(
			"FOR UPDATE SKIP LOCKED",
		);
	});
});

describe("the cycle sweep's batch ceiling", () => {
	// The same correction round 4 applied to the ledger executor, applied to the
	// cycle executor rather than argued by analogy from it. The first two cases
	// are the FALSE POSITIVES the old field name produced on this executor too:
	// a run that spends its whole budget is not a run with a backlog, and only a
	// bounded probe can tell them apart.
	it.skipIf(!RUN_DB)(
		"MAX-1 full pages and a short final page: budget spent, nothing left",
		async () => {
			await inRolledBackTransaction(async (tx) => {
				const seeded =
					PUBLISHING_ABANDON_BATCH_SIZE *
						PUBLISHING_ABANDON_MAX_BATCHES -
					PUBLISHING_ABANDON_BATCH_SIZE / 2;
				await seedCycles(tx, seeded, {
					outcome: "PENDING",
					createdAt: new Date(NOW.getTime() - 3 * 60 * 60_000),
				});

				let probes = 0;
				const result = await withQueryObserver(
					async ({ operation, args, query }) => {
						if (isResidualProbe(operation, args)) {
							probes += 1;
						}
						return query(args);
					},
					() =>
						abandonStalePublishingCycleOutcomes(
							{ staleAfterMs: STALE_AFTER_MS },
							tx,
						),
				);

				expect(result.batches).toBe(PUBLISHING_ABANDON_MAX_BATCHES);
				expect(result.scanned).toBe(seeded);
				expect(result.abandoned).toBe(seeded);
				expect(result.usedBatchBudget).toBe(true);
				expect(result.moreWorkRemains).toBe(false);
				// THIS FIXTURE SPENDS THE WHOLE BUDGET AND STILL ASKS NOTHING,
				// which is the one place the two conditions come apart: the
				// twentieth page is SHORT and fully drained, so the exit is the
				// drained-short-page one and `usedBatchBudget` — true here —
				// does not decide whether the probe goes out. Counted rather
				// than described, because the plan's fixture table records it.
				expect(probes).toBe(0);
			});
		},
		180_000,
	);

	it.skipIf(!RUN_DB)(
		"exactly MAX full pages, nothing left: budget spent, still no backlog",
		async () => {
			await inRolledBackTransaction(async (tx) => {
				const seeded =
					PUBLISHING_ABANDON_BATCH_SIZE *
					PUBLISHING_ABANDON_MAX_BATCHES;
				await seedCycles(tx, seeded, {
					outcome: "PENDING",
					createdAt: new Date(NOW.getTime() - 3 * 60 * 60_000),
				});

				const result = await abandonStalePublishingCycleOutcomes(
					{ staleAfterMs: STALE_AFTER_MS },
					tx,
				);

				expect(result.batches).toBe(PUBLISHING_ABANDON_MAX_BATCHES);
				expect(result.scanned).toBe(seeded);
				expect(result.abandoned).toBe(seeded);
				expect(result.usedBatchBudget).toBe(true);
				// The boundary the old field name got wrong: an exactly-full
				// backlog drained to empty reads as `batches === MAX` too.
				expect(result.moreWorkRemains).toBe(false);
			});
		},
		180_000,
	);

	it.skipIf(!RUN_DB)(
		"MAX full pages with work remaining: the probe, not the batch count, says so",
		async () => {
			await inRolledBackTransaction(async (tx) => {
				const budget =
					PUBLISHING_ABANDON_BATCH_SIZE *
					PUBLISHING_ABANDON_MAX_BATCHES;
				await seedCycles(tx, budget + PUBLISHING_ABANDON_BATCH_SIZE, {
					outcome: "PENDING",
					createdAt: new Date(NOW.getTime() - 3 * 60 * 60_000),
				});

				const result = await abandonStalePublishingCycleOutcomes(
					{ staleAfterMs: STALE_AFTER_MS },
					tx,
				);

				expect(result.batches).toBe(PUBLISHING_ABANDON_MAX_BATCHES);
				expect(result.scanned).toBe(budget);
				expect(result.abandoned).toBe(budget);
				expect(result.usedBatchBudget).toBe(true);
				expect(result.moreWorkRemains).toBe(true);
			});
		},
		180_000,
	);
});

describe("stale PENDING cycles terminalize to ABANDONED", () => {
	// ENUMERATED, not listed. The Global Constraint and Decision 32's cost note
	// both rest on the outcome being a SQL LITERAL in EVERY statement, not in
	// the two somebody remembered to assert on: turn any one of them into $2 and
	// that statement silently leaves the partial index and filters the whole
	// PENDING population, while every behavioural case stays green.
	//
	// So the case reads the module's own *_SQL exports rather than naming two of
	// them, and asserts the export list FIRST. Without that assertion an empty
	// list would satisfy every loop below, and a hand-written list would let a
	// fifth statement ship unpinned -- which is exactly how the remaining-probe
	// and the residual went unpinned for four review rounds.
	it("carries its outcome as a literal in EVERY statement this module exports", async () => {
		const module = await import(
			"../prisma/queries/projects/publishing-notification-reconcile"
		);
		const statements = Object.entries(module).filter(
			([name, value]) =>
				name.endsWith("_SQL") && typeof value === "string",
		) as Array<[string, string]>;

		expect(statements.map(([name]) => name).sort()).toEqual([
			"PUBLISHING_NULL_CLOCK_ENROL_SQL",
			"PUBLISHING_NULL_CLOCK_RESIDUAL_SQL",
			"PUBLISHING_STALE_PENDING_CYCLE_REMAINING_SQL",
			"PUBLISHING_STALE_PENDING_CYCLE_SQL",
		]);

		for (const [name, sql] of statements) {
			expect(sql, name).toContain(`"notificationOutcome" = 'PENDING'`);
			// The failure direction that matters: a bind parameter where the
			// literal was.
			expect(sql, name).not.toMatch(/"notificationOutcome"\s*=\s*\$\d/);
		}

		expect(PUBLISHING_STALE_PENDING_CYCLE_SQL).toContain(
			`LIMIT ${PUBLISHING_ABANDON_BATCH_SIZE}`,
		);
		expect(PUBLISHING_STALE_PENDING_CYCLE_SQL).toContain(
			`ORDER BY "notificationOutcomeAt" ASC`,
		);
	});

	it("reads the explicit activation clock, and neither of the two that look like it", () => {
		// Decision 27, asserted on the TEXT as well as behaviourally, because
		// all three columns are interchangeable to a type-checker and to a
		// reviewer skimming. `createdAt` compiles, reads fine, and writes a
		// permanent false ABANDONED over a workflow whose start was retried.
		// `updatedAt` compiles too and is correct only while an inventory of
		// every writer of this model stays complete — which is the property a
		// third review round showed could not be guarded fail-closed.
		//
		// THE WHOLE EXPRESSION, not `"notificationOutcomeAt" < $1`. That older
		// shape is what this statement looked like when the activity computed
		// the cutoff and passed it as a Date, and pinning it would pass on a
		// statement that had gone back to doing exactly that. Decision 33: the
		// BOUND arrives in milliseconds and the DATABASE computes the cutoff,
		// with `now()` and not `clock_timestamp()`, because clause 2 is what
		// keeps the comparison inside the partial index's Index Cond.
		const BOUND = `"notificationOutcomeAt" < (now() AT TIME ZONE 'UTC') - ($1::bigint * interval '1 millisecond')`;
		expect(PUBLISHING_STALE_PENDING_CYCLE_SQL).toContain(BOUND);
		// THE REMAINING PROBE CARRIES THE SAME BOUND AND WAS PINNED BY NOTHING.
		// It is the statement that decides `moreWorkRemains`, so a probe whose
		// clock drifted from the page's would report a backlog the page cannot
		// see, or miss one it can -- and every case in this file would stay
		// green, because no case compares the two statements' clocks.
		expect(PUBLISHING_STALE_PENDING_CYCLE_REMAINING_SQL).toContain(BOUND);
		expect(PUBLISHING_STALE_PENDING_CYCLE_SQL).not.toContain(`"createdAt"`);
		expect(PUBLISHING_STALE_PENDING_CYCLE_SQL).not.toContain(`"updatedAt"`);

		// The residual is a COUNT of null-clock PENDING cycles and carries NO
		// clock term at all -- it asks how many are LEFT, never how many are
		// stale. Asserted as an absence because a clock appearing here would
		// mean the residual had quietly become a second staleness probe with a
		// second answer, which is the class Decision 33 exists to close.
		expect(PUBLISHING_NULL_CLOCK_RESIDUAL_SQL).not.toContain("now()");
		expect(PUBLISHING_NULL_CLOCK_RESIDUAL_SQL).not.toContain(
			"clock_timestamp()",
		);
		// A null clock is a cycle activated by a build predating the column.
		// Excluding it EXPLICITLY here is what keeps the two passes separable:
		// this statement never adopts such a row, and the bounded enrolment
		// pass is what makes it visible. Without the predicate the exclusion
		// would still happen — NULL < $1 is NULL — but by an unexamined
		// three-valued comparison nobody wrote down.
		expect(PUBLISHING_STALE_PENDING_CYCLE_SQL).toContain(
			`"notificationOutcomeAt" IS NOT NULL`,
		);
	});

	it.skipIf(!RUN_DB)(
		"abandons a PENDING cycle older than the suggestion workflow's execution timeout",
		async () => {
			await inRolledBackTransaction(async (tx) => {
				const id = await seedCycle(tx, {
					outcome: "PENDING",
					createdAt: new Date(NOW.getTime() - 3 * 60 * 60_000),
				});
				const result = await abandonStalePublishingCycleOutcomes(
					{ staleAfterMs: STALE_AFTER_MS },
					tx,
				);
				expect(result.abandoned).toBeGreaterThanOrEqual(1);
				const after = await readCycle(tx, id);
				expect(after.notificationOutcome).toBe("ABANDONED");
				// The version is a SHARED lifecycle version, and every
				// transition write bumps it. A writer holding the old version
				// cannot now win.
				expect(after.notificationOutcomeVersion).toBe(1);
			});
		},
	);

	it.skipIf(!RUN_DB)(
		"leaves a PENDING cycle inside the window alone",
		async () => {
			await inRolledBackTransaction(async (tx) => {
				const id = await seedCycle(tx, {
					outcome: "PENDING",
					createdAt: new Date(NOW.getTime() - 60 * 60_000),
				});
				await abandonStalePublishingCycleOutcomes(
					{ staleAfterMs: STALE_AFTER_MS },
					tx,
				);
				const after = await readCycle(tx, id);
				// A healthy attempt sits at PENDING for its whole duration.
				// PENDING is never an alert by itself — stale work is.
				expect(after.notificationOutcome).toBe("PENDING");
				expect(after.notificationOutcomeVersion).toBe(0);
			});
		},
	);

	it.skipIf(!RUN_DB)(
		"never adopts a cycle that never entered the lifecycle",
		async () => {
			await inRolledBackTransaction(async (tx) => {
				const id = await seedCycle(tx, {
					outcome: "NOT_APPLICABLE",
					createdAt: new Date(NOW.getTime() - 3 * 60 * 60_000),
				});
				await abandonStalePublishingCycleOutcomes(
					{ staleAfterMs: STALE_AFTER_MS },
					tx,
				);
				const after = await readCycle(tx, id);
				// Activation is a different guard with two writers, and no other
				// path may move a row out of NOT_APPLICABLE. The sweep is not
				// one of them.
				expect(after.notificationOutcome).toBe("NOT_APPLICABLE");
			});
		},
	);

	it.skipIf(!RUN_DB)(
		"leaves a cycle that already recorded MAIL_NOT_CONFIGURED alone",
		async () => {
			await inRolledBackTransaction(async (tx) => {
				const id = await seedCycle(tx, {
					outcome: "MAIL_NOT_CONFIGURED",
					createdAt: new Date(NOW.getTime() - 3 * 60 * 60_000),
				});
				await abandonStalePublishingCycleOutcomes(
					{ staleAfterMs: STALE_AFTER_MS },
					tx,
				);
				const after = await readCycle(tx, id);
				// A cycle that deferred keeps its MAIL_NOT_CONFIGURED record
				// forever; the fact of a later delivery lives on the ledger row.
				// The terminality predicate is deliberately NOT widened.
				expect(after.notificationOutcome).toBe("MAIL_NOT_CONFIGURED");
			});
		},
	);

	it.skipIf(!RUN_DB)(
		"survives a late notify attempt: ABANDONED is written, the later MAIL_NOT_CONFIGURED is refused",
		async () => {
			await inRolledBackTransaction(async (tx) => {
				const id = await seedCycle(tx, {
					outcome: "PENDING",
					createdAt: new Date(NOW.getTime() - 3 * 60 * 60_000),
				});
				// The notify attempt read version 0 before the sweep ran.
				const observedByNotify = 0;

				await abandonStalePublishingCycleOutcomes(
					{ staleAfterMs: STALE_AFTER_MS },
					tx,
				);

				const late = await writeCycleNotificationOutcome(
					{
						cycleId: id,
						projectId: PROJECT_ID,
						outcome: "MAIL_NOT_CONFIGURED",
						observedVersion: observedByNotify,
					},
					tx,
				);

				// Refused twice over — the terminality predicate no longer
				// matches ABANDONED, and the version moved. Either alone would
				// be enough; the pair is why the guard is writer-agnostic.
				expect(late).toBe(false);
				const after = await readCycle(tx, id);
				expect(after.notificationOutcome).toBe("ABANDONED");
			});
		},
	);

	it.skipIf(!RUN_DB)(
		"leaves a LATE-ACTIVATED cycle alone even though its row is older than the bound",
		async () => {
			await inRolledBackTransaction(async (tx) => {
				const id = await seedCycle(tx, {
					outcome: "PENDING",
					// The row was inserted three hours ago…
					createdAt: new Date(NOW.getTime() - 3 * 60 * 60_000),
					// …and the notification lifecycle was activated ten minutes
					// ago. This is not a contrived shape: dispatch inserts the
					// cycle BEFORE client.workflow.start, a start failure
					// re-throws so Temporal retries the whole activity, and
					// activation happens later still, in the transaction that
					// sets READY.
					activatedAt: new Date(NOW.getTime() - 10 * 60_000),
				});
				await abandonStalePublishingCycleOutcomes(
					{ staleAfterMs: STALE_AFTER_MS },
					tx,
				);
				const after = await readCycle(tx, id);
				// THE CASE THAT RULES OUT createdAt. Keyed on createdAt this
				// cycle is stale and the sweep terminalizes a LIVE notify
				// attempt — and because ABANDONED is terminal, the real
				// attempt's own outcome write is then refused forever and the
				// cycle keeps a false alert. The shared CAS does not help: it
				// arbitrates who wins the race, not whether the sweep was
				// entitled to run at all.
				expect(after.notificationOutcome).toBe("PENDING");
				expect(after.notificationOutcomeVersion).toBe(0);
			});
		},
	);

	it.skipIf(!RUN_DB)(
		"the ABANDON pass alone leaves a PENDING cycle with no activation clock — ENROLMENT is what makes it visible",
		async () => {
			await inRolledBackTransaction(async (tx) => {
				const id = await seedCycle(tx, {
					outcome: "PENDING",
					createdAt: new Date(NOW.getTime() - 3 * 60 * 60_000),
					// Activated by a build that predates the column.
					activatedAt: null,
				});
				await abandonStalePublishingCycleOutcomes(
					{ staleAfterMs: STALE_AFTER_MS },
					tx,
				);
				const after = await readCycle(tx, id);
				// The two passes must stay DISTINGUISHABLE, which is why this
				// case calls only the abandon one. A null clock is invisible to
				// it — by design, since the alternative is COALESCE-ing to
				// updatedAt and re-importing the implicit coupling the column
				// exists to remove. The enrolment pass is what adopts such
				// a row, from updatedAt, once, before this pass runs. If this
				// case ever goes green because the abandon statement learned to
				// see null clocks, the enrolment pass has been bypassed rather
				// than made redundant.
				expect(after.notificationOutcome).toBe("PENDING");
				expect(after.notificationOutcomeAt).toBeNull();
			});
		},
	);

	// NOT inside the rollback harness, and the reason is the point of the case:
	// `persistCycleTerminal` opens its OWN `db.$transaction`
	// (publishing-suite.ts:201-205) and takes no client, so calling it from
	// inside one would deadlock against the outer transaction's row locks. Since
	// the whole assertion is that these writers change NOTHING, running committed
	// costs nothing — and the file's prefix-scoped afterAll already removes the
	// cycle. Adding a client parameter to a shipped writer purely to make a test
	// tidier would be changing production to suit the test.
	it.skipIf(!RUN_DB)(
		"nothing re-stamps the activation clock once a cycle is PENDING",
		async () => {
			// `db` satisfies the same surface seedCycle/readCycle use.
			const tx = db as unknown as Prisma.TransactionClient;
			const id = await seedCycle(tx, {
				outcome: "PENDING",
				createdAt: new Date(NOW.getTime() - 3 * 60 * 60_000),
				activatedAt: new Date(NOW.getTime() - 10 * 60_000),
			});
			const before = await readCycle(tx, id);

			// The REAL production writers, called for real — not retyped copies
			// of their predicates. This case is much narrower than the writer
			// audit it replaces, and deliberately so: the guarantee is no longer
			// "every writer of this table is fenced away from PENDING", which is
			// an inventory nobody can keep. It is "nothing else writes THIS
			// column", and the frozen file list is the other half.
			//
			// persistCycleTerminal is fenced on status = 'GENERATING', and a
			// PENDING cycle is READY, so both branches must write nothing.
			for (const kind of [
				"INSUFFICIENT_CONTEXT",
				"SUGGESTIONS",
			] as const) {
				const outcome = await persistCycleTerminal({
					cycleId: id,
					kind,
					topics: [],
					sourceCoverage: {},
					sourceFailures: {},
					tenant: {
						projectId: PROJECT_ID,
						organizationId: ORG_ID,
						userId: null,
					},
				});
				expect(
					outcome.persisted,
					`persistCycleTerminal(${kind}) touched a PENDING cycle`,
				).toBe(false);
			}

			// The activation writer itself. It is fenced on NOT_APPLICABLE, so
			// the repair path re-running against an already-activated cycle
			// affects zero rows and CANNOT re-stamp the clock — which is the one
			// way this column could still drift, and therefore the one this case
			// exists for.
			const reactivated = await activateCycleNotificationLifecycle(tx, {
				cycleId: id,
				projectId: PROJECT_ID,
				now: NOW,
			});
			expect(reactivated).toBe(false);

			const after = await readCycle(tx, id);
			expect(after.notificationOutcomeAt?.toISOString()).toBe(
				before.notificationOutcomeAt?.toISOString(),
			);
		},
	);

	it.skipIf(!RUN_DB)(
		"the activation writer is what sets the clock, in the same write that sets PENDING",
		async () => {
			await inRolledBackTransaction(async (tx) => {
				const id = await seedCycle(tx, {
					outcome: "NOT_APPLICABLE",
					createdAt: new Date(NOW.getTime() - 3 * 60 * 60_000),
					activatedAt: null,
				});
				const activated = await activateCycleNotificationLifecycle(tx, {
					cycleId: id,
					projectId: PROJECT_ID,
					now: NOW,
				});
				expect(activated).toBe(true);
				const after = await readCycle(tx, id);
				// One write, both fields. A cycle cannot be PENDING without a
				// clock unless a build predating the column wrote it.
				expect(after.notificationOutcome).toBe("PENDING");
				expect(after.notificationOutcomeAt?.toISOString()).toBe(
					NOW.toISOString(),
				);
			});
		},
	);

	// The other half of Decision 27's defence, and it is a MUCH smaller claim
	// than the writer inventory it replaces: not "every writer of the cycle
	// table is fenced" — which round 3 showed cannot be checked fail-closed —
	// but "nothing mentions this column outside three files". A string search
	// over file contents, so a bracket access, a raw UPDATE, a schema-qualified
	// statement and even a comment all fail it.
	//
	// The fourth entry is the Zod schema mirror. It is GENERATED
	// (prisma/zod, `prisma-zod-generator`, "Auto-generated. Do not edit.") and
	// restates every column of every model in a scalar-field enum, exactly as
	// the generated client does — but unlike prisma/generated it is TRACKED, so
	// it cannot be skipped by directory without also blinding the guard to a
	// hand-written file placed beside it. Listing it keeps the assertion an
	// exact equality: a fifth path is still red.
	//
	// No database: it reads source. It runs unconditionally for that reason.
	it("keeps notificationOutcomeAt to a single writer and a single reader", () => {
		expect(filesMentioning("notificationOutcomeAt")).toEqual([
			"packages/database/prisma/queries/projects/publishing-notification-outcome.ts",
			"packages/database/prisma/queries/projects/publishing-notification-reconcile.ts",
			"packages/database/prisma/schema.prisma",
			"packages/database/prisma/zod/index.ts",
		]);
	});

	it.skipIf(!RUN_DB)(
		"the primary path's residue: the row stays SENDING by design and its cycle still reaches ABANDONED",
		async () => {
			await inRolledBackTransaction(async (tx) => {
				const cycleId = await seedCycle(tx, {
					outcome: "PENDING",
					createdAt: new Date(NOW.getTime() - 3 * 60 * 60_000),
				});
				// The exact state a crashed primary-path send leaves: SENDING,
				// lease dead, no expiry because the row never entered the
				// deferral lifecycle.
				const rowId = await seedRowForCycle(tx, cycleId, {
					status: "SENDING",
					expiresAt: null,
					attemptCount: PUBLISHING_DELIVERY_ATTEMPT_BOUND,
					claimedAt: DEAD_LEASE_AT,
					claimToken: "case-token",
				});

				// NO ledger-sweep call: it moved to 1C-2d-2b with its
				// statements. That does not weaken this case — it sharpens it.
				// The row-grain half is now a NON-write asserted against a slice
				// that has no statement which could touch the row at all, and
				// the cycle-grain half is the whole point: the operator gets a
				// signal even though nothing adopts the row.
				await abandonStalePublishingCycleOutcomes(
					{ staleAfterMs: STALE_AFTER_MS },
					tx,
				);

				// BOTH HALVES, IN ONE CASE, BECAUSE ONE WITHOUT THE OTHER READS
				// AS A LEAK. Pass 1 does not adopt the row — primary-path residue
				// sits outside the deferral lifecycle deliberately — and that is
				// only defensible because the operator DOES get a signal: the
				// cycle carrying it terminalizes to ABANDONED, which is what
				// publishing-notification-delivery.ts means by "the residue
				// parent §9.7 designates for 1C-2d's sweep". The subject of that
				// sentence is the CYCLE OUTCOME, not the row.
				const row = await readRow(tx, rowId);
				expect(row.status).toBe("SENDING");
				expect(row.claimToken).toBe("case-token");

				const cycle = await readCycle(tx, cycleId);
				expect(cycle.notificationOutcome).toBe("ABANDONED");
			});
		},
	);

	// THE SHORT-PAGE EXIT, WHICH ANSWERED WITHOUT ASKING AND WAS WRONG TO. The
	// loop has three exits and the previous pass made two of them probe. This is
	// the third: a page shorter than the batch size broke out with
	// `moreWorkRemains: false` unconditionally, and it broke out BEFORE
	// `wonThisBatch` was consulted — so a short page some or all of whose
	// compare-and-swaps LOST reported no work left while every one of those rows
	// was still stale, still PENDING and still selectable. The comment justified
	// the shortcut with "the page was just drained"; drainage was never tested.
	//
	// NOT REACHABLE FROM PRODUCTION AT THIS COMMIT, said here rather than left to
	// be discovered: the only writer of `notificationOutcomeVersion` today is
	// `writeCycleNotificationOutcome`, whose `outcome` parameter type excludes
	// PENDING and NOT_APPLICABLE, so every version bump also moves the row off
	// PENDING and no shipped caller can lose a swap on a still-selectable page.
	// That is an INVENTORY OF WRITERS, which is the reasoning this module rejects
	// for `updatedAt` two screens into its own doc-comment, and 1C-2d-2b appends
	// writers to that same module: the first lease, attempt counter or retry
	// stamp that bumps a version without terminalizing the row reaches this
	// branch, silently, with no case watching.
	//
	// ROLLED BACK rather than committed, unlike the two contention cases below.
	// Those need a second connection because their invalidating UPDATE runs on
	// `db`; this one runs it on the SAME transaction client the executor was
	// handed, so it blocks on nothing and leaves no row behind — which also keeps
	// the `(mcv)` case's denominator where it is.
	it.skipIf(!RUN_DB)(
		"a SHORT page whose swaps lose reports the work it left behind",
		async () => {
			await inRolledBackTransaction(async (tx) => {
				// Half a page. Derived from the batch size rather than written
				// as a number, so the page stays short if the size moves.
				const seeded = PUBLISHING_ABANDON_BATCH_SIZE / 2;
				const prefix = await seedCycles(tx, seeded, {
					outcome: "PENDING",
					createdAt: new Date(NOW.getTime() - 3 * 60 * 60_000),
				});
				// The page is SHORT, and it is this case's page. Both halves
				// matter: a foreign stale row would make it full and quietly
				// move the case onto the contention branch instead.
				await assertGlobalStalePendingCycles(tx, seeded);

				let invalidated = false;
				let probes = 0;
				const result = await withQueryObserver(
					async ({ model, operation, args, query }) => {
						if (isResidualProbe(operation, args)) {
							probes += 1;
						}
						// PascalCase. The client extension reports the MODEL
						// name, not the delegate property — see the case below
						// for what the other spelling silently degrades into.
						if (
							!invalidated &&
							model === "PublishingSuggestionCycle" &&
							operation === "updateMany"
						) {
							invalidated = true;
							// The OTHER ACTOR, between selection and CAS. Bumps
							// the version on the whole page and leaves every row
							// PENDING and stale, so the page stays SELECTABLE
							// and every swap loses. The backslash escapes LIKE's
							// wildcard reading of the `_` in the prefix.
							await tx.$executeRawUnsafe(
								`UPDATE "publishing_suggestion_cycle"
								    SET "notificationOutcomeVersion" = "notificationOutcomeVersion" + 1
								  WHERE "id" LIKE $1`,
								`${prefix.replaceAll("_", "\\_")}%`,
							);
						}
						return query(args);
					},
					() =>
						abandonStalePublishingCycleOutcomes(
							{ staleAfterMs: STALE_AFTER_MS },
							tx,
						),
				);

				// THE PRECONDITION, asserted rather than assumed: a case whose
				// invalidation never fired is indistinguishable from one whose
				// invalidation fired and did nothing.
				expect(invalidated).toBe(true);
				// THE EXIT, IDENTIFIED rather than assumed: one batch, so not
				// the ceiling; a page shorter than the batch size, so the
				// short-page break and not the contention one; nothing won, so
				// the page it broke on was not drained.
				expect(result.batches).toBe(1);
				expect(result.scanned).toBe(seeded);
				expect(result.scanned).toBeLessThan(
					PUBLISHING_ABANDON_BATCH_SIZE,
				);
				expect(result.abandoned).toBe(0);
				expect(result.lost).toBe(seeded);
				expect(result.usedBatchBudget).toBe(false);
				expect(
					result.moreWorkRemains,
					"the run stopped on a short page it did not drain and reported no work remaining, while every candidate on that page is still stale, still PENDING and still selectable. The short-page exit is answering `false` without testing the drainage its own comment claims.",
				).toBe(true);
				// AND IT ASKED, rather than being handed a constant. This is
				// also the matcher's positive control: the drained case below
				// asserts ZERO probes, which would pass vacuously if
				// `isResidualProbe` never matched anything.
				expect(probes).toBe(1);
			});
		},
		180_000,
	);

	// THE OTHER HALF, and the case that stops the fix above from being a
	// hardcoded `true`. A short page every candidate of which WAS taken is the
	// one exit still entitled to answer without asking, and it must keep costing
	// nothing: this is the shape of an ordinary idle run.
	it.skipIf(!RUN_DB)(
		"a DRAINED short page reports no work left and issues no probe at all",
		async () => {
			await inRolledBackTransaction(async (tx) => {
				const seeded = PUBLISHING_ABANDON_BATCH_SIZE / 2;
				await seedCycles(tx, seeded, {
					outcome: "PENDING",
					createdAt: new Date(NOW.getTime() - 3 * 60 * 60_000),
				});
				await assertGlobalStalePendingCycles(tx, seeded);

				let probes = 0;
				const result = await withQueryObserver(
					async ({ operation, args, query }) => {
						if (isResidualProbe(operation, args)) {
							probes += 1;
						}
						return query(args);
					},
					() =>
						abandonStalePublishingCycleOutcomes(
							{ staleAfterMs: STALE_AFTER_MS },
							tx,
						),
				);

				expect(result.batches).toBe(1);
				expect(result.scanned).toBe(seeded);
				expect(result.abandoned).toBe(seeded);
				expect(result.lost).toBe(0);
				expect(result.usedBatchBudget).toBe(false);
				expect(result.moreWorkRemains).toBe(false);
				expect(
					probes,
					"a short page whose every candidate was taken issued the residual probe anyway. The exception exists so the ordinary idle run pays nothing; making the probe unconditional is not a fix for the undrained case, it is the removal of the exception.",
				).toBe(0);
			});
		},
		180_000,
	);

	// The no-progress break, driven rather than described. The shape that reaches
	// it is a FULL page whose swaps ALL lose while staying selectable: full, or
	// the short-page break fires first; still selectable, or the next page is
	// empty and the short-page break fires anyway. So another actor must
	// invalidate the page BETWEEN selection and CAS without moving it out of the
	// predicate — which is exactly what a version bump does.
	//
	// It commits and cleans up by prefix rather than riding the rollback harness:
	// the observer's invalidating UPDATE runs on `db`, not on the harness's
	// transaction client, so an outer transaction would deadlock against its own
	// row locks.
	it.skipIf(!RUN_DB)(
		"a full page whose swaps all lose stops after one batch",
		async () => {
			const seeded: string[] = [];
			for (let i = 0; i < PUBLISHING_ABANDON_BATCH_SIZE; i += 1) {
				seeded.push(
					await seedCycle(db as unknown as Prisma.TransactionClient, {
						outcome: "PENDING",
						createdAt: new Date(Date.now() - 3 * 60 * 60_000),
						activatedAt: new Date(Date.now() - 3 * 60 * 60_000),
					}),
				);
			}
			expect(seeded).toHaveLength(PUBLISHING_ABANDON_BATCH_SIZE);

			let invalidated = false;
			await withQueryObserver(
				async ({ model, operation, args, query }) => {
					// PascalCase. The client extension reports the MODEL name, not
					// the delegate property — `PublishingSuggestionCycle`, never
					// `publishingSuggestionCycle`. Written the other way the
					// predicate simply never matches, the page is never
					// invalidated, and the case degrades silently into the old
					// worthless fixture: every swap wins, the SHORT-PAGE break
					// stops the loop at two batches, and the branch this case is
					// named for is never reached. Observed exactly that way once.
					if (
						!invalidated &&
						model === "PublishingSuggestionCycle" &&
						operation === "updateMany"
					) {
						invalidated = true;
						// The OTHER ACTOR, between selection and CAS. Bumps the
						// version on the whole page and leaves every row PENDING and
						// stale, so the page stays SELECTABLE and every swap loses.
						await db.$executeRawUnsafe(
							`UPDATE "publishing_suggestion_cycle"
							    SET "notificationOutcomeVersion" = "notificationOutcomeVersion" + 1
							  WHERE "id" = ANY($1::text[])`,
							seeded,
						);
					}
					return query(args);
				},
				async () => {
					const result = await abandonStalePublishingCycleOutcomes({
						staleAfterMs: STALE_AFTER_MS,
					});
					// THE PRECONDITION, asserted rather than assumed. Without it a
					// case whose invalidation never fired is indistinguishable from
					// one whose invalidation fired and did nothing, and the first
					// of those is what a mistyped model name produces.
					expect(invalidated).toBe(true);
					// The whole point: ONE batch, not twenty.
					expect(result.batches).toBe(1);
					expect(result.scanned).toBe(PUBLISHING_ABANDON_BATCH_SIZE);
					expect(result.abandoned).toBe(0);
					expect(result.lost).toBe(PUBLISHING_ABANDON_BATCH_SIZE);
					expect(result.usedBatchBudget).toBe(false);
				},
			);
		},
		180_000,
	);

	// THE SAME EXIT, ASKING WHAT IT LEFT BEHIND. The case above proves the loop
	// STOPS on a fully-lost page; this one proves the run SAYS SO. The residual
	// probe used to be asked only when `batches` reached the ceiling, so the
	// contention exit returned `moreWorkRemains: false` with a full page of
	// stale candidates provably still selectable — the one exit where the
	// backlog is least likely to be empty, and the one where `usedBatchBudget`
	// is false and so carries no signal either.
	//
	// Seeded SIX hours back rather than three, so `ORDER BY
	// "notificationOutcomeAt" ASC` puts this page ahead of the rows the case
	// above committed and left PENDING. That the page really is this page is not
	// assumed: a foreign row in it would win its swap, and `abandoned` would not
	// be zero.
	it.skipIf(!RUN_DB)(
		"a full page whose swaps all lose reports the work it left behind",
		async () => {
			const seeded: string[] = [];
			for (let i = 0; i < PUBLISHING_ABANDON_BATCH_SIZE; i += 1) {
				seeded.push(
					await seedCycle(db as unknown as Prisma.TransactionClient, {
						outcome: "PENDING",
						createdAt: new Date(NOW.getTime() - 6 * 60 * 60_000),
						activatedAt: new Date(NOW.getTime() - 6 * 60 * 60_000),
					}),
				);
			}

			let invalidated = false;
			await withQueryObserver(
				async ({ model, operation, args, query }) => {
					// PascalCase — the model name, never the delegate property.
					// See the case above for what the other spelling silently
					// degrades into.
					if (
						!invalidated &&
						model === "PublishingSuggestionCycle" &&
						operation === "updateMany"
					) {
						invalidated = true;
						await db.$executeRawUnsafe(
							`UPDATE "publishing_suggestion_cycle"
							    SET "notificationOutcomeVersion" = "notificationOutcomeVersion" + 1
							  WHERE "id" = ANY($1::text[])`,
							seeded,
						);
					}
					return query(args);
				},
				async () => {
					const result = await abandonStalePublishingCycleOutcomes({
						staleAfterMs: STALE_AFTER_MS,
					});
					expect(invalidated).toBe(true);
					// The contention exit IDENTIFIED, not assumed: one batch, so
					// not the ceiling; a FULL page, so not the short-page break;
					// nothing won, so it is this branch and no other.
					expect(result.batches).toBe(1);
					expect(result.scanned).toBe(PUBLISHING_ABANDON_BATCH_SIZE);
					expect(result.abandoned).toBe(0);
					expect(result.lost).toBe(PUBLISHING_ABANDON_BATCH_SIZE);
					// UNCHANGED MEANING, asserted so it stays unchanged: the
					// batch budget did not run out. Widening this field to mean
					// "stopped early" would answer a different operator question
					// — whether to raise the ceiling — with the wrong evidence.
					expect(result.usedBatchBudget).toBe(false);
					// A hundred stale candidates are still selectable; this run
					// simply failed to take any of them.
					expect(
						result.moreWorkRemains,
						"the run stopped on a fully-contended page and reported no work remaining, while a full page of stale PENDING cycles is still selectable. The residual probe is being asked only when the batch budget is spent.",
					).toBe(true);
				},
			);
		},
		180_000,
	);
});

/**
 * THE THREE OBJECTS 20260815120380 SHIPS, PINNED — because until this block
 * existed nothing did.
 *
 * `grep -rn "publishing_suggestion_cycle_pending\|notification_clock_stx"
 * packages/` returned exactly two hits: the reconcile module's doc-comment and
 * the migration itself. Every case above asserts BEHAVIOUR, and behaviour is
 * indifferent to how it was reached: drop, rename or re-predicate either index,
 * or drop the statistics object, and all twenty-five stay green while every
 * sweep pass degrades to a scan of the whole cycle table. That is the failure
 * the whole batch-ceiling design exists to prevent and it is the one no
 * behavioural case can see, because `LIMIT` bounds rows RETURNED and never rows
 * READ.
 *
 * Same shape as `publishing-deferral-index-smoke.test.ts`, which pins the
 * LEDGER's two indexes: exact definition equality, kept apart from anything
 * about plan shape. Plan shape and index definition are two different
 * guarantees — the plan-shape suite for this module's statements is 1C-2d-2b's,
 * and pinning a chosen index by name inside an EXPLAIN would fail on a
 * legitimate planner improvement. What is pinned here is what OUR migration
 * built, which is not the planner's business at all.
 */

// CAPTURED from `pg_get_indexdef` on postgres:16 (16.14 — the CI image), not
// predicted. `pg_get_indexdef` RECONSTRUCTS from the catalog rather than echoing
// the migration text: identifiers are quoted only where quoting is required, so
// the mixed-case columns keep their quotes while `id` comes back bare, the
// predicate's literal is rendered with its type cast, and the two ANDed terms
// are each parenthesised. That is why these are literal strings compared with
// `toBe` rather than a regex assembled from the migration file.
//
// The local PostgreSQL 17 was not running and was not used, so unlike the ledger
// sibling these are a single-version capture. If a server upgrade changes the
// rendering, a red test asking a human to look is the outcome we want.
const STALE_INDEX_DEF = `CREATE INDEX publishing_suggestion_cycle_pending_stale_idx ON public.publishing_suggestion_cycle USING btree ("notificationOutcomeAt", id) WHERE (("notificationOutcome" = 'PENDING'::text) AND ("notificationOutcomeAt" IS NOT NULL))`;

const NULL_CLOCK_INDEX_DEF = `CREATE INDEX publishing_suggestion_cycle_pending_null_clock_idx ON public.publishing_suggestion_cycle USING btree ("updatedAt", id) WHERE (("notificationOutcome" = 'PENDING'::text) AND ("notificationOutcomeAt" IS NULL))`;

describe("the schema objects the sweep's bound rests on", () => {
	it.skipIf(!RUN_DB)(
		"keeps both cycle indexes valid, partial and keyed as the two passes read them",
		async () => {
			// The `::text` and `::int` casts are not cosmetic. `pg_class.relname`
			// is PostgreSQL's `name` type and `pg_index.indnkeyatts` is int2;
			// Prisma's raw-query deserializer knows neither and fails the whole
			// query before any assertion below runs.
			const rows = (await db.$queryRawUnsafe(`
		SELECT c.relname::text AS relname,
		       i.indisvalid,
		       i.indnkeyatts::int AS indnkeyatts,
		       pg_get_indexdef(i.indexrelid) AS definition
		  FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
		 WHERE c.relname IN ('publishing_suggestion_cycle_pending_null_clock_idx',
		                     'publishing_suggestion_cycle_pending_stale_idx')
		 ORDER BY c.relname
	`)) as Array<{
				relname: string;
				indisvalid: boolean;
				indnkeyatts: number;
				definition: string;
			}>;

			// Both names, in one assertion, so a DROP and a RENAME are the same
			// red rather than a missing destructure quietly reading `undefined`.
			expect(rows.map((row) => row.relname)).toEqual([
				"publishing_suggestion_cycle_pending_null_clock_idx",
				"publishing_suggestion_cycle_pending_stale_idx",
			]);

			const [nullClock, stale] = rows;

			// EXACT equality on the whole reconstructed definition, never a regex
			// over parts of it. "contains PENDING" would accept a predicate
			// widened to a second outcome — an index that still yields an index
			// scan while admitting rows the sweep must never page through, which
			// reads as a pass. The `IS NOT NULL` term in particular is what stops
			// this index competing for the ENROLMENT page (see the migration): a
			// regex that ignored it would accept the shape whose measured cost is
			// 5,031 buffers to return 100 rows.
			expect(stale.indisvalid).toBe(true);
			expect(stale.indnkeyatts).toBe(2);
			expect(stale.definition).toBe(STALE_INDEX_DEF);

			// `id` in the key is load-bearing on both, and invisible to plan
			// shape at fixture sizes: it is what makes the ordered walk a total
			// order, so a page inside one `updatedAt` tie group can seek rather
			// than sort.
			expect(nullClock.indisvalid).toBe(true);
			expect(nullClock.indnkeyatts).toBe(2);
			expect(nullClock.definition).toBe(NULL_CLOCK_INDEX_DEF);
		},
	);

	it.skipIf(!RUN_DB)(
		"declares the (mcv) statistics object on the correlated pair, and collects a null-clock combination when the table is analyzed",
		async () => {
			const declarations = (await db.$queryRawUnsafe(`
		SELECT s.stxname::text AS stxname,
		       c.relname::text AS relname,
		       s.stxkind::text AS stxkind,
		       (SELECT string_agg(a.attname::text, ',' ORDER BY a.attnum)
		          FROM unnest(s.stxkeys) AS k
		          JOIN pg_attribute a
		            ON a.attrelid = s.stxrelid AND a.attnum = k) AS columns
		  FROM pg_statistic_ext s
		  JOIN pg_class c ON c.oid = s.stxrelid
		 WHERE s.stxname = 'publishing_suggestion_cycle_notification_clock_stx'
	`)) as Array<{
				stxname: string;
				relname: string;
				stxkind: string;
				columns: string;
			}>;

			expect(
				declarations.length,
				"the (mcv) statistics object 20260815120380 ships is gone or renamed. Without it the planner estimates `notificationOutcome = 'PENDING'` and `notificationOutcomeAt IS NULL` as independent, predicts 43 rows where 5,000 match, and the enrolment page becomes a bitmap over the whole null-clock population with a top-N sort on top — measured at 5,131 buffers to return 100 against 202 with the object present.",
			).toBe(1);

			const [declared] = declarations;
			expect(declared.relname).toBe("publishing_suggestion_cycle");
			// `{m}` and nothing else. The migration measured all five candidate
			// shapes and only the MCV list moves this estimate: `(dependencies)`
			// answers equality clauses rather than NullTests, and an EXPRESSION
			// statistic on `(clock IS NULL)` never matches a NullTest on a plain
			// column. Both left the 5,131-buffer plan in place.
			expect(declared.stxkind).toBe("{m}");
			expect(declared.columns).toBe(
				"notificationOutcome,notificationOutcomeAt",
			);

			// AND THAT IT ACTUALLY COLLECTS ONE, which the declaration alone does
			// not buy and which cannot be asserted against the ambient database.
			// Measured on postgres:16 (16.14): `ANALYZE` over an EMPTY table
			// writes no `pg_statistic_ext_data` row at all, so on a fresh CI
			// database — which is this workflow's actual starting condition — the
			// object ships unfilled, exactly as the migration's own comment says.
			// An unconditional `mcv_filled === true` would therefore be red in CI
			// and green here, which is worse than no assertion.
			//
			// So the case supplies the population itself and asserts what the
			// migration depends on: given a correlated one, the object records
			// the PENDING/null-clock COMBINATION with a NULL flag on the second
			// column. That is the one thing only an MCV list carries.
			//
			// Inside the rollback harness, and measured rather than assumed:
			// `ANALYZE` in a transaction updates `pg_statistic_ext_data` and the
			// ROLLBACK reverts it — fingerprint 650ce547… → c1b1e0e3… → 650ce547…
			// on the same object in one psql session — so this leaves the
			// database's statistics exactly as it found them.
			const matches = await inRolledBackTransaction(async (tx) => {
				const createdAt = new Date(NOW.getTime() - 3 * 60 * 60_000);
				await seedCycles(tx, 1_600, {
					outcome: "PENDING",
					createdAt,
					activatedAt: null,
				});
				await seedCycles(tx, 400, {
					outcome: "NOT_APPLICABLE",
					createdAt,
				});
				await tx.$executeRawUnsafe(
					`ANALYZE "publishing_suggestion_cycle"`,
				);
				// The `stxdmcv IS NOT NULL` filter sits in the derived table
				// rather than the outer WHERE: `pg_mcv_list_items` cannot be
				// handed a NULL list, so a kind change would otherwise error
				// here instead of returning zero.
				const [{ n }] = (await tx.$queryRawUnsafe(`
			SELECT count(*)::int AS n
			  FROM (SELECT d.stxdmcv AS mcv
			          FROM pg_statistic_ext s
			          JOIN pg_statistic_ext_data d ON d.stxoid = s.oid
			         WHERE s.stxname = 'publishing_suggestion_cycle_notification_clock_stx'
			           AND d.stxdmcv IS NOT NULL) m,
			       LATERAL pg_mcv_list_items(m.mcv) AS i
			 WHERE i.values[1] = 'PENDING'
			   AND i.nulls[2]
			   AND i.frequency >= 0.5
		`)) as Array<{ n: number }>;
				return n;
			});

			// `>= 0.5` AGAINST THE REAL DENOMINATOR, WHICH IS NOT THIS CASE'S
			// 2,000. Three earlier cases in this file COMMIT PENDING cycles that
			// survive to `afterAll` — the two contention cases a full page each,
			// and "nothing re-stamps the activation clock once a cycle is
			// PENDING" one more — so the table `ANALYZE` sees here is 2,201 rows
			// and the (PENDING, null-clock) combination's frequency is 0.727, not
			// 0.8. Measured on postgres:16 (16.14) rather than derived:
			// total=2201, pending=1801, frequency=0.72694.
			//
			// THE RULE THAT KEEPS THAT MARGIN, stated here because this is where
			// the next author is standing when they need it: ANY case added to
			// this file must either ROLL BACK, or seed its rows OLDER THAN SIX
			// HOURS. Rolling back keeps them out of this denominator entirely;
			// seeding older keeps `ORDER BY "notificationOutcomeAt" ASC` putting
			// the new case's own page first, ahead of the six-hour page the
			// second contention case leaves behind. Neither half is optional. A
			// third COMMITTING case seeding ~1,000 rows drops the frequency to
			// 0.50 and reddens this assertion for a reason having nothing to do
			// with the statistics object it guards; a committing case seeded
			// NEWER quietly takes a page that belongs to someone else.
			//
			// The threshold cannot be satisfied by whatever list the ambient
			// database already carried: run the same probe AFTER the rollback and
			// it returns 0, because the restored list has no null-clock
			// combination in it at all. That is what stops this from being a
			// positive control that cannot fail.
			expect(
				matches,
				"the statistics object collected no PENDING/null-clock combination after ANALYZE over a population that is 80% exactly that. Only an MCV list records a per-column NULL flag, so this is what a change of `stxkind` away from (mcv) looks like.",
			).toBeGreaterThanOrEqual(1);
		},
		180_000,
	);
});

// ---------------------------------------------------------------------------
// 1C-2d-2b-1 — the LEDGER half of the sweep.
//
// Everything below this line is about publishing_notification_delivery. The
// cycle half above computes its cutoff in the database and therefore seeds
// offsets from real time; the ledger statements are handed a `now` by the
// caller, so this half FREEZES its clock. A fixture seeded from the database's
// own clock would silently change population sizes as the calendar moves.
// ---------------------------------------------------------------------------

/**
 * The ledger half's clock. Frozen, deliberately, and NOT this file's `NOW` --
 * see the comment on that constant for why the two cannot be the same value.
 *
 * Seeding this fixture from the database's own `now()` would make the whole
 * ledger half depend on the gap between "when the fixture loaded" and the date
 * written here: a DEFERRED row seeded at `now() + 40 hours` is well inside its
 * expiry on the day it was written and long past it three weeks later, which
 * silently turns 200 expired rows into 2,500 and pushes EXPIRE_DEFERRED over its
 * batch ceiling.
 */
const LEDGER_NOW = new Date("2026-09-01T12:00:00.000Z");

/** The cycle every ledger row below hangs off. */
const CYCLE_ID = `${RUN}_cycle`;

const DEFERRED_ROWS = 2_500;
const SENDING_ROWS = 2_500;
const TERMINAL_ROWS = 5_000;
// Rare, for the same reason 1C-2d-1b's fixture keeps its expired-lease fraction
// small: a small matching fraction is what pushes the planner's selectivity
// estimate toward "most rows don't match", and that estimate is what decides
// index scan versus seq scan plus sort. More than the LIMIT, so a plan that
// materializes the whole matching set is distinguishable from one that stops.
const DEAD_LEASES = 300;
const AT_BOUND_ROWS = 300;

beforeAll(async () => {
	if (!RUN_DB) {
		return;
	}

	// The organization, actor and project come from the cycle half's own
	// `beforeAll` above -- hooks run in declaration order -- and every id here
	// carries the same `RUN` prefix, so the teardown at the top of this file
	// already removes all of it. There is deliberately no second `afterAll`.
	//
	// status is not optional even though Prisma defaults it: the default is
	// GENERATING, and publishing_suggestion_cycle carries
	// CHECK (status <> 'GENERATING' OR executionTimeoutAt IS NOT NULL).
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
		},
	});

	await db.$executeRawUnsafe(
		`INSERT INTO "user" ("id","name","email","emailVerified","createdAt","updatedAt")
		 SELECT $1 || '_u' || g, 'Reconcile Fixture ' || g, $1 || '_u' || g || '@example.com', true, now(), now()
		   FROM generate_series(1, $2) AS g`,
		RUN,
		DEFERRED_ROWS + SENDING_ROWS + TERMINAL_ROWS,
	);

	// DEFERRED: most well inside their expiry, AT_BOUND_ROWS of them at the
	// attempt bound -- which THIS slice still leaves alone, because the
	// DEFERRED-at-bound discharge ships with 1C-2d-2b-2 alongside the claim that
	// produces its rows -- and a tail of exactly 200 already past expiry. 200 is
	// chosen against the batch budget: more than one page of 100, fewer than the
	// ceiling of 20, so the batch-report case can assert BOTH.
	await db.$executeRawUnsafe(
		`INSERT INTO "publishing_notification_delivery"
		   ("id","cycleId","projectId","organizationId","userId","recipientUserId","channel","status","createdAt","expiresAt","attemptCount")
		 SELECT $1 || '_def_' || lpad(g::text, 6, '0'), $2, $3, $4, NULL, $1 || '_u' || g,
		        'EMAIL', 'DEFERRED', now(),
		        CASE WHEN g <= 200 THEN $8::timestamp - interval '1 day'
		             ELSE $8::timestamp + interval '30 days' + (g || ' minutes')::interval END,
		        CASE WHEN g > $5 - $6 THEN $7 ELSE 0 END
		   FROM generate_series(1, $5) AS g`,
		RUN,
		CYCLE_ID,
		PROJECT_ID,
		ORG_ID,
		DEFERRED_ROWS,
		AT_BOUND_ROWS,
		PUBLISHING_DELIVERY_ATTEMPT_BOUND,
		LEDGER_NOW,
	);

	// SENDING: DEAD_LEASES claimed long ago, the rest claimed at LEDGER_NOW (so
	// their lease is live); a slice of the dead-leased ones already past expiry, a
	// slice AT THE BOUND -- which THIS slice now adopts, to FAILED, and 1C-2d-2a
	// did not -- and a slice with a NULL expiry standing for the primary path's
	// residue, which no transition adopts (Decision 26). The null-expiry slice is
	// deliberately BELOW the attempt bound: at the bound it would be excluded by
	// two predicates at once, and a probe excluded twice cannot tell you which one
	// you deleted.
	//
	// The dead-leased candidate set is therefore 280 of the 300, not the 240 it
	// was in 1C-2d-2a: deleting the at-bound exclusion admitted the 40 rows that
	// slice had no arm for. That number is asserted rather than left implicit,
	// because it is the arithmetic the loosening changed.
	await db.$executeRawUnsafe(
		`INSERT INTO "publishing_notification_delivery"
		   ("id","cycleId","projectId","organizationId","userId","recipientUserId","channel","status","createdAt","claimedAt","claimToken","expiresAt","attemptCount")
		 SELECT $1 || '_snd_' || lpad(g::text, 6, '0'), $2, $3, $4, NULL, $1 || '_u' || ($5 + g),
		        'EMAIL', 'SENDING', now(),
		        CASE WHEN g <= $6 THEN $9::timestamp - interval '1 hour' ELSE $9::timestamp END,
		        $1 || '_tok_' || g,
		        CASE WHEN g <= 50 THEN $9::timestamp - interval '1 day'
		             WHEN g > $6 - 20 AND g <= $6 THEN NULL
		             ELSE $9::timestamp + interval '10 days' END,
		        CASE WHEN g > $6 - 60 AND g <= $6 - 20 THEN $7 ELSE 1 END
		   FROM generate_series(1, $8) AS g`,
		RUN,
		CYCLE_ID,
		PROJECT_ID,
		ORG_ID,
		DEFERRED_ROWS,
		DEAD_LEASES,
		PUBLISHING_DELIVERY_ATTEMPT_BOUND,
		SENDING_ROWS,
		LEDGER_NOW,
	);

	// Terminal noise. This is the population that grows without bound in
	// production, and it is what a plan that walks the whole ledger pays for.
	await db.$executeRawUnsafe(
		`INSERT INTO "publishing_notification_delivery"
		   ("id","cycleId","projectId","organizationId","userId","recipientUserId","channel","status","createdAt","expiresAt","attemptCount")
		 SELECT $1 || '_snt_' || lpad(g::text, 6, '0'), $2, $3, $4, NULL, $1 || '_u' || ($5 + g),
		        'EMAIL', 'SENT', now(), now(), 1
		   FROM generate_series(1, $6) AS g`,
		RUN,
		CYCLE_ID,
		PROJECT_ID,
		ORG_ID,
		DEFERRED_ROWS + SENDING_ROWS,
		TERMINAL_ROWS,
	);

	// Measured, not argued (1C-2d-1b recorded the same finding): on a virgin
	// database -- which is CI's actual starting condition -- removing this line
	// costs the plan-shape assertions below; on a database that already carries
	// representative statistics it costs nothing. A single delete-a-guard run is
	// not evidence about a guard on its own when the answer depends on state the
	// experiment was not controlling.
	await db.$executeRawUnsafe(`ANALYZE "publishing_notification_delivery"`);
}, 180_000);

function sqlFor(key: ReclaimStatementKey): string {
	const statement = PUBLISHING_RECLAIM_STATEMENTS.find((t) => t.key === key);
	if (!statement) {
		throw new Error(`No reclaim statement named ${key}`);
	}
	return statement.sql;
}

// These cases need no database: they are properties of the SQL TEXT, and three
// of them are properties no query plan can demonstrate (see each case). They run
// unconditionally so a status accidentally turned into a bind parameter fails
// even on a machine with no Postgres.
describe("the sweep's ledger SQL carries what no plan can prove", () => {
	it("emits every delivery status as a literal, never as a bind parameter", () => {
		for (const statement of PUBLISHING_RECLAIM_STATEMENTS) {
			// The status appears only inside single quotes. A `"status" = $n`
			// anywhere is the degradation the two partial indexes exist to
			// prevent, and nothing in CI catches it except this line.
			expect(statement.sql).not.toMatch(/"status"\s*=\s*\$\d/);
			expect(statement.sql).toMatch(/"status"\s*=\s*'[A-Z_]+'/);
		}
	});

	it("carries the batch bound as a literal, so the bound is a property of the statement", () => {
		for (const statement of PUBLISHING_RECLAIM_STATEMENTS) {
			expect(statement.sql).toContain(
				`LIMIT ${PUBLISHING_RECLAIM_BATCH_SIZE}`,
			);
			expect(statement.sql).not.toMatch(/LIMIT\s+\$\d/);
		}
	});

	// The interface commitment handed forward by 1C-2d-1b. It is asserted on the
	// TEXT and not on the plan on purpose: measured on postgres:16 with 2,500
	// SENDING rows, deleting `ORDER BY "claimedAt" ASC` leaves the plan UNCHANGED
	// (still Index Scan on the lease index, still no Sort), because the range
	// predicate on the index's only key column plus the LIMIT makes an ordered
	// walk the cheapest plan anyway. The ordering guarantee -- oldest claim first,
	// which is what stops the newest claims from starving the oldest -- is
	// therefore carried by the SQL text alone.
	it("orders every page oldest-first, on the key its index is built on", () => {
		expect(sqlFor("RECONCILE_SENDING")).toContain(
			`ORDER BY "claimedAt" ASC`,
		);
		expect(sqlFor("EXPIRE_DEFERRED")).toContain(
			`ORDER BY "expiresAt" ASC, "id" ASC`,
		);
	});

	// THE PRECEDENCE GUARD. In 1C-2d-2a this was the ONLY instrument that could
	// see the arm order, because that slice shipped two exhaustive complementary
	// arms and both orders were behaviourally identical. This slice adds the third
	// arm, so a row matched by two arms now exists and a behavioural case sees it
	// too (see "a row at the bound AND past its expiry is EXPIRED" below). The
	// text guard stays because it names the property directly and fails on the
	// SHAPE rather than on one row's outcome -- and because 1C-2d-2b-2 adds a
	// fourth arm against the same order.
	it("classifies with expiry FIRST and the attempt bound SECOND", () => {
		const sql = sqlFor("RECONCILE_SENDING");
		// Both CASE expressions -- status and reason -- open on the expiry test.
		// There are two of them because the lease columns are cleared
		// unconditionally on every arm rather than inside a CASE.
		//
		// Captured up to the arm's own `THEN`, NOT to end of line. 1C-2d-2a's
		// version read `/CASE WHEN ([^\n]+?)\s*$/gm`, which works only while every
		// CASE happens to break the line before `THEN` -- it silently captured
		// `"expiresAt" <= $2 THEN 'EXPIRED'` the moment one of them did not. A
		// guard that depends on where the SQL string wraps is a guard that fails on
		// a reformat and passes on a swap.
		const opens = [...sql.matchAll(/CASE WHEN\s+([\s\S]+?)\s+THEN/g)].map(
			(m) => m[1],
		);
		expect(opens).toEqual([`"expiresAt" <= $2`, `"expiresAt" <= $2`]);
		// The at-bound arm is BELOW the expiry arm in both. Asserted as an
		// ordering of indices rather than as mere presence: `toContain` would pass
		// with the arms swapped, which is the exact mistake this case exists for.
		for (const marker of [
			`'EXPIRED'`,
			`'${PUBLISHING_RECLAIM_REASON_EXPIRED}'`,
		]) {
			expect(sql.indexOf(marker)).toBeGreaterThan(-1);
		}
		expect(sql.indexOf(`"expiresAt" <= $2 THEN 'EXPIRED'`)).toBeLessThan(
			sql.indexOf(
				`WHEN "attemptCount" >= ${PUBLISHING_DELIVERY_ATTEMPT_BOUND} THEN 'FAILED'`,
			),
		);
		expect(
			sql.indexOf(`THEN '${PUBLISHING_RECLAIM_REASON_EXPIRED}'`),
		).toBeLessThan(
			sql.indexOf(`THEN '${PUBLISHING_RECLAIM_REASON_ATTEMPT_BOUND}'`),
		);
	});

	// The one exclusion the candidate predicate still carries, asserted in the
	// page's WHERE *and* in the re-asserted outer WHERE -- a re-assertion that
	// lost it would let a concurrently-changed row through.
	//
	// 1C-2d-2a also carried `("expiresAt" <= $2 OR "attemptCount" < BOUND)` and
	// this slice DELETED it: it existed to keep at-bound rows out of a slice with
	// no arm to discharge them, and this slice has the arm. The deletion is
	// asserted as an absence so re-adding it -- which would make the new arm
	// unreachable while every other case stayed green -- is red.
	it("keeps the primary path's null-expiry residue out, and nothing else", () => {
		const sql = sqlFor("RECONCILE_SENDING");
		expect(sql.match(/AND "expiresAt" IS NOT NULL/g) ?? []).toHaveLength(2);
		expect(sql).not.toContain(`"attemptCount" <`);
	});

	// The shape Decision 10 landed on, asserted as an absence so re-splitting the
	// SENDING side -- or adding a separate at-bound statement -- is red rather
	// than quiet. The array is compared WHOLE, so a third key of any name fails.
	//
	// This is not tidiness. Two statements split by an `expiresAt` comparison are
	// disjoint only RELATIVE TO ONE CLOCK, and two overlapping executions do not
	// share one; `status` is a partition no clock can move.
	it("ships two statements writing exactly the three states pass 1 can write", () => {
		expect(PUBLISHING_RECLAIM_STATEMENTS.map((t) => t.key)).toEqual([
			"EXPIRE_DEFERRED",
			"RECONCILE_SENDING",
		]);
		// THEN, ELSE *and* the unconditional SET. The ELSE alternative is not
		// padding: the LAST arm of both CASEs is an ELSE, so a pattern that reads
		// only THEN misses one status and one reason -- and the case then passes
		// against a set it never saw, which is how a guard stops guarding.
		const written = new Set(
			PUBLISHING_RECLAIM_STATEMENTS.flatMap((t) => [
				...t.sql.matchAll(
					/(?:THEN|ELSE) '([A-Z_]+)'|SET "status" = '([A-Z_]+)'/g,
				),
			]).map((m) => m[1] ?? m[2]),
		);
		// EXPIRED and FAILED are terminal; DEFERRED is not, and the next tick
		// re-sweeps it. The pattern above cannot tell a status arm from a reason
		// arm -- both are `THEN '...'` -- so the expected set is the UNION of the
		// two vocabularies rather than the statuses alone. That is not a weakening:
		// a status arm added anywhere still fails this, which is what it is for.
		expect(written).toEqual(
			new Set([
				"EXPIRED",
				"FAILED",
				"DEFERRED",
				PUBLISHING_RECLAIM_REASON_EXPIRED,
				PUBLISHING_RECLAIM_REASON_ATTEMPT_BOUND,
				PUBLISHING_RECLAIM_REASON_LEASE_RECLAIMED,
			]),
		);
	});

	// Every reason this module can write is an exported constant. `reason` is
	// free text at the schema level, so a typo is invisible to the type system and
	// this is the only thing that would catch one.
	it("writes only reasons the module exports", () => {
		const reasons = new Set(
			PUBLISHING_RECLAIM_STATEMENTS.flatMap((t) => [
				...t.sql.matchAll(
					/"reason" = (?:CASE[\s\S]*?END|'([A-Z_]+)')/g,
				),
			])
				.flatMap((m) => [...m[0].matchAll(/'(RECONCILE_[A-Z_]+)'/g)])
				.map((m) => m[1]),
		);
		expect(reasons).toEqual(
			new Set([
				PUBLISHING_RECLAIM_REASON_EXPIRED,
				PUBLISHING_RECLAIM_REASON_ATTEMPT_BOUND,
				PUBLISHING_RECLAIM_REASON_LEASE_RECLAIMED,
			]),
		);
	});

	// FOUND BY A PERTURBATION, NOT BY READING THE CODE, and written here rather
	// than left to the database case that found it because this one needs no
	// database and would have caught it at authoring time.
	//
	// `remainingSql` is a NARROWER statement than `sql` -- the candidate predicate
	// alone -- so its arity can differ, and for RECONCILE_SENDING it does: the
	// update binds the lease cutoff AND the clock, the probe binds only the
	// cutoff. Feeding the probe the update's parameter list is `08P01 bind message
	// supplies 2 parameters, but prepared statement "" requires 1`, thrown at
	// runtime, and ONLY on a run that spent its whole batch budget -- so the sweep
	// breaks exactly when the ledger is overloaded and stays broken every tick
	// until the backlog drains below the ceiling by itself.
	//
	// Both directions are asserted. Too FEW parameters is `there is no parameter
	// $n`; too many is the 08P01 above. Neither is a type error and neither shows
	// up in any plan.
	it("binds exactly as many parameters as each statement has placeholders", () => {
		const clock = reclaimClockFrom(LEDGER_NOW);
		const highestPlaceholder = (sql: string): number =>
			[...sql.matchAll(/\$(\d+)/g)].reduce(
				(max, m) => Math.max(max, Number(m[1])),
				0,
			);

		for (const statement of PUBLISHING_RECLAIM_STATEMENTS) {
			expect({
				key: statement.key,
				sql: statement.params(clock).length,
				remaining: statement.remainingParams(clock).length,
			}).toEqual({
				key: statement.key,
				sql: highestPlaceholder(statement.sql),
				remaining: highestPlaceholder(statement.remainingSql),
			});
		}

		// The positive control. A guard that only ever compares equal numbers
		// cannot distinguish "the arities match" from "both sides read the same
		// field", and reading the same field is precisely the defect this replaces.
		expect(
			PUBLISHING_RECLAIM_STATEMENTS.map((s) => [
				highestPlaceholder(s.sql),
				highestPlaceholder(s.remainingSql),
			]),
		).toEqual([
			[1, 1],
			[2, 1],
		]);
	});
});

/**
 * EXPLAIN the sweep's REAL statement -- the same string
 * reclaimPublishingDeliveryStates executes -- and return the plan as text for
 * shape assertions.
 *
 * GENERIC_PLAN, and NO bind values, and both halves are load-bearing:
 *
 *   - Without GENERIC_PLAN, a statement containing $1 fails outright:
 *     `42P02: there is no parameter $1`. EXPLAIN is a utility statement, so the
 *     outer statement's parse analysis does not descend into the SQL being
 *     explained; the inner markers are analysed later, inside ExplainQuery(),
 *     precisely because GENERIC_PLAN was requested.
 *   - PASSING VALUES SILENTLY DEFEATS IT. Measured against this repo's own
 *     client (prisma-client engine over @prisma/adapter-pg) on postgres:16: the
 *     same GENERIC_PLAN request with two values supplied plans as
 *     `Limit -> Index Scan`, while with zero values it plans as
 *     `Limit -> Sort -> Seq Scan`. Add an argument here "to be safe" and every
 *     negative control below goes green while proving nothing.
 *
 * This is also strictly stronger than an ordinary EXPLAIN: it proves the plan
 * holds even when PostgreSQL has no parameter values in hand, which is the
 * situation the whole literal-status requirement is about.
 */
async function explainGeneric(sql: string): Promise<string> {
	return JSON.stringify(
		await db.$queryRawUnsafe(
			`EXPLAIN (GENERIC_PLAN, COSTS OFF, FORMAT JSON) ${sql}`,
		),
	);
}

const SEQ_SCAN = /"Node Type":\s*"Seq Scan"/;
const ANY_SORT = /"Node Type":\s*"(Incremental )?Sort"/;

/**
 * The index each statement's CANDIDATE PAGE must reach. Named rather than left
 * as "some index": "an index was used" is not the property anyone cares about,
 * because the whole literal-status requirement exists to keep THESE two
 * reachable and a plan that fell back to a different one would still satisfy
 * "no Seq Scan".
 */
const SERVING_INDEX: Record<ReclaimStatementKey, string> = {
	EXPIRE_DEFERRED: "publishing_notification_delivery_deferred_drain_idx",
	RECONCILE_SENDING: "publishing_notification_delivery_sending_lease_idx",
};

/**
 * The OUTER update node is allowed to use the primary key, and that is a
 * correction to what 1C-2d-2a's carried plan-shape table records.
 *
 * That table says the outer node for both statements is the partial index --
 * "re-measured under EXPLAIN (COSTS OFF, ANALYZE, BUFFERS) with the fixture
 * verified loaded first", explicitly correcting an earlier draft that had
 * claimed the primary key. Measured here under GENERIC_PLAN against the same
 * shipped schema and a loaded, ANALYZEd fixture, the outer node is
 * `..._pkey`, reached through `id = ANY ($0)`.
 *
 * BOTH READINGS ARE RIGHT, AND THE DIFFERENCE IS THE EXPLAIN MODE. A custom plan
 * has the page's values in hand; a generic plan does not, and with no values to
 * estimate from it prices the primary-key lookup over an array of at most
 * PUBLISHING_RECLAIM_BATCH_SIZE ids below a second walk of the partial index.
 * Nothing about the bound changes -- the outer node is scanning 100 ids by
 * primary key either way -- so this suite pins the property that matters (the
 * PAGE reaches its partial index, nothing reaches anything else, no Seq Scan and
 * no Sort) rather than a node assignment that moves with the plan mode.
 */
const PRIMARY_KEY = "publishing_notification_delivery_pkey";

describe("plan shape of the sweep's real ledger SQL", () => {
	for (const statement of PUBLISHING_RECLAIM_STATEMENTS) {
		it.skipIf(!RUN_DB)(
			`${statement.key} reaches its partial index with no sequential scan and no sort`,
			async () => {
				const plan = await explainGeneric(statement.sql);
				// The candidate page reaches its partial index, and NOTHING in the
				// plan reaches any index other than that one or the primary key.
				const used = [
					...plan.matchAll(/"Index Name":\s*"([^"]+)"/g),
				].map((m) => m[1]);
				expect(used).toContain(SERVING_INDEX[statement.key]);
				expect(
					used.filter(
						(name) =>
							name !== SERVING_INDEX[statement.key] &&
							name !== PRIMARY_KEY,
					),
				).toEqual([]);
				// THE LITERAL-VS-BIND RULE, PAYING OUT VISIBLY. `status` never
				// appears in an Index Cond: it is IMPLIED by the partial index's
				// own predicate and dropped by the planner, which is precisely
				// what it cannot do for `= $n`. If it ever shows up here, the
				// index being reached is not the partial one.
				for (const cond of [
					...plan.matchAll(/"Index Cond":\s*"([^"]*)"/g),
				].map((m) => m[1])) {
					expect(cond).not.toContain("status");
				}
				// No Seq Scan anywhere in the plan -- not in the page, and not in
				// the update's own node. The `IN (SELECT ...)` form this statement
				// deliberately avoids fails HERE, on the outer node, while its
				// inner page still looks correct.
				expect(plan).not.toMatch(SEQ_SCAN);
				// Rejecting only Seq Scan would accept Sort -> Bitmap Heap Scan,
				// which uses the index and is still unbounded: a bitmap scan cannot
				// preserve index order, so the whole matching backlog is
				// materialized and sorted before the LIMIT applies. That is exactly
				// the shape the DEFERRED-at-bound statement has, and exactly why it
				// is not in this slice (Decision 35).
				expect(plan).not.toMatch(ANY_SORT);
			},
		);
	}
});

// The requirement 1C-2d-1b handed forward with no enforcement, enforced.
//
// A partial index is usable only where the query's predicate provably IMPLIES
// the index predicate. A generic plan has no parameter value to reason from, so
// `status = $n` cannot imply `status = 'DEFERRED'` and BOTH partial indexes
// leave the planner's search space at once.
//
// Asserted with EXPLAIN (GENERIC_PLAN) rather than by counting EXECUTEs,
// deliberately: `plan_cache_mode = auto` does not switch to the generic plan
// today because it costs far more, but that is a COST heuristic that moves with
// row counts, and a test pinned to it would be flaky by construction. The
// generic plan's shape is structural.
//
// PARAMETER NUMBERING IS CONTIGUOUS, AND THAT IS NOT A STYLE CHOICE. The status
// markers start immediately after the statement's own parameters, so the
// rewritten statement declares $1..$n with no gaps. Numbering them from a fixed
// high number instead leaves the intervening numbers declared by nothing, and
// PostgreSQL refuses the statement at PARSE time -- `could not determine data
// type of parameter $3`, measured on postgres:16. The case would then fail with
// a database error instead of asserting anything, and "the negative control is
// red" would be true for entirely the wrong reason.
function parameterizeStatuses(statement: ReclaimStatement): string {
	let next = statement.params({
		now: new Date(),
		leaseCutoff: new Date(),
	}).length;
	return statement.sql.replaceAll(
		/"status" = '[A-Z_]+'/g,
		() => `"status" = $${++next}`,
	);
}

it.skipIf(!RUN_DB)(
	"loses the partial index on every ledger statement if the status arrives as a bind parameter",
	async () => {
		for (const statement of PUBLISHING_RECLAIM_STATEMENTS) {
			const plan = await explainGeneric(parameterizeStatuses(statement));
			expect(
				SEQ_SCAN.test(plan),
				`${statement.key} still reached an index with a parameterized status -- the literal requirement is no longer what makes the plan bounded, and this suite no longer proves anything`,
			).toBe(true);
		}
	},
);

/**
 * Plan the SAME parameterized statement as a CUSTOM plan.
 *
 * PREPARE is session state, so this runs inside an interactive transaction --
 * Prisma pins one connection for the callback's lifetime, and a pooled
 * $queryRawUnsafe would not reach the same backend.
 *
 * The values are interpolated into the EXECUTE rather than bound: EXPLAIN is a
 * utility statement and does not accept outer bind parameters. They are
 * test-owned literals, never caller input.
 */
async function explainCustomAndForcedGeneric(
	name: string,
	declaredTypes: string,
	sql: string,
	executeArgs: string,
): Promise<{ custom: string; generic: string }> {
	return db.$transaction(async (tx) => {
		await tx.$executeRawUnsafe(
			`PREPARE ${name} (${declaredTypes}) AS ${sql}`,
		);
		const custom = JSON.stringify(
			await tx.$queryRawUnsafe(
				`EXPLAIN (COSTS OFF, FORMAT JSON) EXECUTE ${name}(${executeArgs})`,
			),
		);
		// The ONE variable. Same statement, same values, same session.
		await tx.$executeRawUnsafe(
			"SET LOCAL plan_cache_mode = force_generic_plan",
		);
		const generic = JSON.stringify(
			await tx.$queryRawUnsafe(
				`EXPLAIN (COSTS OFF, FORMAT JSON) EXECUTE ${name}(${executeArgs})`,
			),
		);
		await tx.$executeRawUnsafe(`DEALLOCATE ${name}`);
		return { custom, generic };
	});
}

// Per-statement declared parameter lists and EXECUTE arguments, in the order
// `parameterizeStatuses` produces: the statement's own timestamps first, then
// one text marker per `"status" = '...'` occurrence, in textual order.
//
// EXPIRE_DEFERRED has THREE markers -- the SET clause, the inner predicate and
// the re-asserted outer predicate. RECONCILE_SENDING has TWO: it writes its
// statuses inside `CASE ... THEN '...'`, which the `"status" = '...'` pattern
// does not match at all, so only its two predicate occurrences are rewritten.
const META: Record<ReclaimStatementKey, { types: string; args: string }> = {
	EXPIRE_DEFERRED: {
		types: "timestamp, text, text, text",
		args: "timestamp '2026-09-01 12:00:00', 'EXPIRED', 'DEFERRED', 'DEFERRED'",
	},
	RECONCILE_SENDING: {
		types: "timestamp, timestamp, text, text",
		args: "timestamp '2026-09-01 11:55:00', timestamp '2026-09-01 12:00:00', 'SENDING', 'SENDING'",
	},
};

it.skipIf(!RUN_DB)(
	"is sensitive to generic-vs-custom planning: the same ledger statement reaches its index with values in hand and loses it without",
	async () => {
		for (const [
			index,
			statement,
		] of PUBLISHING_RECLAIM_STATEMENTS.entries()) {
			const meta = META[statement.key];
			const { custom, generic } = await explainCustomAndForcedGeneric(
				// Derived from the fixture's own RUN and the statement's position,
				// not from a random number: a PREPARE name has to be unique within
				// the session, and a random one makes a failure impossible to
				// correlate with the statement that produced it.
				`meta_${RUN}_${index}`,
				meta.types,
				parameterizeStatuses(statement),
				meta.args,
			);
			// If THIS goes red the rewrite itself is broken, and the negative
			// control above is red for a reason that has nothing to do with partial
			// indexes.
			expect(
				SEQ_SCAN.test(custom),
				`${statement.key}: a CUSTOM plan of the parameterized statement fell back to a sequential scan, so the negative control's redness is not attributable to generic planning`,
			).toBe(false);
			expect(
				SEQ_SCAN.test(generic),
				`${statement.key}: forcing the generic plan did NOT cost the index, so this harness cannot tell the two apart and proves nothing`,
			).toBe(true);
		}
	},
);

// The four instants the behaviour cases below compare against, all derived from
// LEDGER_NOW so a change to the lease budget moves them together. They live here
// rather than beside LEDGER_NOW because this is where they are read.
const LEDGER_DEAD_LEASE_AT = new Date(
	LEDGER_NOW.getTime() - PUBLISHING_EMAIL_LEASE_MS - 1_000,
);
const LEDGER_LIVE_LEASE_AT = new Date(LEDGER_NOW.getTime() - 1_000);
/**
 * Dead under any clock the cases below use, not merely under LEDGER_NOW.
 *
 * `leaseCutoff` is derived from the sweep's own `now`, so a lease that is
 * one second past the budget is dead only relative to THAT clock -- move the
 * clock back two minutes and the same row reads as live. The two-clock cases
 * need a row that is a candidate under both, or they measure the candidate
 * predicate instead of the arms they are about.
 */
const LEDGER_LONG_DEAD_LEASE_AT = new Date(LEDGER_NOW.getTime() - 60 * 60_000);
const LEDGER_PAST_EXPIRY = new Date(LEDGER_NOW.getTime() - 60_000);
const LEDGER_FUTURE_EXPIRY = new Date(
	LEDGER_NOW.getTime() + 14 * 24 * 60 * 60_000,
);

/** `seedRowForCycle` bound to the ledger fixture's cycle. */
function seedRow(
	tx: Prisma.TransactionClient,
	row: {
		status: string;
		expiresAt: Date | null;
		attemptCount: number;
		claimedAt?: Date | null;
		claimToken?: string | null;
	},
): Promise<string> {
	return seedRowForCycle(tx, CYCLE_ID, row);
}

// Every case runs inside a transaction that is rolled back. The sweep's
// statements are deliberately GLOBAL -- they carry no cycle or project predicate
// -- so a case that committed would move the plan-shape fixture's 10,000 rows
// too and make this file order-dependent. Rolling back gives each case the whole
// ledger to itself and needs no teardown; it also exercises the `client`
// parameter the executor accepts.
describe("pass 1 leaves no ledger state stranded", () => {
	it.skipIf(!RUN_DB)(
		"terminalizes a DEFERRED row past its expiry to EXPIRED and keeps expiresAt",
		async () => {
			await inRolledBackTransaction(async (tx) => {
				const id = await seedRow(tx, {
					status: "DEFERRED",
					expiresAt: LEDGER_PAST_EXPIRY,
					attemptCount: 1,
				});
				await reclaimPublishingDeliveryStates({ now: LEDGER_NOW }, tx);
				const row = await readRow(tx, id);
				expect(row.status).toBe("EXPIRED");
				expect(row.reason).toBe(PUBLISHING_RECLAIM_REASON_EXPIRED);
				// expiresAt is deliberately NOT cleared on EXPIRED -- the value is
				// the audit trail for why the row terminalized.
				expect(row.expiresAt).not.toBeNull();
			});
		},
	);

	it.skipIf(!RUN_DB)(
		"leaves a DEFERRED row inside its expiry alone",
		async () => {
			await inRolledBackTransaction(async (tx) => {
				const id = await seedRow(tx, {
					status: "DEFERRED",
					expiresAt: LEDGER_FUTURE_EXPIRY,
					attemptCount: 1,
				});
				await reclaimPublishingDeliveryStates({ now: LEDGER_NOW }, tx);
				const row = await readRow(tx, id);
				expect(row.status).toBe("DEFERRED");
				expect(row.reason).toBeNull();
			});
		},
	);

	it.skipIf(!RUN_DB)(
		"terminalizes an expired SENDING row with a dead lease to EXPIRED rather than reclaiming it forever",
		async () => {
			await inRolledBackTransaction(async (tx) => {
				const id = await seedRow(tx, {
					status: "SENDING",
					expiresAt: LEDGER_PAST_EXPIRY,
					attemptCount: 1,
					claimedAt: LEDGER_DEAD_LEASE_AT,
					claimToken: "case-token",
				});
				await reclaimPublishingDeliveryStates({ now: LEDGER_NOW }, tx);
				const row = await readRow(tx, id);
				// EXPIRED, not DEFERRED. If the reclaim arm ran before the expiry
				// arm this row would be DEFERRED here and would only expire on a
				// later run.
				expect(row.status).toBe("EXPIRED");
				expect(row.reason).toBe(PUBLISHING_RECLAIM_REASON_EXPIRED);
				expect(row.claimedAt).toBeNull();
				expect(row.claimToken).toBeNull();
			});
		},
	);

	it.skipIf(!RUN_DB)(
		"leaves an expired SENDING row with a LIVE lease alone",
		async () => {
			await inRolledBackTransaction(async (tx) => {
				const id = await seedRow(tx, {
					status: "SENDING",
					expiresAt: LEDGER_PAST_EXPIRY,
					attemptCount: 1,
					claimedAt: LEDGER_LIVE_LEASE_AT,
					claimToken: "case-token",
				});
				await reclaimPublishingDeliveryStates({ now: LEDGER_NOW }, tx);
				const row = await readRow(tx, id);
				// A live lease means a send is plausibly mid-provider-call.
				// Terminalizing it to EXPIRED would record a delivery that happened
				// as one that did not. It waits at most one lease length, which is
				// negligible against a 14-day deferral.
				expect(row.status).toBe("SENDING");
				expect(row.claimToken).toBe("case-token");
			});
		},
	);

	it.skipIf(!RUN_DB)(
		"returns a dead-leased SENDING row under the bound to DEFERRED with the lease cleared",
		async () => {
			await inRolledBackTransaction(async (tx) => {
				const id = await seedRow(tx, {
					status: "SENDING",
					expiresAt: LEDGER_FUTURE_EXPIRY,
					attemptCount: PUBLISHING_DELIVERY_ATTEMPT_BOUND - 1,
					claimedAt: LEDGER_DEAD_LEASE_AT,
					claimToken: "case-token",
				});
				await reclaimPublishingDeliveryStates({ now: LEDGER_NOW }, tx);
				const row = await readRow(tx, id);
				// Crash-after-claim: the worker died holding the lease. The row
				// comes back live, and the reclaim leaves expiresAt and id unchanged
				// because that pair is the drain cursor's key.
				//
				// AT BOUND - 1, deliberately. The at-bound arm's condition is `>=`,
				// so this row is one attempt away from the case below and an
				// off-by-one there would fail a row that still had an attempt left.
				expect(row.status).toBe("DEFERRED");
				expect(row.reason).toBe(
					PUBLISHING_RECLAIM_REASON_LEASE_RECLAIMED,
				);
				expect(row.claimedAt).toBeNull();
				expect(row.claimToken).toBeNull();
				expect(row.attemptCount).toBe(
					PUBLISHING_DELIVERY_ATTEMPT_BOUND - 1,
				);
				expect(row.expiresAt?.toISOString()).toBe(
					LEDGER_FUTURE_EXPIRY.toISOString(),
				);
			});
		},
	);

	it.skipIf(!RUN_DB)(
		"discharges a dead-leased SENDING row AT the attempt bound to FAILED",
		async () => {
			await inRolledBackTransaction(async (tx) => {
				const id = await seedRow(tx, {
					status: "SENDING",
					expiresAt: LEDGER_FUTURE_EXPIRY,
					attemptCount: PUBLISHING_DELIVERY_ATTEMPT_BOUND,
					claimedAt: LEDGER_DEAD_LEASE_AT,
					claimToken: "case-token",
				});
				await reclaimPublishingDeliveryStates({ now: LEDGER_NOW }, tx);
				const row = await readRow(tx, id);
				// The arm this slice adds. 1C-2d-2a left this row in SENDING with a
				// dead lease until its deadline passed -- up to the full 14 days --
				// because it had no arm to discharge it and its candidate predicate
				// excluded it outright. Both of those went with this case.
				expect(row.status).toBe("FAILED");
				expect(row.reason).toBe(
					PUBLISHING_RECLAIM_REASON_ATTEMPT_BOUND,
				);
				expect(row.claimedAt).toBeNull();
				expect(row.claimToken).toBeNull();
				// The bound is a fact the sweep READS, never one it writes.
				expect(row.attemptCount).toBe(
					PUBLISHING_DELIVERY_ATTEMPT_BOUND,
				);
			});
		},
	);

	it.skipIf(!RUN_DB)(
		"prefers EXPIRED over FAILED for a row that is BOTH past its expiry and at the bound",
		async () => {
			await inRolledBackTransaction(async (tx) => {
				const id = await seedRow(tx, {
					status: "SENDING",
					expiresAt: LEDGER_PAST_EXPIRY,
					attemptCount: PUBLISHING_DELIVERY_ATTEMPT_BOUND,
					claimedAt: LEDGER_DEAD_LEASE_AT,
					claimToken: "case-token",
				});
				await reclaimPublishingDeliveryStates({ now: LEDGER_NOW }, tx);
				const row = await readRow(tx, id);
				// THE PRECEDENCE, AS BEHAVIOUR RATHER THAN AS TEXT. This is the only
				// row in the suite matched by two arms, so it is the only one whose
				// answer the arm ORDER decides -- which is what makes the order
				// testable at all in this slice and untestable in 1C-2d-2a, where
				// two exhaustive complementary arms made both orders identical.
				//
				// Expiry is a fact about the OBLIGATION, the bound a fact about the
				// MECHANISM, and the obligation's own deadline is the one an
				// operator acting on EXPIRED reads correctly.
				expect(row.status).toBe("EXPIRED");
				expect(row.reason).toBe(PUBLISHING_RECLAIM_REASON_EXPIRED);
			});
		},
	);

	it.skipIf(!RUN_DB)(
		"leaves a LIVE-leased SENDING row at the attempt bound alone",
		async () => {
			await inRolledBackTransaction(async (tx) => {
				const id = await seedRow(tx, {
					status: "SENDING",
					expiresAt: LEDGER_FUTURE_EXPIRY,
					attemptCount: PUBLISHING_DELIVERY_ATTEMPT_BOUND,
					claimedAt: LEDGER_LIVE_LEASE_AT,
					claimToken: "case-token",
				});
				await reclaimPublishingDeliveryStates({ now: LEDGER_NOW }, tx);
				const row = await readRow(tx, id);
				// The new arm does not overtake the dead-lease requirement. A live
				// lease is a send plausibly in flight, and "we stopped trying" is
				// false while somebody is still trying.
				expect(row.status).toBe("SENDING");
				expect(row.reason).toBeNull();
				expect(row.claimToken).toBe("case-token");
			});
		},
	);

	it.skipIf(!RUN_DB)(
		"leaves a DEFERRED row at the attempt bound alone -- that discharge ships with 1C-2d-2b-2",
		async () => {
			await inRolledBackTransaction(async (tx) => {
				const id = await seedRow(tx, {
					status: "DEFERRED",
					expiresAt: LEDGER_FUTURE_EXPIRY,
					attemptCount: PUBLISHING_DELIVERY_ATTEMPT_BOUND,
				});
				await reclaimPublishingDeliveryStates({ now: LEDGER_NOW }, tx);
				const row = await readRow(tx, id);
				// A BOUNDARY ASSERTED, not an absence. The statement this row would
				// need reads and sorts the whole DEFERRED partial index, because
				// attemptCount is not one of that index's keys -- 2,800 rows read to
				// return none, measured. It ships with the claim that produces these
				// rows, which is the slice that can size an index against a real
				// backlog or discharge the row at claim-refusal time instead.
				// Re-adding it here without an index makes this case red.
				expect(row.status).toBe("DEFERRED");
				expect(row.reason).toBeNull();
			});
		},
	);

	it.skipIf(!RUN_DB)(
		"does not adopt the primary path's residue: a null-expiry SENDING row AT the attempt bound",
		async () => {
			await inRolledBackTransaction(async (tx) => {
				const id = await seedRow(tx, {
					status: "SENDING",
					expiresAt: null,
					attemptCount: PUBLISHING_DELIVERY_ATTEMPT_BOUND,
					claimedAt: LEDGER_DEAD_LEASE_AT,
					claimToken: "case-token",
				});
				await reclaimPublishingDeliveryStates({ now: LEDGER_NOW }, tx);
				const row = await readRow(tx, id);
				// A DESIGNED BOUNDARY, not a leak. The sweep drains only rows in the
				// deferral lifecycle -- the ones carrying expiresAt -- and a SENDING
				// row stranded on the PRIMARY path after retry exhaustion is not
				// adopted by it. The operator signal for this row is its CYCLE
				// reaching ABANDONED, which the cycle half above already asserts.
				//
				// Widening pass 1 to take it would extend the deferral guarantee
				// past the email-only scope the product owner set, and would record
				// a delivery nobody observed the outcome of as one that definitely
				// did not happen.
				expect(row.status).toBe("SENDING");
				expect(row.claimToken).toBe("case-token");
			});
		},
	);

	it.skipIf(!RUN_DB)(
		"does not adopt the primary path's residue: a null-expiry SENDING row BELOW the attempt bound",
		async () => {
			await inRolledBackTransaction(async (tx) => {
				const id = await seedRow(tx, {
					status: "SENDING",
					expiresAt: null,
					attemptCount: PUBLISHING_DELIVERY_ATTEMPT_BOUND - 1,
					claimedAt: LEDGER_DEAD_LEASE_AT,
					claimToken: "case-token",
				});
				await reclaimPublishingDeliveryStates({ now: LEDGER_NOW }, tx);
				const row = await readRow(tx, id);
				// The case above is excluded by the null expiry AND would be caught
				// by the at-bound arm if the expiry guard went; this one is excluded
				// by the expiry guard ALONE. A probe excluded twice cannot tell you
				// which guard you deleted, which is why both exist.
				expect(row.status).toBe("SENDING");
				expect(row.claimToken).toBe("case-token");
			});
		},
	);
});

describe("what two overlapping executions can and cannot disagree about", () => {
	it.skipIf(!RUN_DB)(
		"reaches a DIFFERENT terminal state for an at-bound row depending on which clock classified it",
		async () => {
			// DECISION 38, ASSERTED AS BEHAVIOUR. Read the decision before reading
			// this case: it looks like a test of a bug and it is not.
			//
			// 1C-2d-2a measured this row's terminal state as EXPIRED under BOTH
			// acquisition orders. That agreement was bought by the candidate
			// exclusion `("expiresAt" <= now OR "attemptCount" < bound)`, which made
			// the earlier clock skip the row entirely -- it was neither expired on
			// that clock nor under the bound. This slice DELETES that exclusion,
			// because Decisions 25/28's own hand-over requires the loosening, and
			// the row is now a candidate for both clocks.
			//
			// What differs is a LABEL, not an outcome: both states are terminal,
			// both are true of the row, and no mail is sent under either --
			// publishingEmailClaimableSql already refuses a row at the attempt
			// bound, so it was unsendable before either execution reached it.
			//
			// Asserted as two separate runs rather than as an agreement, because
			// asserting that they agree is the claim that is now false, and a case
			// that quietly stopped covering this would leave Decision 38 as prose
			// nothing checks.
			const shape = {
				status: "SENDING",
				expiresAt: LEDGER_PAST_EXPIRY,
				attemptCount: PUBLISHING_DELIVERY_ATTEMPT_BOUND,
				// LONG dead, not LEDGER_DEAD_LEASE_AT. The lease cutoff is derived
				// from the sweep's own `now`, so "dead lease" is CLOCK-RELATIVE: a
				// row one second past the budget on the later clock is still inside
				// it on the earlier one, and the earlier run would then skip the row
				// for the wrong reason -- the case would report a divergence that
				// was really the candidate predicate. An hour is dead under both.
				claimedAt: LEDGER_LONG_DEAD_LEASE_AT,
				claimToken: "case-token",
			};
			// A clock EARLIER than the row's own expiry: the expiry arm is false,
			// so the at-bound arm decides.
			const earlier = new Date(LEDGER_PAST_EXPIRY.getTime() - 60_000);

			await inRolledBackTransaction(async (tx) => {
				const id = await seedRow(tx, shape);
				await reclaimPublishingDeliveryStates({ now: earlier }, tx);
				const row = await readRow(tx, id);
				expect(row.status).toBe("FAILED");
				expect(row.reason).toBe(
					PUBLISHING_RECLAIM_REASON_ATTEMPT_BOUND,
				);
			});

			await inRolledBackTransaction(async (tx) => {
				const id = await seedRow(tx, shape);
				await reclaimPublishingDeliveryStates({ now: LEDGER_NOW }, tx);
				const row = await readRow(tx, id);
				expect(row.status).toBe("EXPIRED");
				expect(row.reason).toBe(PUBLISHING_RECLAIM_REASON_EXPIRED);
			});
		},
	);

	it.skipIf(!RUN_DB)(
		"agrees about a row that is not at the bound, whichever clock classifies it",
		async () => {
			// The control for the case above, and the reason it is not simply "the
			// sweep is clock-dependent". A row under the attempt bound has exactly
			// one arm that can match on each side of its expiry, so the two clocks
			// disagree about WHEN and never about WHAT. Deleting the at-bound arm
			// would make the previous case red and leave this one green, which is
			// how the two together locate the divergence rather than merely
			// reporting it.
			const shape = {
				status: "SENDING",
				expiresAt: LEDGER_PAST_EXPIRY,
				attemptCount: PUBLISHING_DELIVERY_ATTEMPT_BOUND - 1,
				// LONG dead, not LEDGER_DEAD_LEASE_AT. The lease cutoff is derived
				// from the sweep's own `now`, so "dead lease" is CLOCK-RELATIVE: a
				// row exactly one second past the budget on the later clock is still
				// inside it on the earlier one, and the earlier run would then skip
				// the row for the wrong reason and the case would prove nothing
				// about arms. An hour is dead under both.
				claimedAt: LEDGER_LONG_DEAD_LEASE_AT,
				claimToken: "case-token",
			};
			const earlier = new Date(LEDGER_PAST_EXPIRY.getTime() - 60_000);

			await inRolledBackTransaction(async (tx) => {
				const id = await seedRow(tx, shape);
				await reclaimPublishingDeliveryStates({ now: earlier }, tx);
				const row = await readRow(tx, id);
				// Not yet expired on this clock, so it is reclaimed for another try.
				expect(row.status).toBe("DEFERRED");
				expect(row.reason).toBe(
					PUBLISHING_RECLAIM_REASON_LEASE_RECLAIMED,
				);
			});

			await inRolledBackTransaction(async (tx) => {
				const id = await seedRow(tx, shape);
				await reclaimPublishingDeliveryStates({ now: LEDGER_NOW }, tx);
				const row = await readRow(tx, id);
				// Expired on this one. The next tick's EXPIRE_DEFERRED would have
				// taken the row above here anyway: convergence, one tick apart.
				expect(row.status).toBe("EXPIRED");
				expect(row.reason).toBe(PUBLISHING_RECLAIM_REASON_EXPIRED);
			});
		},
	);
});

describe("pass 1 is order-independent by construction", () => {
	// Run the two statements forwards and backwards over one probe set covering
	// every reachable shape, and require the same fixed point. This is stronger
	// than the ordering assertion it replaces: that one promised a correct
	// outcome GIVEN an order, this promises the same outcome given any order.
	//
	// With the SENDING side merged the property is nearly trivial for ONE clock
	// -- two statements disjoint on `status` cannot interact at all -- and that is
	// the point rather than a weakness: the previous design needed this test
	// because its disjointness was an argument about an `expiresAt` comparison,
	// and an argument is what an earlier review round falsified. Keep the test; it
	// is what turns a re-split of the SENDING side into a red run rather than a
	// silent regression.
	//
	// It drives the statements directly rather than through
	// reclaimPublishingDeliveryStates, because order-independence is a property of
	// the STATEMENTS and the executor should not grow a test-only parameter to
	// expose it.
	async function runInOrder(
		tx: Prisma.TransactionClient,
		statements: readonly ReclaimStatement[],
	): Promise<void> {
		const clock = {
			now: LEDGER_NOW,
			leaseCutoff: new Date(
				LEDGER_NOW.getTime() - PUBLISHING_EMAIL_LEASE_MS,
			),
		};
		// EACH STATEMENT RUNS TO EXHAUSTION, not once, and that is not a stylistic
		// echo of the executor. The plan-shape fixture this file shares carries 200
		// DEFERRED rows already past expiry and 280 dead-leased SENDING rows, and
		// every one of them sorts AHEAD of these probes -- the fixture's expiries
		// are a day old against the probes' minute, its claims an hour old against
		// their five. A single 100-row page is therefore entirely fixture, the
		// probes are never reached, and the comparison then holds two identical
		// sets of UNTOUCHED rows and reports order-independence. Green for exactly
		// the wrong reason, which is how it was caught: the fixed-point pin below
		// showed every probe unchanged.
		for (const statement of statements) {
			for (let run = 0; run < PUBLISHING_RECLAIM_MAX_BATCHES; run += 1) {
				const moved = (await tx.$queryRawUnsafe(
					statement.sql,
					...statement.params(clock),
				)) as unknown[];
				if (moved.length < PUBLISHING_RECLAIM_BATCH_SIZE) {
					break;
				}
			}
		}
	}

	// ANNOTATED RATHER THAN INFERRED. Without the annotation the literal widens to
	// a UNION of eleven object types, and `probe.claimedAt` is then a property
	// error on the seven members that omit it -- which vitest's transform does not
	// see and `tsc --noEmit` does. Read it as the seed helper's argument type,
	// which is what it is.
	const PROBES: ReadonlyArray<{
		label: string;
		status: string;
		expiresAt: Date | null;
		attemptCount: number;
		claimedAt?: Date;
		claimToken?: string;
	}> = [
		{
			label: "deferred past expiry",
			status: "DEFERRED",
			expiresAt: LEDGER_PAST_EXPIRY,
			attemptCount: 1,
		},
		{
			label: "deferred inside expiry",
			status: "DEFERRED",
			expiresAt: LEDGER_FUTURE_EXPIRY,
			attemptCount: 1,
		},
		{
			label: "deferred at bound",
			status: "DEFERRED",
			expiresAt: LEDGER_FUTURE_EXPIRY,
			attemptCount: PUBLISHING_DELIVERY_ATTEMPT_BOUND,
		},
		{
			label: "sending past expiry, dead lease",
			status: "SENDING",
			expiresAt: LEDGER_PAST_EXPIRY,
			attemptCount: 1,
			claimedAt: LEDGER_DEAD_LEASE_AT,
			claimToken: "t",
		},
		{
			label: "sending past expiry, live lease",
			status: "SENDING",
			expiresAt: LEDGER_PAST_EXPIRY,
			attemptCount: 1,
			claimedAt: LEDGER_LIVE_LEASE_AT,
			claimToken: "t",
		},
		{
			label: "sending inside expiry, dead lease, under bound",
			status: "SENDING",
			expiresAt: LEDGER_FUTURE_EXPIRY,
			attemptCount: PUBLISHING_DELIVERY_ATTEMPT_BOUND - 1,
			claimedAt: LEDGER_DEAD_LEASE_AT,
			claimToken: "t",
		},
		{
			label: "sending inside expiry, dead lease, at bound",
			status: "SENDING",
			expiresAt: LEDGER_FUTURE_EXPIRY,
			attemptCount: PUBLISHING_DELIVERY_ATTEMPT_BOUND,
			claimedAt: LEDGER_DEAD_LEASE_AT,
			claimToken: "t",
		},
		{
			label: "sending PAST expiry, dead lease, at bound",
			status: "SENDING",
			expiresAt: LEDGER_PAST_EXPIRY,
			attemptCount: PUBLISHING_DELIVERY_ATTEMPT_BOUND,
			claimedAt: LEDGER_DEAD_LEASE_AT,
			claimToken: "t",
		},
		{
			label: "sending null expiry, dead lease, at bound",
			status: "SENDING",
			expiresAt: null,
			attemptCount: PUBLISHING_DELIVERY_ATTEMPT_BOUND,
			claimedAt: LEDGER_DEAD_LEASE_AT,
			claimToken: "t",
		},
		{
			label: "sending null expiry, dead lease, under bound",
			status: "SENDING",
			expiresAt: null,
			attemptCount: 1,
			claimedAt: LEDGER_DEAD_LEASE_AT,
			claimToken: "t",
		},
		{
			label: "sending inside expiry, live lease",
			status: "SENDING",
			expiresAt: LEDGER_FUTURE_EXPIRY,
			attemptCount: 1,
			claimedAt: LEDGER_LIVE_LEASE_AT,
			claimToken: "t",
		},
	];

	async function sweepProbes(
		statements: readonly ReclaimStatement[],
	): Promise<
		Array<{
			label: string;
			status: string;
			reason: string | null;
			leaseCleared: boolean;
		}>
	> {
		return inRolledBackTransaction(async (tx) => {
			const seeded: Array<{ label: string; id: string }> = [];
			for (const probe of PROBES) {
				seeded.push({
					label: probe.label,
					id: await seedRow(tx, {
						status: probe.status,
						expiresAt: probe.expiresAt,
						attemptCount: probe.attemptCount,
						claimedAt: probe.claimedAt ?? null,
						claimToken: probe.claimToken ?? null,
					}),
				});
			}
			await runInOrder(tx, statements);
			const out: Array<{
				label: string;
				status: string;
				reason: string | null;
				leaseCleared: boolean;
			}> = [];
			for (const { label, id } of seeded) {
				const row = await readRow(tx, id);
				out.push({
					label,
					status: row.status,
					reason: row.reason,
					// CARRIED FROM THE ORIGINAL BASELINE because it caught a real
					// regression once: a first cut of the merge kept the lease on
					// the EXPIRED arm as provenance, and 1C-2c's shipped case
					// asserting that a terminalized row releases its lease would
					// have gone red. A shipped case going red is a regression, not
					// a stale test.
					leaseCleared: row.claimToken === null,
				});
			}
			return out;
		});
	}

	it.skipIf(!RUN_DB)(
		"reaches the same fixed point whatever order the statements run in",
		async () => {
			const forwards = await sweepProbes(PUBLISHING_RECLAIM_STATEMENTS);
			const backwards = await sweepProbes(
				[...PUBLISHING_RECLAIM_STATEMENTS].reverse(),
			);
			expect(backwards).toEqual(forwards);
			// And pin the fixed point itself, so "identical" cannot become
			// "identically wrong".
			expect(forwards).toEqual([
				{
					label: "deferred past expiry",
					status: "EXPIRED",
					reason: PUBLISHING_RECLAIM_REASON_EXPIRED,
					leaseCleared: true,
				},
				{
					label: "deferred inside expiry",
					status: "DEFERRED",
					reason: null,
					leaseCleared: true,
				},
				{
					label: "deferred at bound",
					status: "DEFERRED",
					reason: null,
					leaseCleared: true,
				},
				{
					label: "sending past expiry, dead lease",
					status: "EXPIRED",
					reason: PUBLISHING_RECLAIM_REASON_EXPIRED,
					leaseCleared: true,
				},
				{
					label: "sending past expiry, live lease",
					status: "SENDING",
					reason: null,
					leaseCleared: false,
				},
				{
					label: "sending inside expiry, dead lease, under bound",
					status: "DEFERRED",
					reason: PUBLISHING_RECLAIM_REASON_LEASE_RECLAIMED,
					leaseCleared: true,
				},
				{
					// THE ONE CELL THIS SLICE MOVED. 1C-2d-2a read SENDING / null
					// here, because its candidate predicate excluded an at-bound row
					// still inside its expiry and it had no arm to discharge one.
					label: "sending inside expiry, dead lease, at bound",
					status: "FAILED",
					reason: PUBLISHING_RECLAIM_REASON_ATTEMPT_BOUND,
					leaseCleared: true,
				},
				{
					label: "sending PAST expiry, dead lease, at bound",
					status: "EXPIRED",
					reason: PUBLISHING_RECLAIM_REASON_EXPIRED,
					leaseCleared: true,
				},
				{
					label: "sending null expiry, dead lease, at bound",
					status: "SENDING",
					reason: null,
					leaseCleared: false,
				},
				{
					label: "sending null expiry, dead lease, under bound",
					status: "SENDING",
					reason: null,
					leaseCleared: false,
				},
				{
					label: "sending inside expiry, live lease",
					status: "SENDING",
					reason: null,
					leaseCleared: false,
				},
			]);
		},
	);

	// THE PROPERTY ONE CLOCK CANNOT EXPRESS: two EXECUTIONS, not two statement
	// orders. Every execution captures its own `now` (the activity reads the
	// clock, not the workflow), a manual run may overlap the scheduled one, and a
	// timed-out Temporal attempt keeps running beside its retry. A dead-leased
	// SENDING row whose expiresAt falls BETWEEN two captured clocks is classified
	// as a reclaim by the earlier execution and as an expiry by the later one.
	//
	// AND THE INTERMEDIATE STATE IS ASSERTED, NOT SKIPPED. An earlier draft ran a
	// synthetic third tick before reading anything, which erased the transient
	// DEFERRED and made the test agree with its own conclusion by construction.
	// The transient is part of the contract -- it is a row carrying an expiry
	// ALREADY PAST while sitting in a non-terminal state, which is precisely the
	// row claimPublishingEmailDelivery must refuse -- so it is pinned here, before
	// any cleanup tick, and the tick is asserted separately afterwards.
	//
	// UNDER THE BOUND, DELIBERATELY. This row has one attempt spent, so exactly
	// one arm can match on each side of its expiry and the two executions differ
	// about WHEN, never about WHAT. The at-bound row that differs about WHAT is
	// the Decision 38 pair above; keeping them apart is what lets this case still
	// claim convergence.
	//
	// LIMIT, NAMED: this drives both interleavings on ONE connection, because a
	// rolled-back transaction cannot host two. That is sound for the OUTCOME --
	// under READ COMMITTED a blocked statement re-evaluates its WHERE against the
	// committed newer row version, which is exactly what a sequential interleaving
	// does -- and the genuinely concurrent form, two overlapping transactions with
	// the second observed blocking on the first's row lock, is the three-actor
	// case below.
	it.skipIf(!RUN_DB)(
		"pins the transient, then converges: an overlapping pair reaches the same TERMINAL state either way",
		async () => {
			const EARLIER = new Date(LEDGER_NOW.getTime() - 5 * 60_000);
			const LATER = new Date(LEDGER_NOW.getTime() + 5 * 60_000);

			async function race(
				first: Date,
				second: Date,
			): Promise<{
				afterFirst: string;
				afterBoth: string;
				afterTick: string;
			}> {
				return inRolledBackTransaction(async (tx) => {
					const id = await seedRow(tx, {
						status: "SENDING",
						// Straddles both clocks: > EARLIER, <= LATER.
						expiresAt: LEDGER_NOW,
						attemptCount: 1,
						claimedAt: LEDGER_LONG_DEAD_LEASE_AT,
						claimToken: "race-token",
					});
					await reclaimPublishingDeliveryStates({ now: first }, tx);
					// READ BETWEEN THE TWO, and that placement is the whole case.
					// The transient exists only here: the SECOND execution runs
					// EXPIRE_DEFERRED too, and takes the row the first one reclaimed
					// straight to EXPIRED. A read taken only after both executions
					// cannot see the transient at all -- it would assert convergence
					// twice while claiming to pin something else.
					const afterFirst = (await readRow(tx, id)).status;
					await reclaimPublishingDeliveryStates({ now: second }, tx);
					const afterBoth = (await readRow(tx, id)).status;
					// ONLY NOW the next scheduled tick.
					await reclaimPublishingDeliveryStates({ now: LATER }, tx);
					return {
						afterFirst,
						afterBoth,
						afterTick: (await readRow(tx, id)).status,
					};
				});
			}

			const earlierFirst = await race(EARLIER, LATER);
			const laterFirst = await race(LATER, EARLIER);

			// The transient, pinned rather than skipped. The earlier clock leaves a
			// NON-TERMINAL row whose expiry has ALREADY PASSED -- exactly the row
			// claimPublishingEmailDelivery must refuse, which is why 1C-2d-2a
			// hardened it. The later clock terminalizes immediately.
			expect(earlierFirst.afterFirst).toBe("DEFERRED");
			expect(laterFirst.afterFirst).toBe("EXPIRED");

			// And the pair converges within itself: whichever ran first, the second
			// execution closes the row. An interleaving may cost a tick -- for THIS
			// row it may not cost a different answer.
			expect(earlierFirst.afterBoth).toBe("EXPIRED");
			expect(laterFirst.afterBoth).toBe("EXPIRED");

			// Still terminal after another tick. Under the attempt bound EXPIRED is
			// the only state either clock can reach, and nothing moves a row out of
			// it.
			expect(earlierFirst.afterTick).toBe("EXPIRED");
			expect(laterFirst.afterTick).toBe("EXPIRED");
		},
	);
});

// ---------------------------------------------------------------------------
// WHOLE-PASS PROPERTIES. Everything above is a property of one statement, one row
// or one pair of clocks. These four are properties of the PASS: what it refuses
// to touch, what a second run costs, what it reports about its own budget, and
// which of its two defences survives a hand-written UPDATE.
// ---------------------------------------------------------------------------

describe("pass 1 is bounded, convergent and constraint-fenced", () => {
	it.skipIf(!RUN_DB)(
		"never re-queues a row in a terminal state",
		async () => {
			await inRolledBackTransaction(async (tx) => {
				// Every terminal status the shipped CHECK admits, each seeded in the
				// shape that would make it a candidate if `status` were not in the
				// predicate: past its expiry, at the attempt bound, holding a dead
				// lease. `claimToken` is asserted alongside `status` on purpose --
				// all three arms clear the lease unconditionally, so a statement
				// that matched a FAILED row and wrote FAILED back would be invisible
				// to a status-only assertion and loud in the lease pair.
				const seeded: Array<{ status: string; id: string }> = [];
				for (const status of ["SENT", "FAILED", "EXPIRED", "SKIPPED"]) {
					seeded.push({
						status,
						id: await seedRow(tx, {
							status,
							expiresAt: LEDGER_PAST_EXPIRY,
							attemptCount: PUBLISHING_DELIVERY_ATTEMPT_BOUND,
							claimedAt: LEDGER_DEAD_LEASE_AT,
							claimToken: "terminal-token",
						}),
					});
				}

				await reclaimPublishingDeliveryStates({ now: LEDGER_NOW }, tx);

				for (const { status, id } of seeded) {
					const row = await readRow(tx, id);
					expect({
						label: status,
						status: row.status,
						claimToken: row.claimToken,
					}).toEqual({
						label: status,
						status,
						claimToken: "terminal-token",
					});
				}
			});
		},
		180_000,
	);

	it.skipIf(!RUN_DB)(
		"is idempotent: a second run immediately after the first moves nothing",
		async () => {
			await inRolledBackTransaction(async (tx) => {
				await seedRow(tx, {
					status: "DEFERRED",
					expiresAt: LEDGER_PAST_EXPIRY,
					attemptCount: 1,
				});
				await seedRow(tx, {
					status: "SENDING",
					expiresAt: LEDGER_FUTURE_EXPIRY,
					attemptCount: 1,
					claimedAt: LEDGER_DEAD_LEASE_AT,
					claimToken: "case-token",
				});

				const first = await reclaimPublishingDeliveryStates(
					{ now: LEDGER_NOW },
					tx,
				);
				const second = await reclaimPublishingDeliveryStates(
					{ now: LEDGER_NOW },
					tx,
				);

				// Convergence is what makes an interrupted run safe: every state a
				// killed activity can leave behind is a state the next run's
				// predicates also match, and a settled ledger is a fixed point.
				expect(
					Object.values(first.counts).reduce((a, b) => a + b, 0),
				).toBeGreaterThan(0);
				// KEYED, not positional. The carried form asserted
				// `Object.values(second.counts)` against `[0, 0, 0]`, which reads as
				// a count of zeros and is really a count of KEYS -- it went red on
				// this slice for adding a fourth transition rather than for moving a
				// row, and a fifth would have to be added in two places to keep a
				// green run honest.
				expect(second.counts).toEqual({
					EXPIRE_DEFERRED: 0,
					EXPIRE_SENDING: 0,
					FAIL_SENDING_AT_BOUND: 0,
					RECLAIM_SENDING_LEASE: 0,
				});
				// THE SECOND RUN IS EMPTY BECAUSE THE FIRST ONE CLOSED THE WHOLE
				// LEDGER, not because it was cheap: the fixture's 200 overdue
				// DEFERRED rows and 280 dead-leased SENDING rows are inside this
				// transaction too, and this asserts the first run took all of them.
				// A first run that silently did nothing would satisfy the two
				// assertions above and fail this one.
				expect(first.counts.EXPIRE_DEFERRED).toBe(201);
				expect(
					first.counts.EXPIRE_SENDING +
						first.counts.FAIL_SENDING_AT_BOUND +
						first.counts.RECLAIM_SENDING_LEASE,
				).toBe(281);
			});
		},
		180_000,
	);

	it.skipIf(!RUN_DB)(
		"reports which transitions used their whole batch budget",
		async () => {
			await inRolledBackTransaction(async (tx) => {
				const result = await reclaimPublishingDeliveryStates(
					{ now: LEDGER_NOW },
					tx,
				);

				for (const key of Object.keys(
					result.batches,
				) as ReclaimStatementKey[]) {
					expect(result.batches[key]).toBeLessThanOrEqual(
						PUBLISHING_RECLAIM_MAX_BATCHES,
					);
				}

				// The fixture's 200 overdue DEFERRED rows and 280 dead-leased
				// SENDING rows are each more than one page of 100 and far fewer than
				// the ceiling of 20 pages, so BOTH statements must have run more than
				// one batch and both must have stopped short of the budget. The
				// arithmetic is the fixture's, and it is asserted in the idempotence
				// case above rather than restated here.
				expect(result.batches.EXPIRE_DEFERRED).toBeGreaterThan(1);
				expect(result.batches.RECONCILE_SENDING).toBeGreaterThan(1);
				expect(result.usedBatchBudget).toEqual([]);
				expect(result.moreWorkRemains).toEqual([]);
			});
		},
		180_000,
	);

	it.skipIf(!RUN_DB)(
		"lets the CHECK, not the application, reject a DEFERRED row with no expiry",
		async () => {
			// NOT inside `inRolledBackTransaction`: a failed statement aborts the
			// enclosing transaction, and the harness's own rollback would then be
			// the second error rather than the first. This case opens its own
			// transaction, expects it to abort, and seeds nothing that outlives it.
			const id = `${RUN}_shape_probe`;
			await expect(
				db.$transaction(async (tx) => {
					await tx.$executeRawUnsafe(
						`INSERT INTO "user" ("id","name","email","emailVerified","createdAt","updatedAt")
						 VALUES ($1, 'Shape Probe', $1 || '@example.com', true, now(), now())`,
						`${id}_r`,
					);
					await tx.$executeRawUnsafe(
						`INSERT INTO "publishing_notification_delivery"
						   ("id","cycleId","projectId","organizationId","userId","recipientUserId",
						    "channel","status","createdAt","claimedAt","claimToken","expiresAt","attemptCount")
						 VALUES ($1,$2,$3,$4,NULL,$5,'EMAIL','SENDING',now(),$6,'shape-token',NULL,1)`,
						id,
						CYCLE_ID,
						PROJECT_ID,
						ORG_ID,
						`${id}_r`,
						LEDGER_DEAD_LEASE_AT,
					);
					// Assert the CONSTRAINT, not merely the application path. The
					// sweep's `expiresAt IS NOT NULL` predicate is one defence and
					// this CHECK is the other, and only one of the two survives a
					// hand-written UPDATE -- which is what a migration, a backfill or
					// a console session is.
					await tx.$executeRawUnsafe(
						`UPDATE "publishing_notification_delivery" SET "status" = 'DEFERRED' WHERE "id" = $1`,
						id,
					);
				}),
			).rejects.toThrow(
				/publishing_notification_delivery_deferred_shape/,
			);
		},
		180_000,
	);
});

// ---------------------------------------------------------------------------
// THE BATCH CEILING ON THE LEDGER. The same three fixtures the cycle sweep's
// ceiling cases use, against the ledger executor rather than argued across from
// it: the two boundaries where "spent the whole budget" and "has a backlog" come
// apart, and the one where they agree.
// ---------------------------------------------------------------------------

/** 100 x 20 = 2,000 ledger rows per statement per run. */
const RECLAIM_BUDGET =
	PUBLISHING_RECLAIM_BATCH_SIZE * PUBLISHING_RECLAIM_MAX_BATCHES;

/**
 * The ledger's own residual matcher, in the shape `isResidualProbe` has for the
 * cycle sweep: matched against the statement's exported `remainingSql` rather
 * than a substring, so an edit to the probe moves this with it instead of
 * silently counting nothing.
 */
const RECLAIM_REMAINING_SQL = new Set(
	PUBLISHING_RECLAIM_STATEMENTS.map((statement) => statement.remainingSql),
);

function isReclaimResidualProbe(operation: string, args: unknown): boolean {
	if (operation !== "$queryRawUnsafe") {
		return false;
	}
	const statement = Array.isArray(args) ? args[0] : args;
	return (
		typeof statement === "string" && RECLAIM_REMAINING_SQL.has(statement)
	);
}

/** Overdue DEFERRED rows in EXISTENCE — the candidate set EXPIRE_DEFERRED sees. */
async function countOverdueDeferred(
	tx: Prisma.TransactionClient,
): Promise<number> {
	const [{ n }] = (await tx.$queryRawUnsafe(
		`SELECT count(*)::int AS n
		   FROM "publishing_notification_delivery"
		  WHERE "status" = 'DEFERRED' AND "expiresAt" <= $1`,
		LEDGER_NOW,
	)) as Array<{ n: number }>;
	return n;
}

/**
 * Top the overdue-DEFERRED population up to exactly `total`, and assert it.
 *
 * TOPPED UP RATHER THAN SEEDED FLAT, because the plan-shape fixture already
 * carries 200 overdue DEFERRED rows and the sweep has no project predicate: a
 * case that seeded 1,950 of its own would be measuring 2,150 and would drift
 * again the day the fixture changes. The assertion is the point — it is what
 * makes the page arithmetic below a fixture fact rather than a hope.
 */
async function topUpOverdueDeferred(
	tx: Prisma.TransactionClient,
	total: number,
	tag: string,
): Promise<void> {
	const existing = await countOverdueDeferred(tx);
	const needed = total - existing;
	expect(needed).toBeGreaterThan(0);

	const prefix = `${RUN}_${tag}`;
	await tx.$executeRawUnsafe(
		`INSERT INTO "user" ("id","name","email","emailVerified","createdAt","updatedAt")
		 SELECT $1 || '_u' || g, 'Ceiling Fixture ' || g, $1 || '_u' || g || '@example.com', true, now(), now()
		   FROM generate_series(1, $2) AS g`,
		prefix,
		needed,
	);
	// Two days overdue, so these sort AHEAD of the fixture's one-day-overdue tail
	// on the index's own key and the pages are this case's rows first. Not
	// load-bearing for the counts; it keeps a failure's row ids readable.
	await tx.$executeRawUnsafe(
		`INSERT INTO "publishing_notification_delivery"
		   ("id","cycleId","projectId","organizationId","userId","recipientUserId","channel","status","createdAt","expiresAt","attemptCount")
		 SELECT $1 || '_' || lpad(g::text, 6, '0'), $2, $3, $4, NULL, $1 || '_u' || g,
		        'EMAIL', 'DEFERRED', now(), $6::timestamp - interval '2 days', 1
		   FROM generate_series(1, $5) AS g`,
		prefix,
		CYCLE_ID,
		PROJECT_ID,
		ORG_ID,
		needed,
		LEDGER_NOW,
	);

	expect(await countOverdueDeferred(tx)).toBe(total);
}

describe("pass 1's batch ceiling on the ledger", () => {
	it.skipIf(!RUN_DB)(
		"MAX-1 full pages and a short final page: budget spent, nothing left",
		async () => {
			await inRolledBackTransaction(async (tx) => {
				const total =
					RECLAIM_BUDGET - PUBLISHING_RECLAIM_BATCH_SIZE / 2;
				await topUpOverdueDeferred(tx, total, "ceil_short");

				let probes = 0;
				const result = await withQueryObserver(
					async ({ operation, args, query }) => {
						if (isReclaimResidualProbe(operation, args)) {
							probes += 1;
						}
						return query(args);
					},
					() =>
						reclaimPublishingDeliveryStates(
							{ now: LEDGER_NOW },
							tx,
						),
				);

				expect(result.batches.EXPIRE_DEFERRED).toBe(
					PUBLISHING_RECLAIM_MAX_BATCHES,
				);
				expect(result.counts.EXPIRE_DEFERRED).toBe(total);
				expect(result.usedBatchBudget).toContain("EXPIRE_DEFERRED");
				// THE FIRST OF THE TWO FALSE POSITIVES the old field name produced:
				// nineteen full pages and a short twentieth spends the whole budget
				// and leaves nothing behind.
				expect(result.moreWorkRemains).not.toContain("EXPIRE_DEFERRED");
				expect(await countOverdueDeferred(tx)).toBe(0);
				// ONCE PER EXHAUSTED STATEMENT, never per batch. Counted rather than
				// described: the ledger executor asks whenever `runs === MAX`,
				// including on this short-final-page exit, and that is exactly why
				// the probe has to be a query rather than an inference.
				expect(probes).toBe(1);
			});
		},
		180_000,
	);

	it.skipIf(!RUN_DB)(
		"exactly MAX full pages, nothing left: budget spent, still no backlog",
		async () => {
			await inRolledBackTransaction(async (tx) => {
				await topUpOverdueDeferred(tx, RECLAIM_BUDGET, "ceil_exact");

				const result = await reclaimPublishingDeliveryStates(
					{ now: LEDGER_NOW },
					tx,
				);

				expect(result.batches.EXPIRE_DEFERRED).toBe(
					PUBLISHING_RECLAIM_MAX_BATCHES,
				);
				expect(result.counts.EXPIRE_DEFERRED).toBe(RECLAIM_BUDGET);
				expect(result.usedBatchBudget).toContain("EXPIRE_DEFERRED");
				// THE SECOND FALSE POSITIVE, and the harder one: an exactly-full
				// backlog drained to empty reads as `runs === MAX` too, and only the
				// probe can tell it from a real backlog.
				expect(result.moreWorkRemains).not.toContain("EXPIRE_DEFERRED");
				expect(await countOverdueDeferred(tx)).toBe(0);
			});
		},
		180_000,
	);

	it.skipIf(!RUN_DB)(
		"MAX full pages with work remaining: the probe, not the batch count, says so",
		async () => {
			await inRolledBackTransaction(async (tx) => {
				const total = RECLAIM_BUDGET + PUBLISHING_RECLAIM_BATCH_SIZE;
				await topUpOverdueDeferred(tx, total, "ceil_backlog");

				const result = await reclaimPublishingDeliveryStates(
					{ now: LEDGER_NOW },
					tx,
				);

				expect(result.batches.EXPIRE_DEFERRED).toBe(
					PUBLISHING_RECLAIM_MAX_BATCHES,
				);
				expect(result.counts.EXPIRE_DEFERRED).toBe(RECLAIM_BUDGET);
				expect(result.usedBatchBudget).toContain("EXPIRE_DEFERRED");
				expect(result.moreWorkRemains).toContain("EXPIRE_DEFERRED");
				// The 100 the budget could not reach, still overdue and still
				// DEFERRED. Without this the case would pass on an executor that
				// reported a backlog it had actually drained.
				expect(await countOverdueDeferred(tx)).toBe(
					PUBLISHING_RECLAIM_BATCH_SIZE,
				);
			});
		},
		180_000,
	);
});

/** Dead-leased SENDING rows with an expiry — the candidate set RECONCILE_SENDING sees. */
async function countReclaimableSending(
	tx: Prisma.TransactionClient,
): Promise<number> {
	const [{ n }] = (await tx.$queryRawUnsafe(
		`SELECT count(*)::int AS n
		   FROM "publishing_notification_delivery"
		  WHERE "status" = 'SENDING' AND "claimedAt" < $1 AND "expiresAt" IS NOT NULL`,
		new Date(LEDGER_NOW.getTime() - PUBLISHING_EMAIL_LEASE_MS),
	)) as Array<{ n: number }>;
	return n;
}

/** `topUpOverdueDeferred`'s sibling for the other statement. */
async function topUpDeadLeasedSending(
	tx: Prisma.TransactionClient,
	total: number,
	tag: string,
): Promise<void> {
	const existing = await countReclaimableSending(tx);
	const needed = total - existing;
	expect(needed).toBeGreaterThan(0);

	const prefix = `${RUN}_${tag}`;
	await tx.$executeRawUnsafe(
		`INSERT INTO "user" ("id","name","email","emailVerified","createdAt","updatedAt")
		 SELECT $1 || '_u' || g, 'Sending Ceiling ' || g, $1 || '_u' || g || '@example.com', true, now(), now()
		   FROM generate_series(1, $2) AS g`,
		prefix,
		needed,
	);
	await tx.$executeRawUnsafe(
		`INSERT INTO "publishing_notification_delivery"
		   ("id","cycleId","projectId","organizationId","userId","recipientUserId","channel","status","createdAt","claimedAt","claimToken","expiresAt","attemptCount")
		 SELECT $1 || '_' || lpad(g::text, 6, '0'), $2, $3, $4, NULL, $1 || '_u' || g,
		        'EMAIL', 'SENDING', now(), $6::timestamp - interval '1 hour', $1 || '_tok_' || g,
		        $6::timestamp + interval '10 days', 1
		   FROM generate_series(1, $5) AS g`,
		prefix,
		CYCLE_ID,
		PROJECT_ID,
		ORG_ID,
		needed,
		LEDGER_NOW,
	);

	expect(await countReclaimableSending(tx)).toBe(total);
}

describe("pass 1's batch ceiling on the OTHER statement", () => {
	// THE CASE THE THREE ABOVE COULD NOT SUBSTITUTE FOR, and the reason it is its
	// own describe rather than a fourth sibling: every ceiling case above drives
	// EXPIRE_DEFERRED, so RECONCILE_SENDING had never once reached the branch that
	// runs when a statement spends its whole budget. That branch is not shared
	// code with a shared shape -- it binds THAT statement's parameters to THAT
	// statement's probe -- and the two statements do not have the same arity.
	it.skipIf(!RUN_DB)(
		"probes the SENDING statement's own backlog, with the SENDING statement's own parameters",
		async () => {
			await inRolledBackTransaction(async (tx) => {
				const total = RECLAIM_BUDGET + PUBLISHING_RECLAIM_BATCH_SIZE;
				await topUpDeadLeasedSending(tx, total, "ceil_sending");

				const result = await reclaimPublishingDeliveryStates(
					{ now: LEDGER_NOW },
					tx,
				);

				expect(result.batches.RECONCILE_SENDING).toBe(
					PUBLISHING_RECLAIM_MAX_BATCHES,
				);
				expect(
					result.counts.EXPIRE_SENDING +
						result.counts.FAIL_SENDING_AT_BOUND +
						result.counts.RECLAIM_SENDING_LEASE,
				).toBe(RECLAIM_BUDGET);
				expect(result.usedBatchBudget).toContain("RECONCILE_SENDING");
				expect(result.moreWorkRemains).toContain("RECONCILE_SENDING");
				expect(await countReclaimableSending(tx)).toBe(
					PUBLISHING_RECLAIM_BATCH_SIZE,
				);
			});
		},
		180_000,
	);
});
