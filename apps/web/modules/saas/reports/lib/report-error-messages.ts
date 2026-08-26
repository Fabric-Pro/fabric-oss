/**
 * Translate a raw error (a server `error.message`, a thrown `Error`, or a
 * persisted execution-error string) into plain, actionable language for end
 * users.
 *
 * Connection-state failures get the two-step recovery guidance (reconnect the
 * data source, then re-select the project); other known patterns get a clear
 * sentence; everything else falls back to a safe generic message. The goal is
 * that stack traces, API/HTTP codes, and internal identifiers (workflow/activity
 * names, file paths, `TypeError`, …) NEVER reach the UI — only human-readable,
 * actionable copy does.
 *
 * Pure + dependency-free so it can be unit-tested in isolation and reused by any
 * surface that shows a report error (toasts, the execution-history row, …).
 */

export type ReportErrorContext = "generate" | "save" | "delete" | "test";

const GENERIC: Record<ReportErrorContext, string> = {
	generate:
		"Something went wrong while generating this report. Please try again — and if it keeps failing, check your data source connection below.",
	save: "Couldn’t save your changes. Please try again.",
	delete: "Couldn’t delete this report instance. Please try again.",
	test: "Couldn’t test the connection. Please try again in a moment.",
};

/** Known error shapes → a clearer, actionable message. Most-specific first. */
const PATTERNS: { match: RegExp; message: string }[] = [
	{
		// A bound data source whose MCP config no longer resolves: the save-time
		// validation ("Invalid connections: No access to MCP config …") and the
		// run-time client ("MCP configuration not found" / CONFIG_NOT_FOUND). The
		// connection is gone/changed — the fix is to re-select it, not retry.
		match: /\b(no access to mcp config|invalid connections?|mcp config(?:uration)? not found|config(?:uration)?[_ ]?not[_ ]?found|connection (?:is )?no longer (?:available|valid)|no longer available)\b/i,
		message:
			"This report’s data source connection is no longer available — it may have been removed, reconnected (which creates a new connection), or set up by someone else. Re-select a connection in the Data Source Connection section below, then re-select its project.",
	},
	{
		match: /\b(401|403|unauthor\w*|forbidden|invalid[_ -]?token|token (?:has )?expired|expired token|authenticat\w*|auth(?:oriz\w+)?[_ ]?(?:fail\w*|error)|reconnect|re-?auth\w*)\b/i,
		message:
			"This data source needs to be reconnected. Step 1 — reconnect it (its access has expired). Step 2 — re-select your project in the Data Source Connection section below. Reports fail silently after step 1 alone, so don’t skip step 2.",
	},
	{
		match: /\b(ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|timed[_ ]?out|timeout|unreachable|network error|fetch failed|socket hang up|502|503|504)\b/i,
		message:
			"Fabric couldn’t reach the data source — it may be temporarily unavailable. Please try again shortly.",
	},
	{
		match: /\b(no (?:usable )?(?:read[- ]?only )?tools|no tools|0 tools|tool discovery (?:fail\w*)?)\b/i,
		message:
			"The connected data source didn’t expose any tools to read from. Reconnect it, then re-select your project in the Data Source Connection section below.",
	},
	{
		match: /\b(rate[- ]?limit\w*|insufficient (?:credits|quota)|out of credits|quota (?:exceeded|exhausted)|429|too many requests)\b/i,
		message:
			"The AI provider is rate-limited or out of credits right now. Please wait a moment, then try again.",
	},
	{
		match: /\b(no data ?source|not configured|missing connection|select a connection|no connection)\b/i,
		message:
			"This report needs a data source. Connect one, then re-select your project in the Data Source Connection section below.",
	},
];

/**
 * Heuristic for "this string is raw/technical and must not be shown verbatim".
 * Conservative on purpose — when unsure we prefer the safe generic message over
 * leaking internals.
 */
function looksTechnical(raw: string): boolean {
	return (
		raw.length > 180 ||
		// braces / angle brackets / paths / windows drive / double-colon
		/[{}<>]|::|\/[\w.-]+\/|[A-Za-z]:\\/.test(raw) ||
		// error/exception/stack-trace markers
		/\bError\b|\bException\b|\bstack\b|\btrace(?:back)?\b|\b[A-Z][a-z]+Error\b|\bat [\w$.]+ \(/.test(
			raw,
		) ||
		// internal identifiers a user shouldn't see
		/\b(workflow|activity|temporal|orchestrat\w*|undefined|null|NaN|ECONN\w+|ENOTFOUND|ETIMEDOUT)\b/i.test(
			raw,
		) ||
		// opaque ids (cuid/cuid2 — e.g. a leaked MCP config / instance id like
		// "cmnj4fcfm000i04l5s69i0gil") must never reach a user-facing toast
		/\bc[a-z0-9]{20,}\b/i.test(raw)
	);
}

export function humanizeReportError(
	raw: string | undefined | null,
	context: ReportErrorContext = "generate",
): string {
	const text = (raw ?? "").trim();
	if (!text) {
		return GENERIC[context];
	}
	for (const { match, message } of PATTERNS) {
		if (match.test(text)) {
			return message;
		}
	}
	// A short, clean sentence with no technical markers is safe to surface as-is
	// (e.g. a validation message like "Project Name is required"); otherwise fall
	// back to the safe generic message so nothing raw leaks through.
	if (!looksTechnical(text) && text.length <= 160) {
		return text;
	}
	return GENERIC[context];
}
