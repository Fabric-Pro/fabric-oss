"use client";

/**
 * Scroll affordance for fixed-height regions.
 *
 * Atlas Overview has two internally-scrolling regions — the hero tour body and
 * the embedded tech-stack list — whose scrollability was easy to miss (a
 * hover-only scrollbar, no "there's more below" cue). `ScrollFade` wraps a
 * scroll viewport and makes that obvious WITHOUT decorating regions that never
 * overflow:
 *   - an always-visible thin, tokened scrollbar (`.scroll-affordance`);
 *   - soft top/bottom fades that appear ONLY while there is more content in
 *     that direction (measured, not a permanent mask);
 *   - the viewport becomes keyboard-focusable only while it actually overflows,
 *     so arrow-key scrolling works without ever adding a dead tab stop.
 *
 * The fades are `aria-hidden` decoration and every transition is gated behind
 * `motion-safe:`.
 */
import { cn } from "@ui/lib";
import { type ReactNode, useEffect, useState } from "react";

/**
 * Tracks whether a scroll container has content clipped above/below its
 * viewport. Re-measures on scroll, on container/content resize (ResizeObserver)
 * and on any subtree mutation (e.g. an accordion section expanding).
 *
 * Returns a callback ref (a `useState` setter) rather than a `useRef`, so the
 * effect re-binds cleanly whenever the observed node mounts, unmounts, or is
 * replaced — the Overview tour body is keyed per page and remounts on every
 * navigation.
 */
function useScrollAffordance<T extends HTMLElement>() {
	const [node, setNode] = useState<T | null>(null);
	const [canScrollUp, setCanScrollUp] = useState(false);
	const [canScrollDown, setCanScrollDown] = useState(false);

	useEffect(() => {
		if (!node) {
			return;
		}
		const measure = () => {
			const { scrollTop, scrollHeight, clientHeight } = node;
			// A 1px tolerance absorbs sub-pixel rounding so the fades don't
			// flicker at the extremes.
			setCanScrollUp(scrollTop > 1);
			setCanScrollDown(
				Math.ceil(scrollTop + clientHeight) < scrollHeight - 1,
			);
		};
		measure();
		node.addEventListener("scroll", measure, { passive: true });
		const resizeObserver =
			typeof ResizeObserver !== "undefined"
				? new ResizeObserver(measure)
				: null;
		resizeObserver?.observe(node);
		// Content can grow/shrink without the viewport resizing (the tech-stack
		// accordion expands inside a fixed-height box) — watch the subtree too.
		const mutationObserver = new MutationObserver(measure);
		mutationObserver.observe(node, {
			childList: true,
			subtree: true,
			characterData: true,
			attributes: true,
		});
		return () => {
			node.removeEventListener("scroll", measure);
			resizeObserver?.disconnect();
			mutationObserver.disconnect();
		};
	}, [node]);

	return { ref: setNode, canScrollUp, canScrollDown };
}

interface ScrollFadeProps {
	children: ReactNode;
	/** Classes for the inner scroll viewport (height, padding, flex, …). */
	className?: string;
	/** Classes for the outer relative wrapper (layout/sizing). */
	wrapperClassName?: string;
	/** Height utility for the top/bottom fade overlays. Defaults to `h-6`. */
	fadeClassName?: string;
}

/**
 * A vertical scroll viewport that makes its scrollability obvious. See the file
 * header for the behaviour contract.
 */
export function ScrollFade({
	children,
	className,
	wrapperClassName,
	fadeClassName = "h-6",
}: ScrollFadeProps) {
	const { ref, canScrollUp, canScrollDown } =
		useScrollAffordance<HTMLDivElement>();
	const canScroll = canScrollUp || canScrollDown;

	return (
		<div className={cn("relative", wrapperClassName)}>
			<div
				ref={ref}
				// Keyboard-scrollable only while it overflows — no dead tab stop
				// when the content already fits.
				tabIndex={canScroll ? 0 : undefined}
				className={cn(
					"scroll-affordance overflow-y-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
					className,
				)}
			>
				{children}
			</div>
			{/* Top fade — only while content is clipped above. */}
			<div
				aria-hidden="true"
				className={cn(
					"pointer-events-none absolute inset-x-0 top-0 motion-safe:transition-opacity motion-safe:duration-200",
					fadeClassName,
					canScrollUp ? "opacity-100" : "opacity-0",
				)}
				style={{
					background:
						"linear-gradient(to bottom, var(--card), transparent)",
				}}
			/>
			{/* Bottom fade — only while there's more content below. */}
			<div
				aria-hidden="true"
				className={cn(
					"pointer-events-none absolute inset-x-0 bottom-0 motion-safe:transition-opacity motion-safe:duration-200",
					fadeClassName,
					canScrollDown ? "opacity-100" : "opacity-0",
				)}
				style={{
					background:
						"linear-gradient(to top, var(--card), transparent)",
				}}
			/>
		</div>
	);
}
