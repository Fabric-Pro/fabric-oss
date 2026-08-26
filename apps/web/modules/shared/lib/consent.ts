/**
 * Consent primitives shared by the client provider, the server document and the
 * `/api/consent` route handler.
 *
 * Kept free of `"use client"` and of any browser global so a route handler can
 * import it: the server route is the path that still works when the client
 * bundle never hydrates.
 */

import { safeRelativePath } from "@shared/lib/safe-redirect";

export type ConsentPreferences = {
	essential: boolean; // Always true, required for the site to function
	analytics: boolean; // For analytics tracking
	marketing: boolean; // For marketing/advertising cookies
};

export type ConsentState = "pending" | "accepted" | "declined" | "customized";

/** The decisions the banner itself can post. */
export type ConsentDecision = "analytics" | "decline";

export const CONSENT_COOKIE_NAME = "cookie_consent";
export const CONSENT_PREFERENCES_COOKIE_NAME = "cookie_preferences";
export const FABRIC_ANALYTICS_CONSENT_COOKIE_NAME = "fabric_analytics_consent";
/**
 * localStorage fallback for browsers whose tracking-prevention or policy
 * settings block cookie writes. Must not match any analytics/marketing storage
 * prefix, or the consent cleanup would delete the consent record itself.
 */
export const CONSENT_STORAGE_KEY = "fabric_cookie_consent";
export const CONSENT_EXPIRY_DAYS = 365; // GDPR recommends re-consent every 12 months

export const CONSENT_FORM_ACTION = "/api/consent";
export const CONSENT_DECISION_FIELD = "decision";
export const CONSENT_RETURN_TO_FIELD = "returnTo";

export function getConsentCookieDomain(hostname: string) {
	return hostname === "fabric.pro" || hostname.endsWith(".fabric.pro")
		? ".fabric.pro"
		: undefined;
}

export function parseConsentState(value: string | undefined): ConsentState {
	if (
		value === "accepted" ||
		value === "declined" ||
		value === "customized"
	) {
		return value;
	}
	return "pending";
}

export function parsePreferences(
	value: string | undefined,
): ConsentPreferences {
	if (!value) {
		return { essential: true, analytics: false, marketing: false };
	}
	try {
		const parsed = JSON.parse(value);
		return {
			essential: true, // Always true
			analytics: Boolean(parsed.analytics),
			marketing: Boolean(parsed.marketing),
		};
	} catch {
		return { essential: true, analytics: false, marketing: false };
	}
}

/**
 * Maps a posted decision onto the stored state. Anything unrecognised is
 * treated as a decline — the privacy-preserving reading of a malformed post.
 */
export function resolveConsentDecision(decision: string | undefined | null): {
	state: ConsentState;
	preferences: ConsentPreferences;
} {
	if (decision === "analytics") {
		return {
			state: "customized",
			preferences: { essential: true, analytics: true, marketing: false },
		};
	}

	return {
		state: "declined",
		preferences: { essential: true, analytics: false, marketing: false },
	};
}

/**
 * Constrains a post-consent redirect to a same-site path, so the consent form
 * can never be used as an open redirect.
 *
 * Delegates to the shared `safeRelativePath`, which already handles the
 * non-obvious half of this problem: URL parsing strips ASCII tab, newline and
 * carriage return before interpreting the rest, so `"/\t/evil.example"` walks
 * past every leading-character check and then resolves to another host.
 * Returns null rather than a fallback path, so the caller can tell a rejected
 * value apart from a visitor who really was on `/`.
 */
export function sanitizeReturnTo(
	value: string | undefined | null,
): string | null {
	if (!value || value.length > 2048) {
		return null;
	}

	return safeRelativePath(value);
}
