import {
	assertPublishingCycleTenant,
	claimDeferredPublishingEmailDelivery,
	confirmPublishingEmailDelivery,
	type DeferredEmailRow,
	type DrainCursor,
	db,
	deferredPublishingEmailWorkRemains,
	getPublishingSuiteSettings,
	PUBLISHING_DEFERRED_SKIP_NO_ADDRESS,
	PUBLISHING_DEFERRED_SKIP_NOTIFICATIONS_OFF,
	PUBLISHING_DEFERRED_SKIP_TENANT_CHANGED,
	PUBLISHING_DEFERRED_SKIP_UNAUTHORIZED,
	PUBLISHING_DRAIN_BATCH_SIZE,
	PUBLISHING_DRAIN_CURSOR_START,
	PUBLISHING_DRAIN_MAX_BATCHES,
	PUBLISHING_EMAIL_PROVIDER_DEDUPE_WINDOW_MS,
	type PublishingDeferredSkipReason,
	readDeferredPublishingEmailPage,
	reauthorizePublishingRecipient,
	recordPublishingDeferredEmailFailure,
	skipDeferredPublishingEmailDelivery,
} from "@repo/database";
import { logger } from "@repo/logs";
import { isMailConfigured, sendEmail } from "@repo/mail";
import { getBaseUrl } from "@repo/utils";
import { safeHeartbeat } from "../lib/activity-liveness";

/**
 * Publishing Suite 1C-2d-2b-2 — the reconciliation sweep's passes 2 and 3.
 * Fizzy #2213.
 *
 * ## Pass 2 is a GATE ON THIS ACTIVITY, and it returns rather than throwing
 *
 * `isMailConfigured()` is read here, as the first act after the heartbeat, and an
 * unconfigured mail path returns a result with `mailConfigured: false` and zero
 * counts.
 *
 * NOT IN THE WORKFLOW. A workflow that branched on it would read process state
 * inside a deterministic context, recording the value into history once and
 * replaying it forever. It is also the wrong place for a second reason: the
 * workflow must call all three activities unconditionally, so that PASS 1 keeps
 * expiring and reclaiming on a deployment with no key. That ordering is the whole
 * of parent §9.9's requirement — a worker with no key that returned before pass 1
 * would let the backlog grow for exactly as long as the outage lasted, on
 * precisely the deployments that caused it.
 *
 * NOT A THROW. A failed activity is a failed workflow, retried three times, and
 * then an hourly red run on every deployment without a mail key — an alert firing
 * on a supported configuration. The absence of a key is a state to REPORT.
 *
 * ## The four gates, read fresh, per row
 *
 * Tenant, then the project kill switch, then the recipient's re-authorization,
 * then the claim. Stopping at the first refusal, and a refusal at the first three
 * terminalizes the obligation as SKIPPED — never FAILED, which means "try again"
 * and would spin against work that can never be discharged.
 *
 * FRESH, WITH NO PER-RUN MEMO, and the reason is the deferral itself. A batch
 * answer taken once leaves a window that widens with the batch; here the delay
 * between the obligation being recorded and this send is up to FOURTEEN DAYS,
 * which is exactly why §9.2(d) puts re-authorization at the moment of the delayed
 * send. A memo would reintroduce the staleness the deferral makes worst.
 *
 * The CONTENT derivations are memoized per run and the gates are not, and the
 * line between them is whether a stale answer can send mail to someone who should
 * not receive it. A project's display name cannot; its kill switch can.
 *
 * ## What is NOT here
 *
 * The producer. Nothing in this slice writes a DEFERRED row — 1C-2d-3 flips
 * `notify-topics-ready` from dropping an email-only recipient's obligation to
 * deferring it — so on merge this activity reads an empty backlog. That ordering
 * is required rather than incidental: a mechanism that creates durable
 * obligations must not ship ahead of the mechanism that discharges them.
 */

/** Which gate refused, as the counters report it. */
export type DrainSkipReason = PublishingDeferredSkipReason;

export interface DrainDeferredNotificationsOutput {
	/**
	 * FALSE means pass 3 did not run at all — the gate, not a count of zero. On a
	 * deployment with a backlog and no key this is the only field that explains
	 * why nothing drained, which is why it is reported rather than inferred from
	 * `scanned === 0`.
	 */
	mailConfigured: boolean;
	/** Rows the pages returned. */
	scanned: number;
	/** Obligations delivered and confirmed. */
	sent: number;
	/** Terminalized as SKIPPED by a gate, keyed by which gate refused. */
	skipped: Record<DrainSkipReason, number>;
	/** Discharged to FAILED at the attempt bound, by the claim's own refusal. */
	dischargedAtBound: number;
	/** The send was attempted and failed; the row returned to DEFERRED or to FAILED. */
	failed: number;
	/** Another live attempt held the row. Still owed — NOT an error, NOT terminal. */
	held: number;
	/** Not owed any more: delivered, cancelled, or past its deadline. Pass 1 owns it. */
	notClaimable: number;
	/**
	 * Sent with a previous attempt older than the provider's idempotency horizon,
	 * so a duplicate is possible if that earlier attempt was in fact accepted.
	 *
	 * A COUNT PER RUN AND NOT A LINE PER ROW, unlike the primary path's warning.
	 * There, reaching it means an attempt was delayed by more than a day and is
	 * itself the anomaly. Here it is the STRUCTURE: an obligation lives fourteen
	 * days and the provider remembers a key for one, so almost every deferred send
	 * that ever failed once is past the window. A per-row warning would fire on
	 * the normal case and teach an operator to ignore it.
	 */
	sentPastDedupeWindow: number;
	/** Pages read. */
	batches: number;
	/** The run spent its whole page budget. Says nothing about the backlog. */
	usedBatchBudget: boolean;
	/**
	 * A candidate was still there after the last permitted page — PROBED, never
	 * inferred from `batches === MAX`, which is also what a short final page and an
	 * exactly-full backlog produce. This is the field an operator alerts on.
	 */
	moreWorkRemains: boolean;
}

function emptyResult(
	mailConfigured: boolean,
): DrainDeferredNotificationsOutput {
	return {
		mailConfigured,
		scanned: 0,
		sent: 0,
		skipped: {
			[PUBLISHING_DEFERRED_SKIP_TENANT_CHANGED]: 0,
			[PUBLISHING_DEFERRED_SKIP_NOTIFICATIONS_OFF]: 0,
			[PUBLISHING_DEFERRED_SKIP_UNAUTHORIZED]: 0,
			[PUBLISHING_DEFERRED_SKIP_NO_ADDRESS]: 0,
		},
		dischargedAtBound: 0,
		failed: 0,
		held: 0,
		notClaimable: 0,
		sentPastDedupeWindow: 0,
		batches: 0,
		usedBatchBudget: false,
		moreWorkRemains: false,
	};
}

/** What a send needs that the ledger row does not carry. */
interface CycleContent {
	projectName: string;
	topicCount: number;
	url: string;
}

/**
 * Drain deferred email obligations: check the mail configuration, then walk the
 * backlog oldest deadline first and discharge what can be discharged.
 */
export async function drainDeferredPublishingNotifications(): Promise<DrainDeferredNotificationsOutput> {
	safeHeartbeat("drainDeferredPublishingNotifications");

	// PASS 2. The first act, and a RETURN rather than a filter: reading the page
	// and discarding it would pay the scan on exactly the deployment whose backlog
	// is largest.
	if (!isMailConfigured()) {
		const gated = emptyResult(false);
		logger.warn(
			{ event: "publishing.reconcile.deliveries_drained", ...gated },
			"[PublishingReconcile] Deferred email drain skipped — no transactional-email configuration",
		);
		return gated;
	}

	const result = emptyResult(true);
	const content = new Map<string, CycleContent | null>();

	// PASS 3. THE CURSOR IS EPHEMERAL — scoped to this execution, reset to the
	// start of the order every run, never persisted. A stored watermark is a
	// permanent-loss bug rather than an optimisation: the lifecycle deliberately
	// returns a row to DEFERRED WITHOUT changing ("expiresAt","id"), so a retained
	// high-water mark would sit past a reclaimed row forever — never satisfying
	// the cursor predicate again, never selected by any later run, untouched until
	// it expired. The immutability that makes the cursor safe WITHIN a run is
	// exactly what makes it unsafe ACROSS runs.
	let cursor: DrainCursor = PUBLISHING_DRAIN_CURSOR_START;

	while (result.batches < PUBLISHING_DRAIN_MAX_BATCHES) {
		const page = await readDeferredPublishingEmailPage(cursor);
		result.batches += 1;
		result.scanned += page.length;

		for (const row of page) {
			// THE CURSOR ADVANCES ON EVERY ROW THE PAGE RETURNED, including refused
			// ones. Advancing only on success would re-read a refused row on the
			// next page and never make progress past it.
			cursor = { expiresAt: row.expiresAt, id: row.id };
			await drainOne(row, result, content);
			safeHeartbeat("drainDeferredPublishingNotifications");
		}

		// A short page means the backlog is exhausted. Breaking on an empty page
		// alone would spend the whole budget on a backlog one row short of a full
		// page every time.
		if (page.length < PUBLISHING_DRAIN_BATCH_SIZE) {
			break;
		}
	}

	result.usedBatchBudget = result.batches === PUBLISHING_DRAIN_MAX_BATCHES;
	if (result.usedBatchBudget) {
		result.moreWorkRemains =
			await deferredPublishingEmailWorkRemains(cursor);
	}

	const message = `[PublishingReconcile] Drained ${result.sent} deferred email obligation(s) of ${result.scanned} scanned (${result.dischargedAtBound} out of attempts, ${result.failed} failed, ${result.held} held)`;
	// `warn` only when something needs acting on. A deferred obligation that
	// finally sends is the sweep WORKING; a backlog the budget could not clear is
	// not, and it is the field an alert rule reads.
	if (result.moreWorkRemains) {
		logger.warn(
			{ event: "publishing.reconcile.deliveries_drained", ...result },
			message,
		);
	} else {
		logger.info(
			{ event: "publishing.reconcile.deliveries_drained", ...result },
			message,
		);
	}
	return result;
}

async function drainOne(
	row: DeferredEmailRow,
	result: DrainDeferredNotificationsOutput,
	content: Map<string, CycleContent | null>,
): Promise<void> {
	const cycleTenant = {
		organizationId: row.organizationId,
		userId: row.userId,
	};

	// GATE 1 — TENANCY, and it is a separate question from permission rather than
	// a consequence of it. A recipient who kept an active project role across a
	// transfer passes every permission check while belonging to a different tenant
	// than the cycle, so the tuple is compared explicitly.
	if (
		(await assertPublishingCycleTenant({
			projectId: row.projectId,
			cycleTenant,
		})) === "TENANT_CHANGED"
	) {
		await skip(row, PUBLISHING_DEFERRED_SKIP_TENANT_CHANGED, result);
		return;
	}

	// GATE 2 — THE PROJECT KILL SWITCH, re-read now rather than trusted from when
	// the obligation was recorded. A project that switched notifications off
	// during the deferral window must not receive a late email when the key
	// returns. Terminal as SKIPPED, matching the cancellation model: leaving the
	// row DEFERRED would burn drain capacity the oldest-first rule reserves for
	// the rows nearest their deadline, and the setting is in neither partial
	// index's predicate so nothing can filter it cheaply.
	const settings = await getPublishingSuiteSettings(row.projectId);
	if (settings.notificationsEnabled === false) {
		await skip(row, PUBLISHING_DEFERRED_SKIP_NOTIFICATIONS_OFF, result);
		return;
	}

	// GATE 3 — RE-AUTHORIZATION, at the moment of the delayed send. This is the
	// whole reason the deferral is safe: an obligation recorded days ago says
	// nothing about whether that person may be emailed today, and by construction
	// more time has passed here than on any in-band retry. `channel: "EMAIL"` is
	// required rather than defaulted, so a send re-authorized against the bell's
	// toggle is a compile error rather than a silent notification to someone who
	// switched publishing emails off.
	const reauth = await reauthorizePublishingRecipient({
		projectId: row.projectId,
		recipientUserId: row.recipientUserId,
		cycleTenant,
		channel: "EMAIL",
	});
	if (reauth !== "OK") {
		await skip(
			row,
			reauth === "TENANT_CHANGED"
				? PUBLISHING_DEFERRED_SKIP_TENANT_CHANGED
				: PUBLISHING_DEFERRED_SKIP_UNAUTHORIZED,
			result,
		);
		return;
	}

	// GATE 4 — AN ADDRESS TO SEND TO, and it is checked BEFORE the claim on
	// purpose. Claiming first would consume one of the five attempts on a
	// recipient this channel cannot reach at all, and after five ticks the row
	// would terminalize as FAILED — "we tried and it did not work" — for a
	// recipient who has no address rather than a delivery that failed. Terminal
	// and not a fault: retrying cannot create an address.
	const recipient = await db.user.findUnique({
		where: { id: row.recipientUserId },
		select: { email: true },
	});
	const address = recipient?.email ?? null;
	if (!address) {
		await skip(row, PUBLISHING_DEFERRED_SKIP_NO_ADDRESS, result);
		return;
	}

	// THE CLAIM. Everything above is a decision about whether to try; this is the
	// only thing that takes the row, and the bound test and the increment are one
	// statement inside it.
	const claim = await claimDeferredPublishingEmailDelivery({ id: row.id });
	if (claim.outcome === "AT_BOUND") {
		result.dischargedAtBound += 1;
		return;
	}
	if (claim.outcome === "HELD") {
		result.held += 1;
		return;
	}
	if (claim.outcome === "NOT_CLAIMABLE") {
		result.notClaimable += 1;
		return;
	}

	const cycle = await cycleContent(row, content);
	if (!cycle) {
		// The project vanished between the tenancy gate and here. Release the claim
		// rather than holding a lease over a row nothing can describe; the next
		// tick's tenancy gate will terminalize it properly.
		await recordPublishingDeferredEmailFailure({
			cycleId: row.cycleId,
			recipientUserId: row.recipientUserId,
			claimToken: claim.claimToken,
			reason: "PROVIDER_ERROR",
			errorMessage: "project content unavailable at send time",
		});
		result.failed += 1;
		return;
	}

	// EVIDENCE, NOT A REFUSAL. An obligation lives fourteen days and the provider
	// remembers an idempotency key for one, so a previous attempt older than that
	// horizon means a duplicate is possible if that attempt was in fact accepted.
	// The product decision ranks a possible duplicate above a possible silent drop
	// — a duplicate is noise and a dropped notification is invisible — so this
	// counts rather than stops.
	if (
		claim.previousAttemptAt !== null &&
		Date.now() - claim.previousAttemptAt.getTime() >
			PUBLISHING_EMAIL_PROVIDER_DEDUPE_WINDOW_MS
	) {
		result.sentPastDedupeWindow += 1;
	}

	let ok: boolean;
	try {
		ok = await sendEmail({
			to: address,
			templateId: "publishingTopicsReady",
			// THE SAME KEY THE IN-BAND PATH USES, deliberately: an obligation that
			// was attempted in-band and then deferred must collapse into that
			// attempt at the provider rather than arriving twice. Attempt-
			// independent for the same reason — a key carrying the attempt number
			// would make every retry a new message.
			idempotencyKey: `publishing-${row.cycleId}-${row.recipientUserId}`,
			context: {
				projectName: cycle.projectName,
				topicCount: cycle.topicCount,
				url: cycle.url,
			},
		});
	} catch (error) {
		await recordPublishingDeferredEmailFailure({
			cycleId: row.cycleId,
			recipientUserId: row.recipientUserId,
			claimToken: claim.claimToken,
			reason: "PROVIDER_ERROR",
			errorMessage:
				error instanceof Error ? error.message : String(error),
		});
		result.failed += 1;
		return;
	}

	if (!ok) {
		// PROVIDER_REJECTED rather than PROVIDER_ERROR: the union's two members
		// exist to tell "returned false" apart from "threw", and only the throw
		// carries text worth preserving. A classification, never the provider's own
		// response body — `reason` is a column operators group on.
		await recordPublishingDeferredEmailFailure({
			cycleId: row.cycleId,
			recipientUserId: row.recipientUserId,
			claimToken: claim.claimToken,
			reason: "PROVIDER_REJECTED",
		});
		result.failed += 1;
		return;
	}

	const confirmed = await confirmPublishingEmailDelivery({
		cycleId: row.cycleId,
		recipientUserId: row.recipientUserId,
		claimToken: claim.claimToken,
	});
	if (confirmed === "CONFIRMED") {
		result.sent += 1;
		return;
	}
	// The message was sent and this attempt no longer owns the row — its lease
	// expired and something else took it, or the obligation was cancelled
	// mid-flight. Counting it as sent would assert a delivery on a row this run
	// does not own; `notClaimable` is the honest column.
	result.notClaimable += 1;
}

async function skip(
	row: DeferredEmailRow,
	reason: DrainSkipReason,
	result: DrainDeferredNotificationsOutput,
): Promise<void> {
	// The verdict is COUNTED, not assumed. The writer is fenced on the row still
	// being DEFERRED, so a refusal that raced a claim writes nothing and says so —
	// and a run that reported a terminalization it did not perform would be a
	// count nothing could reconcile against the ledger.
	const verdict = await skipDeferredPublishingEmailDelivery({
		id: row.id,
		reason,
	});
	if (verdict === "SKIPPED") {
		result.skipped[reason] += 1;
	} else {
		result.held += 1;
	}
}

/**
 * The project name, its topic count and the absolute link — memoized per RUN.
 *
 * Memoized where the gates are not, and the line is whether a stale answer can
 * send mail to someone who should not receive it. A display name and a topic
 * count cannot; a kill switch and a permission can. The key is the cycle, because
 * the topic count is per cycle.
 *
 * `null` is cached too — a project that vanished stays vanished for the rest of
 * the run, and re-asking once per row would be a query per row for an answer that
 * cannot change back.
 */
async function cycleContent(
	row: DeferredEmailRow,
	cache: Map<string, CycleContent | null>,
): Promise<CycleContent | null> {
	const cached = cache.get(row.cycleId);
	if (cached !== undefined) {
		return cached;
	}

	const [project, topicCount, organization] = await Promise.all([
		db.project.findUnique({
			where: { id: row.projectId },
			select: { name: true },
		}),
		db.publishingTopic.count({
			where: { projectId: row.projectId, cycleId: row.cycleId },
		}),
		// The workspace slug for the ABSOLUTE link. A bell link is context-relative
		// because the reader's own workspace base is prepended for them; a mail
		// client has no such resolver, so the address has to be complete when it
		// leaves here.
		row.organizationId
			? db.organization.findUnique({
					where: { id: row.organizationId },
					select: { slug: true },
				})
			: Promise.resolve(null),
	]);

	if (!project) {
		cache.set(row.cycleId, null);
		return null;
	}

	// getBaseUrl() returns the env value verbatim and may end in "/", which would
	// otherwise produce a double slash.
	const baseUrl = getBaseUrl().replace(/\/+$/, "");
	const workspacePrefix = organization?.slug
		? `/app/${organization.slug}`
		: "/app";
	const value: CycleContent = {
		projectName: project.name,
		topicCount,
		url: `${baseUrl}${workspacePrefix}/projects/${row.projectId}/publishing`,
	};
	cache.set(row.cycleId, value);
	return value;
}
