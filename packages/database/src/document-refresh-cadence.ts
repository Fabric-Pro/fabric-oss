/**
 * Cadence maths for Living Documents auto-refresh.
 *
 * Mirrors `newsletter-cadence.ts` in spirit but not in shape: a newsletter
 * fires on a configured day-of-week + hour, whereas a document refresh fires
 * once its interval has ELAPSED since the last completed cycle. That makes the
 * due-check a simple elapsed-time comparison and keeps cadence a plain string
 * (with a TS union) rather than a Prisma enum — same precedent as
 * `NewsletterSettings.cadence`, and it means adding BIWEEKLY costs no enum
 * migration.
 */

export type DocumentRefreshCadence =
	| "ON_DEPLOY"
	| "DAILY"
	| "WEEKLY"
	| "BIWEEKLY"
	| "MONTHLY";

/**
 * The one cadence that is not a cadence: `ON_DEPLOY` documents are never due on
 * elapsed time, only when a deployment is observed.
 *
 * A named predicate rather than an inline compare because two places must agree
 * about it — the sweep, which must skip these documents, and the deploy trigger,
 * which must find exactly them. Drift in either direction is a document that
 * refreshes never, or twice.
 */
export function isEventDrivenCadence(
	cadence: DocumentRefreshCadence | string,
): boolean {
	return cadence === "ON_DEPLOY";
}

export const DEFAULT_DOCUMENT_REFRESH_CADENCE: DocumentRefreshCadence =
	"BIWEEKLY";

/**
 * What the last cycle did. Stored as TEXT in `lastRefreshStatus`.
 *
 * A cycle either COMPLETES — committing a new version, or judging the document
 * already current — or it does not. Only the completing statuses advance
 * `lastRefreshedAt`; the rest leave the document due so the next sweep retries.
 */
export type DocumentRefreshCompletedStatus =
	| "COMMITTED"
	/**
	 * The refresh produced an update and did NOT write it — the default. It is
	 * waiting for a human to accept or reject. The CYCLE is complete (the model
	 * looked and produced something), so the cadence clock advances: a proposal
	 * nobody acts on must not re-generate, and re-bill, every six hours.
	 */
	| "PROPOSED"
	| "NO_CHANGES"
	/**
	 * The model produced an update and we REFUSED it: it flagged unresolved
	 * ambiguity, or it would have deleted most of the document. The candidate is
	 * discarded, not queued.
	 *
	 * A completed status on purpose. The cycle ran — the model looked and
	 * answered — so the cadence clock advances. Treating a refusal as a failure
	 * would leave the document permanently due and re-generate it, at the owner's
	 * expense, every six hours until a human intervened.
	 */
	| "REFUSED";

export type DocumentRefreshFailureStatus =
	| "SKIPPED_COLLISION"
	| "SKIPPED_STALE_ACTOR"
	| "FAILED";

export type DocumentRefreshStatus =
	| DocumentRefreshCompletedStatus
	| DocumentRefreshFailureStatus;

export interface DocumentRefreshCadenceSettings {
	/** Seeds the per-document jitter, so the herd never re-forms. */
	documentId: string;
	/**
	 * Set when a deployment was observed for this document's project, cleared
	 * when the cycle completes. Only meaningful for `ON_DEPLOY`.
	 */
	deployPendingSince?: Date | null;
	enabled: boolean;
	cadence: DocumentRefreshCadence | string;
	/** Advanced only when a cycle COMPLETES — committed or judged no-change. */
	lastRefreshedAt: Date | null;
	/** Advanced on every attempt, including failures. Drives the retry backoff. */
	lastAttemptAt: Date | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/**
 * A failed refresh does not advance `lastRefreshedAt`, so the document stays
 * due and the hourly sweep would re-dispatch it every hour — 24 model calls a
 * day for a document that is persistently failing. The sweep IS the outer retry
 * loop (Temporal handles the inner one), so it needs a floor.
 */
export const REFRESH_RETRY_BACKOFF_HOURS = 6;

export function refreshIntervalDays(
	cadence: DocumentRefreshCadence | string,
): number {
	switch (cadence) {
		case "DAILY":
			return 1;
		case "WEEKLY":
			return 7;
		case "MONTHLY":
			return 30;
		default:
			// Unknown values fall back to the default cadence rather than throwing:
			// a corrupt settings row must not be able to wedge the whole sweep.
			return 14;
	}
}

/**
 * How far the per-document jitter may push a refresh, in hours.
 *
 * A flat 24h spread is right for the multi-week cadences but wrong for DAILY:
 * it would push a one-day interval out to nearly two, so half the documents on a
 * cadence the reader chose *because it says daily* would refresh every other day.
 *
 * Capping the spread at a quarter of the interval keeps the herd spread out
 * without letting it swallow the promise. The multi-week cadences are unchanged —
 * a quarter of seven days is already past 24h, so they still get the full window.
 */
function maxJitterHours(intervalDays: number): number {
	return Math.min(24, Math.max(1, intervalDays * 6));
}

/**
 * A stable per-document offset, in hours, spread across the window
 * `maxJitterHours` allows for this cadence — a day for WEEKLY and longer, less
 * for DAILY.
 *
 * Without it the herd re-forms: every document enrolled before the feature was
 * switched on becomes due in the same tick, refreshes within the same hour, and
 * therefore comes due again in the same hour a fortnight later — forever. The
 * offset is derived from the document id, so it is deterministic (replay-safe)
 * and permanent.
 */
function refreshJitterHours(documentId: string, intervalDays: number): number {
	let hash = 0;
	for (let i = 0; i < documentId.length; i++) {
		hash = (hash * 31 + documentId.charCodeAt(i)) | 0;
	}
	return Math.abs(hash) % maxJitterHours(intervalDays);
}

/**
 * True when an enrolled document's interval has elapsed and it is not inside
 * the post-failure backoff window. A document that has never refreshed is due
 * immediately on the next sweep after enrollment.
 */
export function isRefreshDue(
	s: DocumentRefreshCadenceSettings,
	now: Date,
): boolean {
	if (!s.enabled) {
		return false;
	}

	if (s.lastAttemptAt) {
		const elapsedSinceAttempt = now.getTime() - s.lastAttemptAt.getTime();
		if (elapsedSinceAttempt < REFRESH_RETRY_BACKOFF_HOURS * HOUR_MS) {
			return false;
		}
	}

	// An event-driven document is never time-due. Without this it falls through
	// to the interval arithmetic below, where an unrecognised cadence defaults to
	// fortnightly — so "refresh on deploy" would quietly also mean "and every
	// fortnight regardless", which is not what the reader chose.
	// An event-driven document is due exactly when its event has happened —
	// never on elapsed time. Falling through to the interval arithmetic below
	// would hit the fortnightly default for an unrecognised cadence, so "refresh
	// on deploy" would quietly also mean "and every fortnight regardless".
	//
	// The backoff check above still applies, so a failing deploy refresh does not
	// re-dispatch every hour; the marker survives until a cycle completes.
	if (isEventDrivenCadence(s.cadence)) {
		return s.deployPendingSince != null;
	}

	if (!s.lastRefreshedAt) {
		return true;
	}

	const elapsed = now.getTime() - s.lastRefreshedAt.getTime();
	const intervalDays = refreshIntervalDays(s.cadence);
	const interval =
		intervalDays * DAY_MS +
		refreshJitterHours(s.documentId, intervalDays) * HOUR_MS;
	return elapsed >= interval;
}

/**
 * A bucket index that is stable within one cadence interval and changes across
 * the boundary. Buckets are as wide as the cadence, and a completed refresh
 * advances `lastRefreshedAt`, so two dispatches for one document can never land
 * in the same bucket — which is what makes it safe as a workflow-id component.
 */
/**
 * `ON_DEPLOY` has no interval, so it falls through to the default 14-day bucket
 * here. That is harmless rather than accidental, and worth stating because it
 * looks like a bug: the dispatcher sets `workflowIdReusePolicy: ALLOW_DUPLICATE`,
 * so a CLOSED workflow's id is reusable and a second deploy inside the same
 * fortnight still starts. The bucket only rejects a start while a refresh for
 * that document is still RUNNING — which is exactly what it should do.
 */
export function refreshPeriodBucket(
	cadence: DocumentRefreshCadence | string,
	now: Date,
): string {
	const intervalDays = refreshIntervalDays(cadence);
	const epochDays = Math.floor(now.getTime() / DAY_MS);
	return `${Math.floor(epochDays / intervalDays)}`;
}

/**
 * Deterministic workflow id. A retried dispatch activity, or a sweep that runs
 * again while the previous refresh is still in flight, reuses this id and
 * Temporal rejects the duplicate start — idempotency without a dedupe table.
 */
export function refreshWorkflowId(
	documentId: string,
	cadence: DocumentRefreshCadence | string,
	now: Date,
): string {
	return `document-refresh-${documentId}-${refreshPeriodBucket(cadence, now)}`;
}
