/**
 * Thin Drive v3 REST helper for exporting a Google Doc to plain text.
 *
 * Discovery happens client-side via the Google Picker; only the export step
 * runs server-side, against file IDs the user has explicitly opened with our
 * app via the Picker (which is the only access pattern `drive.file` grants).
 *
 * Errors are classified into a small set of typed sentinels so the calling
 * batch loop can tally auth failures separately from per-doc not-found /
 * transient failures, and surface a "reconnect Google" CTA when a token
 * revocation invalidates the whole batch mid-flight.
 */

/**
 * 401 / 403 from Drive's export endpoint — the access token isn't valid
 * for this file or has been revoked. Distinguishing this from a generic
 * fetch error lets the batch caller surface a reconnect prompt instead of
 * marking every doc as "extraction failed" with no actionable signal.
 */
export class GoogleDriveExportAuthError extends Error {
	readonly status: number;
	constructor(status: number) {
		super(`Google Drive export auth error (${status})`);
		this.name = "GoogleDriveExportAuthError";
		this.status = status;
	}
}

/**
 * 404 from Drive — the file ID doesn't exist for this user (deleted,
 * never granted access via Picker, or otherwise inaccessible). Per-doc;
 * does not invalidate the batch.
 */
export class GoogleDriveExportNotFoundError extends Error {
	constructor() {
		super(
			"Google Drive export error 404 (file not found or not accessible)",
		);
		this.name = "GoogleDriveExportNotFoundError";
	}
}

/**
 * 429 / 5xx from Drive — transient. Per-doc; does not invalidate the batch.
 * Caller may choose to retry once these are surfaced uniformly.
 */
export class GoogleDriveExportTransientError extends Error {
	readonly status: number;
	constructor(status: number) {
		super(`Google Drive export transient error (${status})`);
		this.name = "GoogleDriveExportTransientError";
		this.status = status;
	}
}

export async function exportGoogleDocText(input: {
	token: string;
	fileId: string;
}): Promise<string> {
	const url = `https://www.googleapis.com/drive/v3/files/${input.fileId}/export?mimeType=${encodeURIComponent(
		"text/plain",
	)}`;
	const response = await fetch(url, {
		headers: { Authorization: `Bearer ${input.token}` },
	});
	if (!response.ok) {
		// Classify so the batch loop can react differently: auth failures
		// invalidate the whole batch (the token is dead); 404s are per-doc;
		// 429/5xx are transient. Anything else falls through as a generic
		// Error and the loop treats it as a per-doc failure.
		if (response.status === 401 || response.status === 403) {
			throw new GoogleDriveExportAuthError(response.status);
		}
		if (response.status === 404) {
			throw new GoogleDriveExportNotFoundError();
		}
		if (response.status === 429 || response.status >= 500) {
			throw new GoogleDriveExportTransientError(response.status);
		}
		throw new Error(`Google Drive export error ${response.status}`);
	}
	return response.text();
}
