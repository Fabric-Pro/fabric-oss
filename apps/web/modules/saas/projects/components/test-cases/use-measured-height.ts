"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";

/**
 * Measure an element's height and keep it current.
 *
 * The Testing page head is sticky and its height is not knowable ahead of time
 * — the title, health line and actions sit on one row on a wide screen and wrap
 * onto three on a narrow one. The table's column header pins directly beneath
 * it, so a guessed offset leaves either a gap the rows scroll through or an
 * overlap that hides the first row. Measured, both hold at every width.
 *
 * Returns a ref callback rather than a ref object so the observer is attached
 * the moment the node exists and detached when it goes.
 */
export function useMeasuredHeight(initial: number) {
	const [height, setHeight] = useState(initial);
	const observer = useRef<ResizeObserver | null>(null);

	const ref = useCallback((node: HTMLElement | null) => {
		observer.current?.disconnect();
		observer.current = null;
		if (!node) {
			return;
		}
		const measure = () =>
			setHeight((prev) => {
				const next = Math.round(node.getBoundingClientRect().height);
				return next === prev ? prev : next;
			});
		measure();
		if (typeof ResizeObserver !== "undefined") {
			observer.current = new ResizeObserver(measure);
			observer.current.observe(node);
		}
	}, []);

	useLayoutEffect(() => () => observer.current?.disconnect(), []);

	return [ref, height] as const;
}
