"use client";

import { useEffect } from "react";

/** Retry window covering hydration before giving up (~2s at 200ms). */
const MAX_RETRIES = 10;
const RETRY_DELAY_MS = 200;

/**
 * Scroll to and briefly highlight the question named by the URL fragment
 * (Fizzy #1751, AC-12) — so a notification lands ON the question rather than the
 * top of the feature.
 *
 * The fragment is `#q-<rootId>` and the row renders the SAME raw root id in
 * `data-question-anchor`, so the writer (`buildQuestionLink`) and this reader
 * cannot drift apart by a prefix.
 *
 * MODELLED ON, NOT SHARED WITH, the document-editor mention scroller. Extracting
 * a common hook would have been tidier, but the only guard on that refactor is a
 * Playwright suite that needs a running app, and silently regressing document
 * mentions to save forty lines is a bad trade. If the two are ever unified, do it
 * behind that E2E, not on a typecheck.
 *
 * The retry loop is the part that matters: the questions list arrives from a
 * query, so the row usually does not exist on first paint and a single
 * `querySelector` would miss every time.
 */
export function useScrollToQuestion(ready: boolean): void {
	useEffect(() => {
		if (typeof window === "undefined" || !ready) {
			return;
		}
		const hash = window.location.hash;
		if (!hash.startsWith("#q-")) {
			return;
		}
		// Root ids are cuids. Reject anything else so a crafted hash cannot break
		// out of the attribute selector.
		const anchor = hash.slice(3);
		if (!/^[0-9a-z_-]+$/i.test(anchor)) {
			return;
		}

		let cancelled = false;
		let retries = 0;
		let flashTimer: ReturnType<typeof setTimeout> | undefined;
		let retryTimer: ReturnType<typeof setTimeout> | undefined;

		const tryScroll = () => {
			if (cancelled) {
				return;
			}
			const el = window.document.querySelector<HTMLElement>(
				`[data-question-anchor="${anchor}"]`,
			);
			if (!el) {
				if (retries >= MAX_RETRIES) {
					return;
				}
				retries += 1;
				retryTimer = setTimeout(tryScroll, RETRY_DELAY_MS);
				return;
			}
			el.scrollIntoView({ block: "center" });
			el.classList.add("mention-flash");
			flashTimer = setTimeout(
				() => el.classList.remove("mention-flash"),
				2000,
			);
		};

		tryScroll();

		return () => {
			cancelled = true;
			if (flashTimer) {
				clearTimeout(flashTimer);
			}
			if (retryTimer) {
				clearTimeout(retryTimer);
			}
		};
	}, [ready]);
}
