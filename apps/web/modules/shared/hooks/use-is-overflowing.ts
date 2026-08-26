"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Returns `[setRef, isOverflowing]` for detecting horizontal text overflow on
 * an element styled with `overflow: hidden` + `text-overflow: ellipsis`
 * (Tailwind `truncate`).
 *
 * The observer is attached *inside* the ref callback rather than in a mount
 * effect. Some surfaces portal the observed element into a slot whose target
 * DOM node only becomes non-null after the parent commits — a one-shot
 * `useEffect` runs before that and bails because the ref is still null, so it
 * never attaches the observer. Anchoring the observer to the element-attach
 * event makes detection work for both portal'd and inline usages, and lets
 * the same hook be reused across editors.
 *
 * Re-measures on:
 *   - element attach (via the ref callback)
 *   - element resize (ResizeObserver — fires when the container shifts, e.g.
 *     when an AI sidebar opens or the viewport changes)
 *   - `value` change (text typed by the user or replaced from upstream state)
 *   - web-font load (`document.fonts.ready`) — fallback-font metrics are
 *     wider than the final webfont, so the initial measurement can flip from
 *     truncated to fitting once the real font swaps in
 */
export function useIsOverflowing<T extends HTMLElement = HTMLElement>(
	value: string,
): readonly [(el: T | null) => void, boolean] {
	const elRef = useRef<T | null>(null);
	const observerRef = useRef<ResizeObserver | null>(null);
	const [isOverflowing, setIsOverflowing] = useState(false);

	const measure = useCallback(() => {
		const el = elRef.current;
		if (!el) {
			return;
		}
		setIsOverflowing(el.scrollWidth > el.clientWidth);
	}, []);

	const setRef = useCallback(
		(el: T | null) => {
			if (observerRef.current) {
				observerRef.current.disconnect();
				observerRef.current = null;
			}
			elRef.current = el;
			if (el && typeof ResizeObserver !== "undefined") {
				measure();
				const observer = new ResizeObserver(measure);
				observer.observe(el);
				observerRef.current = observer;
			}
		},
		[measure],
	);

	useEffect(() => {
		measure();
	}, [value, measure]);

	useEffect(() => {
		if (typeof document === "undefined" || !document.fonts?.ready) {
			return;
		}
		let cancelled = false;
		document.fonts.ready.then(() => {
			if (!cancelled) {
				measure();
			}
		});
		return () => {
			cancelled = true;
		};
	}, [measure]);

	return [setRef, isOverflowing] as const;
}
