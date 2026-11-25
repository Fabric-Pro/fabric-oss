/**
 * The Google Drive connection errors, and a classifier for them by message.
 *
 * Deliberately dependency-free, like `../microsoft/connection-errors.ts`: the
 * API and the Temporal worker both classify an error that crossed a package
 * or activity boundary, where `instanceof` no longer holds, by its message.
 */

const NOT_CONNECTED_MESSAGE = "Google account not connected";
const TOKEN_EXPIRED_MESSAGE = "Google session expired";

/** No usable Google Drive connection: no active row, or no credentials. */
export class GoogleDriveNotConnectedError extends Error {
	constructor() {
		super(NOT_CONNECTED_MESSAGE);
		this.name = "GoogleDriveNotConnectedError";
	}
}

/** The access token expired and could not be refreshed. */
export class GoogleDriveTokenExpiredError extends Error {
	constructor() {
		super(TOKEN_EXPIRED_MESSAGE);
		this.name = "GoogleDriveTokenExpiredError";
	}
}

/**
 * Recognise a Google-Drive-account-not-usable error. Both errors above mean
 * the same thing to a reader: the person has to connect Google Drive again.
 */
export function isGoogleDriveNotConnectedError(message: string): boolean {
	return (
		message.includes(NOT_CONNECTED_MESSAGE) ||
		message.includes(TOKEN_EXPIRED_MESSAGE)
	);
}
