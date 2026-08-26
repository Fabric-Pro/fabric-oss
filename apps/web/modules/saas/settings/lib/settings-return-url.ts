/**
 * Utility for building settings URLs with a `returnTo` query parameter.
 *
 * When the project-creation wizard (or any project page) sends the user to a
 * Settings page, we append `?returnTo=<encoded_path>` so the Settings UI can
 * render a "Return to project" banner once the configuration is complete.
 */

/**
 * Append a `returnTo` query-param to a settings href.
 *
 * @param settingsHref - The target settings path (e.g. `/app/settings/mcp`)
 * @param returnTo     - The path the user should return to (current page)
 * @returns The settings href with the encoded returnTo parameter
 *
 * @example
 * ```ts
 * withReturnTo("/app/settings/ai-providers", "/app/projects/new?step=5&projectId=abc")
 * // => "/app/settings/ai-providers?returnTo=%2Fapp%2Fprojects%2Fnew%3Fstep%3D5%26projectId%3Dabc"
 * ```
 */
export function withReturnTo(settingsHref: string, returnTo: string): string {
	if (!returnTo) {
		return settingsHref;
	}

	const separator = settingsHref.includes("?") ? "&" : "?";
	return `${settingsHref}${separator}returnTo=${encodeURIComponent(returnTo)}`;
}

const RETURN_TO_STORAGE_KEY = "fabric-settings-returnTo";

/**
 * Safely parse the `returnTo` query parameter from the current URL.
 *
 * Returns a validated path or `null`. Rejects:
 * - Protocol-relative URLs (`//evil.com`)
 * - External URLs (`https://…`)
 * - Paths that don't start with `/app/`
 *
 * When a valid `returnTo` is found in the URL, it is also persisted to
 * sessionStorage so it survives in-settings navigation (e.g. clicking
 * a provider card) that would otherwise drop the query parameter.
 *
 * This is the single source of truth for returnTo validation —
 * both the redirect hook and the banner component should use it.
 */
export function getReturnToFromUrl(): string | null {
	if (typeof window === "undefined") {
		return null;
	}

	const params = new URLSearchParams(window.location.search);
	const value = params.get("returnTo");

	if (value) {
		// Must be an internal app path: starts with "/" but not "//"
		if (!value.startsWith("/") || value.startsWith("//")) {
			return null;
		}

		// Extra safety: only allow paths within the app
		if (!value.startsWith("/app/")) {
			return null;
		}

		// Persist so sub-navigation within settings doesn't lose it
		try {
			sessionStorage.setItem(RETURN_TO_STORAGE_KEY, value);
		} catch {
			// ignore storage failures
		}

		return value;
	}

	// Fallback: check sessionStorage for a previously saved returnTo
	// (covers navigation to provider detail pages that drop the query param)
	try {
		const stored = sessionStorage.getItem(RETURN_TO_STORAGE_KEY);
		if (stored?.startsWith("/app/") && !stored.startsWith("//")) {
			return stored;
		}
	} catch {
		// ignore storage failures
	}

	return null;
}

/**
 * Clear the persisted returnTo value.
 * Called after a successful redirect so stale values don't linger.
 */
export function clearReturnTo(): void {
	try {
		sessionStorage.removeItem(RETURN_TO_STORAGE_KEY);
	} catch {
		// ignore storage failures
	}
}
