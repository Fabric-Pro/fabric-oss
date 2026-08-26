"use client";

import { useEffect, useState } from "react";

/**
 * Toast body for a bulk action: a message, an Undo button, and a primary-colored
 * countdown bar across the bottom edge that drains over `durationMs` so the
 * remaining undo window is visible. The bar drains via a `scaleX` transform
 * (transform-origin left) rather than animating `width` — that avoids the
 * rounded-corner clipping that made the bar look "sliced", and is smoother. The
 * bar uses the project's `--primary` token, not a hardcoded color.
 */
export function BulkUndoToast({
	message,
	durationMs,
	onUndo,
}: {
	message: string;
	durationMs: number;
	onUndo: () => void;
}) {
	const [scale, setScale] = useState(1);
	const [animate, setAnimate] = useState(true);
	useEffect(() => {
		// Respect prefers-reduced-motion: skip the draining animation and hold a
		// static bar (sonner still auto-dismisses after `durationMs`). An inline
		// `transition` can't be gated by Tailwind's motion-safe:, so check here.
		if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
			setAnimate(false);
			return;
		}
		// Next frame: flip to 0 so the CSS transition animates the drain.
		const raf = requestAnimationFrame(() => setScale(0));
		return () => cancelAnimationFrame(raf);
	}, []);
	return (
		<div className="relative w-full overflow-hidden rounded-lg border border-border bg-popover shadow-lg">
			<div className="flex items-center gap-3 px-3 py-2.5">
				<p className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
					{message}
				</p>
				<button
					type="button"
					onClick={onUndo}
					className="shrink-0 rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-accent"
				>
					Undo
				</button>
			</div>
			{/* Draining countdown across the bottom edge (clipped to the toast's
			    rounded corners by the parent's overflow-hidden). */}
			<div className="absolute inset-x-0 bottom-0 h-1 bg-border/40">
				<div
					className="h-full bg-primary"
					style={{
						transformOrigin: "left",
						transform: `scaleX(${scale})`,
						transition: animate
							? `transform ${durationMs}ms linear`
							: undefined,
					}}
				/>
			</div>
		</div>
	);
}
