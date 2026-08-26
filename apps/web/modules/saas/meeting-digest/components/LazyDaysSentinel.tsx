"use client";

import { useCallback, useEffect, useRef } from "react";

/**
 * Trigger for the digest's later-days fetch (#2106, FR2 / D1).
 *
 * Fires when scrolled into view, but renders a real <button> rather than a bare
 * observer div. That button is both the fallback where IntersectionObserver is
 * unavailable (jsdom, older browsers) and the accessible path in every browser:
 * a scroll-only trigger cannot be reached by keyboard at all.
 *
 * The once-only guard is per mount, so an observer that reports several
 * intersections while the request is in flight cannot queue a second fetch. The
 * retry path deliberately bypasses it — that is the user asking again after a
 * failure, which is exactly what the guard must not swallow.
 */
export function LazyDaysSentinel({
	onLoad,
	isLoading,
	isError,
}: {
	onLoad: () => void;
	isLoading: boolean;
	isError: boolean;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const firedRef = useRef(false);

	const fireOnce = useCallback(() => {
		if (firedRef.current) {
			return;
		}
		firedRef.current = true;
		onLoad();
	}, [onLoad]);

	useEffect(() => {
		if (typeof IntersectionObserver === "undefined") {
			return;
		}
		const element = ref.current;
		if (!element) {
			return;
		}
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((entry) => entry.isIntersecting)) {
					fireOnce();
				}
			},
			{ threshold: 0.1 },
		);
		observer.observe(element);
		return () => observer.disconnect();
	}, [fireOnce]);

	if (isError) {
		return (
			<div className="space-y-1 rounded border border-destructive/40 px-3 py-2">
				<p className="text-sm text-destructive">
					Couldn't load the rest of your calendar.
				</p>
				<button
					type="button"
					className="text-sm underline underline-offset-2"
					onClick={() => {
						firedRef.current = true;
						onLoad();
					}}
				>
					Retry
				</button>
			</div>
		);
	}

	if (isLoading) {
		return (
			<div
				ref={ref}
				aria-live="polite"
				className="px-3 py-2 text-sm text-muted-foreground"
			>
				Loading more days…
			</div>
		);
	}

	return (
		<div ref={ref} className="pt-1">
			<button
				type="button"
				className="text-sm text-muted-foreground underline underline-offset-2 hover:text-foreground"
				onClick={fireOnce}
			>
				Show more days
			</button>
		</div>
	);
}
