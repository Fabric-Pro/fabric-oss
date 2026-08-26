/**
 * Translate cryptic PM-tool sync errors into actionable, user-facing
 * guidance before they're persisted to `lastPmSyncError` and shown in the
 * "PM sync failed" panel.
 *
 * The raw errors come straight from the PM tool's MCP server (Jira/Rovo,
 * ADO, etc.) and are often opaque to an end user. The worst offender —
 * and the reason this exists — is Atlassian Rovo returning:
 *
 *   "Cloud id f4f670d4-… isn't explicitly granted by the user."
 *
 * That happens when the project's linked Jira board lives on an Atlassian
 * site the user's current connection can no longer reach (e.g. they
 * reconnected to a different site, or lost access). The fix is always the
 * same — re-select the project's board onto a site they can access — but
 * the raw message gives no hint of that. We detect the known shapes and
 * prepend a one-line, actionable instruction while preserving the original
 * text (truncated) for support/debugging.
 *
 * Failure-proof: unknown errors pass through unchanged.
 */

/**
 * A known cryptic-error shape and the actionable guidance to surface for it.
 * `match` is tested against the raw error message (case-insensitive).
 */
interface PmErrorRule {
	match: RegExp;
	/**
	 * Optional veto: when set and it matches the raw message, this rule is
	 * skipped. Lets a broad `match` (e.g. "not found") exclude look-alikes that
	 * are really a different failure — e.g. a permission error that happens to
	 * say "work item not found: access denied" is NOT a deleted card.
	 */
	notMatch?: RegExp;
	/** Short, actionable, end-user-facing sentence. */
	guidance: string;
}

const PM_ERROR_RULES: PmErrorRule[] = [
	{
		// Atlassian Rovo: the board's Atlassian site isn't in the granted
		// token's accessible resources (stale board reference after the
		// user's Atlassian access moved sites).
		match: /cloud[\s_-]?id\b.*\bisn'?t\b.*\bgranted\b/i,
		guidance:
			"This project's Jira board is on an Atlassian site your current connection can't reach. Open the project's Settings → Project Management and re-select a board on a site you have access to.",
	},
	{
		// Generic Atlassian "no accessible resources" / site-access shapes.
		match: /no\b.*\baccessible\b.*\bresources?\b/i,
		guidance:
			"Fabric couldn't find an Atlassian site for this connection. Reconnect Atlassian from Settings → MCP Servers, then re-select the project's board under Project Settings → Project Management.",
	},
	{
		// Jira description hard limit (ADF 32 KB) — actionable: the image/
		// content is too large for inline embedding.
		match: /CONTENT_LIMIT_EXCEEDED|maximum.*length.*32\s?7?6?7?/i,
		guidance:
			"The description is too large for Jira's content limit. Enable image attachments (Settings → MCP Servers → Atlassian → Connect image attachments) so large images upload as files instead of inline data.",
	},
	{
		// The linked PM card was deleted on its server (or its id no longer
		// resolves). On a push this surfaces as "Resource not found" / 404 /
		// "does not exist". Vetoed for permission shapes (401/403/forbidden/
		// access denied), which look similar but are NOT a deleted card. The
		// stable phrase "no longer exists" is matched by the roadmap chip
		// (`isPmTicketMissingError`) to show a distinct "PM card missing" state,
		// and mirrors the FLAG_MISSING unlink the push path already proposed.
		match: /\bnot found\b|does not exist|could not be found|resource not found|\b404\b/i,
		notMatch:
			/permission|forbidden|unauthor|\b401\b|\b403\b|access denied|access[\s_-]?token/i,
		guidance:
			"The linked PM card no longer exists in the PM tool — it was deleted, or its id no longer resolves. Fabric has flagged it to be unlinked: open the Review Center to unlink this item, and the next sync will create a fresh card.",
	},
];

/**
 * Returns an actionable message for a known cryptic PM error, or the
 * original message unchanged when nothing matches. When a rule matches,
 * the guidance leads and the original detail is kept (parenthesized) so
 * support can still see the upstream text.
 */
export function humanizePmSyncError(rawMessage: string): string {
	if (!rawMessage) {
		return rawMessage;
	}
	for (const rule of PM_ERROR_RULES) {
		if (rule.notMatch?.test(rawMessage)) {
			continue;
		}
		if (rule.match.test(rawMessage)) {
			return `${rule.guidance} (Original error: ${rawMessage})`;
		}
	}
	return rawMessage;
}
