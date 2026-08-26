/**
 * Re-drive the contributor notification for ONE publishing cycle.
 *
 * Usage: pnpm --filter @repo/temporal redrive:publishing-notification -- --cycle-id <id>
 *
 * This calls the notification activity's plain-function core directly. It does NOT start
 * publishingSuggestionWorkflow — that would regenerate topics. Safe to run more than once: the
 * ledger's unique (cycleId, recipientUserId, channel) makes a second run a no-op for anything
 * already delivered.
 *
 * Refuses to run against a cycle whose notificationOutcome is already terminal (see the check
 * below) — the notification core's "already terminal" branch does not deliver anything in that
 * case, it just terminalizes whatever ledger rows are still outstanding to SKIPPED/CYCLE_CLOSED
 * and returns. That is correct for a cycle that genuinely finished, but it is exactly the trap for
 * an ABANDONED cycle (1C-2d): re-driving the operator's own alert would silently discharge the
 * obligations the alert exists to surface. So this script stops before ever calling the core,
 * rather than relying on that branch to no-op safely.
 *
 * Also refuses — overridably, with --force-stale — when an email obligation on the cycle was last
 * attempted longer ago than the provider retains its idempotency key. This is the ONE path in the
 * system that can re-send an obligation after that second layer of duplicate protection has
 * lapsed: inside a workflow every retry lands within minutes, but a re-drive is run by a person,
 * often the morning after.
 *
 * And refuses — NOT overridably — when RESEND_API_KEY is absent from the shell. That guard is about
 * the CLOSE, not the send; see it below for why running without a mail key is the one way this
 * script discharges the obligations it was run to recover.
 */
import {
	db,
	PUBLISHING_EMAIL_PROVIDER_DEDUPE_WINDOW_MS,
	publishingEmailClaimableSql,
} from "@repo/database";
import { isMailConfigured } from "@repo/mail";
import { runPublishingTopicsReadyNotification } from "../src/activities/publishing-suggestion/notify-topics-ready";

/**
 * Outcomes this script may still act on: PENDING and RESOLUTION_FAILED are the two values a
 * transition writer may overwrite (see NON_TERMINAL in
 * packages/database/prisma/queries/projects/publishing-notification-outcome.ts), and
 * NOT_APPLICABLE is the entry default — runPublishingTopicsReadyNotification's own first step
 * repairs it to PENDING before doing anything else. Every other value (SENT, NO_RECIPIENTS,
 * CANCELLED, DISABLED, MAIL_NOT_CONFIGURED, ABANDONED) is a terminal write: the cycle's answer
 * already stands, and re-driving it does not deliver.
 */
const REDRIVEABLE_OUTCOMES = new Set([
	"NOT_APPLICABLE",
	"PENDING",
	"RESOLUTION_FAILED",
]);

async function main(): Promise<void> {
	const flagIndex = process.argv.indexOf("--cycle-id");
	const cycleId = flagIndex === -1 ? undefined : process.argv[flagIndex + 1];
	if (!cycleId) {
		console.error("usage: --cycle-id <publishing suggestion cycle id>");
		process.exit(1);
	}

	const cycle = await db.publishingSuggestionCycle.findUnique({
		where: { id: cycleId },
		select: {
			id: true,
			projectId: true,
			organizationId: true,
			userId: true,
			status: true,
			notificationOutcome: true,
		},
	});
	if (!cycle) {
		console.error(`cycle ${cycleId} not found`);
		process.exit(1);
	}
	if (cycle.status !== "READY") {
		console.error(
			`cycle ${cycleId} is ${cycle.status}, not READY — nothing to notify`,
		);
		process.exit(1);
	}
	if (!REDRIVEABLE_OUTCOMES.has(cycle.notificationOutcome)) {
		console.error(
			`cycle ${cycleId} has notificationOutcome=${cycle.notificationOutcome}, which is already ` +
				"terminal — refusing to re-drive. Re-driving a terminal cycle does not deliver: the " +
				'notification core\'s "already terminal" branch just terminalizes any outstanding ' +
				"ledger rows to SKIPPED/CYCLE_CLOSED and returns without notifying anyone. If this is " +
				"an ABANDONED cycle, that is the alert itself, not something this script can discharge " +
				"— investigate why the workflow never resolved.",
		);
		process.exit(1);
	}

	// ONE read of this cycle's UNRESOLVED email obligations, feeding BOTH guards below. They ask
	// different questions of the same rows — the mail guard asks how many obligations a close would
	// discharge (a LOWER BOUND; see below), the dedupe-horizon guard asks how long ago each was
	// attempted — and two queries would be two snapshots, with a row free to move between them.
	//
	// EVERY STILL-OWED STATE, derived from the predicate the claim itself uses rather than
	// retyped from it (1C-2d-2a Decision 34). `status IN ('SENDING','FAILED')` was the earlier
	// shape and it has a hole exactly where it matters: reconciliation PRESERVES lastAttemptAt when
	// it returns a SENDING row to DEFERRED, so after a schedule outage a DEFERRED row can be older
	// than the provider's idempotency horizon while still inside its 14-day expiry. That row is
	// invisible to a status list and re-sending it delivers a second copy. Deriving the set instead
	// of restating it is what stops the tool and the claim drifting into different answers about
	// which rows are still re-sendable.
	//
	// The lease term is dropped: this asks WHAT IS STILL OWED, not who is holding it right now. A
	// row someone else holds is still an obligation this re-drive could duplicate.
	//
	// WHAT THIS SET IS, said plainly, because two previous versions of this comment said something
	// else and were wrong in a way that would be discovered rather than read: it is the email
	// obligations that are still OWED. Not "claimable" — that word means owed AND free to take, and
	// this query drops exactly the term that asks the second half, one paragraph above. A row a live
	// attempt is holding right now is in this set and is not claimable; calling the set claimable
	// tells an operator the opposite of the sentence that precedes it.
	//
	// Still owed is the right set for the dedupe-horizon question below, and a lower
	// bound for the close's — `terminalizeExistingDeliveriesAsSkipped` matches
	// `deliveredAt: null AND status <> 'SKIPPED'`, a superset of this one. The mail-key refusal is
	// unconditional and does not depend on the count, so nothing about that guard's behaviour turns
	// on the difference; only the number it prints does.
	const openEmailObligations = await db.$queryRawUnsafe<
		Array<{
			recipientUserId: string;
			status: string;
			lastAttemptAt: Date | null;
		}>
	>(
		`SELECT "recipientUserId", "status", "lastAttemptAt"
		   FROM "publishing_notification_delivery"
		  WHERE "cycleId" = $1
		    AND "channel" = 'EMAIL'
		    AND ${publishingEmailClaimableSql({})}`,
		cycleId,
	);

	// THE MAIL KEY, and the refusal is about the CLOSE rather than about the send.
	//
	// This script runs as plain `tsx` with no dotenv wrapper, so it sees whatever the operator's
	// shell holds — DATABASE_URL exported, RESEND_API_KEY usually not. Handing that environment to
	// the notification core does not skip the email channel harmlessly. The core finds the mail
	// client unusable, drops every email obligation for the attempt, and then CLOSES the cycle with
	// the FORCED outcome MAIL_NOT_CONFIGURED. Three consequences follow, and the third is the one
	// that makes this a guard rather than a warning:
	//
	//   1. The close terminalizes every outstanding EMAIL row to SKIPPED / CYCLE_CLOSED and releases
	//      its lease. notify-topics-ready.ts documents that as a deployment-skew window — the key
	//      present on one worker revision and absent on another. Run from an operator shell it stops
	//      being a window and becomes the default.
	//   2. A row a LIVE attempt is holding mid-provider-call is discharged with the rest. The
	//      dedupe-horizon guard below does not catch it: that row was claimed seconds ago, so its
	//      lastAttemptAt is recent. Its confirm is token-fenced, so it answers LOST and the ledger's
	//      final word on a message that may well have been delivered is SKIPPED / CYCLE_CLOSED with
	//      a null deliveredAt.
	//   3. MAIL_NOT_CONFIGURED is not in REDRIVEABLE_OUTCOMES, so this script refuses that cycle
	//      from then on — including for the IN_APP obligation the operator may have been recovering.
	//      The recovery tool discharges what it was run to recover, and then locks itself out.
	//
	// UNCONDITIONAL on the key, deliberately, rather than conditioned on this cycle already having
	// email rows. The forced outcome is written whenever the EMAIL CANDIDATE SET is non-empty, and
	// that set is not derivable from the ledger: a cycle with no EMAIL rows is the COMMON shape here
	// (a NOT_APPLICABLE cycle never entered the lifecycle, so it has none by definition) and is
	// precisely the one where a re-drive would create the first ones. Every ledger-shaped proxy is
	// therefore unsound in the direction that causes the defect — it waves through the cycle with no
	// rows and the cycle whose rows are all terminal, both of which still terminalize on a non-empty
	// candidate set. Over-refusing costs one environment variable and says so; under-refusing
	// discharges obligations and cannot be undone.
	//
	// NO --force ESCAPE, and none is offered. The one state in which proceeding without a key is
	// genuinely harmless — a project with zero email candidates, where the core's own
	// `emailCandidates.length === 0` short-circuit makes the key irrelevant — cannot be told apart
	// from the dangerous ones without re-deriving the candidate set here, which would duplicate
	// three steps of the activity and drift from them silently. Setting the key is safe in every
	// case, including that one.
	if (!isMailConfigured()) {
		console.error(
			"RESEND_API_KEY is not set in this shell, and this script loads no env file of its own " +
				"— refusing to re-drive.\n" +
				"This is not caution about the send; it is about the close. With no mail key the " +
				"notification core drops every email obligation for the attempt and then closes the " +
				"cycle as MAIL_NOT_CONFIGURED, a TERMINAL outcome. That close terminalizes every " +
				"outstanding EMAIL row to SKIPPED/CYCLE_CLOSED and releases its lease — including a " +
				"row a live worker attempt is holding mid-send, whose recent lastAttemptAt puts it " +
				"outside the 24h guard — and it puts the cycle outside the set this script will ever " +
				"act on again, IN_APP obligations included.\n" +
				(openEmailObligations.length > 0
					? `${openEmailObligations.length} email obligation(s) on this cycle are unresolved ` +
						"right now and would be discharged by that close.\n"
					: "This cycle has no unresolved email rows yet, so that close would discharge " +
						"nothing — but the terminal write still lands, and the emails this re-drive " +
						"exists to send are dropped for good.\n") +
				"Export RESEND_API_KEY (the value the worker runs with) and re-run.",
		);
		process.exit(1);
	}

	// KEYED ON lastAttemptAt, evaluated over the rows read above rather than in a second query: the
	// horizon is a property of each row, not of the set, so filtering it here keeps both guards
	// looking at one snapshot. A null lastAttemptAt is NOT stale — it means no attempt was ever
	// recorded — which is what the SQL predicate `lt` said and what this comparison preserves.
	const staleCutoff = new Date(
		Date.now() - PUBLISHING_EMAIL_PROVIDER_DEDUPE_WINDOW_MS,
	);
	const resendable = openEmailObligations.filter(
		(row) => row.lastAttemptAt !== null && row.lastAttemptAt < staleCutoff,
	);
	const force = process.argv.includes("--force-stale");
	if (resendable.length > 0 && !force) {
		// DERIVED from the same constant the predicate above uses, never typed as a literal. The
		// message and the query must never be able to disagree: an operator decides whether to
		// force past this refusal on the number printed here, so a stale "24h" beside a window
		// that had moved would be advice the code no longer follows.
		const windowHours =
			PUBLISHING_EMAIL_PROVIDER_DEDUPE_WINDOW_MS / 3_600_000;
		console.error(
			`${resendable.length} email obligation(s) on this cycle were last attempted more ` +
				`than ${windowHours}h ago and were never confirmed. Each one MAY already have been ` +
				"accepted by the provider — an attempt can hand off a message and then fail before " +
				"recording it, and a false return from the mail client covers exactly that case. " +
				`Within ${windowHours}h the idempotency key collapses the re-send; past it the ` +
				"provider has dropped the key, so re-driving now can deliver a SECOND copy.\n" +
				"Re-run with --force-stale to accept that, having decided a possible duplicate " +
				"is better than a possible silent drop.",
		);
		process.exit(1);
	}

	console.log(
		`re-driving ${cycleId} (outcome was ${cycle.notificationOutcome})`,
	);
	await runPublishingTopicsReadyNotification({
		cycleId: cycle.id,
		tenant: {
			projectId: cycle.projectId,
			organizationId: cycle.organizationId,
			userId: cycle.userId,
		},
	});

	const after = await db.publishingSuggestionCycle.findUniqueOrThrow({
		where: { id: cycleId },
		select: { notificationOutcome: true },
	});
	const rows = await db.publishingNotificationDelivery.findMany({
		where: { cycleId },
		select: {
			recipientUserId: true,
			channel: true,
			status: true,
			deliveredAt: true,
		},
	});
	const delivered = rows.filter((r) => r.deliveredAt !== null);
	const outstanding = rows.filter(
		(r) => r.deliveredAt === null && r.status !== "SKIPPED",
	);
	const byChannel = (list: typeof rows, channel: string) =>
		list.filter((r) => r.channel === channel).length;
	console.log(`outcome: ${after.notificationOutcome}`);
	console.log(
		`delivered: ${byChannel(delivered, "IN_APP")} in-app, ${byChannel(delivered, "EMAIL")} email`,
	);
	// SENDING is counted as OUTSTANDING, not as in-flight-and-fine. A row still SENDING after the
	// re-drive returned means its lease is held by an execution this script cannot see, and the
	// operator needs that surfaced rather than rounded down.
	console.log(
		`outstanding: ${byChannel(outstanding, "IN_APP")} in-app, ${byChannel(outstanding, "EMAIL")} email ` +
			`(${outstanding.filter((r) => r.status === "SENDING").length} still holding a lease)`,
	);
}

main()
	.catch((error) => {
		console.error(error);
		process.exit(1);
	})
	.finally(() => db.$disconnect());
