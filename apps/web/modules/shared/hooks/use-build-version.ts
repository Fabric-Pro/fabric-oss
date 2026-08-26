"use client";

import {
	getAppVersion,
	isVersionCheckEnabled,
	parseVersionPayload,
	VERSION_POLL_INTERVAL_MS,
	type VersionPayload,
} from "@shared/lib/app-version";
import { useCallback, useEffect, useRef, useState } from "react";

interface BuildVersionState {
	/** True once a newer deployed version has been observed. Sticky. */
	isStale: boolean;
}

export interface UseBuildVersionResult extends BuildVersionState {
	/**
	 * Poll the version endpoint now. Resolves with the fresh state (or `null`
	 * when checking is disabled or the request failed) so seam handlers can act
	 * on the result immediately without waiting for React state to settle.
	 */
	checkNow: () => Promise<BuildVersionState | null>;
}

/**
 * Polls `/api/version` and reports whether the currently-loaded build is stale
 * relative to the latest deployment. Polls on mount, on focus, on return to
 * visibility, and on an interval — but only while the tab is visible, and only
 * in production builds carrying a real version. Network failures are swallowed
 * and the stale flag is sticky (a transient bad poll never clears it).
 */
export function useBuildVersion(): UseBuildVersionResult {
	const enabled = isVersionCheckEnabled();
	const currentVersion = getAppVersion();
	const [state, setState] = useState<BuildVersionState>({ isStale: false });
	// Sticky stale flag, read synchronously by seam handlers / repeated polls.
	const isStaleRef = useRef(false);

	const checkNow =
		useCallback(async (): Promise<BuildVersionState | null> => {
			if (!enabled) {
				return null;
			}
			let payload: VersionPayload | null = null;
			try {
				const response = await fetch("/api/version", {
					cache: "no-store",
					credentials: "omit",
					headers: { accept: "application/json" },
				});
				if (!response.ok) {
					return null;
				}
				payload = parseVersionPayload(await response.json());
			} catch {
				// Network blip — keep prior state, never surface an error.
				return null;
			}
			if (!payload || payload.version === "dev") {
				return null;
			}
			const stale =
				payload.version !== currentVersion || isStaleRef.current;
			if (stale) {
				isStaleRef.current = true;
			}
			const next: BuildVersionState = { isStale: stale };
			setState((prev) => (prev.isStale === next.isStale ? prev : next));
			return next;
		}, [enabled, currentVersion]);

	useEffect(() => {
		if (!enabled) {
			return;
		}
		let cancelled = false;
		const tick = () => {
			if (!cancelled && document.visibilityState === "visible") {
				void checkNow();
			}
		};
		tick(); // on mount / app load
		const interval = window.setInterval(tick, VERSION_POLL_INTERVAL_MS);
		const onFocus = () => tick();
		const onVisibility = () => {
			if (document.visibilityState === "visible") {
				tick();
			}
		};
		window.addEventListener("focus", onFocus);
		document.addEventListener("visibilitychange", onVisibility);
		return () => {
			cancelled = true;
			window.clearInterval(interval);
			window.removeEventListener("focus", onFocus);
			document.removeEventListener("visibilitychange", onVisibility);
		};
	}, [enabled, checkNow]);

	return { ...state, checkNow };
}
