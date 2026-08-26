import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	db,
	PUBLISHING_ABANDON_BATCH_SIZE,
	PUBLISHING_ABANDON_MAX_BATCHES,
	PUBLISHING_DELIVERY_ATTEMPT_BOUND,
	PUBLISHING_EMAIL_LEASE_MS,
	PUBLISHING_RECLAIM_REASON_ATTEMPT_BOUND,
	PUBLISHING_RECLAIM_REASON_EXPIRED,
	PUBLISHING_RECLAIM_REASON_LEASE_RECLAIMED,
} from "@repo/database";
import { logger } from "@repo/logs";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest";
// TOP-LEVEL, not `await import()` inside the case, and the difference is a CI
// failure rather than a style note. This barrel is the whole activity graph:
// loading it measured 11.0 s on an idle developer machine against the package's
// 20 s `testTimeout`, and inside a test body that cost is charged to the case.
// On a shared runner, after 469 other files, it went over and the case timed out
// while asserting nothing about time. A static import is paid in the file's
// COLLECTION phase, which vitest budgets separately and `testTimeout` does not
// bound — which is why the older `newsletter/activities-registration.test.ts`
// asks this same question this same way, and passed in the run this one failed.
import * as activitiesBarrel from "../src/activities";
import { PUBLISHING_SUGGESTION_EXECUTION_TIMEOUT_MS } from "../src/activities/publishing-suggestion/dispatch-suggestion";
import { markCycleFailed } from "../src/activities/publishing-suggestion/mark-cycle-failed";
import {
	abandonStalePublishingCycles,
	reclaimPublishingNotificationStates,
} from "../src/activities/publishing-suggestion/reconcile-notifications";

/**
 * ⚠ THIS SUITE MUTATES EVERY TENANT IN WHATEVER DATABASE `DATABASE_URL` NAMES,
 * IRREVERSIBLY. Point it only at a disposable one.
 *
 * `abandonStalePublishingCycles()` takes NO arguments by design (Decision 21):
 * a scheduled sweep has no caller-supplied input, so there is no project or
 * tenant predicate to pass and no `client` to hand it. It therefore binds to the
 * package-level `db` and cannot be wrapped the way the sibling suite
 * `publishing-reconcile-sweep.test.ts` wraps its cases in
 * `inRolledBackTransaction` — every call below COMMITS.
 *
 * What that means concretely, if this is pointed at a shared database: every
 * `PENDING` cycle in it whose activation clock is older than the staleness bound
 * is terminalized to `ABANDONED`. ABANDONED is TERMINAL, so the live attempt's
 * own outcome write is then refused — the damage is not "a wrong row", it is a
 * permanently wrong answer plus a permanently silenced writer. Every null-clock
 * `PENDING` cycle also gets an activation clock it can never lose again. THE
 * BLAST RADIUS IS THE STALENESS BOUND, NOT THIS FILE'S FIXTURE PREFIX; the
 * `${RUN}_` prefix makes teardown exact for rows this suite CREATED and does
 * nothing whatever for rows it MUTATED.
 *
 * The guard below is the mechanical half of this paragraph: a `DATABASE_URL`
 * whose host is not loopback is refused before the first write. It is a
 * heuristic, deliberately — loopback proves "not somebody else's server", never
 * "disposable", and a tunnel to a shared database is loopback. It exists to
 * catch the actual mistake, which is running this with a `.env.local` still
 * pointing at a shared dev database.
 */
const LOOPBACK_DB_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function assertDisposableDatabase(): void {
	const url = process.env.DATABASE_URL;
	if (!url) {
		throw new Error(
			"publishing-reconcile-activity.test.ts: RUN_DB_INTEGRATION=1 with no DATABASE_URL set.",
		);
	}
	let host: string;
	try {
		host = new URL(url).hostname;
	} catch {
		throw new Error(
			"publishing-reconcile-activity.test.ts: DATABASE_URL is not a parseable URL, so its host cannot be checked. Refusing to run.",
		);
	}
	if (!LOOPBACK_DB_HOSTS.has(host)) {
		// The HOST is named and nothing else — a connection string carries
		// credentials, and this message goes to CI logs.
		throw new Error(
			`publishing-reconcile-activity.test.ts refuses to run against the non-loopback database host "${host}". This suite terminalizes every stale PENDING cycle in the target database, in every tenant, irreversibly. Point DATABASE_URL at a disposable local database (for example the throwaway postgres:16 container this plan's Task 10 describes) and re-run.`,
		);
	}
}

const RUN_DB = process.env.RUN_DB_INTEGRATION === "1";
const RUN = `recact_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

// Fixture ids, all prefixed so teardown is exact. Not real identifiers.
const ORG_ID = `${RUN}_org`;
const ACTOR_ID = `${RUN}_actor`;
const PROJECT_ID = `${RUN}_proj`;

// PAST THE STALENESS BOUND, derived from the bound rather than restated. This
// was a literal `3 * 60 * 60_000` in FOUR places — three seeded offsets and the
// `ageActivationClock` duration — while the file already imported the real
// bound two lines above. That is the same drift class the whole slice exists to
// remove, and one that Task 10's grep for `2 * 60 * 60 * 1000` cannot see,
// because three hours spelled this way is a different number in a different
// arithmetic. An hour past the bound, so a cutoff the database computes a
// moment later is still comfortably clear of it.
const PAST_THE_BOUND_MS =
	PUBLISHING_SUGGESTION_EXECUTION_TIMEOUT_MS + 60 * 60_000;

beforeAll(async () => {
	if (!RUN_DB) {
		return;
	}
	// FIRST, before the first write. Everything below this line commits.
	assertDisposableDatabase();
	await db.organization.create({
		data: {
			id: ORG_ID,
			name: `Reconcile Activity ${RUN}`,
			slug: `reconcile-activity-${RUN}`,
			createdAt: new Date(),
		},
	});
	await db.user.create({
		data: {
			id: ACTOR_ID,
			name: "Reconcile Activity Actor",
			email: `${ACTOR_ID}@example.com`,
			emailVerified: true,
			createdAt: new Date(),
			updatedAt: new Date(),
		},
	});
	await db.project.create({
		data: {
			id: PROJECT_ID,
			name: `Reconcile Activity ${RUN}`,
			organizationId: ORG_ID,
			userId: ACTOR_ID,
			techStack: [],
			features: [],
			tags: [],
		},
	});
}, 120_000);

afterAll(async () => {
	if (!RUN_DB) {
		return;
	}
	// The backslash escapes LIKE's wildcard meaning of "_". Every statement
	// names a non-empty literal prefix, so a half-built fixture deletes nothing.
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
}, 120_000);

afterEach(() => {
	vi.restoreAllMocks();
});

let seq = 0;

/**
 * The activity is UNSCOPED by design — it walks every tenant — so a case cannot
 * isolate itself by filtering. It isolates on the READ side by asserting only
 * on the rows it created, and by tolerating counts from whatever else the
 * fixture left behind (hence `toBeGreaterThanOrEqual` rather than `toBe` on
 * totals).
 *
 * THERE IS NO ISOLATION ON THE WRITE SIDE and there cannot be — see the file
 * header. Reading only your own rows says nothing about which rows the sweep
 * changed, and the sweep changes every stale one in the database.
 */
async function seedCycle(outcome: string, createdAt: Date): Promise<string> {
	seq += 1;
	const id = `${RUN}_cyc_${String(seq).padStart(6, "0")}`;
	// `notificationOutcomeAt` is seeded from the same instant as `createdAt`
	// here because this suite's cases are about the ACTIVITY's arithmetic, not
	// about the clock's provenance — Task 4 owns the case where the two differ.
	await db.$executeRawUnsafe(
		`INSERT INTO "publishing_suggestion_cycle"
		   ("id","projectId","organizationId","userId","status","actorUserId",
		    "startedAt","completedAt","coveredThrough","notificationOutcome",
		    "notificationOutcomeVersion","notificationOutcomeAt","createdAt","updatedAt")
		 VALUES ($1,$2,$3,NULL,'READY',$4,$5,$5,$5,$6,0,$5,$5,$5)`,
		id,
		PROJECT_ID,
		ORG_ID,
		ACTOR_ID,
		createdAt,
		outcome,
	);
	return id;
}

/**
 * ADDED BACK BY 1C-2d-2b-1, alongside the three ledger cases that use them —
 * which is the promise 2a made when it deleted them. Staged in 2a they were
 * ~50 lines nothing executed and a second uncovered copy of an INSERT
 * `publishing-reconcile-sweep.test.ts` already had.
 *
 * A delivery row for `cycleId`, plus the recipient user it references. The
 * recipient is created per row rather than reused, so a case can seed several
 * without deciding whether two rows may share one — the ledger's own uniqueness
 * rules are `publishing-notifications.test.ts`'s subject, not this file's.
 * `${id}_r` keeps the recipient under the same run prefix, so the `afterAll`
 * above deletes it with everything else and the teardown needs no change: it
 * already removes `publishing_notification_delivery` by prefix, and it does so
 * BEFORE the cycles, which is the order the foreign keys require.
 */
async function seedDelivery(
	cycleId: string,
	row: {
		status: string;
		expiresAt: Date | null;
		attemptCount: number;
		claimedAt?: Date | null;
		claimToken?: string | null;
	},
): Promise<string> {
	seq += 1;
	const id = `${RUN}_del_${String(seq).padStart(6, "0")}`;
	await db.$executeRawUnsafe(
		`INSERT INTO "user" ("id","name","email","emailVerified","createdAt","updatedAt")
		 VALUES ($1, 'Activity Recipient', $1 || '@example.com', true, now(), now())`,
		`${id}_r`,
	);
	await db.$executeRawUnsafe(
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

async function statusOf(id: string): Promise<string> {
	const rows = (await db.$queryRawUnsafe(
		`SELECT "status" FROM "publishing_notification_delivery" WHERE "id" = $1`,
		id,
	)) as Array<{ status: string }>;
	return rows[0].status;
}

async function reasonOf(id: string): Promise<string | null> {
	const rows = (await db.$queryRawUnsafe(
		`SELECT "reason" FROM "publishing_notification_delivery" WHERE "id" = $1`,
		id,
	)) as Array<{ reason: string | null }>;
	return rows[0].reason;
}

async function notificationOutcomeAtOf(
	cycleId: string,
): Promise<string | null> {
	const rows = (await db.$queryRawUnsafe(
		`SELECT "notificationOutcomeAt" FROM "publishing_suggestion_cycle" WHERE "id" = $1`,
		cycleId,
	)) as Array<{ notificationOutcomeAt: Date | null }>;
	return rows[0].notificationOutcomeAt?.toISOString() ?? null;
}

async function outcomeOf(cycleId: string): Promise<string> {
	const rows = (await db.$queryRawUnsafe(
		`SELECT "notificationOutcome" FROM "publishing_suggestion_cycle" WHERE "id" = $1`,
		cycleId,
	)) as Array<{ notificationOutcome: string }>;
	return rows[0].notificationOutcome;
}

/**
 * PENDING with NO activation clock — the shape a worker on the previous build
 * leaves behind. `updatedAt` is written explicitly because this insert is raw
 * SQL: @updatedAt is a client-side behaviour of the Prisma query engine, not a
 * database default, and the column is NOT NULL.
 */
async function seedCycleWithNullClock(updatedAt: Date): Promise<string> {
	seq += 1;
	const id = `${RUN}_ncc_${String(seq).padStart(6, "0")}`;
	await db.$executeRawUnsafe(
		`INSERT INTO "publishing_suggestion_cycle"
		   ("id","projectId","organizationId","userId","status","actorUserId",
		    "startedAt","completedAt","coveredThrough","notificationOutcome",
		    "notificationOutcomeVersion","notificationOutcomeAt","createdAt","updatedAt")
		 VALUES ($1,$2,$3,NULL,'READY',$4,$5,$5,$5,'PENDING',0,NULL,$5,$5)`,
		id,
		PROJECT_ID,
		ORG_ID,
		ACTOR_ID,
		updatedAt,
	);
	return id;
}

/**
 * One bulk insert of `PUBLISHING_ABANDON_BATCH_SIZE * PUBLISHING_ABANDON_MAX_BATCHES + 1`
 * null-clock PENDING cycles, via `generate_series` — 2,001 rows in a single
 * statement, which is the cheap way to reach the only state that leaves a
 * residual behind. Imports the two constants rather than restating 2,001, so a
 * budget change moves the fixture with it.
 */
async function seedNullClockCyclesPastTheBudget(): Promise<void> {
	seq += 1;
	const count =
		PUBLISHING_ABANDON_BATCH_SIZE * PUBLISHING_ABANDON_MAX_BATCHES + 1;
	const prefix = `${RUN}_ncb_${String(seq).padStart(6, "0")}_`;
	const now = new Date();
	await db.$executeRawUnsafe(
		`INSERT INTO "publishing_suggestion_cycle"
		   ("id","projectId","organizationId","userId","status","actorUserId",
		    "startedAt","completedAt","coveredThrough","notificationOutcome",
		    "notificationOutcomeVersion","notificationOutcomeAt","createdAt","updatedAt")
		 SELECT $1 || lpad(g::text, 7, '0'), $2::text, $3::text, NULL,
		        'READY'::publishing_cycle_status, $4::text,
		        $5::timestamp, $5::timestamp, $5::timestamp, 'PENDING'::text, 0,
		        NULL, $5::timestamp, $5::timestamp
		   FROM generate_series(1, $6::int) g`,
		prefix,
		PROJECT_ID,
		ORG_ID,
		ACTOR_ID,
		now,
		count,
	);
}

/**
 * Move a cycle's activation clock back by `ms` — the only thing a LATER sweep
 * tick changes relative to the one that just enrolled it. Not in the brief's
 * code block; written here to give the "enrol THIS tick, sweep on a LATER one"
 * case the second half of its property without waiting for real time to pass.
 */
async function ageActivationClock(cycleId: string, ms: number): Promise<void> {
	await db.$executeRawUnsafe(
		`UPDATE "publishing_suggestion_cycle"
		    SET "notificationOutcomeAt" = "notificationOutcomeAt" - ($2::bigint * interval '1 millisecond')
		  WHERE "id" = $1`,
		cycleId,
		ms,
	);
}

describe("the reconciliation activities", () => {
	it("import no mail path at all", () => {
		// Parent §9.9's hard requirement: step 1 must REQUIRE NO
		// TRANSACTIONAL-EMAIL KEY, "which is why it touches no mail path".
		// Stated that way round on purpose — the task queue this activity runs
		// on routes work, it does not create a process or an environment
		// boundary, so "keyless WORKER" would name an isolation that does not
		// exist. Asserted on the SOURCE rather than by deleting an environment
		// variable, because an import that is merely unreached still couples
		// this activity to the mail package's module-load behaviour — and that
		// is what an env-var test would miss.
		//
		// ONE FILE DEEP, AND THE LIMITATION IS RECORDED RATHER THAN CLOSED. The
		// rationale above is about COUPLING, and coupling is transitive while
		// this guard is not: `reconcile-notifications.ts` imports a constant
		// from `dispatch-suggestion.ts`, so a mail import added THERE would
		// couple this activity exactly as the paragraph describes and leave
		// this case green. It is correct today — checked by reading the import
		// graph, not assumed. Widening it to a transitive import walk is
		// deliberately not done here: the walk is the thing that would need its
		// own tests, and 2a is not where that belongs. If this guard is ever
		// the reason a mail dependency was believed absent, read the graph.
		const source = readFileSync(
			join(
				__dirname,
				"..",
				"src",
				"activities",
				"publishing-suggestion",
				"reconcile-notifications.ts",
			),
			"utf8",
		);
		expect(source).not.toContain("@repo/mail");
		expect(source).not.toContain("RESEND_API_KEY");
		expect(source).not.toContain("isMailConfigured");
	});

	it("are exported from the publishing-suggestion activities barrel", () => {
		// The worker passes the whole activities namespace to every
		// Worker.create call, so an activity that is not re-exported is one
		// Temporal reports as "not registered" at the first tick — hours after
		// the deploy, with nothing red in CI.
		//
		// Asserted against the ROOT barrel deliberately: that namespace object is
		// what `worker.ts` hands to `Worker.create`, so a re-export the
		// publishing-suggestion sub-barrel has but the root does not is exactly
		// the failure this case exists to catch. See the import for why it is
		// loaded at module scope.
		expect(typeof activitiesBarrel.abandonStalePublishingCycles).toBe(
			"function",
		);
		// ONE LINE, NOT ONE CASE, and that is the whole edit 1C-2d-2b-1 needed
		// here: the sub-barrel re-exports this module with `export *`, so the
		// second activity arrives without a barrel change. Which is exactly why
		// the assertion has to be added by hand — a star export that silently
		// stops covering a name would leave this case green.
		expect(
			typeof activitiesBarrel.reclaimPublishingNotificationStates,
		).toBe("function");
		// 1C-3b's broadcast, added by hand for the reason the line above gives.
		// The workflow proxies this off the barrel by name, so a module that
		// exists and compiles but is never re-exported fails at RUN time and at no
		// earlier point — its own unit suite imports the file directly and would
		// stay green.
		expect(typeof activitiesBarrel.broadcastPublishingTopicsToChat).toBe(
			"function",
		);
	});

	it.skipIf(!RUN_DB)(
		"emits exactly one warn line carrying the run's abandoned count, not one per cycle",
		async () => {
			const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
			const stale = new Date(Date.now() - PAST_THE_BOUND_MS);
			await seedCycle("PENDING", stale);
			await seedCycle("PENDING", stale);

			const output = await abandonStalePublishingCycles();

			expect(output.abandoned).toBeGreaterThanOrEqual(2);
			// One line, whatever the count. A per-cycle line buries the number an
			// alert would key on.
			const ours = warn.mock.calls.filter(
				(call) =>
					(call[0] as { event?: string })?.event ===
					"publishing.reconcile.cycles_abandoned",
			);
			expect(ours).toHaveLength(1);
			expect((ours[0][0] as { abandoned: number }).abandoned).toBe(
				output.abandoned,
			);
			expect(ours[0][1]).toContain("[PublishingReconcile]");
		},
	);

	it.skipIf(!RUN_DB)(
		"still reports at info level when nothing was abandoned",
		async () => {
			const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
			const info = vi.spyOn(logger, "info").mockImplementation(() => {});
			// Every cycle this fixture seeded that could go stale already has.
			await abandonStalePublishingCycles();
			const output = await abandonStalePublishingCycles();

			expect(output.abandoned).toBe(0);
			const warned = warn.mock.calls.filter(
				(call) =>
					(call[0] as { event?: string })?.event ===
					"publishing.reconcile.cycles_abandoned",
			);
			const informed = info.mock.calls.filter(
				(call) =>
					(call[0] as { event?: string })?.event ===
					"publishing.reconcile.cycles_abandoned",
			);
			// A quiet hour is still evidence the sweep ran. Emitting nothing at
			// zero would make "the schedule stopped firing" indistinguishable
			// from "there was nothing to do".
			expect(warned).toHaveLength(0);
			expect(informed.length).toBeGreaterThanOrEqual(1);
		},
	);

	it.skipIf(!RUN_DB)(
		"enrols a null-clock PENDING cycle THIS tick and sweeps it on a LATER one",
		async () => {
			// The rolling-deploy shape: PENDING, activated by a build that did
			// not know the column, updatedAt already past the staleness bound.
			const cycleId = await seedCycleWithNullClock(
				new Date(Date.now() - PAST_THE_BOUND_MS),
			);

			const output = await abandonStalePublishingCycles();

			// ENROLLED, and its clock is floored at the moment the sweep first
			// saw the row (Decision 33) — so a stale `updatedAt` written by a
			// worker whose clock trails this one cannot make a LIVE cycle look
			// stale. The cost is that this cycle is NOT swept on this tick.
			expect(output.enrolled).toBeGreaterThanOrEqual(1);
			const clock = await notificationOutcomeAtOf(cycleId);
			expect(clock).not.toBeNull();
			// biome-ignore lint/style/noNonNullAssertion: asserted not-null above
			expect(new Date(clock!).getTime()).toBeGreaterThan(
				Date.now() - 60_000,
			);
			expect(await outcomeOf(cycleId)).toBe("PENDING");

			// The SECOND half of the property, and without it this case would
			// pass just as well if enrolment were deleted and the row simply
			// ignored: move the clock a full bound back — the only thing a later
			// tick changes — and the same activity now terminalizes it.
			await ageActivationClock(cycleId, PAST_THE_BOUND_MS);
			await abandonStalePublishingCycles();
			expect(await outcomeOf(cycleId)).toBe("ABANDONED");
		},
	);

	it.skipIf(!RUN_DB)(
		"raises the level on a non-zero null-clock residual even when nothing was abandoned",
		async () => {
			const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
			// Fresh: inside the staleness window, so enrolment adopts it and the
			// abandon pass correctly leaves it alone. The residual is what makes
			// this run interesting, and a run that printed at info here would be
			// indistinguishable from a quiet hour.
			await seedCycleWithNullClock(new Date());
			// The residual is read AFTER enrolment, so the only way a run ends
			// with one is a population larger than the run's own ceiling. That
			// is the real condition an operator needs to see — rows arriving
			// faster than the pass adopts them — so the fixture produces it
			// honestly rather than by lowering the ceiling for the test.
			await seedNullClockCyclesPastTheBudget();

			const output = await abandonStalePublishingCycles();

			expect(output.abandoned).toBe(0);
			expect(output.nullClockResidual).toBeGreaterThan(0);

			// THE THREE UNQUALIFIED COUNTERS BELONG TO THE ABANDON PASS, and
			// this is the one run in the suite where the two passes provably
			// DISAGREE — enrolment spends its whole 20-batch budget on the
			// 2,001-row fixture above while the abandon pass reads one empty
			// page. Anywhere else the two agree by accident and an assertion
			// would discriminate nothing.
			//
			// The seam is one edit wide: `{ ...result, ... }` becoming
			// `{ ...result, ...enrolment, ... }` to "carry both passes" turns
			// `usedBatchBudget` — which an operator reads as "raise the
			// ceiling" — into the ENROLMENT pass's answer, silently, on the
			// exact field whose Task 4 doc-comment says it "says nothing about
			// the backlog". Verified to discriminate: adding that spread makes
			// this case fail with `expected 20 to be 1`.
			expect(output.batches).toBe(1);
			expect(output.usedBatchBudget).toBe(false);

			const ours = warn.mock.calls.filter(
				(call) =>
					(call[0] as { event?: string })?.event ===
					"publishing.reconcile.cycles_abandoned",
			);
			expect(ours).toHaveLength(1);
			expect(ours[0][1]).toContain("without an activation clock");
		},
	);

	it.skipIf(!RUN_DB)(
		"derives the staleness bound from the suggestion workflow's execution timeout, and USES it",
		async () => {
			// The activity reports the BOUND, never a cutoff instant. A cutoff
			// would be this process's opinion about when the database decided,
			// which is the value Decision 33 says must not exist here — an
			// earlier draft of this case parsed `output.staleBeforeAt`, which is
			// the field the re-cut deleted.
			const bound = PUBLISHING_SUGGESTION_EXECUTION_TIMEOUT_MS;

			// Two cycles STRADDLING the bound, seeded relative to real time
			// because the cutoff is computed in the database. Reporting the
			// number is not the same as using it, and asserting only the field
			// would pass on an activity that reported the constant and passed a
			// different one down.
			const live = await seedCycle(
				"PENDING",
				new Date(Date.now() - bound + 10 * 60_000),
			);
			const stuck = await seedCycle(
				"PENDING",
				new Date(Date.now() - bound - 10 * 60_000),
			);

			const output = await abandonStalePublishingCycles();

			expect(output.staleAfterMs).toBe(bound);
			expect(await outcomeOf(stuck)).toBe("ABANDONED");
			expect(await outcomeOf(live)).toBe("PENDING");
		},
	);

	it.skipIf(!RUN_DB)(
		"markCycleFailed never writes either notification column, fenced or not",
		async () => {
			// The writer that lives in THIS package: @repo/database may not
			// import the worker (the dependency cycle CHILD:460-466 forbids it),
			// so the real function is exercised here against a real PENDING
			// cycle rather than retyped as SQL next to the writer it copies.
			//
			// Under the OLD implicit clock this case was load-bearing — it was
			// the only executable evidence that a @repo/temporal writer could
			// not move `updatedAt` on a PENDING cycle. Under the explicit column
			// it is defence in depth rather than the guarantee: the guarantee is
			// that markCycleFailed does not name `notificationOutcomeAt` at all,
			// which Task 4's frozen-file guard enforces across all three package
			// trees. Kept because a behavioural case and a source guard fail for
			// different reasons, and this one costs nothing.
			//
			// AND THE FENCE IS NOT WHAT THIS CASE TESTS — measured, by removing
			// it. `markCycleFailed` writes `status`, and NOTHING in this file
			// reads `status`. With the fence removed the cycle does reach
			// FAILED and both assertions below still pass, because that writer
			// names neither notification column with the fence or without it.
			// Do not read these two assertions as evidence about the fence; the
			// guarantee is Task 4's frozen-file guard, which is about what the
			// writer NAMES.
			const cycleId = await seedCycle(
				"PENDING",
				new Date(Date.now() - PAST_THE_BOUND_MS),
			);
			const before = await notificationOutcomeAtOf(cycleId);

			// Fenced on status = 'GENERATING' — a PENDING cycle is READY, so
			// this affects zero rows today. The assertions below hold either
			// way; see above.
			await markCycleFailed(cycleId, PROJECT_ID, "audit probe");

			expect(await notificationOutcomeAtOf(cycleId)).toBe(before);
			const outcome = await outcomeOf(cycleId);
			expect(outcome).toBe("PENDING");
		},
	);

	// ------------------------------------------------------------------
	// THE LEDGER ACTIVITY — 1C-2d-2b-1. `reclaimPublishingNotificationStates`
	// commits like its sibling and is unscoped for the same reason, so the file
	// header's blast-radius warning covers these too: every dead-leased SENDING
	// row and every overdue DEFERRED row in the database moves.
	// ------------------------------------------------------------------

	it.skipIf(!RUN_DB)(
		"expires and reclaims with no transactional-email key present",
		async () => {
			// Deleted rather than blanked. An empty string is a value, and a
			// mail-config check reading `process.env.RESEND_API_KEY` would see
			// "" as absent on some code paths and present on others; deleting
			// the key is the state a deployment that never configured mail is
			// actually in.
			//
			// It is a WEAKER instrument than the source assertion above and is
			// kept anyway, because the two fail differently: the source guard
			// catches an import, this catches a READ. Neither catches the other.
			const previous = process.env.RESEND_API_KEY;
			delete process.env.RESEND_API_KEY;
			try {
				const cycleId = await seedCycle("PENDING", new Date());
				const expiredId = await seedDelivery(cycleId, {
					status: "DEFERRED",
					expiresAt: new Date(Date.now() - 60_000),
					attemptCount: 1,
				});
				const strandedId = await seedDelivery(cycleId, {
					status: "SENDING",
					expiresAt: new Date(Date.now() + 86_400_000),
					attemptCount: 1,
					claimedAt: new Date(
						Date.now() - PUBLISHING_EMAIL_LEASE_MS - 60_000,
					),
					claimToken: `${RUN}_tok`,
				});
				const atBoundId = await seedDelivery(cycleId, {
					status: "SENDING",
					expiresAt: new Date(Date.now() + 86_400_000),
					attemptCount: PUBLISHING_DELIVERY_ATTEMPT_BOUND,
					claimedAt: new Date(
						Date.now() - PUBLISHING_EMAIL_LEASE_MS - 60_000,
					),
					claimToken: `${RUN}_tok_bound`,
				});

				await reclaimPublishingNotificationStates();

				// THIS CASE IS WHAT MAKES THE 2b-1/2b-2 SPLIT HONEST: the half
				// that ships the ledger transitions makes progress on exactly
				// the deployment that produced the backlog. All three rows move
				// with no mail key anywhere in the process.
				expect(await statusOf(expiredId)).toBe("EXPIRED");
				expect(await reasonOf(expiredId)).toBe(
					PUBLISHING_RECLAIM_REASON_EXPIRED,
				);
				expect(await statusOf(strandedId)).toBe("DEFERRED");
				expect(await reasonOf(strandedId)).toBe(
					PUBLISHING_RECLAIM_REASON_LEASE_RECLAIMED,
				);
				expect(await statusOf(atBoundId)).toBe("FAILED");
				expect(await reasonOf(atBoundId)).toBe(
					PUBLISHING_RECLAIM_REASON_ATTEMPT_BOUND,
				);
			} finally {
				if (previous !== undefined) {
					process.env.RESEND_API_KEY = previous;
				}
			}
		},
	);

	it.skipIf(!RUN_DB)(
		"returns per-transition counts and the clock it classified with",
		async () => {
			const cycleId = await seedCycle("PENDING", new Date());
			await seedDelivery(cycleId, {
				status: "DEFERRED",
				expiresAt: new Date(Date.now() - 60_000),
				attemptCount: 1,
			});

			const before = Date.now();
			const output = await reclaimPublishingNotificationStates();
			const after = Date.now();

			// EXHAUSTIVE ON THE KEY SET, not a spot check. The counts are keyed
			// by TRANSITION and the statements are keyed separately, so a fifth
			// transition added by 1C-2d-2b-2 without a reader here would be a
			// number the workflow reports and nothing has ever seen.
			expect(Object.keys(output.counts).sort()).toEqual([
				"EXPIRE_DEFERRED",
				"EXPIRE_SENDING",
				"FAIL_SENDING_AT_BOUND",
				"RECLAIM_SENDING_LEASE",
			]);
			expect(Object.keys(output.batches).sort()).toEqual([
				"EXPIRE_DEFERRED",
				"RECONCILE_SENDING",
			]);
			// The activity is unscoped, so another fixture's rows can raise this
			// — but not lower it below the row this case seeded.
			expect(output.counts.EXPIRE_DEFERRED).toBeGreaterThanOrEqual(1);

			// `sweptAt` is the clock the run CLASSIFIED with, so it has to fall
			// inside the call rather than merely be a string. Asserting only
			// `typeof === "string"` would pass on a hardcoded literal, which is
			// precisely what an operator correlating this line against a row's
			// `expiresAt` would be misled by.
			const sweptAt = Date.parse(output.sweptAt);
			expect(Number.isNaN(sweptAt)).toBe(false);
			expect(sweptAt).toBeGreaterThanOrEqual(before);
			expect(sweptAt).toBeLessThanOrEqual(after);
		},
	);

	it.skipIf(!RUN_DB)(
		"emits one info line per run carrying the ledger counts",
		async () => {
			const info = vi.spyOn(logger, "info").mockImplementation(() => {});
			const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
			const cycleId = await seedCycle("PENDING", new Date());
			await seedDelivery(cycleId, {
				status: "DEFERRED",
				expiresAt: new Date(Date.now() - 60_000),
				attemptCount: 1,
			});

			const output = await reclaimPublishingNotificationStates();

			// The pass-1 half of the durable-write audit: without this the
			// states_reclaimed line is a write with no reader, which is the
			// exact shape the ABANDONED signal exists to avoid repeating.
			const ours = info.mock.calls.filter(
				(call) =>
					(call[0] as { event?: string })?.event ===
					"publishing.reconcile.states_reclaimed",
			);
			expect(ours).toHaveLength(1);
			expect((ours[0][0] as { moved: number }).moved).toBe(
				Object.values(output.counts).reduce((sum, n) => sum + n, 0),
			);
			expect(
				(ours[0][0] as { usedBatchBudget: string[] }).usedBatchBudget,
			).toEqual([]);
			expect(
				(ours[0][0] as { moreWorkRemains: string[] }).moreWorkRemains,
			).toEqual([]);
			expect(ours[0][1]).toContain("[PublishingReconcile]");

			// INFO AND NOT WARN, asserted rather than left to the level in the
			// source. The cycle line raises itself to warn when it has something
			// to report; this one never does, because an expired obligation is
			// the sweep WORKING. An alert rule keyed on level would fire hourly
			// on a healthy deployment if this ever moved.
			expect(
				warn.mock.calls.filter(
					(call) =>
						(call[0] as { event?: string })?.event ===
						"publishing.reconcile.states_reclaimed",
				),
			).toHaveLength(0);
		},
	);
});
