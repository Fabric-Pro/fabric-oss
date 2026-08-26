import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { db } from "@repo/database";
import { afterAll, beforeAll, expect, it } from "vitest";

/**
 * The re-drive tool's DUPLICATE GUARD, against real Postgres (1C-2d-2a Decision 34).
 *
 * The tool is the one path in the system that can re-send an obligation after the provider has
 * forgotten its idempotency key, so the set of rows it calls "still owed" is the whole guard. It is
 * now derived from `publishingEmailClaimableSql` rather than restated as `status IN
 * ('SENDING','FAILED')`, and these two cases are the rows the two shapes disagree about.
 *
 * A NEW FILE: the script had no test of its own — its only coverage today is incidental, inside
 * publishing-email-delivery.test.ts — and neither the child-process harness nor the seeded cycle is
 * inherited from anywhere.
 */

const RUN_DB = process.env.RUN_DB_INTEGRATION === "1";

// Same prefix discipline as the database suites: every row this file creates carries it, so
// teardown is exact and a leak is identifiable.
const RUN = `redrive_${randomUUID().replaceAll("-", "")}`;
const ORG_ID = `${RUN}_org`;
const ACTOR_ID = `${RUN}_actor`;
const RECIPIENT_ID = `${RUN}_recipient`;
const PROJECT_ID = `${RUN}_proj`;
const DEFERRED_CYCLE_ID = `${RUN}_cycle_deferred`;
const AT_BOUND_CYCLE_ID = `${RUN}_cycle_atbound`;

/**
 * Run the re-drive script as a CHILD PROCESS and return its exit code and stderr.
 *
 * It is a script, not a module: it reads argv, writes to stderr and calls process.exit, and the
 * behaviour under test IS the exit code. Importing it would run it at import time and take the
 * vitest worker down with it.
 *
 * RESEND_API_KEY is supplied because the mail-key guard sits BEFORE the guard under test and exits
 * first when the key is absent — with no key these cases would assert against a refusal that has
 * nothing to do with the dedupe horizon. The value is a placeholder and no provider call is made:
 * both cycles below have zero eligible recipients, so the notification core short-circuits on an
 * empty candidate set before any send.
 */
function runRedrive(args: string[]): { status: number; stderr: string } {
	const result = spawnSync(
		"node",
		[
			"--import",
			"tsx",
			"scripts/redrive-publishing-notification.ts",
			...args,
		],
		{
			cwd: process.cwd(),
			encoding: "utf8",
			env: { ...process.env, RESEND_API_KEY: "placeholder-mail-key" },
		},
	);
	return { status: result.status ?? -1, stderr: result.stderr ?? "" };
}

const THIRTY_HOURS_AGO = new Date(Date.now() - 30 * 60 * 60_000);

/**
 * One EMAIL obligation on its own cycle, in a shape no production writer can build yet:
 * `expiresAt` and `attemptCount` have no writer until 1C-2d-2b and 1C-2d-3, so this is raw.
 *
 * A CYCLE PER CASE, not one shared cycle. The script reads per-cycle and the at-bound case runs the
 * notification core to completion, which closes its cycle — a shared one would make the second case
 * depend on the first having run, and on which order vitest chose.
 */
async function seedObligation(input: {
	cycleId: string;
	status: string;
	attemptCount: number;
}): Promise<void> {
	await db.publishingSuggestionCycle.create({
		data: {
			id: input.cycleId,
			projectId: PROJECT_ID,
			organizationId: ORG_ID,
			status: "READY",
			actorUserId: ACTOR_ID,
			coveredThrough: new Date(),
			notificationOutcome: "PENDING",
		},
	});
	await db.$executeRawUnsafe(
		`INSERT INTO "publishing_notification_delivery"
		   ("id","cycleId","projectId","organizationId","userId",
		    "recipientUserId","channel","status","lastAttemptAt","expiresAt","attemptCount")
		 VALUES ($1,$2,$3,$4,NULL,$5,'EMAIL',$6,$7,
		    (clock_timestamp() AT TIME ZONE 'UTC') + interval '10 days', $8)`,
		`${input.cycleId}_row`,
		input.cycleId,
		PROJECT_ID,
		ORG_ID,
		RECIPIENT_ID,
		input.status,
		THIRTY_HOURS_AGO,
		input.attemptCount,
	);
}

beforeAll(async () => {
	if (!RUN_DB) {
		return;
	}
	// organization -> user -> project -> cycle, in foreign-key order. The delivery rows hang off
	// the per-case cycles.
	await db.organization.create({
		data: {
			id: ORG_ID,
			name: "redrive org",
			slug: `${RUN}-slug`,
			createdAt: new Date(),
		},
	});
	for (const [id, name] of [
		[ACTOR_ID, "Redrive actor"],
		[RECIPIENT_ID, "Redrive recipient"],
	] as const) {
		await db.user.create({
			data: {
				id,
				name,
				email: `${id}@example.com`,
				emailVerified: true,
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		});
	}
	// ACTIVE explicitly: every fence in the delivery module filters on it, and the script's own
	// READY check reads the cycle rather than the project — a project at the model default would
	// make the core answer TENANT_CHANGED for a reason that cannot occur in production.
	await db.project.create({
		data: {
			id: PROJECT_ID,
			name: "redrive project",
			userId: ACTOR_ID,
			organizationId: ORG_ID,
			status: "ACTIVE",
		},
	});

	// A DEFERRED row older than the provider's 24h idempotency horizon and still WELL inside its
	// 14-day expiry. Invisible to `status IN ('SENDING','FAILED')`.
	await seedObligation({
		cycleId: DEFERRED_CYCLE_ID,
		status: "DEFERRED",
		attemptCount: 1,
	});
	// A FAILED row at the attempt bound: equally old, equally unexpired, and not re-sendable at
	// all — so the horizon question does not arise for it.
	await seedObligation({
		cycleId: AT_BOUND_CYCLE_ID,
		status: "FAILED",
		attemptCount: 5,
	});
}, 180_000);

afterAll(async () => {
	if (!RUN_DB) {
		return;
	}
	// delivery -> cycle -> project -> user -> organization
	await db.publishingNotificationDelivery.deleteMany({
		where: { projectId: PROJECT_ID },
	});
	await db.publishingSuggestionCycle.deleteMany({
		where: { projectId: PROJECT_ID },
	});
	await db.project.deleteMany({ where: { id: PROJECT_ID } });
	await db.user.deleteMany({ where: { id: { startsWith: RUN } } });
	await db.organization.deleteMany({ where: { id: ORG_ID } });
}, 180_000);

it.skipIf(!RUN_DB)(
	"refuses an old DEFERRED obligation still inside its expiry",
	async () => {
		const { status, stderr } = runRedrive([
			"--cycle-id",
			DEFERRED_CYCLE_ID,
		]);

		// Under the shipped `status IN ('SENDING','FAILED')` query this row was invisible and the
		// script ran, re-sending a message the provider has already forgotten the idempotency key
		// for. Reconciliation preserves lastAttemptAt when it returns a SENDING row to DEFERRED,
		// so "old, deferred and still owed" is the ordinary shape after a schedule outage.
		expect(status).toBe(1);
		expect(stderr).toMatch(/were last attempted more than 24h ago/);
		// The count in the message is the derived set, not a constant: a guard that refused while
		// reporting zero obligations would be refusing for some other reason.
		expect(stderr).toMatch(/^1 email obligation\(s\)/m);
		// It stopped BEFORE the core, so the obligation it was run to recover is still open.
		const row = await db.publishingNotificationDelivery.findUniqueOrThrow({
			where: { id: `${DEFERRED_CYCLE_ID}_row` },
		});
		expect(row.status).toBe("DEFERRED");
	},
	180_000,
);

it.skipIf(!RUN_DB)(
	"does NOT demand --force-stale for a FAILED row at the attempt bound",
	async () => {
		const { status, stderr } = runRedrive([
			"--cycle-id",
			AT_BOUND_CYCLE_ID,
		]);

		// The shipped query counted this row and refused — a false alarm, because a row at the
		// attempt bound is terminal in fact and cannot be re-sent at all, so there is nothing for
		// a second copy to duplicate. This project's own history is that a guard which cries wolf
		// gets forced past on the day it matters.
		expect(stderr).not.toMatch(/were last attempted more than 24h ago/);
		// Not merely "a different message": the script ran to completion. Asserting only on the
		// absent string would also pass for a script that fell over one line earlier.
		expect(status).toBe(0);
	},
	180_000,
);
