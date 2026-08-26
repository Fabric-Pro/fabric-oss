/**
 * Frontend build-version detection.
 *
 * The build version is baked into the bundle at build time by `next.config.ts`
 * (`env.NEXT_PUBLIC_APP_VERSION`), resolved from the Vercel commit SHA (or an
 * explicit override / local git SHA). Both the client and the server
 * `/api/version` route read it through {@link getAppVersion}, so the version a
 * client loaded can be compared against the version the *latest* deployment
 * reports.
 */

/** Sentinel used when no real build version is available (local dev, etc.). */
export const DEV_VERSION = "dev";

/** Poll cadence while the tab is visible. */
export const VERSION_POLL_INTERVAL_MS = 60_000;

/**
 * Minimum time the tab must have been hidden before a return-to-visible event
 * is treated as a safe seam for a silent reload. Short tab switches never
 * trigger a reload.
 */
export const HIDDEN_RELOAD_THRESHOLD_MS = 5 * 60_000;

/**
 * How long a user may sit on a stale build — actively on one screen, never
 * navigating or hiding the tab — before the countdown banner appears as a
 * backstop so they aren't stranded on old code.
 */
export const STALE_BANNER_AFTER_MS = 10 * 60_000;

/** Countdown (seconds) the backstop banner shows before it auto-refreshes. */
export const BACKSTOP_COUNTDOWN_SECONDS = 60;

/**
 * The build version baked into this bundle. Written so that after Next inlines
 * `process.env.NEXT_PUBLIC_APP_VERSION` it degrades to a string literal that
 * also works in the browser (no runtime `process` access required).
 */
export function getAppVersion(): string {
	const version = process.env.NEXT_PUBLIC_APP_VERSION;
	return version && version.length > 0 ? version : DEV_VERSION;
}

/**
 * Version checking only runs in production builds that carry a real version.
 * In dev — or a build without a resolvable version — the watcher is inert, so
 * HMR and local rebuilds never trigger spurious reloads.
 */
export function isVersionCheckEnabled(): boolean {
	return (
		process.env.NODE_ENV === "production" && getAppVersion() !== DEV_VERSION
	);
}

export interface VersionPayload {
	version: string;
}

/** Defensive parse of the `/api/version` response body. */
export function parseVersionPayload(input: unknown): VersionPayload | null {
	if (!input || typeof input !== "object") {
		return null;
	}
	const record = input as Record<string, unknown>;
	const version = record.version;
	if (typeof version !== "string" || version.length === 0) {
		return null;
	}
	return { version };
}
