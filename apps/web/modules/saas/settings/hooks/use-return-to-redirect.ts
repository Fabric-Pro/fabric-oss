"use client";

import { getReturnToFromUrl } from "@saas/settings/lib/settings-return-url";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Custom event dispatched when a settings page completes configuration
 * and the user should be redirected back to the project setup flow.
 *
 * The SettingsReturnBanner listens for this event and shows a countdown
 * before navigating back.
 */
export const RETURN_REDIRECT_EVENT = "settings:return-redirect";

/**
 * Hook for auto-redirecting back to the project setup flow after
 * a setting has been configured.
 *
 * Reads `returnTo` from the current URL (validated via shared utility).
 * When `triggerReturn()` is called (typically after a successful save),
 * it dispatches a custom event that the SettingsReturnBanner picks up
 * to show a countdown animation.
 *
 * The redirect is non-blocking — the user can cancel via "Stay here" in the banner.
 */
export function useReturnToRedirect() {
	const router = useRouter();
	const [returnTo, setReturnTo] = useState<string | null>(null);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		setReturnTo(getReturnToFromUrl());
	}, []);

	// Listen for cancel from banner "Stay here" button
	useEffect(() => {
		const handler = () => {
			if (timerRef.current) {
				clearTimeout(timerRef.current);
				timerRef.current = null;
			}
		};
		window.addEventListener("settings:return-cancel", handler);
		return () => {
			window.removeEventListener("settings:return-cancel", handler);
			if (timerRef.current) {
				clearTimeout(timerRef.current);
			}
		};
	}, []);

	const triggerReturn = useCallback(() => {
		// Guard: skip if no returnTo or redirect already in progress
		if (!returnTo || timerRef.current) {
			return;
		}

		// Dispatch event for SettingsReturnBanner to show countdown
		window.dispatchEvent(new CustomEvent(RETURN_REDIRECT_EVENT));

		// Navigate after countdown (matches banner animation duration)
		timerRef.current = setTimeout(() => {
			router.push(returnTo);
		}, 3000);
	}, [returnTo, router]);

	const cancelReturn = useCallback(() => {
		if (timerRef.current) {
			clearTimeout(timerRef.current);
			timerRef.current = null;
		}
	}, []);

	return { returnTo, triggerReturn, cancelReturn };
}
