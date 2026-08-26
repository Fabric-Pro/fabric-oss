import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { db } from "../index";

const RUN_DB = process.env.RUN_DB_INTEGRATION === "1";

// Enough rows that a sequential scan is a plan the planner would genuinely consider, so a missing
// or wrongly-shaped index shows up as a plan change rather than as a test that is merely slow.
const DEFERRED_ROWS = 2_500;
const SENDING_ROWS = 2_500;
// Two constraints pull in opposite directions and both matter.
// RARE, because a small EXPIRED_LEASES fraction is what pushes the planner's selectivity estimate
// for "claimedAt" < now() - interval '5 minutes' toward "most rows don't match" — that estimate is
// what decides index-scan versus seq-scan-plus-sort in the planner's cost model. (It is not about
// runtime early termination: the query carries ORDER BY "claimedAt" ASC, so a sequential scan can
// never early-terminate under that ordering — it must read every matching row and sort before LIMIT
// can apply, and both of the lease-reclaim case's assertions already reject that shape regardless.
// The suite also runs EXPLAIN without ANALYZE, so no query here is ever executed and there is no
// runtime behavior to invoke either way.)
// MORE THAN THE LIMIT, because with fewer matches than the LIMIT the query can never demonstrate
// early termination: every match fits in one batch, so a plan that materializes and sorts the
// entire matching set looks identical to one that stops at 100. 300 of 2500 satisfies both.
// A delete-a-guard run against this constant left the suite green at the current fixture size, so
// it is kept as a realistic row shape rather than as a guard the suite is known to depend on.
const EXPIRED_LEASES = 300;

// Every row this suite creates carries this prefix in its id, so cleanup is exact and a leak is
// identifiable. Not a real identifier of anything.
// The FULL uuid, not a slice. Teardown deletes by this prefix across five tables, so a prefix
// collision with a leaked fixture would delete rows this run did not create — the exact hazard the
// prefixed-id scheme exists to remove. Eight hex characters is 32 bits; the whole uuid costs
// nothing and ends the argument.
const RUN = `idxsmoke_${randomUUID().replaceAll("-", "")}`;

// Neutralize every LIKE metacharacter, backslash first so the escapes added after it are not
// themselves escaped. Used by teardown; a prefix built by interpolation alone is a pattern, not a
// literal, and this suite's teardown spans five tables including "user" and "organization".
function escapeLikePattern(value: string): string {
	return value
		.replaceAll("\\", "\\\\")
		.replaceAll("%", "\\%")
		.replaceAll("_", "\\_");
}

// One identical expiry shared by half the DEFERRED rows — the batch a single cycle's close
// creates. TIE_MID_ID is an id in the middle of that group when ordered by id.
const TIE_EXPIRES_AT = new Date("2027-01-01T00:00:00.000Z");
const TIE_GROUP = DEFERRED_ROWS / 2;
const TIE_MID_ID = `${RUN}_tie_${String(Math.floor(TIE_GROUP / 2)).padStart(6, "0")}`;

// `pg_get_indexdef` RECONSTRUCTS a definition from the catalog — it does not echo the migration's
// text. Identifiers are quoted only where quoting is required, so "expiresAt" keeps its quotes
// (mixed case) while `id` and `status` come back bare, and the predicate's literal is rendered with
// its type cast. That is why these are two literal strings compared with toBe rather than a regex
// assembled from the migration file.
//
// Both strings below were captured from `pg_get_indexdef` on postgres:16 (16.14, the CI image) and
// on the local postgres:17 (17.10), byte-identical on both. They are an observation, not a
// prediction: a test asserting the author's expectation instead of the database's behaviour is the
// failure this capture exists to prevent.
const DRAIN_INDEX_DEF =
	"CREATE INDEX publishing_notification_delivery_deferred_drain_idx ON public.publishing_notification_delivery USING btree (\"expiresAt\", id) WHERE (status = 'DEFERRED'::text)";
const LEASE_INDEX_DEF =
	"CREATE INDEX publishing_notification_delivery_sending_lease_idx ON public.publishing_notification_delivery USING btree (\"claimedAt\") WHERE (status = 'SENDING'::text)";

// EVERY row this fixture creates gets a deterministic, RUN-prefixed id, and cleanup addresses rows
// by that prefix alone. This is not tidiness — it is the difference between a safe teardown and a
// catastrophic one. This schema does NOT enable Prisma's strictUndefinedChecks preview (see
// `generator client` at schema.prisma:1-5), so `where: { id: undefined }` is not an error and not a
// no-match: Prisma DROPS the condition, and `deleteMany` with no condition deletes the whole table.
// An id left undefined because setup failed three lines earlier would therefore delete every
// project or organization in the database, with cascades. Prefixed ids plus raw DELETE ... LIKE
// removes the possibility rather than relying on setup having succeeded.
const ORG_ID = `${RUN}_org`;
const ACTOR_ID = `${RUN}_actor`;
const PROJECT_ID = `${RUN}_proj`;
const CYCLE_ID = `${RUN}_cycle`;

beforeAll(async () => {
	if (!RUN_DB) {
		return;
	}

	// createdAt is required on Organization and has no default (schema.prisma:429).
	await db.organization.create({
		data: {
			id: ORG_ID,
			name: `Index Fixture ${RUN}`,
			slug: `index-fixture-${RUN}`,
			createdAt: new Date(),
		},
	});

	await db.user.create({
		data: {
			id: ACTOR_ID,
			name: "Index Fixture Actor",
			email: `${ACTOR_ID}@example.com`,
			emailVerified: true,
			createdAt: new Date(),
			updatedAt: new Date(),
		},
	});

	// Project.userId is REQUIRED (schema.prisma:1380) and is the owner, present on organization
	// projects too — it is NOT the tenant-XOR column. The XOR lives on the denormalized copies
	// downstream, which is why the delivery rows below carry userId NULL while this project does
	// not. Confusing the two is how an org fixture ends up looking personal. techStack, features
	// and tags are String[] with no @default (schema.prisma:1373-1377), so they must be supplied.
	await db.project.create({
		data: {
			id: PROJECT_ID,
			name: `Index Fixture ${RUN}`,
			organizationId: ORG_ID,
			userId: ACTOR_ID,
			techStack: [],
			features: [],
			tags: [],
		},
	});

	// status is NOT optional here even though Prisma defaults it. The default is GENERATING, and
	// `publishing_suggestion_cycle` carries CHECK (status <> 'GENERATING' OR executionTimeoutAt IS
	// NOT NULL) from 20260714140000 — a GENERATING cycle must name its liveness-reclaim deadline.
	// Omitting both type-checks cleanly and then fails at runtime, before a single delivery row is
	// inserted. READY is also what this fixture MEANS: deliveries exist because a cycle closed.
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

	// Recipients. The ledger's unique (cycleId, recipientUserId, channel) means one cycle needs one
	// user per row, so these are generated in bulk rather than through the ORM.
	await db.$executeRawUnsafe(
		`INSERT INTO "user" ("id","name","email","emailVerified","createdAt","updatedAt")
		 SELECT $1 || '_u' || g, 'Index Fixture ' || g, $1 || '_u' || g || '@example.com', true, now(), now()
		   FROM generate_series(1, $2) AS g`,
		RUN,
		DEFERRED_ROWS + SENDING_ROWS,
	);

	// Half the DEFERRED rows stagger their expiry; half share TIE_EXPIRES_AT exactly.
	await db.$executeRawUnsafe(
		`INSERT INTO "publishing_notification_delivery"
		   ("id","cycleId","projectId","organizationId","userId","recipientUserId","channel","status","createdAt","expiresAt","attemptCount")
		 SELECT $1 || '_stag_' || lpad(g::text, 6, '0'), $2, $3, $4, NULL, $1 || '_u' || g,
		        'EMAIL', 'DEFERRED', now(), now() + (g || ' minutes')::interval, 0
		   FROM generate_series(1, $5) AS g`,
		RUN,
		CYCLE_ID,
		PROJECT_ID,
		ORG_ID,
		TIE_GROUP,
	);

	await db.$executeRawUnsafe(
		`INSERT INTO "publishing_notification_delivery"
		   ("id","cycleId","projectId","organizationId","userId","recipientUserId","channel","status","createdAt","expiresAt","attemptCount")
		 SELECT $1 || '_tie_' || lpad(g::text, 6, '0'), $2, $3, $4, NULL, $1 || '_u' || ($5 + g),
		        'EMAIL', 'DEFERRED', now(), $6::timestamp, 0
		   FROM generate_series(1, $7) AS g`,
		RUN,
		CYCLE_ID,
		PROJECT_ID,
		ORG_ID,
		TIE_GROUP,
		TIE_EXPIRES_AT,
		TIE_GROUP,
	);

	// SENDING rows: EXPIRED_LEASES of them claimed long ago, the rest claimed just now — sized to
	// give the planner a real selectivity estimate to discriminate on, not to trigger any runtime
	// early termination (EXPLAIN below never executes). See EXPIRED_LEASES above for the full case.
	await db.$executeRawUnsafe(
		`INSERT INTO "publishing_notification_delivery"
		   ("id","cycleId","projectId","organizationId","userId","recipientUserId","channel","status","createdAt","claimedAt","claimToken","attemptCount")
		 SELECT $1 || '_send_' || lpad(g::text, 6, '0'), $2, $3, $4, NULL, $1 || '_u' || ($5 + g),
		        'EMAIL', 'SENDING', now(),
		        CASE WHEN g <= $6 THEN now() - interval '1 hour' ELSE now() END,
		        $1 || '_tok_' || g, 0
		   FROM generate_series(1, $7) AS g`,
		RUN,
		CYCLE_ID,
		PROJECT_ID,
		ORG_ID,
		DEFERRED_ROWS,
		EXPIRED_LEASES,
		SENDING_ROWS,
	);

	// Measured, not argued: on a virgin database — pg_stats confirmed empty and last_analyze
	// confirmed null for this table, which is CI's actual starting condition — removing this line
	// costs two of the three plan-shape assertions below; on a database that already carries
	// representative statistics from prior runs, removing it costs nothing. That split is the
	// general point: a single delete-a-guard run is not evidence about a guard on its own, because
	// the answer depends on state (accumulated statistics, here) the experiment was not controlling.
	await db.$executeRawUnsafe(`ANALYZE "publishing_notification_delivery"`);
}, 120_000);

// Explicit timeout: beforeAll gets 120_000 but afterAll had none, so it ran under Vitest's default
// 10s hookTimeout (vitest.config.ts pins only testTimeout). Teardown below deletes ~5,000 delivery
// rows and ~5,000 user rows with cascade checks against every table referencing user, which can
// exceed 10s on a shared dev database. A timed-out afterAll fails red AND leaves ~10,000 fixture
// rows behind for the next run's ANALYZE to see.
afterAll(async () => {
	if (!RUN_DB) {
		return;
	}

	// Raw DELETE addressed by the RUN prefix, never an ORM deleteMany on a captured id — see the
	// note above ORG_ID. Every statement here names a non-empty literal prefix, so the worst a
	// half-built fixture can do is delete nothing. Order follows the foreign keys.
	// LIKE reads "_" as a single-character wildcard, and RUN carries one of its own
	// ("idxsmoke_<uuid>"). Escaping only the separator would leave that one live, so the pattern
	// would also match an id differing at exactly that position. Escaping the whole prefix is
	// what makes the comment above ORG_ID true rather than nearly true: no reachable id matches
	// today, because the uuid is fresh per run, but a teardown that deletes across five tables
	// does not get to rest on an argument about how unlikely a collision is.
	const prefix = `${escapeLikePattern(RUN)}\\_%`;
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
}, 120_000);

async function explain(sql: string, ...params: unknown[]): Promise<string> {
	return JSON.stringify(await db.$queryRawUnsafe(sql, ...params));
}

it.skipIf(!RUN_DB)(
	"plans the drain page without a sequential scan",
	async () => {
		const plan = await explain(`
		EXPLAIN (FORMAT JSON)
		SELECT "id", "expiresAt" FROM "publishing_notification_delivery"
		 WHERE "status" = 'DEFERRED'
		 ORDER BY "expiresAt" ASC, "id" ASC
		 LIMIT 100
	`);

		expect(plan).not.toMatch(/"Node Type":\s*"Seq Scan"/);
		// Same argument as the tie-group case below: a single-column index on expiresAt alone still
		// yields Index Scan + Sort here, which would pass the check above while sorting the entire
		// DEFERRED set. This is the un-cursored first page, the shape every sweep issues first, so a
		// wrong-shaped index shows up here before it shows up anywhere else.
		expect(plan).not.toMatch(/"Node Type":\s*"(Incremental )?Sort"/);
	},
);

// The cursor form is what every page after the first runs, and it is where an index on expiresAt
// ALONE stops being equivalent. Rejecting only Seq Scan is not enough: a single-column index still
// yields Index Scan + Sort, which passes that assertion while scanning and sorting an entire expiry
// group. Batch-created deferrals share an expiry in production, so this is the realistic case.
it.skipIf(!RUN_DB)(
	"seeks within a tie group on the composite cursor, with no sort",
	async () => {
		const plan = await explain(
			`
		EXPLAIN (FORMAT JSON)
		SELECT "id", "expiresAt" FROM "publishing_notification_delivery"
		 WHERE "status" = 'DEFERRED'
		   AND ("expiresAt", "id") > ($1::timestamp, $2)
		 ORDER BY "expiresAt" ASC, "id" ASC
		 LIMIT 100
	`,
			TIE_EXPIRES_AT,
			TIE_MID_ID,
		);

		expect(plan).not.toMatch(/"Node Type":\s*"Seq Scan"/);
		// A Sort or Incremental Sort here means the index cannot serve the order and the planner is
		// materializing the tie group to get it. This also correctly rejects a bitmap heap scan, which
		// cannot preserve index order; a correctly ordered parallel plan is not rejected.
		expect(plan).not.toMatch(/"Node Type":\s*"(Incremental )?Sort"/);
	},
);

// ORDER BY "claimedAt" ASC is not decoration — see the plan's Decision 6. It is the shape
// 1C-2d-2's lease-reclaim pass must issue, and it is what lets one index serve predicate and order.
it.skipIf(!RUN_DB)(
	"seeks the lease-reclaim scan in claim order, with no sort",
	async () => {
		const plan = await explain(`
		EXPLAIN (FORMAT JSON)
		SELECT "id" FROM "publishing_notification_delivery"
		 WHERE "status" = 'SENDING'
		   AND "claimedAt" < now() - interval '5 minutes'
		 ORDER BY "claimedAt" ASC
		 LIMIT 100
	`);

		expect(plan).not.toMatch(/"Node Type":\s*"Seq Scan"/);
		// Rejecting only Seq Scan would accept Sort -> Bitmap Heap Scan -> Bitmap Index Scan, which
		// uses the index and is still unbounded: a bitmap scan cannot preserve index order, so the
		// whole expired backlog is materialized and sorted before the LIMIT applies. That is the exact
		// cost this index exists to avoid, and at production backlog sizes it is the failure. The
		// fixture seeds more expired rows than the LIMIT precisely so this assertion has something to
		// discriminate.
		expect(plan).not.toMatch(/"Node Type":\s*"(Incremental )?Sort"/);
	},
);

// Plan shape and index definition are two different guarantees and they need two different tests.
// The EXPLAIN cases above deliberately do NOT pin which index the planner chose — pinning a name
// there would fail on a legitimate planner improvement. This case pins what OUR migration built,
// which is not the planner's business at all.
it.skipIf(!RUN_DB)(
	"keeps both indexes valid, partial, and keyed as the sweep needs",
	async () => {
		// The ::text casts are not cosmetic. pg_class.relname is PostgreSQL's `name` type and
		// pg_index.indnkeyatts is int2; Prisma's raw-query deserializer knows neither and fails the
		// whole query with "Failed to deserialize column of type 'name'" — before any assertion below
		// gets to run. Casting at the source is the fix; widening the assertions to tolerate whatever
		// came back would not have been.
		const rows = (await db.$queryRawUnsafe(`
		SELECT c.relname::text AS relname,
		       i.indisvalid,
		       i.indnkeyatts::int AS indnkeyatts,
		       pg_get_indexdef(i.indexrelid) AS definition
		  FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
		 WHERE c.relname IN ('publishing_notification_delivery_deferred_drain_idx',
		                     'publishing_notification_delivery_sending_lease_idx')
		 ORDER BY c.relname
	`)) as Array<{
			relname: string;
			indisvalid: boolean;
			indnkeyatts: number;
			definition: string;
		}>;

		expect(rows.map((row) => row.relname)).toEqual([
			"publishing_notification_delivery_deferred_drain_idx",
			"publishing_notification_delivery_sending_lease_idx",
		]);

		const [drain, lease] = rows;

		// EXACT equality on the whole reconstructed definition, not a regex over parts of it. A regex
		// that says "contains SENDING" accepts `status = 'SENT' OR status = 'SENDING'` — an index whose
		// broadened predicate reintroduces the very terminal-row scan this test exists to exclude,
		// while reading as a pass. Equality has no such gap, and when a PostgreSQL upgrade changes how
		// a definition is rendered, a red test asking a human to look is the outcome we want.
		expect(drain.indisvalid).toBe(true);
		expect(drain.indnkeyatts).toBe(2);
		expect(drain.definition).toBe(DRAIN_INDEX_DEF);

		// The partial predicate is load-bearing and NOT provable from plan shape. A full-table index on
		// "claimedAt" yields an Index Scan with no Sort — the lease plan-shape case above stays green —
		// while applying status='SENDING' as a mere FILTER. As terminal rows accumulate, that scan walks
		// an arbitrarily long prefix of them to find 100 SENDING rows: exactly the unbounded page this
		// index exists to prevent, passing an assertion that claims to pin boundedness.
		expect(lease.indisvalid).toBe(true);
		expect(lease.indnkeyatts).toBe(1);
		expect(lease.definition).toBe(LEASE_INDEX_DEF);
	},
);

// This case asserts a limitation on the sweep that 1C-2d-2 writes — not a defect in either index.
// A partial index is usable only where the query's predicate provably IMPLIES the index predicate.
// A GENERIC plan has no parameter value to reason from, so `status = $1` cannot imply `status =
// 'DEFERRED'`, and both partial indexes simply leave the planner's search space. Every EXPLAIN
// above inlines the status as a literal, which proves strictly less than the production path does:
// an ORM sends parameterized statements.
//
// Measured on postgres:16 (16.14) with plan_cache_mode=auto, three independent sessions, identical
// every time: a PREPAREd drain page EXECUTEd six times still plans as a CUSTOM plan on the seventh
// (Index Only Scan on the drain index). `auto` only adopts the generic plan when it does not cost
// more, and here it costs far more — so today's path is not broken. But that is a COST comparison,
// and what it is being compared against is the shape below. The sweep must therefore emit the status
// as a LITERAL rather than as a bind parameter; the alternative is a full scan and sort of the whole
// ledger on the single query the backlog design depends on.
//
// Asserted with EXPLAIN (GENERIC_PLAN) rather than by counting EXECUTEs, deliberately: the count at
// which `auto` switches is a planner heuristic and the cost comparison moves with row counts, so a
// test pinned to either would be flaky by construction. The generic plan's shape is structural.
it.skipIf(!RUN_DB)(
	"cannot reach either partial index under a generic plan — the sweep must send the status as a literal",
	async () => {
		// `explain()` below calls $queryRawUnsafe with this SQL and NO extra arguments, so PostgreSQL
		// never receives a bound value for $1 — yet the call succeeds instead of failing with "bind
		// message supplies 0 parameters, but prepared statement requires 1". EXPLAIN is a utility
		// statement, so the outer statement's parse analysis does not descend into the SQL text being
		// explained, and the Parse step reports zero parameters for the EXPLAIN statement itself. The
		// inner `$1` is analysed later and separately, inside ExplainQuery(), precisely because
		// GENERIC_PLAN was requested — that is what makes a parameter marker legal here at all. Do not
		// "fix" this by adding a bound argument; that would defeat the GENERIC_PLAN request this case
		// depends on.
		const drain = await explain(`
		EXPLAIN (GENERIC_PLAN, COSTS OFF, FORMAT JSON)
		SELECT "id", "expiresAt" FROM "publishing_notification_delivery"
		 WHERE "status" = $1
		 ORDER BY "expiresAt" ASC, "id" ASC
		 LIMIT 100
	`);
		expect(drain).toMatch(/"Node Type":\s*"Seq Scan"/);

		const lease = await explain(`
		EXPLAIN (GENERIC_PLAN, COSTS OFF, FORMAT JSON)
		SELECT "id" FROM "publishing_notification_delivery"
		 WHERE "status" = $1
		   AND "claimedAt" < now() - interval '5 minutes'
		 ORDER BY "claimedAt" ASC
		 LIMIT 100
	`);
		expect(lease).toMatch(/"Node Type":\s*"Seq Scan"/);

		// The same two queries with the status inlined do NOT fall back — otherwise this case would
		// pass on a database with no indexes at all and pin nothing. That is the discrimination the
		// three plan-shape cases above already make, restated here so this case cannot drift into
		// asserting that the ledger is simply unindexable.
		const drainWithLiteral = await explain(`
		EXPLAIN (COSTS OFF, FORMAT JSON)
		SELECT "id", "expiresAt" FROM "publishing_notification_delivery"
		 WHERE "status" = 'DEFERRED'
		 ORDER BY "expiresAt" ASC, "id" ASC
		 LIMIT 100
	`);
		expect(drainWithLiteral).not.toMatch(/"Node Type":\s*"Seq Scan"/);

		const leaseWithLiteral = await explain(`
		EXPLAIN (COSTS OFF, FORMAT JSON)
		SELECT "id" FROM "publishing_notification_delivery"
		 WHERE "status" = 'SENDING'
		   AND "claimedAt" < now() - interval '5 minutes'
		 ORDER BY "claimedAt" ASC
		 LIMIT 100
	`);
		expect(leaseWithLiteral).not.toMatch(/"Node Type":\s*"Seq Scan"/);
	},
);
