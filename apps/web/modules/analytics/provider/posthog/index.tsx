"use client";

import { useCookieConsent } from "@shared/hooks/cookie-consent";
import { usePathname } from "next/navigation";
import posthog from "posthog-js";
import { useEffect, useRef, useState } from "react";

const posthogKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;
const posthogHost =
	process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com";

function getSurface(pathname: string) {
	if (/\/docs(?:\/|$)/.test(pathname)) {
		return "docs";
	}
	if (/\/app(?:\/|$)/.test(pathname)) {
		return "product";
	}
	return "marketing";
}

/**
 * Contact intent is "went to TechFabric's contact experience" — match the
 * apex AND any subdomain (www.techfabric.com), never a lookalike suffix
 * (nottechfabric.com), so attribution does not silently drop when a link is
 * authored with a host prefix.
 */
export function isTechFabricContactUrl(destination: URL) {
	const isTechFabricHost =
		destination.hostname === "techfabric.com" ||
		destination.hostname.endsWith(".techfabric.com");

	return isTechFabricHost && /^\/contact(?:\/|$)/.test(destination.pathname);
}

export function AnalyticsScript() {
	const pathname = usePathname();
	const lastPage = useRef<string | null>(null);
	// Reactive, so the page-view and click effects re-run once init completes
	// instead of depending on this effect happening to land first in the commit.
	const [initialized, setInitialized] = useState(false);

	useEffect(() => {
		if (!posthogKey) {
			return;
		}

		if (!posthog.__loaded) {
			posthog.init(posthogKey, {
				api_host: posthogHost,
				ui_host: "https://us.posthog.com",
				person_profiles: "identified_only",
				persistence: "localStorage+cookie",
				cross_subdomain_cookie: true,
				secure_cookie: true,
				autocapture: false,
				capture_pageview: false,
				capture_pageleave: false,
				disable_session_recording: true,
			});
		}

		setInitialized(true);
	}, []);

	useEffect(() => {
		if (!posthogKey || !initialized || lastPage.current === pathname) {
			return;
		}

		lastPage.current = pathname;
		posthog.capture("fabric_page_viewed", {
			product: "suite",
			path: pathname,
			site: window.location.hostname,
			surface: getSurface(pathname),
		});
	}, [pathname, initialized]);

	useEffect(() => {
		if (!posthogKey || !initialized) {
			return;
		}

		const captureContactClick = (event: MouseEvent) => {
			const link = (
				event.target as Element | null
			)?.closest<HTMLAnchorElement>("a[href]");
			if (!link) {
				return;
			}

			let destination: URL;
			try {
				destination = new URL(link.href, window.location.href);
			} catch {
				// Malformed/unsupported href (e.g. a bare "mailto:" fragment) —
				// nothing to attribute.
				return;
			}
			if (!isTechFabricContactUrl(destination)) {
				return;
			}

			posthog.capture("fabric_contact_clicked", {
				product: "suite",
				path: window.location.pathname,
				placement: link.dataset.fabricPlacement ?? "content",
				site: window.location.hostname,
			});
		};

		document.addEventListener("click", captureContactClick);
		return () => document.removeEventListener("click", captureContactClick);
	}, [initialized]);

	return null;
}

export function useAnalytics() {
	const { hasResponded, preferences } = useCookieConsent();

	const trackEvent = (event: string, data?: Record<string, unknown>) => {
		if (
			!posthogKey ||
			!hasResponded ||
			!preferences.analytics ||
			!posthog.__loaded
		) {
			return;
		}

		posthog.capture(event, data);
	};

	return {
		trackEvent,
	};
}
