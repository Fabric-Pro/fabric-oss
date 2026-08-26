/**
 * Tagged error classes for the Slack file-download helper.
 *
 * These errors are surfaced to the apply-time orchestrator
 * `attachPendingMediaToStory` which maps each tag to a typed
 * `AttachmentWarning.reason` (`scope_missing` / `auth_failed` /
 * `external_workspace` / `download_failed`).
 *
 * Security: message strings MUST NOT contain the bot token, the signed
 * `url_private` URL, or any response-body bytes. The `cause` field is for
 * internal traces only — never log the cause untyped.
 */

interface ErrorOptions {
	cause?: unknown;
}

/**
 * Slack response indicated the bot token lacks the `files:read` scope.
 * Slack signals this as HTTP 200 with `{ ok: false, error: "missing_scope" }`
 * (NOT 401 — see `AuthFailedError` for token-level failures).
 *
 * Mapped to `AttachmentWarning.reason = "scope_missing"`.
 */
export class ScopeMissingError extends Error {
	constructor(
		message = "Slack bot token missing files:read scope",
		options?: ErrorOptions,
	) {
		super(message);
		this.name = "ScopeMissingError";
		if (options?.cause !== undefined) {
			(this as { cause?: unknown }).cause = options.cause;
		}
	}
}

/**
 * Slack returned 401 — the bot token is invalid, revoked, expired, or the
 * workspace account is inactive (`invalid_auth`, `token_revoked`,
 * `token_expired`, `account_inactive`, `not_authed`). These are token-level
 * failures, not scope failures: re-authorizing the workspace fixes them.
 *
 * Mapped to `AttachmentWarning.reason = "auth_failed"`.
 */
export class AuthFailedError extends Error {
	constructor(
		message = "Slack auth failed — bot token invalid or revoked",
		options?: ErrorOptions,
	) {
		super(message);
		this.name = "AuthFailedError";
		if (options?.cause !== undefined) {
			(this as { cause?: unknown }).cause = options.cause;
		}
	}
}

/**
 * Slack returned 403 — the file lives in a different workspace than the bot.
 *
 * Mapped to `AttachmentWarning.reason = "external_workspace"`.
 */
export class ExternalWorkspaceError extends Error {
	constructor(
		message = "Slack file lives in an external workspace",
		options?: ErrorOptions,
	) {
		super(message);
		this.name = "ExternalWorkspaceError";
		if (options?.cause !== undefined) {
			(this as { cause?: unknown }).cause = options.cause;
		}
	}
}

/**
 * Generic download failure — timeout, abort, 5xx, byte-cap overflow, or any
 * other non-2xx outcome that isn't a recognized scope/workspace error.
 *
 * The optional `status` field captures the HTTP status code when available so
 * the caller can include it in structured logs without re-parsing.
 *
 * Mapped to `AttachmentWarning.reason = "download_failed"`.
 */
export class DownloadFailedError extends Error {
	public readonly status?: number;

	constructor(
		message = "Slack download failed",
		options?: ErrorOptions & { status?: number },
	) {
		super(message);
		this.name = "DownloadFailedError";
		if (options?.status !== undefined) {
			this.status = options.status;
		}
		if (options?.cause !== undefined) {
			(this as { cause?: unknown }).cause = options.cause;
		}
	}
}
