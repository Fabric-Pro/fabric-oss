"use client";

import { useBuildVersion } from "@shared/hooks/use-build-version";
import {
	BACKSTOP_COUNTDOWN_SECONDS,
	HIDDEN_RELOAD_THRESHOLD_MS,
	STALE_BANNER_AFTER_MS,
} from "@shared/lib/app-version";
import { canAutoReload } from "@shared/lib/auto-reload-guard";
import { Alert, AlertDescription, AlertTitle } from "@ui/components/alert";
import { Button } from "@ui/components/button";
import { RefreshCw } from "lucide-react";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

function reloadNow() {
	window.location.reload();
}

/**
 * Watches the deployed build version. When the loaded build is stale it
 * upgrades the user *seamlessly* — reloading to the latest build at the next
 * safe seam (an internal navigation, or returning to the tab after being away)
 * with no UI at all. Only if the user stays on a single screen for a long time
 * without ever hitting a seam does a banner appear, giving a one-minute
 * countdown before it refreshes so they are never stranded on old code.
 */
export function BuildVersionWatcher() {
	const { isStale, checkNow } = useBuildVersion();

	// Sticky ref so DOM event handlers read the latest value without re-binding.
	const isStaleRef = useRef(isStale);
	isStaleRef.current = isStale;

	// --- Navigation seam: turn the next internal page navigation into a single
	// full navigation to the same destination on the fresh build.
	useEffect(() => {
		function onClickCapture(event: MouseEvent) {
			if (!isStaleRef.current || event.defaultPrevented) {
				return;
			}
			if (
				event.button !== 0 ||
				event.metaKey ||
				event.ctrlKey ||
				event.shiftKey ||
				event.altKey
			) {
				return;
			}
			const anchor = (event.target as HTMLElement | null)?.closest?.("a");
			const href = anchor?.getAttribute("href");
			if (!anchor || !href) {
				return;
			}
			if (anchor.target && anchor.target !== "_self") {
				return;
			}
			if (anchor.hasAttribute("download")) {
				return;
			}
			let url: URL;
			try {
				url = new URL(href, window.location.href);
			} catch {
				return;
			}
			if (url.origin !== window.location.origin) {
				return;
			}
			// Only act on real page changes — leave same-page query/hash
			// updates to the SPA so we don't turn a lightweight in-page
			// transition into a full reload.
			if (url.pathname === window.location.pathname) {
				return;
			}
			// Unsaved work present — let the SPA navigate normally and reload
			// later at a safer seam (avoids a surprise "leave site?" prompt).
			if (!canAutoReload()) {
				return;
			}
			event.preventDefault();
			window.location.assign(url.href);
		}
		document.addEventListener("click", onClickCapture, true);
		return () =>
			document.removeEventListener("click", onClickCapture, true);
	}, []);

	// --- Navigation seam fallback: a programmatic route change while stale.
	const pathname = usePathname();
	const lastPathRef = useRef(pathname);
	useEffect(() => {
		if (pathname === lastPathRef.current) {
			return;
		}
		lastPathRef.current = pathname;
		if (isStaleRef.current && canAutoReload()) {
			reloadNow();
		}
	}, [pathname]);

	// --- Return-from-hidden seam: reload after a sufficiently long absence.
	const hiddenSinceRef = useRef<number | null>(null);
	useEffect(() => {
		function onVisibility() {
			if (document.visibilityState === "hidden") {
				hiddenSinceRef.current = Date.now();
				return;
			}
			const hiddenAt = hiddenSinceRef.current;
			hiddenSinceRef.current = null;
			if (hiddenAt === null) {
				return;
			}
			if (Date.now() - hiddenAt < HIDDEN_RELOAD_THRESHOLD_MS) {
				return;
			}
			void checkNow().then((result) => {
				if (result?.isStale && canAutoReload()) {
					reloadNow();
				}
			});
		}
		document.addEventListener("visibilitychange", onVisibility);
		return () =>
			document.removeEventListener("visibilitychange", onVisibility);
	}, [checkNow]);

	// --- Backstop: the user has sat on a stale build for a long time without
	// ever hitting a seam. Surface the countdown banner so they aren't stranded.
	const [showBanner, setShowBanner] = useState(false);
	useEffect(() => {
		if (!isStale) {
			return;
		}
		const timer = window.setTimeout(() => {
			if (isStaleRef.current) {
				setShowBanner(true);
			}
		}, STALE_BANNER_AFTER_MS);
		return () => window.clearTimeout(timer);
	}, [isStale]);

	if (isStale && showBanner) {
		return <UpdateCountdownBanner />;
	}
	return null;
}

function UpdateCountdownBanner() {
	const t = useTranslations();
	const [seconds, setSeconds] = useState(BACKSTOP_COUNTDOWN_SECONDS);

	useEffect(() => {
		if (seconds <= 0) {
			reloadNow();
			return;
		}
		const timer = window.setTimeout(() => setSeconds((s) => s - 1), 1000);
		return () => window.clearTimeout(timer);
	}, [seconds]);

	return (
		// `sticky` rather than plain flow: this banner is the only warning
		// before a forced reload, and it fires on someone parked mid-page —
		// almost always scrolled down. In static flow it would mount at the
		// top of the document, off-screen, and the page would reload with no
		// warning ever seen. Sticky still occupies its flow space, so it
		// reserves height and pushes content down instead of covering it.
		//
		// Spacing belongs on this wrapper, never on the Alert: the Alert owns
		// `p-4`, so `pt-*`/`pb-*` there would shrink its own padding instead
		// of adding any outer gap. `shrink-0` is defensive — on full-height
		// routes the column is `h-full overflow-hidden`, and today the page
		// root absorbs the shrink, but a sibling with its own `min-h-*` would
		// hit its floor and redirect that pressure here.
		<div className="sticky top-0 z-10 flex shrink-0 justify-center px-3 pt-3 pb-1 motion-safe:animate-in motion-safe:fade-in">
			{/* The Alert's role="alert" announces the message once on mount.
			 * The per-second countdown is aria-hidden so it doesn't spam
			 * screen readers; SR users hear the static description instead. */}
			<Alert
				variant="primary"
				className="flex max-w-2xl items-center gap-3"
			>
				<RefreshCw className="size-4 shrink-0" aria-hidden="true" />
				<div className="flex-1">
					<AlertTitle>{t("appUpdate.banner.title")}</AlertTitle>
					<AlertDescription>
						{t("appUpdate.banner.description")}{" "}
						<span
							aria-hidden="true"
							className="tabular-nums opacity-80"
						>
							{t("appUpdate.banner.countdown", { seconds })}
						</span>
					</AlertDescription>
				</div>
				<Button
					size="sm"
					variant="primary"
					className="shrink-0"
					onClick={reloadNow}
				>
					{t("appUpdate.banner.action")}
				</Button>
			</Alert>
		</div>
	);
}
