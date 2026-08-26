"use client";

import { ConsentBanner } from "@shared/components/ConsentBanner";
import {
	CONSENT_COOKIE_NAME,
	CONSENT_EXPIRY_DAYS,
	CONSENT_PREFERENCES_COOKIE_NAME,
	CONSENT_STORAGE_KEY,
	type ConsentPreferences,
	type ConsentState,
	FABRIC_ANALYTICS_CONSENT_COOKIE_NAME,
	getConsentCookieDomain,
	parseConsentState,
	parsePreferences,
} from "@shared/lib/consent";
import Cookies from "js-cookie";
import { usePathname } from "next/navigation";
import { createContext, useCallback, useEffect, useState } from "react";

export type { ConsentPreferences, ConsentState } from "@shared/lib/consent";

export const ConsentContext = createContext<{
	consentState: ConsentState;
	preferences: ConsentPreferences;
	hasResponded: boolean;
	allowAllCookies: () => void;
	declineAllCookies: () => void;
	savePreferences: (prefs: Partial<ConsentPreferences>) => void;
	// Legacy compatibility
	userHasConsented: boolean;
	allowCookies: () => void;
	declineCookies: () => void;
}>({
	consentState: "pending",
	preferences: { essential: true, analytics: false, marketing: false },
	hasResponded: false,
	allowAllCookies: () => {},
	declineAllCookies: () => {},
	savePreferences: () => {},
	// Legacy
	userHasConsented: false,
	allowCookies: () => {},
	declineCookies: () => {},
});

const GOOGLE_ANALYTICS_ID = process.env.NEXT_PUBLIC_GOOGLE_ANALYTICS_ID as
	| string
	| undefined;

const ANALYTICS_COOKIE_PREFIXES = [
	"_ga",
	"_gid",
	"_gat",
	"mp_",
	"ph_",
	"ajs_",
	"amplitude_",
];

const MARKETING_COOKIE_PREFIXES = ["_gcl_", "_fbp", "_fbc"];

const ANALYTICS_STORAGE_PREFIXES = [
	"mp_",
	"mixpanel",
	"ph_",
	"posthog",
	"ajs_",
	"amplitude",
	"_ga",
	"_gid",
	"_gat",
];

const MARKETING_STORAGE_PREFIXES = ["_gcl_", "_fbp", "_fbc", "ttclid"];

function getCookieDomainCandidates(hostname: string) {
	if (
		!hostname ||
		hostname === "localhost" ||
		/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)
	) {
		return [];
	}

	const parts = hostname.split(".").filter(Boolean);

	if (parts.length < 2) {
		return [];
	}

	const baseDomain = parts.slice(-2).join(".");
	return [hostname, `.${hostname}`, baseDomain, `.${baseDomain}`];
}

function removeCookieEverywhere(name: string) {
	Cookies.remove(name);
	Cookies.remove(name, { path: "/" });

	if (typeof window === "undefined") {
		return;
	}

	for (const domain of getCookieDomainCandidates(window.location.hostname)) {
		Cookies.remove(name, { path: "/", domain });
	}
}

function clearCookiesByPrefixes(prefixes: string[]) {
	if (typeof document === "undefined") {
		return;
	}

	try {
		const cookieNames = document.cookie
			.split(";")
			.map((entry) => entry.trim().split("=")[0])
			.filter(Boolean);

		for (const name of cookieNames) {
			if (prefixes.some((prefix) => name.startsWith(prefix))) {
				removeCookieEverywhere(name);
			}
		}
	} catch {
		// Sandboxed frames can throw SecurityError on document.cookie access.
	}
}

function clearStorageByPrefixes(prefixes: string[]) {
	if (typeof window === "undefined") {
		return;
	}

	const clear = (storage: Storage) => {
		const keys = Object.keys(storage);
		for (const key of keys) {
			if (prefixes.some((prefix) => key.startsWith(prefix))) {
				storage.removeItem(key);
			}
		}
	};

	try {
		clear(window.localStorage);
	} catch {
		// Some browser privacy modes can block localStorage access.
	}

	try {
		clear(window.sessionStorage);
	} catch {
		// Some browser privacy modes can block sessionStorage access.
	}
}

function applyGoogleConsentMode(
	analyticsAllowed: boolean,
	marketingAllowed: boolean,
) {
	if (typeof window === "undefined") {
		return;
	}

	const win = window as unknown as Window & {
		gtag?: (...args: unknown[]) => void;
		dataLayer?: unknown[];
		[key: string]: unknown;
	};

	if (GOOGLE_ANALYTICS_ID) {
		win[`ga-disable-${GOOGLE_ANALYTICS_ID}`] = !analyticsAllowed;
	}

	if (typeof win.gtag === "function") {
		win.gtag("consent", "update", {
			analytics_storage: analyticsAllowed ? "granted" : "denied",
			ad_storage: marketingAllowed ? "granted" : "denied",
			ad_user_data: marketingAllowed ? "granted" : "denied",
			ad_personalization: marketingAllowed ? "granted" : "denied",
		});
	}
}

function applyProviderConsent(analyticsAllowed: boolean) {
	if (typeof window === "undefined") {
		return;
	}

	const win = window as unknown as Window & {
		posthog?: {
			opt_in_capturing?: () => void;
			opt_out_capturing?: () => void;
			reset?: () => void;
		};
		mixpanel?: {
			opt_in_tracking?: () => void;
			opt_out_tracking?: () => void;
			reset?: () => void;
		};
	};

	if (analyticsAllowed) {
		win.posthog?.opt_in_capturing?.();
		win.mixpanel?.opt_in_tracking?.();
		return;
	}

	win.posthog?.opt_out_capturing?.();
	win.posthog?.reset?.();
	win.mixpanel?.opt_out_tracking?.();
	win.mixpanel?.reset?.();
}

function enforceNonEssentialConsent(
	analyticsAllowed: boolean,
	marketingAllowed: boolean,
) {
	applyGoogleConsentMode(analyticsAllowed, marketingAllowed);
	applyProviderConsent(analyticsAllowed);

	if (!analyticsAllowed) {
		clearCookiesByPrefixes(ANALYTICS_COOKIE_PREFIXES);
		clearStorageByPrefixes(ANALYTICS_STORAGE_PREFIXES);
	}

	if (!marketingAllowed) {
		clearCookiesByPrefixes(MARKETING_COOKIE_PREFIXES);
		clearStorageByPrefixes(MARKETING_STORAGE_PREFIXES);
	}
}

function getConsentCookieAttributes() {
	const sharedDomain = getConsentCookieDomain(window.location.hostname);

	return {
		domain: sharedDomain,
		expires: CONSENT_EXPIRY_DAYS,
		path: "/",
		sameSite: "lax" as const,
		secure: window.location.protocol === "https:",
	};
}

function writeConsentCookies(state: ConsentState, prefs: ConsentPreferences) {
	if (typeof window === "undefined") {
		return;
	}

	try {
		const cookieAttributes = getConsentCookieAttributes();
		Cookies.set(CONSENT_COOKIE_NAME, state, cookieAttributes);
		Cookies.set(
			CONSENT_PREFERENCES_COOKIE_NAME,
			JSON.stringify(prefs),
			cookieAttributes,
		);
		Cookies.set(
			FABRIC_ANALYTICS_CONSENT_COOKIE_NAME,
			prefs.analytics ? "granted" : "denied",
			cookieAttributes,
		);
	} catch {
		// Tracking-prevention modes, managed browser policies, and sandboxed
		// frames can block or throw on cookie writes. The localStorage
		// fallback still records the decision.
	}
}

function writeConsentFallback(state: ConsentState, prefs: ConsentPreferences) {
	if (typeof window === "undefined") {
		return;
	}

	try {
		window.localStorage.setItem(
			CONSENT_STORAGE_KEY,
			JSON.stringify({
				state,
				preferences: prefs,
				updatedAt: new Date().toISOString(),
			}),
		);
	} catch {
		// localStorage can be blocked too; dismissal already happened via
		// React state, so the decision just won't survive a reload.
	}
}

function readConsentFallback(): {
	state: ConsentState;
	preferences: ConsentPreferences;
} | null {
	if (typeof window === "undefined") {
		return null;
	}

	try {
		const raw = window.localStorage.getItem(CONSENT_STORAGE_KEY);
		if (!raw) {
			return null;
		}

		const parsed = JSON.parse(raw);
		const state = parseConsentState(parsed?.state);
		if (state === "pending") {
			return null;
		}

		// Parity with the cookie expiry: a stale decision must not outlive
		// the GDPR re-consent window.
		const updatedAt = Date.parse(parsed?.updatedAt);
		if (
			Number.isNaN(updatedAt) ||
			Date.now() - updatedAt > CONSENT_EXPIRY_DAYS * 24 * 60 * 60 * 1000
		) {
			return null;
		}

		// A declined record can never grant optional categories, even if the
		// stored preferences were tampered with — analytics loading is gated
		// on preferences.analytics, not on the state value.
		const optionalAllowed = state !== "declined";

		return {
			state,
			preferences: {
				essential: true,
				analytics:
					optionalAllowed && Boolean(parsed?.preferences?.analytics),
				marketing:
					optionalAllowed && Boolean(parsed?.preferences?.marketing),
			},
		};
	} catch {
		return null;
	}
}

function shouldForceGlobalPrivacyOptOut() {
	if (typeof navigator === "undefined") {
		return false;
	}

	const nav = navigator as Navigator & {
		globalPrivacyControl?: boolean;
	};

	// US state laws commonly require honoring user-level opt-out signals.
	return nav.globalPrivacyControl === true || navigator.doNotTrack === "1";
}

export function ConsentProvider({
	children,
	initialConsent,
	initialPreferences,
	isEmbed = false,
}: {
	children: React.ReactNode;
	initialConsent?: string;
	initialPreferences?: string;
	isEmbed?: boolean;
}) {
	// Seeded from the server-read cookies only. `navigator` must not be
	// consulted here: the server has none, so a render-time GPC/DNT check
	// produces a first client render that differs from the server markup, and
	// a hydration mismatch React cannot recover from leaves the server DOM in
	// place with no handlers attached — a banner that hovers but never
	// responds to a click. The signal is honoured in an effect below instead.
	const [consentState, setConsentState] = useState<ConsentState>(() =>
		parseConsentState(initialConsent),
	);
	const [preferences, setPreferences] = useState<ConsentPreferences>(() =>
		parsePreferences(initialPreferences),
	);
	const pathname = usePathname();

	const hasResponded = consentState !== "pending";

	const saveConsentState = useCallback(
		(state: ConsentState, prefs: ConsentPreferences) => {
			// State first: dismissing the banner must never depend on
			// persistence succeeding — both writes below are best-effort.
			setConsentState(state);
			setPreferences(prefs);

			if (!isEmbed) {
				writeConsentCookies(state, prefs);
				writeConsentFallback(state, prefs);
			}
		},
		[isEmbed],
	);

	useEffect(() => {
		if (!shouldForceGlobalPrivacyOptOut()) {
			return;
		}

		if (
			consentState === "declined" &&
			!preferences.analytics &&
			!preferences.marketing
		) {
			return;
		}

		saveConsentState("declined", {
			essential: true,
			analytics: false,
			marketing: false,
		});
	}, [
		consentState,
		preferences.analytics,
		preferences.marketing,
		saveConsentState,
	]);

	// Recover a decision persisted to the localStorage fallback when the
	// cookies were blocked, and best-effort re-write them (self-healing).
	// Deliberately not routed through saveConsentState: that would refresh
	// the fallback's updatedAt on every mount and slide the re-consent
	// window forever.
	useEffect(() => {
		if (
			isEmbed ||
			shouldForceGlobalPrivacyOptOut() ||
			consentState !== "pending"
		) {
			return;
		}

		const stored = readConsentFallback();
		if (!stored) {
			return;
		}

		setConsentState(stored.state);
		setPreferences(stored.preferences);
		writeConsentCookies(stored.state, stored.preferences);
	}, [consentState, isEmbed]);

	useEffect(() => {
		enforceNonEssentialConsent(
			preferences.analytics,
			preferences.marketing,
		);
	}, [preferences.analytics, preferences.marketing]);

	const allowAllCookies = useCallback(() => {
		const prefs: ConsentPreferences = {
			essential: true,
			analytics: true,
			marketing: true,
		};
		saveConsentState("accepted", prefs);
	}, [saveConsentState]);

	const declineAllCookies = useCallback(() => {
		const prefs: ConsentPreferences = {
			essential: true,
			analytics: false,
			marketing: false,
		};
		saveConsentState("declined", prefs);
	}, [saveConsentState]);

	const savePreferences = useCallback(
		(prefs: Partial<ConsentPreferences>) => {
			const newPrefs: ConsentPreferences = {
				essential: true, // Always true
				analytics: prefs.analytics ?? preferences.analytics,
				marketing: prefs.marketing ?? preferences.marketing,
			};
			saveConsentState("customized", newPrefs);
		},
		[preferences, saveConsentState],
	);

	// Legacy compatibility - userHasConsented is true when user has responded (either way)
	const userHasConsented = hasResponded;
	const allowCookies = allowAllCookies;
	const declineCookies = declineAllCookies;
	const allowAnalytics = useCallback(() => {
		saveConsentState("customized", {
			essential: true,
			analytics: true,
			marketing: false,
		});
	}, [saveConsentState]);

	return (
		<ConsentContext.Provider
			value={{
				consentState,
				preferences,
				hasResponded,
				allowAllCookies,
				declineAllCookies,
				savePreferences,
				// Legacy
				userHasConsented,
				allowCookies,
				declineCookies,
			}}
		>
			{children}
			{!hasResponded && !isEmbed ? (
				<ConsentBanner
					onAllowAnalytics={allowAnalytics}
					onDecline={declineAllCookies}
					returnTo={pathname ?? undefined}
				/>
			) : null}
		</ConsentContext.Provider>
	);
}
