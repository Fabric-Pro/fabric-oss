/**
 * Application-log context for bug analysis (Fizzy #1234).
 *
 * This module is the PORT. It owns everything that must be true regardless of
 * which log-access mechanism the team finally approves (FR4): the feature
 * gate, point-of-use authorization, redaction, budgeting, the prompt clause,
 * and the FR3 "logs were not available" outcome. The mechanism itself — today
 * an MCP server exposing a log-query tool — arrives as an injected
 * `LogSourceAdapter`, so swapping it for a dedicated connector changes one
 * file and none of the security-critical code below.
 *
 * Layering: no MCP import here on purpose. `@repo/ai` must not depend on
 * `@repo/mcp`; the Temporal activity supplies the adapter.
 *
 * Failure modes, deliberately asymmetric:
 *   - redaction failure -> entry dropped (fail closed, in `@repo/utils`)
 *   - platform failure  -> analysis proceeds WITHOUT logs (fail open, FR3)
 */
import { getProjectMemberRole } from "@repo/database";
import { logger } from "@repo/logs";
import {
	hasPermission,
	Permissions,
	resolveProjectPermissions,
} from "@repo/permissions";
import { isBugAnalysisLogContextEnabled } from "@repo/utils/feature-flag";
import {
	type RawLogEntry,
	type RedactedLogEntry,
	redactLogEntries,
} from "@repo/utils/log-redaction";

export type LogSeverity = "error" | "warning" | "info";

/** What to ask the log source for. Every field is a hard bound, not a hint. */
export interface LogQueryScope {
	/** How far back to look, in minutes. */
	lookbackMinutes: number;
	/** Lowest severity to include. */
	minSeverity: LogSeverity;
	/** Hard cap on entries the adapter may return. */
	maxEntries: number;
	/** Terms narrowing the query to the item under analysis. */
	terms: string[];
	/**
	 * Server-derived organization bound for this analysis. A shared-store
	 * adapter MUST constrain its query to it and the port refuses to run
	 * without it; dedicated stores ignore it — their tenant boundary is the
	 * binding itself.
	 */
	organizationId?: string;
}

/**
 * Prototype defaults. Recorded as tunables in ADR-017 rather than hardcoded
 * opinions — the right window is a question for the feasibility review.
 */
export const DEFAULT_LOG_SCOPE: Omit<LogQueryScope, "terms"> = {
	lookbackMinutes: 24 * 60,
	minSeverity: "error",
	maxEntries: 50,
};

/**
 * Total characters of log content allowed into the prompt. The analysis
 * prompt already runs an 80k-token budget; logs take a bounded slice of it so
 * a noisy platform cannot crowd out the backlog and the transcripts.
 */
export const MAX_LOG_CONTEXT_CHARS = 12_000;

/**
 * Which structured property keys may reach the model.
 *
 * Empty — the default — means DROP the whole properties bag.
 *
 * This is the allowlist half of ADR-017's open question, and it is deliberately
 * the default rather than an option. A log MESSAGE is free text that has to be
 * read to be useful, so it can only be denylisted; the structured bag is
 * different. It is where credentials arrive in bulk (connection settings, auth
 * headers, request context), it is named by key so an allowlist is meaningful,
 * and it is rarely what makes a root cause legible. Excluding unknown keys by
 * default inverts the failure mode exactly where inverting it is cheap.
 *
 * An operator opts specific keys back in, e.g.
 * `FABRIC_BUG_ANALYSIS_LOG_PROPERTY_ALLOWLIST=requestId,correlationId`.
 * Comparison is case-insensitive because platforms disagree on casing.
 */
export function configuredPropertyAllowlist(): string[] {
	return (process.env.FABRIC_BUG_ANALYSIS_LOG_PROPERTY_ALLOWLIST ?? "")
		.split(",")
		.map((key) => key.trim())
		.filter(Boolean);
}

/**
 * Apply the property policy to raw entries, BEFORE redaction.
 *
 * Dropping first means an excluded key is never inspected, never pattern
 * matched and never partially emitted — redaction only ever sees what policy
 * already permitted. PURE, and provider-agnostic: every adapter's output goes
 * through it.
 */
export function applyPropertyPolicy(
	entries: RawLogEntry[],
	allowlist: string[] = configuredPropertyAllowlist(),
): RawLogEntry[] {
	if (allowlist.length === 0) {
		return entries.map(({ properties: _dropped, ...rest }) => rest);
	}
	const allowed = new Set(allowlist.map((key) => key.toLowerCase()));
	return entries.map((entry) => {
		if (!entry.properties) {
			return entry;
		}
		const kept: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(entry.properties)) {
			if (allowed.has(key.toLowerCase())) {
				kept[key] = value;
			}
		}
		const { properties: _dropped, ...rest } = entry;
		return Object.keys(kept).length > 0
			? { ...rest, properties: kept }
			: rest;
	});
}

/** The swappable mechanism. Implementations live outside this package. */
export interface LogSourceAdapter {
	/** Stable mechanism id for logs and traceability, e.g. `"mcp"`. */
	readonly kind: string;
	/** Human label for the configured source, shown in the FR3 note. */
	readonly label: string;
	/**
	 * Whether the backing store outlives one tenant — e.g. a deployment-wide
	 * platform-telemetry workspace that every project inherits. Queries against
	 * such a store MUST be constrained to `scope.organizationId`: search terms
	 * alone would otherwise return rows generated by other tenants (security
	 * review of Fizzy #1234). Required, not defaulted, so every provider has to
	 * answer it — a tenant's own connected MCP servers and a project-bound
	 * workspace are dedicated by construction; a deployment default is not.
	 */
	readonly sharedStore: boolean;
	fetchLogExcerpts(scope: LogQueryScope): Promise<RawLogEntry[]>;
}

export type LogContextStatus =
	/** Logs were fetched, redacted and injected. */
	| "included"
	/** The feature gate is off. */
	| "disabled"
	/** Requester does not currently have access to the project. */
	| "unauthorized"
	/** No log source is configured for this project — FR3. */
	| "not-configured"
	/** A source is configured but returned nothing in scope. */
	| "empty"
	/** A source is configured but could not be reached — FR3. */
	| "unavailable";

export interface LogContextResult {
	status: LogContextStatus;
	/** Prompt clause to append. Empty for every status except `included`. */
	clause: string;
	/**
	 * One-line, user-facing explanation of why logs are or are not present.
	 * FR3 requires this be surfaced when logs were not available.
	 */
	note: string;
	entryCount: number;
	redactionCount: number;
	droppedCount: number;
	sourceLabel?: string;
}

function result(
	status: LogContextStatus,
	note: string,
	extra: Partial<LogContextResult> = {},
): LogContextResult {
	return {
		status,
		clause: "",
		note,
		entryCount: 0,
		redactionCount: 0,
		droppedCount: 0,
		...extra,
	};
}

/**
 * Render redacted entries as the BODY of a prompt section. PURE —
 * unit-testable without a platform, a DB or a flag.
 *
 * Returns no `###` heading: the prompt builder adds headings for every context
 * source uniformly, and this one used to be the single exception that carried
 * its own. A section list that is uniform except for one member is exactly
 * what a future editor reorders or renumbers without noticing.
 *
 * The preamble stays here, next to the entries it describes — it tells the
 * model that `[REDACTED]` marks a removed value rather than a literal one, and
 * separating it from the entries would defeat its purpose.
 */
export function renderLogContextClause(
	entries: RedactedLogEntry[],
	sourceLabel: string,
): string {
	const lines: string[] = [
		`Source: ${sourceLabel}. These entries were retrieved for this analysis`,
		"and passed through automated redaction, which replaces recognised",
		"credentials and personal data with `[REDACTED]`. Treat `[REDACTED]` as",
		"'a value was removed here', never as the literal logged value, and do",
		"not ask for or speculate about what it contained. Redaction is",
		"pattern-based and therefore best-effort: if a value in these entries",
		"still looks like a secret, do not repeat it in your answer.",
		"",
	];

	for (const entry of entries) {
		const stamp = entry.timestamp ? `${entry.timestamp} ` : "";
		const level = entry.severity
			? `[${entry.severity.toUpperCase()}] `
			: "";
		const tail = entry.truncated ? " …(truncated)" : "";
		lines.push(`- ${stamp}${level}${entry.message}${tail}`);
		if (entry.properties && Object.keys(entry.properties).length > 0) {
			lines.push(`  properties: ${JSON.stringify(entry.properties)}`);
		}
	}

	return lines.join("\n");
}

/**
 * Trim entries to the character budget, keeping the earliest-listed (the
 * adapter is responsible for ordering by relevance). Returns what fits.
 */
/**
 * What one entry costs in the RENDERED clause, not just its raw content.
 *
 * Counting only message + properties understated the real cost by the
 * timestamp, severity marker, list punctuation, newlines and the
 * `properties:` label. Measured against a live Azure Monitor response, a
 * 12,000-character budget produced a 14,200-character clause — an 18%
 * overshoot into the analyzer's token budget. Mirrors the output of
 * `renderLogContextClause` below; change them together.
 */
function entryRenderCost(entry: RedactedLogEntry): number {
	const stamp = entry.timestamp ? entry.timestamp.length + 1 : 0;
	const level = entry.severity ? entry.severity.length + 3 : 0;
	const tail = entry.truncated ? " …(truncated)".length : 0;
	const properties =
		entry.properties && Object.keys(entry.properties).length > 0
			? JSON.stringify(entry.properties).length +
				"\n  properties: ".length
			: 0;
	// "- " plus the trailing newline.
	return 3 + stamp + level + entry.message.length + tail + properties;
}

/**
 * Trim entries to the character budget, keeping the earliest-listed (the
 * adapter is responsible for ordering by relevance). Returns what fits.
 *
 * The budget covers the WHOLE rendered section, preamble included, so the
 * caller gets what it asked for rather than the content total plus formatting.
 */
export function capEntriesToBudget(
	entries: RedactedLogEntry[],
	maxChars: number = MAX_LOG_CONTEXT_CHARS,
	sourceLabel = "",
): RedactedLogEntry[] {
	const kept: RedactedLogEntry[] = [];
	// Rendering an empty clause gives the exact preamble cost, so the reserve
	// stays correct when that copy is edited.
	let used = renderLogContextClause([], sourceLabel).length;
	for (const entry of entries) {
		const cost = entryRenderCost(entry);
		if (used + cost > maxChars) {
			break;
		}
		kept.push(entry);
		used += cost;
	}
	return kept;
}

export interface BuildLogContextArgs {
	projectId: string;
	requesterUserId: string;
	/**
	 * The organization the analysis runs in, from the authenticated session —
	 * never caller-supplied free text. A shared store is unreadable without it.
	 * Null for personal-context projects, which by definition have no
	 * organization to scope a shared source to.
	 */
	organizationId?: string | null;
	/** Call site, for logs. e.g. `"backlog-analysis"`. */
	surface: string;
	/**
	 * Resolve the project's log source. Returns `null` when the project has
	 * none configured — that is FR3's "not configured", not an error.
	 */
	resolveAdapter: () => Promise<LogSourceAdapter | null>;
	/** Terms narrowing the query to the item(s) under analysis. */
	terms: string[];
	scope?: Partial<Omit<LogQueryScope, "terms">>;
}

/**
 * Flag -> authorization -> resolve -> fetch -> redact -> budget -> render.
 *
 * Never throws. Every failure returns a `LogContextResult` whose `clause` is
 * empty and whose `note` explains why, so the caller can proceed with a
 * log-free analysis and still tell the user what happened (FR3).
 */
export async function buildBugAnalysisLogContext(
	args: BuildLogContextArgs,
): Promise<LogContextResult> {
	if (!isBugAnalysisLogContextEnabled()) {
		return result("disabled", "Log-backed analysis is not enabled.");
	}

	try {
		// Point-of-use authorization: the requester must still be entitled at
		// the moment the logs are read, not merely when the analysis was queued.
		//
		// Deliberately stricter than the surrounding analysis, which needs only
		// project access. Runtime logs are the most sensitive context source
		// Fabric handles — they carry whatever the application happened to
		// print — so reading them is gated on the project-settings permission,
		// which OWNER and PROJECT_ADMIN hold and EDITOR does not. Resolved
		// through `@repo/permissions` rather than by comparing role names,
		// because that is the one place the role-to-permission map lives.
		const role = await getProjectMemberRole(
			args.projectId,
			args.requesterUserId,
		);
		if (
			!hasPermission(
				resolveProjectPermissions(role),
				Permissions.PROJECT_SETTINGS_EDIT,
			)
		) {
			return result(
				"unauthorized",
				"Logs were not included: reading project logs needs project-admin access.",
			);
		}

		const adapter = await args.resolveAdapter();
		if (!adapter) {
			return result(
				"not-configured",
				"Logs were not available: no log source is configured for this project.",
			);
		}

		// A shared store is only readable when the query can be scoped to one
		// organization, and the scope comes from the session, not the caller.
		// Without it the query would run over every tenant the deployment has
		// ever logged — so it does not run at all. Fail closed.
		const organizationId = args.organizationId ?? undefined;
		if (adapter.sharedStore && !organizationId) {
			return result(
				"not-configured",
				"Logs were not available: the configured log source spans multiple organizations and could not be scoped to yours.",
			);
		}

		const scope: LogQueryScope = {
			...DEFAULT_LOG_SCOPE,
			...args.scope,
			terms: args.terms,
			organizationId,
		};

		// Policy first, then redaction: an excluded property is never inspected.
		const raw = applyPropertyPolicy(await adapter.fetchLogExcerpts(scope));
		if (raw.length === 0) {
			return result(
				"empty",
				`No matching log entries were found in ${adapter.label} for the selected window.`,
				{ sourceLabel: adapter.label },
			);
		}

		const redacted = redactLogEntries(raw);
		const kept = capEntriesToBudget(
			redacted.entries,
			MAX_LOG_CONTEXT_CHARS,
			adapter.label,
		);

		if (kept.length === 0) {
			return result(
				"empty",
				`Log entries were found in ${adapter.label} but none could be included.`,
				{
					sourceLabel: adapter.label,
					droppedCount: redacted.droppedCount,
				},
			);
		}

		logger.info("[BugAnalysis] application-log context injected", {
			surface: args.surface,
			projectId: args.projectId,
			mechanism: adapter.kind,
			fetched: raw.length,
			included: kept.length,
			dropped: redacted.droppedCount,
			redactions: redacted.redactionCount,
		});

		return {
			status: "included",
			clause: renderLogContextClause(kept, adapter.label),
			note: `Included ${kept.length} redacted log ${
				kept.length === 1 ? "entry" : "entries"
			} from ${adapter.label}.`,
			entryCount: kept.length,
			redactionCount: redacted.redactionCount,
			droppedCount: redacted.droppedCount,
			sourceLabel: adapter.label,
		};
	} catch (err) {
		// Fail open on availability: a bug analysis must still succeed without
		// logs rather than fail outright (card NFR: degrade gracefully).
		// `reason` is not redundant with `err`: an Error's message and stack are
		// non-enumerable, so a nested one serialises to `{}` through the JSON
		// sink and takes the only account of WHY logs were unreachable with it.
		// This status is the feature's single failure mode, and the reasons
		// behind it — no credential, no role assignment, a bad workspace id —
		// are indistinguishable without it.
		logger.warn(
			"[BugAnalysis] log context unavailable; continuing without",
			{
				surface: args.surface,
				projectId: args.projectId,
				reason: err instanceof Error ? err.message : String(err),
				cause:
					err instanceof Error && err.cause instanceof Error
						? err.cause.message
						: undefined,
				err,
			},
		);
		return result(
			"unavailable",
			"Logs were not available: the configured log source could not be reached.",
		);
	}
}
