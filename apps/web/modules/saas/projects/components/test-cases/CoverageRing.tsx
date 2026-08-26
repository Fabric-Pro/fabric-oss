"use client";

import { cn } from "@ui/lib";

/**
 * The canonical coverage donut — a tokenized `stroke-primary` arc over a
 * `stroke-muted` track. Extracted from `TestCaseStatStrip` so every coverage
 * metric (automation %, CI-run coverage, the QA tab's rings) renders the same
 * mark instead of each surface drawing its own.
 *
 * `pathLength={100}` normalizes the circumference so `strokeDasharray` can be
 * expressed directly as a percentage — no 2πr math, and it stays correct if the
 * radius ever changes.
 */
export function CoverageRing({
	value,
	ariaLabel,
	size = "md",
	className,
}: {
	/** 0–100. Clamped, so a bad upstream tally can't draw an invalid arc. */
	value: number;
	ariaLabel: string;
	size?: "sm" | "md";
	className?: string;
}) {
	const safe = Math.max(0, Math.min(100, Math.round(value)));
	const sizeClass = size === "sm" ? "size-9" : "size-11";

	return (
		<span
			className={cn(
				"relative inline-flex shrink-0",
				sizeClass,
				className,
			)}
			role="img"
			aria-label={ariaLabel}
		>
			<svg
				viewBox="0 0 36 36"
				className={cn("-rotate-90", sizeClass)}
				aria-hidden="true"
			>
				<circle
					cx="18"
					cy="18"
					r="15.9155"
					fill="none"
					className="stroke-muted"
					strokeWidth="3.4"
				/>
				<circle
					cx="18"
					cy="18"
					r="15.9155"
					fill="none"
					className="stroke-primary"
					strokeWidth="3.4"
					strokeLinecap="round"
					pathLength={100}
					strokeDasharray={`${safe} ${100 - safe}`}
				/>
			</svg>
		</span>
	);
}
