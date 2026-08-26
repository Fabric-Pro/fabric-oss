/**
 * OAuth popup helper.
 *
 * Centralizes window.open() for OAuth flows so every integration handles
 * popup-blocked detection consistently.
 */

const DEFAULT_WIDTH = 600;
const DEFAULT_HEIGHT = 700;

export interface OAuthPopupOptions {
	url: string;
	name: string;
	width?: number;
	height?: number;
}

export const POPUP_BLOCKED_MESSAGE =
	"Popup blocked by your browser. Allow popups for this site and try again.";

/**
 * Open an OAuth popup centered on the current window.
 *
 * Returns the popup Window on success, or null if the browser blocked it
 * (or returned a closed/inaccessible window). Callers should surface
 * POPUP_BLOCKED_MESSAGE to the user when null is returned.
 */
export function openOAuthPopup(options: OAuthPopupOptions): Window | null {
	if (typeof window === "undefined") {
		return null;
	}

	const width = options.width ?? DEFAULT_WIDTH;
	const height = options.height ?? DEFAULT_HEIGHT;
	const left = window.screenX + (window.outerWidth - width) / 2;
	const top = window.screenY + (window.outerHeight - height) / 2;

	const popup = window.open(
		options.url,
		options.name,
		`width=${width},height=${height},left=${left},top=${top}`,
	);

	if (!popup || popup.closed || typeof popup.closed === "undefined") {
		return null;
	}

	return popup;
}
