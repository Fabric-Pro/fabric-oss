/**
 * pollStatusPage activity.
 *
 * Fetches a provider's status-page data endpoint and normalizes the
 * response into a `{ openIncident, shouldCloseExisting, health, severity }`
 * shape the workflow can act on.
 *
 * Default path: an Atlassian Statuspage `summary.json` endpoint. Non-
 * Atlassian providers (Google Workspace / Google Cloud / Slack /
 * status.io-hosted pages / Zendesk SSP) opt in via the `customParser`
 * discriminator wired from `@repo/observability`'s registry. The
 * dispatch happens BEFORE the default parse so the response shape
 * doesn't have to be guessed at parse time.
 *
 * Determinism: this activity wraps a fetch — it lives outside the workflow
 * sandbox by design (per `fabric/standards/backend/temporal.md`).
 *
 * Error policy: NEVER throws on transport / non-2xx / parse failures. The
 * Statuspage cron iterates every registered provider and must keep going
 * even if one provider's endpoint is flaky. Instead, we return
 * `{ health: "UNKNOWN", openIncident: null, shouldCloseExisting: false }`.
 *
 * Timeout: 10s per call. Statuspage usually responds in <500ms; anything
 * longer signals the provider's status infrastructure itself is degraded.
 *
 * Outbound headers:
 *   - `User-Agent: Fabric-Monitoring/1.0 (+https://fabric.pro/status)` —
 *     identifies our automated traffic to vendors per their docs'
 *     guidance for poll consumers.
 *   - `Accept: application/json` — most endpoints content-negotiate based
 *     on this header (e.g. without it Notion's incident.io host serves
 *     the SPA HTML on the same URL).
 *
 * 429 backoff: if a provider returns `429 Too Many Requests` with a
 * `Retry-After` header, the activity logs the suggested wait and
 * surfaces UNKNOWN. Temporal's activity retry policy handles the
 * actual backoff — we don't `setTimeout` inside the activity (which
 * would block the worker thread).
 */
import { log } from "@temporalio/activity";
import type { IncidentSeverity, ProviderHealthStatus } from "./shared-types";

const FETCH_TIMEOUT_MS = 10_000;

/**
 * Identifies Fabric's status-page poller to upstream vendors. Atlassian,
 * Google, and Slack all recommend setting a descriptive UA on automated
 * pollers so they can identify and (if needed) contact us. Kept as a
 * constant — no env-var indirection required.
 */
const POLLER_USER_AGENT = "Fabric-Monitoring/1.0 (+https://fabric.pro/status)";

/**
 * Atlassian Statuspage `status.indicator` enum (verbatim from the public
 * API contract). We accept any string defensively to absorb provider
 * variance — unknown values map to `UNKNOWN`.
 */
type StatuspageIndicator =
	| "none"
	| "minor"
	| "major"
	| "critical"
	| "maintenance"
	| string;

/**
 * Subset of the Statuspage `summary.json` payload we read. Documented at:
 *   https://developer.statuspage.io/#operation/getPagesPageIdSummary
 * Only the fields we need are typed — everything else is ignored.
 */
interface StatuspageSummary {
	status?: {
		indicator?: StatuspageIndicator;
		description?: string;
	};
	incidents?: Array<{
		id: string;
		name: string;
		status?: string; // "investigating" | "identified" | "monitoring" | "resolved" | "postmortem"
		impact?: string;
		components?: Array<{ name?: string; status?: string }>;
	}>;
}

export interface PollStatusPageInput {
	/** Provider registry key — passed through to the workflow on the response. */
	providerKey: string;
	/** Status-page data endpoint URL. */
	url: string;
	/**
	 * When set, dispatches to a non-Atlassian parser BEFORE attempting
	 * the default `summary.json` decode. Unset = Atlassian default.
	 */
	customParser?:
		| "google-workspace"
		| "google-cloud"
		| "slack"
		| "status-io"
		| "zendesk-ssp"
		| "salesforce";
	/** For the `google-workspace` parser. Narrow on `service_name`. */
	googleWorkspaceServiceName?: string;
	/** For the `google-cloud` parser. Narrow on `affected_products[].title`. */
	googleCloudProductTitle?: string;
	/** For the `zendesk-ssp` parser. Narrow on service `attributes.slug`. */
	zendeskServiceSlug?: string;
	/**
	 * Atlassian Statuspage component-name allow-list. When set, the
	 * default parser only treats an incident as active when at least one
	 * of its `incident.components[].name` entries matches an entry here
	 * (case-insensitive). Empty / undefined = all incidents.
	 *
	 * Used for multi-component pages (e.g., Cloudflare's
	 * `status.cloudflarestatus.com`) where Fabric only cares about a
	 * subset of the provider's surface (e.g., R2, not Billing).
	 */
	statusPageComponents?: string[];
}

export interface PollStatusPageOpenIncident {
	/** Provider's incident ID — used as the unique dedupe key in the DB. */
	id: string;
	/** Free-text incident name shown in the admin UI. */
	name: string;
	/** Component names that the provider lists as affected. */
	affectedComponents: string[];
}

export interface PollStatusPageOutput {
	/** Provider registry key (echoed back from input). */
	providerKey: string;
	/** Normalized provider health for this poll. */
	health: ProviderHealthStatus;
	/** Severity derived from the indicator. Defaults to SEV2. */
	severity: IncidentSeverity;
	/** Non-null when the page reports an active incident. */
	openIncident: PollStatusPageOpenIncident | null;
	/**
	 * When the provider is OPERATIONAL but our DB has an active incident
	 * for this provider, the workflow should close it.
	 *
	 * The workflow owns the "2 consecutive operational polls" hysteresis
	 * (per L14) — this flag is only the per-poll signal.
	 */
	shouldCloseExisting: boolean;
	/** Raw indicator string (for forensic logging). */
	rawIndicator: string;
}

/**
 * Map Statuspage `status.indicator` → our `ProviderHealthStatus` enum.
 *
 * `none → OPERATIONAL`, `minor → DEGRADED`, `major →
 * PARTIAL_OUTAGE`, `critical → MAJOR_OUTAGE`, `maintenance → MAINTENANCE`.
 * Anything else (including missing field) → UNKNOWN.
 */
function indicatorToHealth(
	indicator: StatuspageIndicator | undefined,
): ProviderHealthStatus {
	switch (indicator) {
		case "none":
			return "OPERATIONAL";
		case "minor":
			return "DEGRADED";
		case "major":
			return "PARTIAL_OUTAGE";
		case "critical":
			return "MAJOR_OUTAGE";
		case "maintenance":
			return "MAINTENANCE";
		default:
			return "UNKNOWN";
	}
}

/**
 * Map health → our `IncidentSeverity` enum.
 *
 * Statuspage incidents default to SEV-2. We escalate to SEV-1 on
 * `MAJOR_OUTAGE` per the "critical means everyone is affected" reading.
 * DEGRADED stays SEV-2 (Teams + banner, no page).
 */
function healthToSeverity(health: ProviderHealthStatus): IncidentSeverity {
	switch (health) {
		case "MAJOR_OUTAGE":
			return "SEV1";
		default:
			return "SEV2";
	}
}

/**
 * Build the `UNKNOWN` fallback used by every error path. Centralized so
 * the shape is identical regardless of which decoder bailed.
 */
function unknownResult(input: PollStatusPageInput): PollStatusPageOutput {
	return {
		providerKey: input.providerKey,
		health: "UNKNOWN",
		severity: "SEV2",
		openIncident: null,
		shouldCloseExisting: false,
		rawIndicator: "unknown",
	};
}

/**
 * Defensive logger that no-ops if the Temporal activity context is not
 * available (e.g., when the activity is unit-tested without a worker
 * context attached).
 */
function tryLog(
	level: "info" | "warn",
	message: string,
	attrs: Record<string, unknown>,
): void {
	try {
		if (level === "warn") {
			log.warn(message, attrs);
		} else {
			log.info(message, attrs);
		}
	} catch {
		// No-op outside of an activity context (unit tests).
	}
}

/**
 * Sentinel returned by `fetchJson` when the response is unusable
 * (transport failure, non-2xx, non-JSON content-type, or a JSON parse
 * error). A unique `Symbol` is used so a legitimate JSON value of
 * `null` / `undefined` / arbitrary string is never confused with the
 * error path.
 */
const FETCH_FAILED = Symbol("pollStatusPage.fetchFailed");

/**
 * Internal fetch helper. Adds the User-Agent + Accept headers, applies
 * the 10s timeout, and surfaces `Retry-After` for 429 responses.
 */
async function fetchJson(
	url: string,
	signal: AbortSignal,
	providerKey: string,
): Promise<unknown | typeof FETCH_FAILED> {
	const response = await fetch(url, {
		method: "GET",
		signal,
		headers: {
			Accept: "application/json",
			"User-Agent": POLLER_USER_AGENT,
		},
		// Some incident.io hosts return JSON-only when redirected to the
		// migrated domain; we still want the body of the final response.
		redirect: "follow",
	});

	if (response.status === 429) {
		const retryAfter = response.headers.get("retry-after");
		tryLog("warn", "Status page returned 429 Too Many Requests", {
			providerKey,
			url,
			retryAfter: retryAfter ?? undefined,
		});
		return FETCH_FAILED;
	}

	if (!response.ok) {
		tryLog("warn", "Status page returned non-2xx", {
			providerKey,
			url,
			httpStatus: response.status,
		});
		return FETCH_FAILED;
	}

	// Content-type sniffing — some vendors (incident.io HTML pages, the
	// old Notion host) return 200 + `text/html` on the same URL when
	// content negotiation goes wrong. Trying to JSON.parse the body in
	// that case yields a confusing SyntaxError; the explicit guard logs
	// the mismatch so we can spot URL drift in Application Insights.
	//
	// Note: when `Response` is mocked in unit tests, the headers map may
	// be undefined; we treat a missing content-type as "trust the test
	// fixture" and proceed to JSON parse.
	const contentType = response.headers?.get?.("content-type");
	if (contentType && !contentType.toLowerCase().includes("json")) {
		tryLog("warn", "Status page response is not JSON", {
			providerKey,
			url,
			contentType,
		});
		return FETCH_FAILED;
	}

	try {
		return await response.json();
	} catch (err) {
		tryLog("warn", "Status page JSON parse failed", {
			providerKey,
			url,
			error: err instanceof Error ? err.message : String(err),
		});
		return FETCH_FAILED;
	}
}

/**
 * Returns true when the incident affects at least one of the configured
 * `statusPageComponents` (case-insensitive name match), OR when no
 * filter is configured at all.
 *
 * Used by `parseAtlassian` to keep multi-component pages (Cloudflare's
 * Workers / R2 / Billing / Pages) from cross-polluting per-provider
 * health: a Cloudflare Billing incident should NOT make the R2 row
 * show "Major outage".
 */
function incidentMatchesComponentFilter(
	inc: NonNullable<StatuspageSummary["incidents"]>[number],
	filter: readonly string[] | undefined,
): boolean {
	if (!filter || filter.length === 0) {
		return true;
	}
	const wanted = new Set(filter.map((name) => name.toLowerCase()));
	for (const c of inc.components ?? []) {
		const name = (c.name ?? "").toLowerCase();
		if (wanted.has(name)) {
			return true;
		}
	}
	return false;
}

/**
 * Atlassian Statuspage `summary.json` parser — the default for any
 * provider without a `customParser` discriminator.
 *
 * When `statusPageComponents` is set on the input, we filter the
 * incidents array to only include incidents that affect one of the
 * configured components, and we DOWNGRADE the rollup indicator
 * accordingly: if the only incidents on the page are for components we
 * don't care about, the result becomes OPERATIONAL even when the page-
 * wide indicator says `minor` / `major` / `critical`.
 */
function parseAtlassian(
	input: PollStatusPageInput,
	json: unknown,
): PollStatusPageOutput {
	const summary = (json as StatuspageSummary) ?? {};
	if (!summary.status?.indicator) {
		tryLog("warn", "Atlassian summary missing status.indicator", {
			providerKey: input.providerKey,
			url: input.url,
		});
		return unknownResult(input);
	}

	const indicator = summary.status.indicator;
	const componentFilter = input.statusPageComponents;
	const hasComponentFilter = Boolean(
		componentFilter && componentFilter.length > 0,
	);

	// Live incidents excluding resolved/postmortem, then narrowed to the
	// configured component allow-list when one is provided.
	const liveIncidents = (summary.incidents ?? []).filter((inc) => {
		const status = (inc.status ?? "").toLowerCase();
		return status !== "resolved" && status !== "postmortem";
	});
	const relevantIncidents = hasComponentFilter
		? liveIncidents.filter((inc) =>
				incidentMatchesComponentFilter(inc, componentFilter),
			)
		: liveIncidents;
	const liveIncident = relevantIncidents[0];

	// When a component filter is set and no relevant incidents remain,
	// we override the page-wide indicator: the provider surface WE care
	// about is operational even if the rest of the platform is degraded.
	const effectiveHealth =
		hasComponentFilter && relevantIncidents.length === 0
			? "OPERATIONAL"
			: indicatorToHealth(indicator);
	const severity = healthToSeverity(effectiveHealth);

	if (effectiveHealth !== "OPERATIONAL" && liveIncident) {
		return {
			providerKey: input.providerKey,
			health: effectiveHealth,
			severity,
			openIncident: {
				id: liveIncident.id,
				name: liveIncident.name,
				affectedComponents: (liveIncident.components ?? [])
					.map((c) => c.name)
					.filter((name): name is string => Boolean(name)),
			},
			shouldCloseExisting: false,
			rawIndicator: indicator,
		};
	}

	if (effectiveHealth === "OPERATIONAL") {
		return {
			providerKey: input.providerKey,
			health: effectiveHealth,
			severity,
			openIncident: null,
			shouldCloseExisting: true,
			rawIndicator: indicator,
		};
	}

	return {
		providerKey: input.providerKey,
		health: effectiveHealth,
		severity,
		openIncident: null,
		shouldCloseExisting: false,
		rawIndicator: indicator,
	};
}

// =============================================================================
// Custom parsers
// =============================================================================

/**
 * Google Workspace / Google Cloud incident shape. Both feeds use the
 * identical schema — only the host and the filter field differ.
 */
interface GoogleIncident {
	id: string;
	number?: string;
	begin?: string;
	end?: string | null;
	external_desc?: string;
	service_name?: string;
	severity?: "low" | "medium" | "high" | string;
	status_impact?:
		| "SERVICE_INFORMATION"
		| "SERVICE_DISRUPTION"
		| "SERVICE_OUTAGE"
		| string;
	most_recent_update?: {
		status?: string;
		text?: string;
	};
	affected_products?: Array<{
		id?: string;
		title?: string;
	}>;
}

/**
 * Map a Google `status_impact` enum to our `ProviderHealthStatus`. Per
 * the public Google Workspace + Cloud documentation:
 *   - `SERVICE_OUTAGE`     → MAJOR_OUTAGE (full unavailability)
 *   - `SERVICE_DISRUPTION` → PARTIAL_OUTAGE (degraded performance / partial)
 *   - `SERVICE_INFORMATION` → DEGRADED (notice / minor info)
 */
function googleImpactToHealth(
	impact: string | undefined,
): ProviderHealthStatus {
	switch (impact) {
		case "SERVICE_OUTAGE":
			return "MAJOR_OUTAGE";
		case "SERVICE_DISRUPTION":
			return "PARTIAL_OUTAGE";
		case "SERVICE_INFORMATION":
			return "DEGRADED";
		default:
			return "UNKNOWN";
	}
}

/**
 * Extract a clean, single-line incident title from a Google
 * Workspace / Cloud incident.
 *
 * The Google feeds serve `external_desc` and `most_recent_update.text` as
 * markdown documents — typically opening with a `**Summary**` heading
 * followed by the actual one-line summary on the next line, then deeper
 * sections (`**Description**`, `**Customer Symptoms**`, `**Workaround**`).
 * Splitting on `\n` and taking the first line yields the literal heading
 * (`**Summary**`) instead of the human-readable text, which is what users
 * saw in the admin UI ("Gmail incident: **Summary**").
 *
 * Three real-world response shapes the parser must handle:
 *   1. Standard:   `**Summary**\nSome users may be unable to send.`
 *   2. With colon: `**Title:**\nCustomers may experience delays.`
 *   3. ATX prefix: `# Incident Report\n## Summary\nOn Wednesday...`
 *   4. Inline:     `**Summary** Some users may be unable to send.`
 *      (heading and content on the same line — common in shorter updates)
 *
 * Strategy:
 *   1. Strip leading whitespace and markdown bold/italic/header markers
 *      from each line.
 *   2. If the cleaned line starts with a known heading label followed by
 *      a separator (`:`, `—`, `-`, or whitespace), strip the heading
 *      prefix and keep the remainder (handles the inline shape).
 *   3. Skip lines that, after stripping, are empty OR look like a
 *      standalone section heading.
 *   4. Return the first remaining non-empty line, trimmed.
 *   5. If everything was filtered out (unusual response), fall back to
 *      the raw first line so we still surface something — but with the
 *      heading prefix stripped if any, never the bare literal `**Summary**`.
 */
function extractGoogleIncidentTitle(raw: string | undefined): string | null {
	if (!raw) {
		return null;
	}

	// Markdown wrappers we strip *while keeping* the inner text so an
	// otherwise meaningful one-liner like `**API errors elevated**` is
	// surfaced as "API errors elevated".
	const stripMarkdown = (line: string): string =>
		line
			// `**bold**` and `__bold__`
			.replace(/(\*\*|__)(.*?)\1/g, "$2")
			// `*italic*` and `_italic_` (but avoid eating `_` inside words)
			.replace(/(^|\s)[*_]([^*_\s][^*_]*?)[*_](\s|$)/g, "$1$2$3")
			// Leading ATX heading markers (`# `, `## `, etc.)
			.replace(/^#{1,6}\s+/, "")
			// Leading list bullets / blockquotes
			.replace(/^[>\-*+]\s+/, "")
			.trim();

	// Common section-heading words emitted by Google's incident feed.
	// When the cleaned line matches one of these exactly (case-insensitive,
	// possibly with a trailing colon), it's a label not a sentence. We
	// also use this set to strip an inline heading prefix from a content
	// line (case 4 in the function comment above).
	//
	// Sourced from observed live payloads on
	// `https://www.google.com/appsstatus/dashboard/incidents.json` and
	// `https://status.cloud.google.com/incidents.json`. Adding a new
	// heading is one-line: append the lowercase phrase here.
	const HEADING_WORDS = new Set([
		"summary",
		"description",
		"customer symptoms",
		"workaround",
		"next update",
		"status",
		"impact",
		"root cause",
		"current status",
		"investigation",
		"mitigation",
		// Observed on Google Workspace Gmail responses (see 2026-04-08 and
		// 2025-11-10 Gmail incidents) — Google uses "Title" interchangeably
		// with "Summary" depending on the template the on-call author picks.
		"title",
		// Some incident write-ups open with an h1 ATX heading like
		// `# Incident Report` followed by `## Summary`. Without this entry
		// the parser would surface the literal "Incident Report" as the
		// incident description.
		"incident report",
		"post-mortem",
		"preliminary post-mortem",
	]);

	// Build a regex that matches a known heading prefix at the START of a
	// cleaned line, optionally followed by a separator + the actual
	// content. Used to strip "**Summary** Some users..." → "Some users...".
	// The `|` alternatives are sorted longest-first so "customer symptoms"
	// matches before "customer" (defensive — there is no "customer"
	// heading today but the ordering is safer).
	const headingPrefixPattern = new RegExp(
		`^(?:${[...HEADING_WORDS]
			.sort((a, b) => b.length - a.length)
			.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
			.join("|")})\\s*[:\\-—–]?\\s+`,
		"i",
	);

	const lines = raw.split(/\r?\n/);
	for (const original of lines) {
		const cleaned = stripMarkdown(original);
		if (!cleaned) {
			continue;
		}
		// Standalone heading line (the whole cleaned content is a heading
		// word, optionally with a trailing colon): skip it. The body
		// content is on a subsequent line in the multi-line form.
		const headingProbe = cleaned.replace(/[:.]\s*$/, "").toLowerCase();
		if (HEADING_WORDS.has(headingProbe)) {
			continue;
		}
		// Lines that are entirely punctuation or markdown leftovers.
		if (!/[\p{L}\p{N}]/u.test(cleaned)) {
			continue;
		}
		// Inline heading: `Summary Some users may be unable...` →
		// strip the leading "Summary " prefix and return the remainder.
		// Only strips when the remainder is non-empty so we don't lose
		// content (a line that's just "Summary" alone is caught above).
		const stripped = cleaned.replace(headingPrefixPattern, "");
		if (stripped && stripped !== cleaned) {
			return stripped;
		}
		return cleaned;
	}

	// Fallback: at least one stripped first line, even if it looks like a
	// heading. We still apply the inline-heading prefix strip so we never
	// return the bare literal "Summary" or "**Summary**" — that's the
	// regression this function exists to prevent.
	const fallbackCleaned = stripMarkdown(lines[0] ?? "");
	if (!fallbackCleaned) {
		return null;
	}
	const fallbackStripped = fallbackCleaned.replace(headingPrefixPattern, "");
	return fallbackStripped || fallbackCleaned;
}

/**
 * Pick the worst-current-health incident from a filtered Google
 * incident list. An incident is considered active when `end` is absent
 * or in the future. We rank by `status_impact` (OUTAGE > DISRUPTION >
 * INFORMATION) so a coexisting full outage outranks a coexisting notice.
 */
function pickWorstGoogleIncident(
	incidents: GoogleIncident[],
	nowIso: string,
): GoogleIncident | undefined {
	const active = incidents.filter((inc) => {
		if (!inc.end) {
			return true;
		}
		return inc.end > nowIso; // simple ISO-8601 lexicographic compare
	});
	if (active.length === 0) {
		return undefined;
	}
	const rank: Record<string, number> = {
		SERVICE_OUTAGE: 3,
		SERVICE_DISRUPTION: 2,
		SERVICE_INFORMATION: 1,
	};
	return active.reduce((worst, inc) => {
		const a = rank[worst.status_impact ?? ""] ?? 0;
		const b = rank[inc.status_impact ?? ""] ?? 0;
		return b > a ? inc : worst;
	});
}

/**
 * Parse a Google Workspace `incidents.json` payload narrowed to a
 * single product by `service_name` (case-insensitive). Used for Gmail,
 * Google Drive.
 */
function parseGoogleWorkspace(
	input: PollStatusPageInput,
	json: unknown,
): PollStatusPageOutput {
	if (!Array.isArray(json)) {
		tryLog("warn", "Google Workspace incidents.json was not an array", {
			providerKey: input.providerKey,
			url: input.url,
		});
		return unknownResult(input);
	}
	const filter = input.googleWorkspaceServiceName?.toLowerCase();
	const all = json as GoogleIncident[];
	const matched = filter
		? all.filter((inc) => (inc.service_name ?? "").toLowerCase() === filter)
		: all;

	const worst = pickWorstGoogleIncident(matched, new Date().toISOString());
	if (!worst) {
		return {
			providerKey: input.providerKey,
			health: "OPERATIONAL",
			severity: "SEV2",
			openIncident: null,
			shouldCloseExisting: true,
			rawIndicator: "google-workspace:operational",
		};
	}

	const health = googleImpactToHealth(worst.status_impact);
	const severity = healthToSeverity(health);
	return {
		providerKey: input.providerKey,
		health,
		severity,
		openIncident:
			health === "OPERATIONAL"
				? null
				: {
						id: worst.id,
						name:
							extractGoogleIncidentTitle(
								worst.most_recent_update?.text,
							) ??
							extractGoogleIncidentTitle(worst.external_desc) ??
							worst.service_name ??
							"Google Workspace incident",
						affectedComponents: (worst.affected_products ?? [])
							.map((p) => p.title)
							.filter((t): t is string => Boolean(t)),
					},
		shouldCloseExisting: false,
		rawIndicator: `google-workspace:${worst.status_impact ?? "unknown"}`,
	};
}

/**
 * Parse a Google Cloud `incidents.json` payload narrowed to a single
 * product by an `affected_products[].title` match (case-insensitive).
 * Used for BigQuery, Cloud Storage.
 */
function parseGoogleCloud(
	input: PollStatusPageInput,
	json: unknown,
): PollStatusPageOutput {
	if (!Array.isArray(json)) {
		tryLog("warn", "Google Cloud incidents.json was not an array", {
			providerKey: input.providerKey,
			url: input.url,
		});
		return unknownResult(input);
	}
	const filter = input.googleCloudProductTitle?.toLowerCase();
	const all = json as GoogleIncident[];
	const matched = filter
		? all.filter((inc) =>
				(inc.affected_products ?? []).some(
					(p) => (p.title ?? "").toLowerCase() === filter,
				),
			)
		: all;

	const worst = pickWorstGoogleIncident(matched, new Date().toISOString());
	if (!worst) {
		return {
			providerKey: input.providerKey,
			health: "OPERATIONAL",
			severity: "SEV2",
			openIncident: null,
			shouldCloseExisting: true,
			rawIndicator: "google-cloud:operational",
		};
	}

	const health = googleImpactToHealth(worst.status_impact);
	const severity = healthToSeverity(health);
	return {
		providerKey: input.providerKey,
		health,
		severity,
		openIncident:
			health === "OPERATIONAL"
				? null
				: {
						id: worst.id,
						name:
							extractGoogleIncidentTitle(
								worst.most_recent_update?.text,
							) ??
							extractGoogleIncidentTitle(worst.external_desc) ??
							worst.service_name ??
							"Google Cloud incident",
						affectedComponents: (worst.affected_products ?? [])
							.map((p) => p.title)
							.filter((t): t is string => Boolean(t)),
					},
		shouldCloseExisting: false,
		rawIndicator: `google-cloud:${worst.status_impact ?? "unknown"}`,
	};
}

/**
 * Slack status v2 shape (per Slack's public docs):
 *   {
 *     status: "ok" | "active",
 *     active_incidents: [
 *       {
 *         id: number,
 *         title: string,
 *         status: "active" | "resolved",
 *         type: "incident" | "notice" | "outage",
 *         services: string[],
 *         ...
 *       }
 *     ]
 *   }
 *
 * Top-level `status: "ok"` with empty `active_incidents` is the all-
 * operational case. When `active_incidents` has entries, we map by
 * incident `type`: outage→PARTIAL_OUTAGE, incident→DEGRADED,
 * notice→DEGRADED. Slack does not surface a "full outage" enum so we
 * stay at PARTIAL_OUTAGE for the worst case.
 */
interface SlackResponse {
	status?: "ok" | "active" | string;
	active_incidents?: Array<{
		id?: number | string;
		title?: string;
		status?: "active" | "resolved" | string;
		type?: "incident" | "notice" | "outage" | string;
		services?: string[];
	}>;
}

function parseSlack(
	input: PollStatusPageInput,
	json: unknown,
): PollStatusPageOutput {
	const body = (json as SlackResponse) ?? {};
	const top = body.status;
	if (!top) {
		tryLog("warn", "Slack status response missing top-level status", {
			providerKey: input.providerKey,
			url: input.url,
		});
		return unknownResult(input);
	}

	const incidents = (body.active_incidents ?? []).filter(
		(i) => (i.status ?? "").toLowerCase() !== "resolved",
	);
	if (top === "ok" && incidents.length === 0) {
		return {
			providerKey: input.providerKey,
			health: "OPERATIONAL",
			severity: "SEV2",
			openIncident: null,
			shouldCloseExisting: true,
			rawIndicator: "slack:ok",
		};
	}

	// Rank by type: outage > incident > notice.
	const rank: Record<string, number> = { outage: 3, incident: 2, notice: 1 };
	const worst = [...incidents].sort(
		(a, b) =>
			(rank[(b.type ?? "").toLowerCase()] ?? 0) -
			(rank[(a.type ?? "").toLowerCase()] ?? 0),
	)[0];

	let health: ProviderHealthStatus;
	if (!worst) {
		// `status: "active"` but no listed incident — treat as DEGRADED so
		// the admin sees something flagged without inventing detail.
		health = "DEGRADED";
	} else {
		switch ((worst.type ?? "").toLowerCase()) {
			case "outage":
				health = "PARTIAL_OUTAGE";
				break;
			default:
				health = "DEGRADED";
		}
	}
	const severity = healthToSeverity(health);

	return {
		providerKey: input.providerKey,
		health,
		severity,
		openIncident: worst
			? {
					id: String(worst.id ?? `slack-${Date.now()}`),
					name: worst.title ?? "Slack incident",
					affectedComponents: worst.services ?? [],
				}
			: null,
		shouldCloseExisting: false,
		rawIndicator: `slack:${top}:${worst?.type ?? "unknown"}`,
	};
}

/**
 * status.io 1.0 shape (per https://api.status.io/docs):
 *   {
 *     result: {
 *       status_overall: { status: "Operational" | "Degraded Performance" |
 *                                  "Partial Service Disruption" |
 *                                  "Service Disruption", status_code: 100|300|400|500 },
 *       status: [{ id, name, status, status_code, containers: [...] }],
 *       incidents: [{ _id, name, current_state, current_status, ... }],
 *       maintenance: { active: [...], upcoming: [...] }
 *     }
 *   }
 *
 * `status_code` 100 = Operational, 300 = Degraded Performance, 400 =
 * Partial Service Disruption, 500 = Service Disruption (treated as
 * MAJOR_OUTAGE).
 */
interface StatusIoResponse {
	result?: {
		status_overall?: {
			status?: string;
			status_code?: number;
		};
		incidents?: Array<{
			_id?: string;
			id?: string;
			name?: string;
			current_state?: string | number;
			current_status?: string | number;
			components_affected?: Array<{
				name?: string;
			}>;
		}>;
		maintenance?: {
			active?: Array<{
				_id?: string;
				id?: string;
				name?: string;
			}>;
		};
	};
}

function statusIoCodeToHealth(code: number | undefined): ProviderHealthStatus {
	switch (code) {
		case 100:
			return "OPERATIONAL";
		case 300:
			return "DEGRADED";
		case 400:
			return "PARTIAL_OUTAGE";
		case 500:
			return "MAJOR_OUTAGE";
		default:
			return "UNKNOWN";
	}
}

function parseStatusIo(
	input: PollStatusPageInput,
	json: unknown,
): PollStatusPageOutput {
	const body = (json as StatusIoResponse) ?? {};
	const code = body.result?.status_overall?.status_code;
	if (typeof code !== "number") {
		tryLog(
			"warn",
			"status.io response missing status_overall.status_code",
			{
				providerKey: input.providerKey,
				url: input.url,
			},
		);
		return unknownResult(input);
	}

	const maintenance = body.result?.maintenance?.active ?? [];
	const incidents = body.result?.incidents ?? [];

	// Maintenance windows take precedence over operational rollup — a
	// scheduled window IS the answer for those providers.
	if (maintenance.length > 0 && code === 100) {
		const m = maintenance[0];
		return {
			providerKey: input.providerKey,
			health: "MAINTENANCE",
			severity: "SEV2",
			openIncident: {
				id: String(m._id ?? m.id ?? `status-io-maint-${Date.now()}`),
				name: m.name ?? "Scheduled maintenance",
				affectedComponents: [],
			},
			shouldCloseExisting: false,
			rawIndicator: "status-io:maintenance",
		};
	}

	const health = statusIoCodeToHealth(code);
	const severity = healthToSeverity(health);

	if (health === "OPERATIONAL") {
		return {
			providerKey: input.providerKey,
			health,
			severity,
			openIncident: null,
			shouldCloseExisting: true,
			rawIndicator: `status-io:${code}`,
		};
	}

	const live = incidents[0];
	return {
		providerKey: input.providerKey,
		health,
		severity,
		openIncident: live
			? {
					id: String(
						live._id ?? live.id ?? `status-io-${Date.now()}`,
					),
					name: live.name ?? "Provider incident",
					affectedComponents: (live.components_affected ?? [])
						.map((c) => c.name)
						.filter((n): n is string => Boolean(n)),
				}
			: null,
		shouldCloseExisting: false,
		rawIndicator: `status-io:${code}`,
	};
}

/**
 * Zendesk SSP (Status Self-service Portal) shape:
 *   {
 *     data: [
 *       {
 *         id: string, type: "incident",
 *         attributes: {
 *           name: string,
 *           impact: "minor" | "major" | "critical",
 *           status: "investigating" | "identified" | "monitoring" | "resolved",
 *           outage: boolean, degradation: boolean,
 *           startedAt: string, resolvedAt: string | null,
 *           ...
 *         },
 *         relationships: { incidentServices: { data: [{id, type}] } }
 *       }
 *     ],
 *     included: [...]
 *   }
 *
 * An incident is active when `attributes.status !== "resolved"`. We map
 * by impact: critical→MAJOR_OUTAGE, major→PARTIAL_OUTAGE, minor→DEGRADED.
 */
interface ZendeskSspIncident {
	id?: string;
	type?: string;
	attributes?: {
		name?: string;
		impact?: "minor" | "major" | "critical" | string;
		status?: string;
		outage?: boolean;
		degradation?: boolean;
		resolvedAt?: string | null;
	};
	relationships?: {
		incidentServices?: {
			data?: Array<{ id?: string; type?: string }>;
		};
	};
}

interface ZendeskSspResponse {
	data?: ZendeskSspIncident[];
}

function zendeskImpactToHealth(
	impact: string | undefined,
): ProviderHealthStatus {
	switch (impact) {
		case "critical":
			return "MAJOR_OUTAGE";
		case "major":
			return "PARTIAL_OUTAGE";
		case "minor":
			return "DEGRADED";
		default:
			return "UNKNOWN";
	}
}

function parseZendeskSsp(
	input: PollStatusPageInput,
	json: unknown,
): PollStatusPageOutput {
	const body = (json as ZendeskSspResponse) ?? {};
	if (!Array.isArray(body.data)) {
		tryLog("warn", "Zendesk SSP response missing data array", {
			providerKey: input.providerKey,
			url: input.url,
		});
		return unknownResult(input);
	}

	const active = body.data.filter(
		(inc) =>
			(inc.attributes?.status ?? "").toLowerCase() !== "resolved" &&
			!inc.attributes?.resolvedAt,
	);

	if (active.length === 0) {
		return {
			providerKey: input.providerKey,
			health: "OPERATIONAL",
			severity: "SEV2",
			openIncident: null,
			shouldCloseExisting: true,
			rawIndicator: "zendesk-ssp:operational",
		};
	}

	// Rank by impact severity.
	const rank: Record<string, number> = { critical: 3, major: 2, minor: 1 };
	const worst = active.sort(
		(a, b) =>
			(rank[a.attributes?.impact ?? ""] ?? 0) -
			(rank[b.attributes?.impact ?? ""] ?? 0),
	)[active.length - 1];

	const health = zendeskImpactToHealth(worst.attributes?.impact);
	const severity = healthToSeverity(health);
	return {
		providerKey: input.providerKey,
		health,
		severity,
		openIncident: {
			id: String(worst.id ?? `zendesk-${Date.now()}`),
			name: worst.attributes?.name ?? "Zendesk incident",
			affectedComponents: [],
		},
		shouldCloseExisting: false,
		rawIndicator: `zendesk-ssp:${worst.attributes?.impact ?? "unknown"}`,
	};
}

/**
 * Salesforce Trust v1 incident shape (`/v1/incidents/active`):
 *   [
 *     {
 *       id: number, externalId: string,
 *       affectsAll: boolean, isCore: boolean,
 *       status: "Confirmed" | "Resolved" | ...,
 *       type: "Degradation" | "Disruption" | "Performance" | ...,
 *       serviceKeys: ["coreService", ...],
 *       IncidentImpacts: [{
 *         severity: "minor" | "major" | "critical",
 *         startTime, endTime: string | null,
 *         type: "featureServiceDisruption" | ...,
 *       }]
 *     }
 *   ]
 *
 * The endpoint already filters to *active* incidents — an empty array
 * means everything is operational. We rank the worst incident by impact
 * severity, escalating to MAJOR_OUTAGE when `affectsAll: true` and the
 * type is "Disruption".
 */
interface SalesforceIncident {
	id?: number;
	externalId?: string;
	status?: string;
	type?: "Degradation" | "Disruption" | "Performance" | string;
	affectsAll?: boolean;
	isCore?: boolean;
	serviceKeys?: string[];
	message?: {
		rootCause?: string | null;
	};
	IncidentImpacts?: Array<{
		severity?: "minor" | "major" | "critical" | string;
		type?: string;
		endTime?: string | null;
	}>;
}

function salesforceSeverityToHealth(
	severity: string | undefined,
	type: string | undefined,
	affectsAll: boolean | undefined,
): ProviderHealthStatus {
	// Full disruption that affects every instance → MAJOR_OUTAGE.
	if (affectsAll && (type === "Disruption" || severity === "critical")) {
		return "MAJOR_OUTAGE";
	}
	switch (severity) {
		case "critical":
			return "MAJOR_OUTAGE";
		case "major":
			return "PARTIAL_OUTAGE";
		case "minor":
			return "DEGRADED";
		default:
			// Type-based fallback: Disruption is more serious than Degradation.
			return type === "Disruption" ? "PARTIAL_OUTAGE" : "DEGRADED";
	}
}

function parseSalesforce(
	input: PollStatusPageInput,
	json: unknown,
): PollStatusPageOutput {
	if (!Array.isArray(json)) {
		tryLog(
			"warn",
			"Salesforce active incidents response was not an array",
			{
				providerKey: input.providerKey,
				url: input.url,
			},
		);
		return unknownResult(input);
	}

	const all = json as SalesforceIncident[];
	const active = all.filter(
		(inc) =>
			// The /active endpoint already filters, but defensive: drop
			// rows that have already been marked Resolved upstream.
			(inc.status ?? "").toLowerCase() !== "resolved",
	);

	if (active.length === 0) {
		return {
			providerKey: input.providerKey,
			health: "OPERATIONAL",
			severity: "SEV2",
			openIncident: null,
			shouldCloseExisting: true,
			rawIndicator: "salesforce:operational",
		};
	}

	// Rank by worst impact severity.
	const rank: Record<string, number> = { critical: 3, major: 2, minor: 1 };
	const worst = active.reduce((acc, inc) => {
		const a = Math.max(
			...((acc.IncidentImpacts ?? []).map(
				(i) => rank[i.severity ?? ""] ?? 0,
			) || [0]),
		);
		const b = Math.max(
			...((inc.IncidentImpacts ?? []).map(
				(i) => rank[i.severity ?? ""] ?? 0,
			) || [0]),
		);
		return b > a ? inc : acc;
	});

	const worstSeverity = (worst.IncidentImpacts ?? [])
		.map((i) => i.severity)
		.sort((a, b) => (rank[b ?? ""] ?? 0) - (rank[a ?? ""] ?? 0))[0];

	const health = salesforceSeverityToHealth(
		worstSeverity,
		worst.type,
		worst.affectsAll,
	);
	const severity = healthToSeverity(health);

	return {
		providerKey: input.providerKey,
		health,
		severity,
		openIncident: {
			id: String(
				worst.externalId ?? worst.id ?? `salesforce-${Date.now()}`,
			),
			name:
				worst.message?.rootCause ??
				`${worst.type ?? "Incident"}${
					worst.affectsAll ? " (all instances)" : ""
				}`,
			affectedComponents: worst.serviceKeys ?? [],
		},
		shouldCloseExisting: false,
		rawIndicator: `salesforce:${worstSeverity ?? worst.type ?? "unknown"}`,
	};
}

/**
 * Dispatch on `customParser`. Returns null when no custom parser is
 * configured so callers can fall through to the Atlassian default.
 */
function dispatchCustomParser(
	input: PollStatusPageInput,
	json: unknown,
): PollStatusPageOutput | null {
	switch (input.customParser) {
		case "google-workspace":
			return parseGoogleWorkspace(input, json);
		case "google-cloud":
			return parseGoogleCloud(input, json);
		case "slack":
			return parseSlack(input, json);
		case "status-io":
			return parseStatusIo(input, json);
		case "zendesk-ssp":
			return parseZendeskSsp(input, json);
		case "salesforce":
			return parseSalesforce(input, json);
		default:
			return null;
	}
}

/**
 * Poll a provider's status-page data endpoint and normalize the result.
 * Never throws — returns `UNKNOWN` on transport / parse failure so the
 * cron iterates all providers regardless.
 */
export async function pollStatusPage(
	input: PollStatusPageInput,
): Promise<PollStatusPageOutput> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

	try {
		const json = await fetchJson(
			input.url,
			controller.signal,
			input.providerKey,
		);
		if (json === FETCH_FAILED) {
			return unknownResult(input);
		}

		const customResult = dispatchCustomParser(input, json);
		if (customResult) {
			return customResult;
		}

		return parseAtlassian(input, json);
	} catch (err) {
		tryLog("warn", "Status page poll threw", {
			providerKey: input.providerKey,
			url: input.url,
			error: err instanceof Error ? err.message : String(err),
		});
		return unknownResult(input);
	} finally {
		clearTimeout(timer);
	}
}
