/**
 * Slack authenticated file download.
 *
 * Used by the apply-time orchestrator `attachPendingMediaToStory` to fetch
 * the binary bytes of a Slack file from its signed `url_private`, then upload
 * them into R2 under the `story-media/...` keyspace.
 *
 * Security contract:
 *  - The bot token is sent only as an `Authorization: Bearer …` header. It
 *    is NEVER included in any thrown message, log statement, or error trace.
 *  - The `urlPrivate` is treated as sensitive (time-bounded signed URL) and
 *    is NEVER logged. Callers surface structured fields (`refId`, `mime`,
 *    `size`) only.
 *  - Only `https://` URLs are accepted. Non-HTTPS callers fail at the
 *    boundary with `DownloadFailedError` before any network IO occurs.
 *
 * Failure mapping:
 *  - 200 + JSON body `{ ok: false, error: "missing_scope" }`
 *                                         → `ScopeMissingError`
 *  - 401 (`invalid_auth` / `token_revoked` / `token_expired` /
 *      `account_inactive` / `not_authed`)
 *                                         → `AuthFailedError`
 *  - 403                                  → `ExternalWorkspaceError`
 *  - any other non-2xx, abort, byte-cap   → `DownloadFailedError`
 */

import {
	AuthFailedError,
	DownloadFailedError,
	ExternalWorkspaceError,
	ScopeMissingError,
} from "./download-file.errors";

export interface DownloadSlackFileOptions {
	/**
	 * AbortController signal — propagated to `fetch`. The caller's overall
	 * approval-time budget controller (`APPROVAL_BUDGET_MS`) wires this.
	 */
	signal?: AbortSignal;
	/**
	 * Hard byte ceiling for the download. When cumulative bytes exceed this,
	 * the read is aborted and `DownloadFailedError("image_too_large")` is
	 * thrown. Matches `MAX_BYTES_PER_IMAGE` in `attachment-constants.ts`.
	 */
	maxBytes: number;
}

export interface DownloadSlackFileResult {
	buffer: Buffer;
	mime: string;
	size: number;
}

/**
 * Type guard: a successful `fetch` response that may contain a JSON error
 * body even though the HTTP status was 200 (Slack returns 200 with
 * `{ ok: false, error: "..." }` for some auth failures).
 */
async function isJsonErrorBody(
	response: Response,
): Promise<{ ok: false; error?: string } | null> {
	const contentType = response.headers.get("content-type") ?? "";
	if (!contentType.toLowerCase().includes("application/json")) {
		return null;
	}
	// Clone before reading so the caller can still consume the body if we
	// happen to mis-detect (defense in depth).
	try {
		const parsed = (await response.clone().json()) as {
			ok?: boolean;
			error?: string;
		};
		if (parsed && parsed.ok === false) {
			return { ok: false, error: parsed.error };
		}
	} catch {
		// Not valid JSON — fall through.
	}
	return null;
}

export async function downloadSlackFile(
	urlPrivate: string,
	accessToken: string,
	options: DownloadSlackFileOptions,
): Promise<DownloadSlackFileResult> {
	// HTTPS-only boundary. Reject before any network IO.
	if (!urlPrivate.startsWith("https://")) {
		throw new DownloadFailedError("Slack file URL must use https://");
	}

	const { signal, maxBytes } = options;

	let response: Response;
	try {
		response = await fetch(urlPrivate, {
			headers: {
				Authorization: `Bearer ${accessToken}`,
			},
			signal,
		});
	} catch (cause) {
		// AbortError, network failure, DNS, TLS, etc. — surface as a generic
		// download failure. NEVER include the URL or token in the message.
		throw new DownloadFailedError("Slack file fetch failed", { cause });
	}

	const status = response.status;

	if (status === 401) {
		// 401 is Slack's token-level failure (invalid_auth / token_revoked /
		// token_expired / account_inactive / not_authed). The genuine scope
		// failure is HTTP 200 with `{ok:false, error:"missing_scope"}` —
		// handled below.
		throw new AuthFailedError(undefined, {
			cause: { status },
		});
	}

	if (status === 403) {
		throw new ExternalWorkspaceError(undefined, {
			cause: { status },
		});
	}

	// Slack sometimes returns 200 with `{ ok: false, error: "missing_scope" }`
	// instead of 401. Detect that before treating the body as binary.
	if (status === 200) {
		const jsonError = await isJsonErrorBody(response);
		if (jsonError && jsonError.error === "missing_scope") {
			throw new ScopeMissingError(undefined, {
				cause: { status, slackError: "missing_scope" },
			});
		}
		// Any other 200 + JSON ok=false body is an opaque download failure.
		if (jsonError) {
			throw new DownloadFailedError(
				"Slack download responded with JSON error body",
				{
					status,
					cause: { slackError: jsonError.error },
				},
			);
		}
	}

	if (status < 200 || status >= 300) {
		throw new DownloadFailedError("Slack download non-2xx response", {
			status,
		});
	}

	const body = response.body;
	if (!body) {
		// Empty body on 2xx — surface as download failure.
		throw new DownloadFailedError("Slack download returned empty body", {
			status,
		});
	}

	// Stream the body with a running byte ceiling. The reader is also bound
	// to the caller's `signal` via the underlying `fetch`, so an abort
	// propagates here as a read error.
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let received = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			if (value) {
				received += value.byteLength;
				if (received > maxBytes) {
					try {
						await reader.cancel();
					} catch {
						// Best-effort cleanup; ignore secondary failures.
					}
					throw new DownloadFailedError("image_too_large", {
						status,
					});
				}
				chunks.push(value);
			}
		}
	} catch (err) {
		if (err instanceof DownloadFailedError) {
			throw err;
		}
		throw new DownloadFailedError("Slack download stream read failed", {
			cause: err,
			status,
		});
	}

	const buffer = Buffer.concat(chunks.map((c) => Buffer.from(c)));
	const mime =
		response.headers.get("content-type") ?? "application/octet-stream";

	return {
		buffer,
		mime,
		size: buffer.byteLength,
	};
}
