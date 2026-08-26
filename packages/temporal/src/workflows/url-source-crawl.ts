/**
 * URL Source Crawl Workflow
 *
 * Durable orchestration for adding / re-syncing a URL context source via
 * Firecrawl. The activity envelope is:
 *
 *  - `SINGLE_PAGE`  → one scrape → store markdown on the parent ProjectContext.
 *  - `PATH_PREFIX`  → crawl → for each page: upsert ProjectContextUrlPage row,
 *                    then (if content changed OR manual-resync) embed it into
 *                    Qdrant. Concurrency capped at 5 to bound Firecrawl/embed
 *                    pressure.
 *
 * Determinism rules per `fabric/standards/backend/temporal.md`:
 *   - No `Date.now()`, no `Math.random()`, no `new Date()` in this file.
 *   - All wall-clock / IO inside activities. The workflow uses `workflow.now()`.
 *
 * Failure mode: on any activity throw, run a best-effort
 * `updateParentStatusActivity` with FAILED status and the unwrapped error,
 * then re-throw so Temporal records it. Returns `{ success: false }` instead
 * of throwing only when finalize itself succeeded; otherwise Temporal sees
 * the original failure.
 *
 * Registered under the string name **`urlSourceCrawlWorkflow`** — matches the
 * exported function name so the API procedure (Group 3) can start it via the
 * Temporal client by literal string.
 */
import {
	ActivityFailure,
	ApplicationFailure,
	CancellationScope,
	CancelledFailure,
	log,
	patched,
	proxyActivities,
	workflowInfo,
} from "@temporalio/workflow";
import type * as activities from "../activities";

/**
 * Telemetry contract for `project_context_url_crawl_failed` (
 * tasks.md Group 10.1). The workflow emits this as a structured log event so
 * the ops dashboard (Datadog / Grafana per ROLLOUT.md) can alert on it.
 *
 * Stages map to the activity that threw:
 *   - `firecrawl-scrape` → `firecrawlScrapeActivity`
 *   - `firecrawl-crawl`  → `firecrawlCrawlActivity`
 *   - `embed`            → `embedUrlPageActivity`
 *   - `upsert`           → `upsertUrlPageActivity`
 *
 * Error types map from the `ApplicationFailure.type` produced by the
 * Firecrawl-client wrapper (Group 2):
 *   - `FIRECRAWL_ROBOTS_BLOCKED` → `ROBOTS_BLOCKED`
 *   - `FIRECRAWL_QUOTA_EXCEEDED` → `QUOTA_EXCEEDED`
 *   - `FIRECRAWL_TIMEOUT`        → `TIMEOUT`
 *   - everything else            → `UNKNOWN`
 */
export type UrlCrawlFailureStage =
	| "firecrawl-scrape"
	| "firecrawl-crawl"
	| "embed"
	| "upsert"
	| "unknown";
export type UrlCrawlFailureErrorType =
	| "ROBOTS_BLOCKED"
	| "QUOTA_EXCEEDED"
	| "TIMEOUT"
	| "UNKNOWN";

export function classifyFailureStage(error: unknown): UrlCrawlFailureStage {
	if (error instanceof ActivityFailure) {
		const at = error.activityType;
		if (at === "firecrawlScrapeActivity") {
			return "firecrawl-scrape";
		}
		if (at === "firecrawlCrawlActivity") {
			return "firecrawl-crawl";
		}
		if (at === "embedUrlPageActivity") {
			return "embed";
		}
		if (at === "embedSingleContextActivity") {
			return "embed";
		}
		if (at === "upsertUrlPageActivity") {
			return "upsert";
		}
	}
	return "unknown";
}

/**
 * Detect a user-driven cancellation in a workflow's `catch` block. Temporal
 * propagates cancel as `CancelledFailure`, sometimes wrapped in
 * `ActivityFailure` when an activity was in flight at cancel time. Walks the
 * cause chain so we don't miss a deeply-wrapped CancelledFailure.
 */
export function isCancellation(error: unknown): boolean {
	const unwrap = (e: unknown): unknown => {
		if (e instanceof ActivityFailure && e.cause) {
			return unwrap(e.cause);
		}
		return e;
	};
	return unwrap(error) instanceof CancelledFailure;
}

export function classifyFailureErrorType(
	error: unknown,
): UrlCrawlFailureErrorType {
	const unwrap = (e: unknown): unknown => {
		if (e instanceof ActivityFailure && e.cause) {
			return unwrap(e.cause);
		}
		return e;
	};
	const inner = unwrap(error);
	if (inner instanceof ApplicationFailure) {
		const t = inner.type ?? "";
		if (t === "FIRECRAWL_ROBOTS_BLOCKED") {
			return "ROBOTS_BLOCKED";
		}
		if (t === "FIRECRAWL_QUOTA_EXCEEDED") {
			return "QUOTA_EXCEEDED";
		}
		if (t === "FIRECRAWL_TIMEOUT") {
			return "TIMEOUT";
		}
	}
	return "UNKNOWN";
}

/**
 * Walk an `ActivityFailure` / `ApplicationFailure` `cause` chain to surface
 * the meaningful Firecrawl message instead of Temporal's generic outer
 * wrapper ("Activity task failed"). Mirrors the helper used by the PM-sync
 * workflow (`unwrapPmSyncError`) — kept local so this file stays
 * workflow-sandbox-safe (no imports outside `@temporalio/workflow`).
 *
 * Without this, the parent `ProjectContext.extractionError` ended up
 * storing "Activity task failed" for every crawl failure — making the
 * failed-card tooltip useless. Now we drill into `cause.message` (typed
 * `ApplicationFailure` from `firecrawl-crawl-activity.ts`) so the user
 * sees the real reason (e.g. "Firecrawl returned 429 (rate limited) —
 * check your Firecrawl plan.").
 *
 * Exported so it's directly unit-testable without spinning up a workflow.
 */
export function extractMeaningfulErrorMessage(error: unknown): string {
	const GENERIC = new Set([
		"Activity task failed",
		"Workflow execution failed",
	]);

	let current: unknown = error;
	let depth = 0;
	let best = "";

	while (current != null && depth < 8) {
		const e = current as { message?: unknown; cause?: unknown };
		const message = typeof e.message === "string" ? e.message : "";
		if (message && !GENERIC.has(message)) {
			best = message;
		}
		current = e.cause;
		depth += 1;
	}

	if (best) {
		return best.slice(0, 500);
	}

	if (error instanceof ApplicationFailure) {
		return (error.message ?? error.type ?? "Url source crawl failed").slice(
			0,
			500,
		);
	}
	if (error instanceof Error) {
		return (error.message || "Unknown error").slice(0, 500);
	}
	return "Unknown error";
}

/**
 * Deterministic "now" inside the workflow sandbox.
 *
 * In the Temporal TypeScript SDK, `Date.now()` is patched to return the
 * workflow's logical time (the event time recorded in history), so it's
 * deterministic on replay. The repo's other workflows (`agent-supervisor`,
 * `approval-workflow`, `batch-document-generation`, etc.) call `new Date()`
 * and `Date.now()` directly for the same reason. We funnel through this
 * helper so the determinism smoke test can allowlist this one call site.
 */
function workflowNow(): number {
	return Date.now();
}

// ---------------------------------------------------------------------------
// Activity proxies (one config per latency profile)
// ---------------------------------------------------------------------------

const {
	firecrawlScrapeActivity,
	upsertUrlPageActivity,
	updateParentStatusActivity,
	pruneOrphanUrlPagesActivity,
	bulkInitUrlPagesActivity,
} = proxyActivities<typeof activities>({
	startToCloseTimeout: "1 minute",
	retry: {
		initialInterval: "1s",
		maximumInterval: "30s",
		backoffCoefficient: 2,
		maximumAttempts: 3,
	},
});

// Per-URL scrape used by the SPLIT path-prefix branch. Same provider, same
// retry policy as the SINGLE_PAGE scrape — but with a separate proxy so the
// timeout reflects path-prefix's per-page reality (a JS-rendered help-center
// article can take 30-90s end-to-end including settle + selector wait +
// extraction). Heartbeat doesn't matter here — each scrape is short enough
// that a single heartbeat-timeout window is fine.
const {
	firecrawlScrapeActivity: firecrawlScrapeForCrawlActivity,
	firecrawlMapActivity,
} = proxyActivities<typeof activities>({
	startToCloseTimeout: "5 minutes",
	retry: {
		initialInterval: "2s",
		maximumInterval: "30s",
		backoffCoefficient: 2,
		maximumAttempts: 3,
	},
});

const { firecrawlCrawlActivity } = proxyActivities<typeof activities>({
	// 120 min budget. The map+scrape pipeline runs N URLs through /v1/scrape
	// at concurrency 1 (Firecrawl-side rate-limit-friendly) with a 5-min
	// Firecrawl-side timeout per page, plus the 500-page upper bound from
	// the API. Worst-case 500 pages × ~10s = ~85 min + map overhead;
	// 120 min gives headroom. Matches the activity's own elapsed-time
	// budget in `crawlSite` (DEFAULT_CRAWL_OVERALL_TIMEOUT_MS = 119 min)
	// so the activity returns a partial-success result rather than being
	// killed by Temporal mid-run.
	startToCloseTimeout: "120 minutes",
	heartbeatTimeout: "30 seconds",
	retry: {
		initialInterval: "2s",
		maximumInterval: "60s",
		backoffCoefficient: 2,
		maximumAttempts: 3,
	},
});

const { embedUrlPageActivity, embedSingleContextActivity } = proxyActivities<
	typeof activities
>({
	startToCloseTimeout: "5 minutes",
	heartbeatTimeout: "30 seconds",
	retry: {
		initialInterval: "1s",
		maximumInterval: "30s",
		backoffCoefficient: 2,
		maximumAttempts: 3,
	},
});

// ---------------------------------------------------------------------------
// Public input/output contract
// ---------------------------------------------------------------------------

export type UrlSourceScope = "SINGLE_PAGE" | "PATH_PREFIX";
export type UrlRefreshMode = "ONCE" | "DAILY" | "WEEKLY" | "MONTHLY" | "LIVE";
/**
 * Crawl execution mode.
 *
 *   - `initial`             → first add via processLink.
 *   - `manual-resync`       → user clicked Re-sync now (forces re-embed
 *                             even when content hash matches).
 *   - `scheduled`           → Temporal Schedule fire.
 *   - `retry-single-page`   → user retried one FAILED row from the
 *                             full-view child list. Scrapes + upserts +
 *                             embeds exactly one URL (`retryPageUrl`),
 *                             does not re-crawl siblings, and does not
 *                             touch `urlLastSyncedAt` /
 *                             `urlNextRefreshAt` on the parent (the
 *                             schedule remains the source of truth for
 *                             those).
 */
export type UrlCrawlMode =
	| "initial"
	| "manual-resync"
	| "scheduled"
	| "retry-single-page";

export type UrlSourceProviderName =
	| "firecrawl"
	| "jina"
	| "tavily"
	| "exa"
	| "parallel";

export interface UrlSourceCrawlWorkflowInput {
	contextId: string;
	url: string;
	scope: UrlSourceScope;
	maxPages: number;
	projectId: string;
	userId: string | null;
	organizationId: string | null;
	apiKey: string;
	/**
	 * Multi-provider routing (commit 3 of 3, multi-provider PR). Optional so
	 * that legacy in-flight workflows (started before this field shipped)
	 * continue to work — the activities default to Firecrawl when absent.
	 */
	providerName?: UrlSourceProviderName;
	urlRefreshMode?: UrlRefreshMode;
	parentSourceTitle?: string | null;
	mode?: UrlCrawlMode;
	/**
	 * Required when `mode === 'retry-single-page'`. The exact URL of the
	 * one child page to re-scrape + re-upsert + re-embed. Ignored for any
	 * other mode. The URL must already correspond to an existing
	 * `ProjectContextUrlPage` row under `contextId` — the workflow
	 * upserts in place rather than creating a new row.
	 */
	retryPageUrl?: string;
}

export interface UrlSourceCrawlWorkflowOutput {
	success: boolean;
	scope: UrlSourceScope;
	pagesIndexed: number;
	pagesSkipped: number;
	error?: string;
}

const BATCH_CONCURRENCY = 5;

// ---------------------------------------------------------------------------
// Pure helpers (no IO, no wall-clock — safe in the workflow sandbox)
// ---------------------------------------------------------------------------

/**
 * Derive the `includePaths` prefix from a URL's pathname. The Zendesk Help
 * Center driver (`/hc/en-us`) becomes `["/hc/en-us"]`. Single-segment or
 * root paths return an empty list — the downstream filter falls back to
 * "match everything under the host", letting Firecrawl decide.
 *
 * Pure / deterministic — safe in workflow code.
 *
 * Format note: returns BARE prefixes (no glob suffix). `filterByIncludePaths`
 * in `firecrawl-client.ts` accepts bare prefixes — `matchesPrefix` already
 * does the "pathname === prefix OR pathname starts with `${prefix}/`" check
 * directly. A previous version of this function returned `${prefix}/.*` to
 * signal regex/glob intent, but the filter compares strings literally; the
 * `.*` was matched verbatim, no real URL ever did, and the filter dropped
 * every discovered article. The crawl then fell back to scraping ONLY the
 * root URL via the zero-URL fallback path. Verified directly on staging:
 * after this fix lands, article URLs survive the filter and get scraped.
 */
export function deriveIncludePaths(url: string): string[] {
	let pathname: string;
	try {
		pathname = new URL(url).pathname;
	} catch {
		return [];
	}
	const trimmed = pathname.replace(/\/+$/, "");
	if (!trimmed || trimmed === "") {
		return [];
	}
	return [trimmed];
}

/**
 * Extract URLs from scraped markdown that point at the same origin and
 * sit under the same path prefix as the parent crawl. Used to grow the
 * scrape queue with links found IN page content that `/v1/map` missed
 * (some help-centers have articles linked from a hub page that don't
 * appear in the sitemap).
 *
 * Pure / deterministic — safe in workflow code. Replay reproduces the
 * same sequence because: same markdown input → same regex matches →
 * same filter outputs → same dedupe order.
 *
 * Normalisation rules:
 *  - Strip URL fragments (`#section`) so multiple anchors in a page don't
 *    each become their own scrape target.
 *  - Match Firecrawl's `/v1/map` output shape: keep query strings (some
 *    docs platforms use them as page selectors) and don't normalise
 *    trailing slashes (the prefix filter already handles both forms).
 *
 * Match shapes:
 *  - Markdown links: `[label](https://…)`
 *  - Bare URLs in the body
 *
 * Filter pipeline per URL: parsable → same-origin as `parentUrl` →
 * pathname matches at least one of `includePaths` (when non-empty;
 * mirrors `matchesPrefix` in firecrawl-client.ts).
 */
export function extractInPrefixLinks(
	markdown: string,
	parentUrl: string,
	includePaths?: readonly string[],
): string[] {
	let parentOrigin: string;
	try {
		parentOrigin = new URL(parentUrl).origin;
	} catch {
		return [];
	}

	// Two passes: markdown-link syntax first, then any remaining bare
	// http(s) URLs in the body. A `Set` dedupes the raw match strings
	// before normalisation; final dedupe happens against the workflow's
	// `seen` set so we don't re-queue URLs already scheduled.
	const linkRegex = /\[(?:[^\]]*?)\]\((https?:\/\/[^\s)]+)\)/g;
	const bareUrlRegex = /(?<![([])https?:\/\/[^\s<>()"`'\]]+/g;
	const raw = new Set<string>();
	let m: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex.exec
	while ((m = linkRegex.exec(markdown)) !== null) {
		raw.add(m[1]);
	}
	// biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex.exec
	while ((m = bareUrlRegex.exec(markdown)) !== null) {
		raw.add(m[0]);
	}

	const out: string[] = [];
	const seenNormalised = new Set<string>();
	for (const candidate of raw) {
		let u: URL;
		try {
			u = new URL(candidate);
		} catch {
			continue;
		}
		if (u.origin !== parentOrigin) {
			continue;
		}
		u.hash = ""; // strip fragments
		if (includePaths && includePaths.length > 0) {
			const ok = includePaths.some(
				(prefix) =>
					u.pathname === prefix ||
					u.pathname.startsWith(`${prefix}/`),
			);
			if (!ok) {
				continue;
			}
		}
		const normalised = u.toString();
		if (seenNormalised.has(normalised)) {
			continue;
		}
		seenNormalised.add(normalised);
		out.push(normalised);
	}
	return out;
}

/**
 * Compute `urlNextRefreshAt` from the workflow's logical clock. Returns
 * `null` for cadences that don't get a schedule (ONCE / LIVE — Group 5
 * owns the Temporal Schedule for the recurring modes; this is the
 * informational "next run" timestamp persisted on the parent row).
 *
 * Pure: takes the clock as a parameter, returns a `Date`. The caller (the
 * workflow body) sources the clock via `workflowNow()`.
 */
export function computeNextRefreshAt(
	mode: UrlRefreshMode | undefined,
	nowMs: number,
): Date | null {
	if (!mode || mode === "ONCE" || mode === "LIVE") {
		return null;
	}
	const DAY_MS = 24 * 60 * 60 * 1000;
	switch (mode) {
		case "DAILY":
			return new Date(nowMs + DAY_MS);
		case "WEEKLY":
			return new Date(nowMs + 7 * DAY_MS);
		case "MONTHLY":
			return new Date(nowMs + 30 * DAY_MS);
		default:
			return null;
	}
}

/**
 * Emit the success-path `project_context_url_resynced` telemetry event per
 * The `initial` add path is handled by the client-side
 * `project_context_url_added` event in `ContextUploaderDialog` — the
 * workflow only emits the resync event for `manual-resync` and `scheduled`
 * invocations so the dashboard doesn't double-count fresh adds. Server-side
 * delivery is via structured log tagged `analytics_event` (see ROLLOUT.md).
 *
 * Pure / deterministic — only writes to the workflow log sink which Temporal
 * replays from history.
 */
function emitResyncTelemetry(args: {
	mode: UrlCrawlMode;
	pagesIndexed: number;
	durationMs: number;
	projectId: string;
	contextId: string;
}): void {
	if (args.mode === "initial") {
		return;
	}
	const trigger = args.mode === "manual-resync" ? "manual" : "scheduled";
	log.info("analytics_event", {
		event: "project_context_url_resynced",
		trigger,
		pagesIndexed: args.pagesIndexed,
		durationMs: args.durationMs,
		projectId: args.projectId,
		contextId: args.contextId,
	});
}

async function runBatched<T, R>(
	items: T[],
	concurrency: number,
	worker: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
	const results: PromiseSettledResult<R>[] = new Array(items.length);
	let cursor = 0;

	async function pump(): Promise<void> {
		while (cursor < items.length) {
			const myIndex = cursor++;
			try {
				const value = await worker(items[myIndex], myIndex);
				results[myIndex] = { status: "fulfilled", value };
			} catch (err) {
				results[myIndex] = { status: "rejected", reason: err };
			}
		}
	}

	const workers = Array.from(
		{ length: Math.min(concurrency, items.length) },
		() => pump(),
	);
	await Promise.all(workers);
	return results;
}

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

export async function urlSourceCrawlWorkflow(
	input: UrlSourceCrawlWorkflowInput,
): Promise<UrlSourceCrawlWorkflowOutput> {
	const {
		contextId,
		url,
		scope,
		maxPages,
		projectId,
		userId,
		organizationId,
		apiKey,
		providerName,
		urlRefreshMode,
		parentSourceTitle,
		mode = "initial",
		retryPageUrl,
	} = input;

	log.info("[UrlSourceCrawl] start", {
		contextId,
		url,
		scope,
		mode,
		workflowId: workflowInfo().workflowId,
	});

	let pagesIndexed = 0;
	let pagesSkipped = 0;
	const startedAtMs = workflowNow();

	try {
		// Retry mode: scrape + upsert + embed exactly one URL. We never
		// touch the parent's `extractionStatus` or the schedule fields —
		// the parent stays as the user left it (typically COMPLETED with
		// some FAILED children). Errors in this branch flow through the
		// same outer catch which records FAILED state on the parent; we
		// reset the child to FAILED with its own message via the upsert
		// activity's `extractionStatus` write.
		if (mode === "retry-single-page") {
			const targetUrl = retryPageUrl ?? url;
			if (!targetUrl) {
				throw ApplicationFailure.nonRetryable(
					"retry-single-page requires retryPageUrl",
					"URL_SOURCE_CRAWL_BAD_INPUT",
				);
			}

			const page = await firecrawlScrapeActivity({
				url: targetUrl,
				apiKey,
				...(providerName !== undefined ? { providerName } : {}),
			});

			const upsert = await upsertUrlPageActivity({
				parentContextId: contextId,
				projectId,
				pageUrl: page.pageUrl,
				pageTitle: page.pageTitle,
				content: page.markdown,
				etag: page.etag,
				lastModifiedHeader: page.lastModifiedHeader,
				userId,
				organizationId,
				// `manual-resync` mode forces re-embed even on hash match,
				// matching the user's intent ("retry this one page").
				mode: "manual-resync",
			});

			if (!upsert.skipped) {
				const effectiveUserId = userId ?? "";
				await embedUrlPageActivity({
					pageId: upsert.pageId,
					parentContextId: contextId,
					projectId,
					pageUrl: page.pageUrl,
					parentSourceTitle: parentSourceTitle ?? null,
					content: page.markdown,
					userId: effectiveUserId,
					organizationId: organizationId ?? undefined,
				});
				pagesIndexed = 1;
			} else {
				pagesSkipped = 1;
			}

			log.info("[UrlSourceCrawl] retry-single-page completed", {
				contextId,
				pageUrl: page.pageUrl,
				skipped: upsert.skipped,
			});

			return {
				success: true,
				scope,
				pagesIndexed,
				pagesSkipped,
			};
		}

		if (scope === "SINGLE_PAGE") {
			const page = await firecrawlScrapeActivity({
				url,
				apiKey,
				...(providerName !== undefined ? { providerName } : {}),
			});

			// Store markdown directly on the parent row (matches the legacy
			// LINK behavior — no child rows for single-page sources). The
			// finalize call below stamps COMPLETED + the timestamps; the
			// embed step right after lands chunks in Qdrant so RAG can find
			// the content. Earlier versions of this workflow expected an
			// out-of-band embedding kickoff that never existed — the result
			// was a scraped-but-blind context (UI showed Indexed, project_rag_query
			// returned no chunks). The patched gate below pins the new behavior
			// to fresh workflows only; replays of older histories never wrote
			// the embed command, so they must skip it for replay determinism.
			pagesIndexed = 1;

			const nextRefresh = computeNextRefreshAt(
				urlRefreshMode,
				workflowNow(),
			);

			await updateParentStatusActivity({
				contextId,
				extractionStatus: "COMPLETED",
				urlLastSyncedAt: new Date(workflowNow()),
				urlNextRefreshAt: nextRefresh,
				content: page.markdown,
				// Notification-emit fields. Gated
				// behind `patched()` so old in-flight histories — whose
				// `ScheduleActivityTask` event recorded the input WITHOUT
				// these fields — replay deterministically. Replays of fresh
				// histories (post-deploy) include the fields and trigger
				// the bell row inside the activity. Replay
				// determinism rule (`fabric/standards/backend/temporal.md`).
				...(patched("url-source-completion-notifications-2026-05-23")
					? {
							projectId,
							userId,
							organizationId,
							sourceUrl: url,
							pagesIndexed: 1,
						}
					: {}),
			});

			if (patched("url-source-embed-single-page-2026-05-15")) {
				// `userId` on the workflow input is `string | undefined`; the
				// embed activity expects a plain string. Mirrors the same
				// fallback used by the retry-single-page and PATH_PREFIX branches
				// when they call embedUrlPageActivity.
				const effectiveUserId = userId ?? "";
				try {
					await embedSingleContextActivity({
						contextId,
						projectId,
						userId: effectiveUserId,
						organizationId: organizationId ?? undefined,
						content: page.markdown,
						// Parent ProjectContext is created with type "LINK"
						// (see createLinkContext in @repo/database). Embedding
						// metadata.type drives chunk payload + filters; keep
						// in lockstep with how other LINK contexts are embedded.
						type: "LINK",
						metadata: {
							sourceUrl: page.pageUrl,
							sourceTitle: parentSourceTitle ?? undefined,
						},
					});
				} catch (embedError) {
					// Embedding is best-effort: the page is already scraped and
					// visible in the UI, so a transient embed failure shouldn't
					// flip the parent back to FAILED. Mirrors the path-prefix
					// branch's resilience — log + continue.
					log.warn("[UrlSourceCrawl] single-page embed failed", {
						contextId,
						pageUrl: page.pageUrl,
						error:
							embedError instanceof Error
								? embedError.message
								: String(embedError),
					});
				}
			}

			log.info("[UrlSourceCrawl] single-page completed", {
				contextId,
				pageUrl: page.pageUrl,
			});

			emitResyncTelemetry({
				mode,
				pagesIndexed,
				durationMs: workflowNow() - startedAtMs,
				projectId,
				contextId,
			});

			return {
				success: true,
				scope,
				pagesIndexed,
				pagesSkipped,
			};
		}

		// PATH_PREFIX branch
		const includePaths = deriveIncludePaths(url);

		// `patched()` gates the new split-activities path. Old workflow
		// histories (started before this deploy) hit the OLD single-
		// activity branch so replay deterministically matches the
		// command sequence recorded in their history. New workflows
		// take the SPLIT branch, which is restart-safe — see the
		// firecrawl-map-activity JSDoc for the root-cause analysis.
		// Pages are captured into this shared shape so the rest of the
		// workflow (prune-orphans, finalize, telemetry) is identical
		// between branches.
		const pages: Array<{
			pageUrl: string;
			pageTitle: string | null;
			markdown: string;
			etag?: string;
			lastModifiedHeader?: string;
		}> = [];

		// Tracks per-page outcomes (success/skipped/failed-upsert) so the
		// finalize step's totalIndexed math is identical in both branches.
		const upsertedSkipped: boolean[] = [];
		const upsertedPageIds: (string | null)[] = [];

		if (patched("url-source-split-map-and-per-url-scrape-2026-05-15")) {
			// NEW: map → per-URL scrape (sequential). Each scrape is its
			// own activity, so a worker restart only kills the in-flight
			// scrape; everything already upserted survives. Sticks with
			// concurrency=1 to keep the Azure-egress + Firecrawl render-
			// pool fix from the legacy crawlSite path.
			const mapResult = await firecrawlMapActivity({
				url,
				apiKey,
				...(providerName !== undefined ? { providerName } : {}),
				...(includePaths.length > 0 ? { includePaths } : {}),
				limit: maxPages,
			});

			log.info("[UrlSourceCrawl] map returned urls", {
				contextId,
				urlCount: mapResult.urls.length,
			});

			// Zero-URL fallback: mirror `crawlSite`'s behaviour — scrape
			// the root URL itself so the user still gets something
			// indexed when map found nothing under the requested path.
			const targets = mapResult.urls.length > 0 ? mapResult.urls : [url];

			// Bulk-init PENDING placeholder rows for every discovered URL
			// BEFORE we start the per-URL loop. Pure UX move: with this
			// the full-view child list shows the whole crawl set in one
			// shot (all rows in "Processing" state) and each one flips to
			// Indexed / Failed in place as the loop processes it. Without
			// this, rows appear one-by-one and the user has no idea how
			// many are left or what the total scope is.
			//
			// MUST have its OWN `patched()` gate, distinct from the outer
			// split-map-and-per-url-scrape one. Workflows started after
			// #987 deployed but BEFORE #991 already wrote the outer marker
			// AND already scheduled per-URL scrape activities — their
			// history goes straight from map → firecrawlScrapeActivity
			// with NO bulkInitUrlPagesActivity in between. Replaying them
			// under the post-#991 code without a second gate trips:
			//   "Activity type of scheduled event 'firecrawlScrapeActivity'
			//    does not match activity type of activity command
			//    'bulkInitUrlPagesActivity'"
			// Verified on CI replay-validation against the in-flight
			// `url-crawl-cmp73drpm000004icz9novjme` history. Adding the
			// dedicated marker makes the bulk-init skippable for those
			// histories while NEW workflows write the marker and call it.
			//
			// Idempotent on re-syncs (skips URLs already present), so the
			// existing rows from a partial earlier crawl survive.
			if (patched("url-source-bulk-init-pending-rows-2026-05-15")) {
				await bulkInitUrlPagesActivity({
					parentContextId: contextId,
					projectId,
					urls: targets,
					userId,
					organizationId,
				});
			}

			// Per-URL scrape loop. Each iteration is bounded: scrape (≤5
			// min) → upsert (≤1 min) → optional embed (≤5 min). A worker
			// restart at any point only loses the one URL currently
			// in flight; everything written so far is durable.
			//
			// Queue + seen-set so we can grow `targets` mid-loop via
			// link-following (next gate below). For legacy workflows
			// that don't follow links, `queue` is just `targets` and
			// behaves identically to the old `for-of`.
			const seenUrls = new Set<string>(targets);
			const queue: string[] = [...targets];
			const followLinks = patched(
				"url-source-follow-content-links-2026-05-15",
			);

			while (queue.length > 0) {
				const targetUrl = queue.shift() as string;
				let page: {
					pageUrl: string;
					pageTitle: string | null;
					markdown: string;
					etag?: string;
					lastModifiedHeader?: string;
				};
				try {
					page = await firecrawlScrapeForCrawlActivity({
						url: targetUrl,
						apiKey,
						...(providerName !== undefined ? { providerName } : {}),
					});
				} catch (scrapeError) {
					log.warn("[UrlSourceCrawl] per-url scrape failed", {
						pageUrl: targetUrl,
						reason:
							scrapeError instanceof Error
								? scrapeError.message
								: String(scrapeError),
					});
					continue;
				}
				pages.push(page);

				let upsert: { pageId: string; skipped: boolean };
				try {
					upsert = await upsertUrlPageActivity({
						parentContextId: contextId,
						projectId,
						pageUrl: page.pageUrl,
						pageTitle: page.pageTitle,
						content: page.markdown,
						etag: page.etag,
						lastModifiedHeader: page.lastModifiedHeader,
						userId,
						organizationId,
						mode,
					});
				} catch (upsertError) {
					log.warn("[UrlSourceCrawl] upsert failed", {
						pageUrl: page.pageUrl,
						reason:
							upsertError instanceof Error
								? upsertError.message
								: String(upsertError),
					});
					upsertedSkipped.push(false);
					upsertedPageIds.push(null);
					continue;
				}
				upsertedSkipped.push(upsert.skipped);
				upsertedPageIds.push(upsert.pageId);

				if (upsert.skipped) {
					pagesSkipped++;
				} else {
					try {
						const effectiveUserId = userId ?? "";
						await embedUrlPageActivity({
							pageId: upsert.pageId,
							parentContextId: contextId,
							projectId,
							pageUrl: page.pageUrl,
							parentSourceTitle: parentSourceTitle ?? null,
							content: page.markdown,
							userId: effectiveUserId,
							organizationId: organizationId ?? undefined,
						});
						pagesIndexed++;
					} catch (embedError) {
						log.warn("[UrlSourceCrawl] embed failed", {
							pageUrl: page.pageUrl,
							reason:
								embedError instanceof Error
									? embedError.message
									: String(embedError),
						});
					}
				}

				// Link-following step. After each successful scrape we
				// parse the markdown for same-origin + same-prefix URLs
				// the user CARED about but `/v1/map` didn't return — some
				// help-centres have leaf articles linked from a hub page
				// that aren't in the sitemap. New discoveries are queued
				// in the SAME loop with the same per-URL activity, so
				// they inherit all the restart-resilience properties.
				//
				// Bounded by `maxPages`: once `seenUrls.size` hits the
				// cap we stop enqueuing new ones. The map step's initial
				// `limit: maxPages` keeps the starting set within the
				// cap; this guard ensures discovery never breaches it.
				//
				// Gated by its own `patched()` marker because adding new
				// scrape activities mid-loop changes the workflow command
				// sequence — old histories don't have these and would
				// trip non-determinism on replay. Legacy workflows skip
				// the block entirely; only fresh ones explore links.
				if (followLinks && seenUrls.size < maxPages) {
					const newLinks = extractInPrefixLinks(
						page.markdown,
						url,
						includePaths.length > 0 ? includePaths : undefined,
					);
					for (const link of newLinks) {
						if (seenUrls.size >= maxPages) {
							break;
						}
						if (seenUrls.has(link)) {
							continue;
						}
						seenUrls.add(link);
						queue.push(link);
					}
				}
			}
		} else {
			// LEGACY: single big firecrawlCrawlActivity that does map +
			// all scrapes + returns the full list. Kept ONLY so old
			// histories replay deterministically. New crawls take the
			// patched branch above.
			const legacyPages = await firecrawlCrawlActivity({
				url,
				apiKey,
				...(providerName !== undefined ? { providerName } : {}),
				includePaths:
					includePaths.length > 0 ? includePaths : undefined,
				limit: maxPages,
				sitemap: "include",
			});

			log.info("[UrlSourceCrawl] crawl returned pages", {
				contextId,
				pageCount: legacyPages.length,
			});

			for (const p of legacyPages) {
				pages.push(p);
			}

			const upsertOutcomes = await runBatched(
				legacyPages,
				BATCH_CONCURRENCY,
				(page) =>
					upsertUrlPageActivity({
						parentContextId: contextId,
						projectId,
						pageUrl: page.pageUrl,
						pageTitle: page.pageTitle,
						content: page.markdown,
						etag: page.etag,
						lastModifiedHeader: page.lastModifiedHeader,
						userId,
						organizationId,
						mode,
					}),
			);

			type EmbedJob = {
				pageId: string;
				pageUrl: string;
				content: string;
			};
			const embedJobs: EmbedJob[] = [];

			for (let i = 0; i < legacyPages.length; i++) {
				const outcome = upsertOutcomes[i];
				const page = legacyPages[i];
				if (outcome.status !== "fulfilled") {
					log.warn("[UrlSourceCrawl] upsert failed", {
						pageUrl: page.pageUrl,
						reason: String(outcome.reason),
					});
					continue;
				}
				if (outcome.value.skipped) {
					pagesSkipped++;
					continue;
				}
				embedJobs.push({
					pageId: outcome.value.pageId,
					pageUrl: page.pageUrl,
					content: page.markdown,
				});
			}

			if (embedJobs.length > 0) {
				const effectiveUserId = userId ?? "";
				const embedOutcomes = await runBatched(
					embedJobs,
					BATCH_CONCURRENCY,
					(job) =>
						embedUrlPageActivity({
							pageId: job.pageId,
							parentContextId: contextId,
							projectId,
							pageUrl: job.pageUrl,
							parentSourceTitle: parentSourceTitle ?? null,
							content: job.content,
							userId: effectiveUserId,
							organizationId: organizationId ?? undefined,
						}),
				);

				for (const outcome of embedOutcomes) {
					if (
						outcome.status === "fulfilled" &&
						outcome.value.success
					) {
						pagesIndexed++;
					}
				}
			}
		}

		// Prune orphans: delete `ProjectContextUrlPage` rows under this
		// parent whose URL did not appear in the current crawl. Handles
		// the "63 indexed > 40 max pages" UX bug — when a user lowers
		// `maxPages` (or the site removes pages, or the scope narrows),
		// the prior crawl's rows hang around and inflate the count.
		// Trimming here keeps `_count.urlPages` in line with the user's
		// configured cap.
		//
		// Wrapped in `patched()` because inserting a new activity into
		// the workflow's command sequence is non-deterministic against
		// pre-existing histories — Temporal's replay validator (the
		// `replay-validation` CI job) flags it as
		// "Activity type of scheduled event 'updateParentStatusActivity'
		// does not match activity type of activity command
		// 'pruneOrphanUrlPagesActivity'". `patched()` writes a marker
		// into new histories; replays of OLD histories return false
		// (skipping the prune) so the command sequence still matches
		// what's recorded.
		//
		// Once every in-flight crawl from before this deploy has
		// finished (max 119 min activity timeout + retries — call it a
		// day to be safe), we can drop the conditional and call the
		// activity unconditionally. Until then, keep this guard.
		if (patched("url-source-prune-orphans-2026-05-15")) {
			const keptUrls = pages.map((p) => p.pageUrl);
			await pruneOrphanUrlPagesActivity({
				parentContextId: contextId,
				keptUrls,
			});
		}

		// Pages whose content was unchanged still count as "indexed" from the
		// user's POV — the row is present, has a Qdrant id from the prior
		// run, and participates in retrieval. Roll skipped into indexed for
		// the parent's pages-indexed metric.
		const totalIndexed = pagesIndexed + pagesSkipped;
		const nextRefresh = computeNextRefreshAt(urlRefreshMode, workflowNow());

		await updateParentStatusActivity({
			contextId,
			extractionStatus: "COMPLETED",
			urlLastSyncedAt: new Date(workflowNow()),
			urlNextRefreshAt: nextRefresh,
			// Notification-emit fields. Gated for
			// replay-determinism — see the SINGLE_PAGE call above for the
			// rationale.
			...(patched("url-source-completion-notifications-2026-05-23")
				? {
						projectId,
						userId,
						organizationId,
						sourceUrl: url,
						pagesIndexed: totalIndexed,
					}
				: {}),
		});

		log.info("[UrlSourceCrawl] path-prefix completed", {
			contextId,
			pagesIndexed: totalIndexed,
			newlyEmbedded: pagesIndexed,
			skippedUnchanged: pagesSkipped,
		});

		emitResyncTelemetry({
			mode,
			pagesIndexed: totalIndexed,
			durationMs: workflowNow() - startedAtMs,
			projectId,
			contextId,
		});

		return {
			success: true,
			scope,
			pagesIndexed: totalIndexed,
			pagesSkipped,
		};
	} catch (error) {
		// Was this a user-driven cancellation? Temporal propagates cancel as
		// `CancelledFailure` (sometimes wrapped in `ActivityFailure` when an
		// activity was in flight at cancel time). Treat as a clean partial-
		// success: finalize the parent to CANCELLED (terminal-but-distinct
		// from COMPLETED so the UI renders "Cancelled"), keep already-
		// indexed pages, clear `urlActiveWorkflowId` so future re-syncs
		// can start. Pages embedded so far survive in
		// ProjectContextUrlPage + Qdrant.
		const cancelled = isCancellation(error);
		if (cancelled) {
			log.info("[UrlSourceCrawl] cancelled by user", {
				contextId,
				pagesIndexedSoFar: pagesIndexed,
				pagesSkippedSoFar: pagesSkipped,
			});
			try {
				const nextRefreshOnCancel = computeNextRefreshAt(
					urlRefreshMode,
					workflowNow(),
				);
				// Gate the cancel-path finalize behind `patched()`. The
				// pre-#980 cancel-path scheduled `updateParentStatusActivity`
				// inside the default (cancelled) scope, where Temporal
				// cancels it before it runs — so old histories for cancelled
				// workflows ended without an activity finalize, going
				// straight to WorkflowExecutionCompleted. Replaying those
				// histories with the new nonCancellable finalize would try
				// to schedule an activity at a point where history has
				// WorkflowExecutionCompleted, surfacing as
				// "Activity machine does not handle this event:
				// WorkflowExecutionCompleted" in CI replay-validation.
				// `patched()` makes the finalize opt-in per workflow: only
				// runs for histories started after this deploy.
				if (
					patched(
						"url-source-cancel-path-noncancellable-finalize-2026-05-15",
					)
				) {
					// Run finalize in a non-cancellable scope. The default
					// workflow scope is already cancelled (that's how we got
					// here), so any activity scheduled inside it would be
					// cancelled before it started — leaving the parent row
					// stuck in EXTRACTING.
					// If we already indexed at least one page before the
					// cancel reached us, that data is real and usable —
					// retrieval can search it, the user can download / view
					// / cite the indexed rows. Stamping "CANCELLED" in that
					// case makes the row look like nothing got done. Treat
					// any cancel with `pagesIndexed > 0` as a SUCCESSFUL
					// partial completion (COMPLETED status + bump
					// `urlLastSyncedAt` so the row presents like a normal
					// finish). CANCELLED is reserved for the genuine
					// "nothing indexed" case where the user really did
					// throw away all the work.
					const cancelledWithProgress =
						pagesIndexed + pagesSkipped > 0;
					const finalStatus = cancelledWithProgress
						? "COMPLETED"
						: "CANCELLED";
					const finalLastSyncedAt = cancelledWithProgress
						? new Date(workflowNow())
						: null;
					await CancellationScope.nonCancellable(async () => {
						await updateParentStatusActivity({
							contextId,
							extractionStatus: finalStatus,
							urlLastSyncedAt: finalLastSyncedAt,
							urlNextRefreshAt: nextRefreshOnCancel,
							extractionError: null,
							// Notification-emit fields, gated for replay
							// determinism. When finalStatus is COMPLETED
							// (cancel-with-progress), the user gets a
							// "Indexed N pages" row. When it's CANCELLED,
							// the emit helper is silent for CANCELLED.
							...(patched(
								"url-source-completion-notifications-2026-05-23",
							)
								? {
										projectId,
										userId,
										organizationId,
										sourceUrl: url,
										pagesIndexed:
											pagesIndexed + pagesSkipped,
									}
								: {}),
						});
					});
				}
			} catch (finalizeError) {
				log.error(
					"[UrlSourceCrawl] failed to finalize after cancellation",
					{
						contextId,
						finalizeError:
							finalizeError instanceof Error
								? finalizeError.message
								: String(finalizeError),
					},
				);
			}
			return {
				success: true,
				scope,
				pagesIndexed: pagesIndexed + pagesSkipped,
				pagesSkipped,
			};
		}

		// Walk the cause chain — Temporal wraps activity throws in an
		// `ActivityFailure` whose own `.message` is just "Activity task
		// failed". The real Firecrawl reason lives in
		// `.cause` (`ApplicationFailure`) thrown by
		// `firecrawl-crawl-activity.ts`. Without unwrapping, every
		// failed crawl ended up persisting "Activity task failed" to
		// `ProjectContext.extractionError` and the failed-card tooltip
		// in `ProjectContextsList`/`FailedUrlBadge` was useless.
		const errorMessage = extractMeaningfulErrorMessage(error);

		const failureStage = classifyFailureStage(error);
		const failureErrorType = classifyFailureErrorType(error);

		log.error("[UrlSourceCrawl] failed", {
			contextId,
			error: errorMessage,
			stage: failureStage,
			errorType: failureErrorType,
		});

		// Group 10.1 telemetry: `project_context_url_crawl_failed`. Server-side
		// emitted as a structured log event tagged `analytics_event` so the
		// ops dashboard can route it without an HTTP analytics dependency. See
		// `ROLLOUT.md` for the Datadog/Grafana query.
		log.info("analytics_event", {
			event: "project_context_url_crawl_failed",
			stage: failureStage,
			errorType: failureErrorType,
			projectId,
			contextId,
		});

		// retry-single-page failures DO NOT touch the parent row — the
		// parent's status (typically COMPLETED with mixed children) must
		// remain accurate. Marking it FAILED here would falsely red-flag
		// the entire URL source when only one child failed. The child
		// page's own `extractionStatus` was already left in PENDING by
		// the API procedure when it kicked us off; an in-flight Firecrawl
		// failure means the upsert activity didn't run, so the row keeps
		// its prior FAILED state. The user's UI sees the failure as the
		// retry button reverting (status pill stays FAILED).
		if (mode === "retry-single-page") {
			throw ApplicationFailure.nonRetryable(
				errorMessage,
				"URL_SOURCE_CRAWL_FAILED",
			);
		}

		// Best-effort finalize; if THIS fails Temporal records the original
		// error and the parent row stays in EXTRACTING (the reconciliation
		// script in Group 5 can sweep stuck rows).
		try {
			await updateParentStatusActivity({
				contextId,
				extractionStatus: "FAILED",
				extractionError: errorMessage,
				urlLastSyncedAt: null,
				urlNextRefreshAt: null,
				// Notification-emit fields ("completed", FAILED
				// branch). Gated for replay determinism — see the
				// SINGLE_PAGE COMPLETED call for the same rationale. Emits
				// "Failed to index ${url}" + extractionError as snippet.
				...(patched("url-source-completion-notifications-2026-05-23")
					? {
							projectId,
							userId,
							organizationId,
							sourceUrl: url,
							pagesIndexed: pagesIndexed + pagesSkipped,
						}
					: {}),
			});
		} catch (finalizeError) {
			log.error("[UrlSourceCrawl] failed to finalize FAILED state", {
				contextId,
				finalizeError:
					finalizeError instanceof Error
						? finalizeError.message
						: String(finalizeError),
			});
		}

		throw ApplicationFailure.nonRetryable(
			errorMessage,
			"URL_SOURCE_CRAWL_FAILED",
		);
	}
}
