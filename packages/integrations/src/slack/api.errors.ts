/**
 * Slack API errors that a retry can never clear.
 *
 * Slack answers these with HTTP 200 and `{ ok: false, error: "..." }`, so
 * without classification they arrive as ordinary failures and get retried
 * forever. `not_in_channel` alone accounted for roughly 2,000 worker errors a
 * week in production: a poll every fifteen minutes, per project, against a
 * channel the bot had never been invited to — a state only a person can change.
 *
 * Callers should stop polling and tell the user, rather than retrying.
 */

interface ErrorOptions {
	cause?: unknown;
}

/**
 * Slack error codes that describe configuration, not a transient fault.
 *
 * - `not_in_channel`, `channel_not_found`, `is_archived` — the bot cannot see
 *   the channel; someone has to invite it or re-link.
 * - `missing_scope`, `not_allowed_token_type` — the token lacks a permission;
 *   the app has to be re-authorised.
 * - `invalid_auth`, `token_revoked`, `account_inactive` — the token is dead.
 */
export const PERMANENT_SLACK_ERRORS = new Set([
	"not_in_channel",
	"channel_not_found",
	"is_archived",
	"missing_scope",
	"not_allowed_token_type",
	"invalid_auth",
	"token_revoked",
	"account_inactive",
]);

/**
 * A Slack call failed for a reason that will keep failing until a human
 * changes the workspace or the integration.
 */
export class SlackConfigurationError extends Error {
	/** The raw Slack error code, e.g. `not_in_channel`. */
	public readonly slackError: string;

	constructor(slackError: string, message: string, options?: ErrorOptions) {
		super(message);
		this.name = "SlackConfigurationError";
		this.slackError = slackError;
		if (options?.cause !== undefined) {
			(this as { cause?: unknown }).cause = options.cause;
		}
	}
}

/** True when this Slack error code will not clear on its own. */
export function isPermanentSlackError(slackError: string | undefined): boolean {
	return slackError !== undefined && PERMANENT_SLACK_ERRORS.has(slackError);
}
