/**
 * Publishing Suite — manual "Generate now".
 *
 * Exists because a MANUAL cadence with no manual trigger would be a setting
 * that silently disables the feature forever.
 *
 * A forced run bypasses BOTH spend guards — the dispatcher's cost guard and the
 * workflow's F7 freshness gate — so its own cooldown is the only thing bounding
 * it. That is why the floor is ONE HOUR rather than the five minutes
 * `requestDailyBriefRegeneration` uses: the daily tick bounds the scheduled
 * path, but nothing bounds an HTTP endpoint except this.
 *
 * The cooldown is measured against the newest cycle's `startedAt` and is NOT
 * bypassable by any input flag.
 *
 * Reuse, not reimplementation: starting the cycle itself is delegated to
 * `runPublishingSuggestionDispatch` — the plain-function core of the daily
 * sweep's dispatch activity (imported through the narrow
 * `@repo/temporal/activities/publishing-suggestion` subpath, NOT the
 * package-level `./activities` barrel, which would pull the whole worker
 * activity graph into an API request path for one function). That function
 * already owns the tenant re-read, the XOR normalization, the liveness
 * reclaim and the idempotency — duplicating cycle creation here would fork
 * that logic. It is the same code the daily sweep runs; the Temporal
 * *activity* wrapper around it (`dispatchPublishingSuggestion`, which calls
 * `heartbeat()`) is deliberately NOT used here, since `heartbeat()` requires
 * a Temporal Worker's activity-execution context that this API process never
 * has.
 */
import { db } from "@repo/database";
import { isTemporalAvailable } from "@repo/temporal";

/** Deliberately 12x the daily-brief floor — see the file header. */
const MANUAL_COOLDOWN_MS = 60 * 60 * 1000;

export interface RequestPublishingGenerationInput {
	projectId: string;
	triggeredByUserId: string;
}

export type RequestPublishingGenerationResult =
	| { status: "rate_limited" }
	| { status: "unavailable" }
	| { status: "in_flight"; cycleId: string }
	| { status: "started" };

export async function requestPublishingGeneration(
	input: RequestPublishingGenerationInput,
): Promise<RequestPublishingGenerationResult> {
	// In-flight guard. The partial unique index
	// (`publishing_suggestion_cycle_active` on projectId WHERE status =
	// 'GENERATING') is the real enforcement; this read turns the race into a
	// friendly response instead of a constraint error.
	const live = await db.publishingSuggestionCycle.findFirst({
		where: { projectId: input.projectId, status: "GENERATING" },
		orderBy: { startedAt: "desc" },
		select: { id: true, startedAt: true },
	});
	if (live) {
		return { status: "in_flight", cycleId: live.id };
	}

	// Cooldown: measured against the newest cycle's `startedAt` (any terminal
	// status — a GENERATING one would already have returned above), computed
	// HERE in application code from the row's actual timestamp rather than
	// trusted from a query filter. That makes the gate depend only on a
	// server-read clock and a server-read row, with no input of any kind
	// able to widen or skip it.
	const newest = await db.publishingSuggestionCycle.findFirst({
		where: { projectId: input.projectId },
		orderBy: { startedAt: "desc" },
		select: { id: true, startedAt: true },
	});
	if (
		newest &&
		Date.now() - newest.startedAt.getTime() < MANUAL_COOLDOWN_MS
	) {
		return { status: "rate_limited" };
	}

	if (!(await isTemporalAvailable())) {
		return { status: "unavailable" };
	}

	// Imported lazily and through the NARROW subpath added to
	// packages/temporal/package.json. The package-level `./activities` barrel
	// re-exports every activity module in the worker (Playwright, the AWS SDK,
	// the agent runtime); pulling that into an API request path is not
	// acceptable. The subpath chosen is still the whole publishing-suggestion
	// activity family — collectors, topic computation, dispatch — not a single
	// function, but that is far narrower than the alternative.
	const { runPublishingSuggestionDispatch } = await import(
		"@repo/temporal/activities/publishing-suggestion"
	);

	// By this point `runPublishingSuggestionDispatch` has already created the
	// GENERATING cycle row (before it attempts `client.workflow.start`). Inside
	// a Temporal Worker, a non-already-started start failure re-throwing is
	// correct — Temporal retries the activity and reuses the same row. Here it
	// is wrong: nothing retries an HTTP handler, so letting that throw
	// propagate would turn a transient Temporal outage into a raw 500 on top
	// of a cycle stranded in GENERATING until the liveness reclaim in
	// dispatch-suggestion.ts frees it.
	//
	// We do not touch packages/temporal to split "transport/start failure"
	// from "a bug inside the dispatch core" — from this call site, wrapping a
	// single `await`, the two are indistinguishable. Treating the whole call
	// as a transport failure is the lesser harm: a masked bug still surfaces
	// (logged below, and the stuck-cycle symptom would recur and get noticed)
	// whereas an unhandled 500 plus a locked-out project is a worse user-facing
	// failure mode for what may just be a dropped connection.
	// Breadcrumb: a manual run has no occurrenceKey (that column is NULL for
	// this path — see dispatch-suggestion.ts). `triggeredByUserId` is now also
	// persisted onto the created cycle row (PublishingSuggestionCycle.triggeredByUserId),
	// so this log is no longer the ONLY record of who triggered it — it remains
	// the only record when cycle creation itself fails before that row exists.
	console.info("[requestPublishingGeneration] manual run initiated", {
		projectId: input.projectId,
		triggeredByUserId: input.triggeredByUserId,
	});
	try {
		await runPublishingSuggestionDispatch({
			projectId: input.projectId,
			force: true,
			triggeredByUserId: input.triggeredByUserId,
		});
	} catch (err) {
		console.error(
			"[requestPublishingGeneration] dispatch failed after cycle creation",
			err,
		);
		return { status: "unavailable" };
	}
	return { status: "started" };
}
