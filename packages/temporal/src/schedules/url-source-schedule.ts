/**
 * Per-URL Temporal Schedule helpers (URL Context Sources, spec §7.2).
 *
 * Wraps `ScheduleClient` for the DAILY / WEEKLY / MONTHLY cadences a
 * `ProjectContext` LINK row can opt into. ONCE and LIVE are NOT scheduled
 * here — ONCE has no recurring run, LIVE happens at retrieval time.
 *
 * Schedule ID convention: `url-source-schedule-${contextId}` (matches the
 * `ProjectContext.urlScheduleId` column).
 *
 * Workflow start: each fire starts `urlSourceCrawlWorkflow` by string name
 * with `mode: 'scheduled'`. The schedule's `apiKey` argument must be the
 * decrypted Firecrawl key — the activity sandbox can't reach the credential
 * store at fire-time. Callers MUST resolve the key before invoking
 * `createUrlSourceSchedule` / `updateUrlSourceSchedule`.
 *
 * Idempotency:
 *   - `createUrlSourceSchedule` is NOT idempotent — callers must call
 *     `deleteUrlSourceSchedule` first on the cadence-change path. The
 *     `updateUrlSourceSchedule` helper handles that internally.
 *   - `deleteUrlSourceSchedule` swallows "not found" so retry-safe.
 */
import type { ScheduleClient } from "@temporalio/client";
import type {
	UrlRefreshMode,
	UrlSourceScope,
} from "../workflows/url-source-crawl";

// Re-exported from the workflow types so callers don't reach across modules.
export type { UrlRefreshMode, UrlSourceScope };

const URL_CRAWL_WORKFLOW_NAME = "urlSourceCrawlWorkflow";
const URL_CONTEXT_TASK_QUEUE = "project-documents";

/**
 * Modes that result in a Temporal Schedule. ONCE and LIVE never get one.
 * Exported so the API layer can branch consistently.
 */
const SCHEDULED_MODES = new Set<UrlRefreshMode>(["DAILY", "WEEKLY", "MONTHLY"]);

export function isScheduledMode(
	mode: UrlRefreshMode | null | undefined,
): boolean {
	return mode != null && SCHEDULED_MODES.has(mode);
}

/**
 * Map a refresh cadence to its cron spec.
 *
 * All crons fire at **00:00 UTC** (Temporal interprets cron expressions in
 * UTC by default — there's no `CronOptions.timezone` configured for these
 * schedules). The cadence rows surfaced to the user in the Details sidebar
 * read directly from these strings:
 *
 *   DAILY   → `0 0 * * *`   (every day at 00:00 UTC)
 *   WEEKLY  → `0 0 * * 0`   (every Sunday at 00:00 UTC — cron Sunday = 0)
 *   MONTHLY → `0 0 1 * *`   (the 1st of every month at 00:00 UTC)
 *
 * If you change these strings you MUST also update
 *   - the Details sidebar tooltip in `UrlSourcePageView.tsx`
 *   - `cadenceNextFireUtc` below
 *   - the snapshot of cron behavior tests pin to in
 *     `__tests__/url-source-schedule.test.ts`
 *
 * Returns `null` for ONCE / LIVE / unknown modes — those don't get a schedule.
 */
export function cronForRefreshMode(
	mode: UrlRefreshMode | null | undefined,
): string | null {
	if (!mode) {
		return null;
	}
	switch (mode) {
		case "DAILY":
			return "0 0 * * *";
		case "WEEKLY":
			return "0 0 * * 0";
		case "MONTHLY":
			return "0 0 1 * *";
		default:
			return null;
	}
}

/**
 * Compute the next fire time (UTC) for a given refresh cadence, anchored at
 * `now`. Mirrors the Temporal Schedule's actual fire schedule — DAILY fires
 * at the next 00:00 UTC, WEEKLY at the next Sunday 00:00 UTC, MONTHLY at the
 * 1st of the next month 00:00 UTC. ONCE / LIVE / unknown → `null` (those
 * have no schedule, so "next refresh" doesn't apply).
 *
 * Used by the API layer (`process-context-link`, `update-url-source`) to
 * stamp `ProjectContext.urlNextRefreshAt` at schedule create / update time
 * so the full-view Details sidebar can render an accurate countdown
 * BEFORE the schedule first fires.
 *
 * Pure / deterministic — takes the clock as a parameter, no `Date.now()`.
 * The aligned-to-midnight semantics intentionally differ from the
 * workflow-side `computeNextRefreshAt` (which uses `now + interval` because
 * it runs post-fire and only needs to advance one period); both stamps
 * eventually converge on the same UTC midnight after the first scheduled
 * fire.
 */
export function cadenceNextFireUtc(
	mode: UrlRefreshMode | null | undefined,
	now: Date,
): Date | null {
	if (!mode || mode === "ONCE" || mode === "LIVE") {
		return null;
	}

	const year = now.getUTCFullYear();
	const month = now.getUTCMonth();
	const date = now.getUTCDate();

	// Boundary semantics: when `now` lands EXACTLY on the cron's fire moment
	// (00:00:00.000 UTC for all three cadences here) we return that moment,
	// not the next period's. The previous behaviour added one period
	// regardless, which produced an off-by-7-days (or -1-day, -1-month)
	// stamp on `ProjectContext.urlNextRefreshAt` if a schedule was created
	// at exactly midnight. Anywhere strictly after midnight still advances
	// to the next period — matches Temporal's "skip past fires" semantics.
	const isExactMidnight =
		now.getUTCHours() === 0 &&
		now.getUTCMinutes() === 0 &&
		now.getUTCSeconds() === 0 &&
		now.getUTCMilliseconds() === 0;

	switch (mode) {
		case "DAILY": {
			// Strictly after `now`, except when `now` IS exactly today's
			// midnight — then return today's midnight (which is `now`).
			if (isExactMidnight) {
				return new Date(Date.UTC(year, month, date, 0, 0, 0, 0));
			}
			return new Date(Date.UTC(year, month, date + 1, 0, 0, 0, 0));
		}
		case "WEEKLY": {
			// Next Sunday at 00:00 UTC. JS getUTCDay(): Sunday = 0,
			// Saturday = 6. At exactly Sunday-midnight return this moment.
			// On any other Sunday-after-midnight we advance a full 7 days
			// so we don't fire twice in the same window.
			const day = now.getUTCDay();
			if (day === 0 && isExactMidnight) {
				return new Date(Date.UTC(year, month, date, 0, 0, 0, 0));
			}
			const daysUntilNextSunday = day === 0 ? 7 : 7 - day;
			const next = Date.UTC(
				year,
				month,
				date + daysUntilNextSunday,
				0,
				0,
				0,
				0,
			);
			return new Date(next);
		}
		case "MONTHLY": {
			// 1st of next month at 00:00 UTC. JavaScript handles December
			// rollover via month=12 → next-year-January through `Date.UTC`.
			// At exactly the 1st-of-the-month-midnight return this moment.
			if (date === 1 && isExactMidnight) {
				return new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
			}
			const next = Date.UTC(year, month + 1, 1, 0, 0, 0, 0);
			return new Date(next);
		}
		default:
			return null;
	}
}

/**
 * Build the deterministic schedule ID for a context. The reconciliation
 * workflow parses `contextId` back out of this string, so the format is
 * load-bearing.
 */
export function buildUrlSourceScheduleId(contextId: string): string {
	return `url-source-schedule-${contextId}`;
}

/**
 * Extract `contextId` from a schedule ID produced by
 * `buildUrlSourceScheduleId`. Returns `null` for non-URL-source schedules.
 */
export function parseContextIdFromScheduleId(
	scheduleId: string,
): string | null {
	const prefix = "url-source-schedule-";
	if (!scheduleId.startsWith(prefix)) {
		return null;
	}
	const suffix = scheduleId.slice(prefix.length);
	return suffix.length > 0 ? suffix : null;
}

/**
 * Typed error for the "create/update needs a Firecrawl key but caller passed
 * nothing" path. Surfaces from `updateUrlSourceSchedule` when switching
 * INTO a scheduled mode without a resolved key — the API procedure has to
 * decrypt and pass it in.
 */
export class MissingFirecrawlKeyError extends Error {
	constructor(
		message = "Firecrawl API key is required to schedule a URL source",
	) {
		super(message);
		this.name = "MissingFirecrawlKeyError";
	}
}

// ---------------------------------------------------------------------------
// Public shape of the workflow args. Mirrors `UrlSourceCrawlWorkflowInput`
// from `packages/temporal/src/workflows/url-source-crawl.ts` — kept in sync
// manually since the workflow module can't be imported from this file (its
// transitive `@temporalio/workflow` deps don't load in a client context).
// ---------------------------------------------------------------------------

/** Mirrors `UrlSourceProviderName` from `workflows/url-source-crawl.ts`. */
type UrlSourceProviderName =
	| "firecrawl"
	| "jina"
	| "tavily"
	| "exa"
	| "parallel";

interface ScheduledUrlCrawlArgs {
	contextId: string;
	url: string;
	scope: UrlSourceScope;
	maxPages: number;
	projectId: string;
	userId: string | null;
	organizationId: string | null;
	apiKey: string;
	providerName?: UrlSourceProviderName;
	urlRefreshMode: UrlRefreshMode;
	parentSourceTitle?: string | null;
	mode: "scheduled";
}

export interface CreateUrlSourceScheduleArgs {
	contextId: string;
	url: string;
	scope: UrlSourceScope;
	maxPages: number;
	projectId: string;
	userId: string | null;
	organizationId: string | null;
	apiKey: string;
	/**
	 * Optional. Defaults to Firecrawl when absent — the activity falls back
	 * the same way, so schedules created before this field shipped continue
	 * to fire correctly.
	 */
	providerName?: UrlSourceProviderName;
	refreshMode: UrlRefreshMode;
	parentSourceTitle?: string | null;
}

export interface CreateUrlSourceScheduleResult {
	scheduleId: string;
}

/**
 * Create a Temporal Schedule for a URL context source. Caller MUST have
 * already verified `refreshMode` is one of DAILY/WEEKLY/MONTHLY — passing
 * ONCE/LIVE throws `MissingFirecrawlKeyError`-adjacent error so this never
 * silently no-ops.
 *
 * The schedule starts `urlSourceCrawlWorkflow` with `mode: 'scheduled'`.
 * The workflow's `workflowId` is derived from `scheduledTime` so two
 * concurrent fires (e.g., catch-up after worker downtime) don't collide.
 */
export async function createUrlSourceSchedule(
	args: CreateUrlSourceScheduleArgs,
	scheduleClient: ScheduleClient,
): Promise<CreateUrlSourceScheduleResult> {
	const cron = cronForRefreshMode(args.refreshMode);
	if (!cron) {
		// Defensive — should be caught upstream. Throws so misuse is loud.
		throw new Error(
			`createUrlSourceSchedule called with non-scheduled mode "${args.refreshMode}"`,
		);
	}
	if (!args.apiKey) {
		throw new MissingFirecrawlKeyError();
	}

	const scheduleId = buildUrlSourceScheduleId(args.contextId);

	const workflowArgs: ScheduledUrlCrawlArgs = {
		contextId: args.contextId,
		url: args.url,
		scope: args.scope,
		maxPages: args.maxPages,
		projectId: args.projectId,
		userId: args.userId,
		organizationId: args.organizationId,
		apiKey: args.apiKey,
		...(args.providerName !== undefined
			? { providerName: args.providerName }
			: {}),
		urlRefreshMode: args.refreshMode,
		parentSourceTitle: args.parentSourceTitle ?? null,
		mode: "scheduled",
	};

	await scheduleClient.create({
		scheduleId,
		spec: {
			cronExpressions: [cron],
		},
		action: {
			type: "startWorkflow",
			workflowType: URL_CRAWL_WORKFLOW_NAME,
			taskQueue: URL_CONTEXT_TASK_QUEUE,
			args: [workflowArgs],
			// Schedules let `${scheduledTime}` be templated into the
			// workflowId — but the JS SDK's `startWorkflow` action expects a
			// literal string. We compose a stable prefix; Temporal appends
			// its own unique suffix on each fire (it has to, or two catch-up
			// runs would collide). We keep our prefix short so the suffix
			// fits the 1000-char workflowId limit on Temporal Cloud.
			workflowId: `url-crawl-${args.contextId}`,
		},
		policies: {
			// If the previous run is still going (e.g. crawl took longer
			// than 24h), skip — better to wait for the next slot than to
			// double-crawl and double-bill Firecrawl.
			overlap: "SKIP",
			catchupWindow: "1 hour",
		},
		state: {
			paused: false,
			note: `URL source crawl schedule for context ${args.contextId} (${args.refreshMode})`,
		},
	});

	return { scheduleId };
}

export interface UpdateUrlSourceScheduleArgs {
	contextId: string;
	oldRefreshMode: UrlRefreshMode | null;
	newRefreshMode: UrlRefreshMode | null;
	// All required because we may need to (re)create. Optional in the type
	// is too lax — the API layer should always have these resolved.
	url: string;
	scope: UrlSourceScope;
	maxPages: number;
	projectId: string;
	userId: string | null;
	organizationId: string | null;
	parentSourceTitle?: string | null;
	// Required ONLY when newRefreshMode is one of DAILY/WEEKLY/MONTHLY.
	// Optional in the type because the same call handles "switch to ONCE"
	// where no key is needed (delete-only path).
	apiKey?: string | null;
	/** Optional — carried through to the schedule's workflow args. */
	providerName?: UrlSourceProviderName;
}

export interface UpdateUrlSourceScheduleResult {
	// `scheduleId` is the persistent identifier the caller writes back to
	// `ProjectContext.urlScheduleId`. `null` means "no schedule should exist"
	// (i.e. new mode is ONCE/LIVE/null). The DB write is the caller's job.
	scheduleId: string | null;
	action: "created" | "updated" | "deleted" | "noop";
}

/**
 * Transition a context's schedule between cadences.
 *
 *   scheduled  → scheduled  : update in place (re-create under same id).
 *   scheduled  → ONCE/LIVE  : delete schedule, return scheduleId=null.
 *   ONCE/LIVE  → scheduled  : create schedule, return new scheduleId.
 *   scheduled  → scheduled  (same mode): no-op.
 *   ONCE       ↔ LIVE       : no-op (no schedule on either side).
 *
 * Switching INTO a scheduled mode REQUIRES `apiKey`; throws
 * `MissingFirecrawlKeyError` if not supplied. The caller (API procedure)
 * decrypts the key via `getSearchProviderConfig` + `decryptApiKey`.
 */
export async function updateUrlSourceSchedule(
	args: UpdateUrlSourceScheduleArgs,
	scheduleClient: ScheduleClient,
): Promise<UpdateUrlSourceScheduleResult> {
	const oldScheduled = isScheduledMode(args.oldRefreshMode);
	const newScheduled = isScheduledMode(args.newRefreshMode);
	const scheduleId = buildUrlSourceScheduleId(args.contextId);

	// Case 1: stayed un-scheduled (ONCE ↔ LIVE, null ↔ ONCE, etc.) — nothing to do.
	if (!oldScheduled && !newScheduled) {
		return { scheduleId: null, action: "noop" };
	}

	// Case 2: scheduled → un-scheduled (delete).
	if (oldScheduled && !newScheduled) {
		await deleteUrlSourceSchedule({ scheduleId }, scheduleClient);
		return { scheduleId: null, action: "deleted" };
	}

	// Cases 3 + 4 need an apiKey. Reject loudly otherwise.
	if (!args.apiKey) {
		throw new MissingFirecrawlKeyError();
	}

	// Case 3: un-scheduled → scheduled (create).
	if (!oldScheduled && newScheduled && args.newRefreshMode != null) {
		const result = await createUrlSourceSchedule(
			{
				contextId: args.contextId,
				url: args.url,
				scope: args.scope,
				maxPages: args.maxPages,
				projectId: args.projectId,
				userId: args.userId,
				organizationId: args.organizationId,
				apiKey: args.apiKey,
				...(args.providerName !== undefined
					? { providerName: args.providerName }
					: {}),
				refreshMode: args.newRefreshMode,
				parentSourceTitle: args.parentSourceTitle,
			},
			scheduleClient,
		);
		return { scheduleId: result.scheduleId, action: "created" };
	}

	// Case 4: scheduled → scheduled (update in place).
	// Same mode → no-op rather than rewriting cron with the same value.
	if (args.oldRefreshMode === args.newRefreshMode) {
		return { scheduleId, action: "noop" };
	}

	// Different scheduled mode — delete + recreate. `ScheduleHandle.update`
	// can mutate spec + action in place but the args payload is unwieldy
	// (the SDK expects the full ScheduleDescription back) — and we're not
	// optimizing for sub-second cadence switches. Drop + create is
	// idempotent given our id format.
	await deleteUrlSourceSchedule({ scheduleId }, scheduleClient);
	const result = await createUrlSourceSchedule(
		{
			contextId: args.contextId,
			url: args.url,
			scope: args.scope,
			maxPages: args.maxPages,
			projectId: args.projectId,
			userId: args.userId,
			organizationId: args.organizationId,
			apiKey: args.apiKey,
			...(args.providerName !== undefined
				? { providerName: args.providerName }
				: {}),
			// Guarded above (`newScheduled` true and we returned early for null).
			refreshMode: args.newRefreshMode as UrlRefreshMode,
			parentSourceTitle: args.parentSourceTitle,
		},
		scheduleClient,
	);
	return { scheduleId: result.scheduleId, action: "updated" };
}

export interface DeleteUrlSourceScheduleArgs {
	scheduleId: string;
}

/**
 * Delete a schedule by id. Swallows "not found" so the delete path is
 * idempotent — the reconciliation workflow and the context-delete
 * procedure both rely on this behavior.
 */
export async function deleteUrlSourceSchedule(
	args: DeleteUrlSourceScheduleArgs,
	scheduleClient: ScheduleClient,
): Promise<{ deleted: boolean }> {
	try {
		const handle = scheduleClient.getHandle(args.scheduleId);
		await handle.delete();
		return { deleted: true };
	} catch (error) {
		// The Temporal SDK throws a generic Error with code "NOT_FOUND" /
		// message "schedule not found" depending on namespace state. We
		// match loosely so both server and Cloud variants are handled.
		const message = error instanceof Error ? error.message : String(error);
		if (
			/not\s*found/i.test(message) ||
			(error as { code?: string }).code === "NOT_FOUND"
		) {
			return { deleted: false };
		}
		throw error;
	}
}
