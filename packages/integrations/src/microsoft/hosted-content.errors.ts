/**
 * Tagged error classes for the Teams hosted-content download helper.
 *
 * Surfaced to the apply-time orchestrator `attachPendingMediaToStory`,
 * which maps each tag to a typed `AttachmentWarning.reason`
 * (`download_failed` — Teams does not surface a "scope missing" code
 * symmetric to Slack; treat 401/403/429 + 5xx all as `download_failed`,
 * per spec FR-20 + § 4.8).
 *
 * Security: message strings MUST NOT contain the Graph access token,
 * the signed `hostedContents/{id}/$value` URL, or any response-body
 * bytes. The `cause` field is for internal traces only — never log the
 * cause untyped.
 */

interface ErrorOptions {
	cause?: unknown;
}

/**
 * Generic Teams hosted-content download failure — covers 401/403/429/5xx,
 * timeout, abort, and byte-cap overflow.
 *
 * The optional `status` field captures the HTTP status code when available
 * so the caller can include it in structured logs without re-parsing.
 *
 * Mapped to `AttachmentWarning.reason = "download_failed"`.
 */
export class DownloadFailedError extends Error {
	public readonly status?: number;

	constructor(
		message = "Teams hosted-content download failed",
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
