"use client";

import { cn } from "@ui/lib";
import { AlertTriangleIcon, LoaderCircleIcon } from "lucide-react";
import { forwardRef } from "react";

type Props = {
	onClick?: () => void;
	className?: string;
	pmToolName?: string;
	loading?: boolean;
	/**
	 * Overrides the default "PM sync conflict" text/aria — used to surface a
	 * distinct "PM unavailable" state when the user's connection couldn't load
	 * the PM side.
	 */
	label?: string;
};

export const PmSyncConflictBadge = forwardRef<HTMLButtonElement, Props>(
	function PmSyncConflictBadge(
		{ onClick, className, pmToolName, loading, label },
		ref,
	) {
		const resolvedLabel = label ?? "PM sync conflict";
		// A custom label (e.g. "PM unavailable") is an error state, not a
		// reviewable conflict — don't tell screen-reader users to "review".
		const ariaLabel = label
			? pmToolName
				? `${resolvedLabel} — ${pmToolName}`
				: resolvedLabel
			: pmToolName
				? `${resolvedLabel} — review changes against ${pmToolName}`
				: `${resolvedLabel} — review`;
		return (
			<button
				ref={ref}
				type="button"
				disabled={loading}
				onClick={(e) => {
					e.stopPropagation();
					onClick?.();
				}}
				aria-label={ariaLabel}
				className={cn(
					"inline-flex items-center gap-1.5 rounded-md border border-highlight/30 bg-muted px-2 py-0.5",
					"text-[10px] font-medium uppercase tracking-[0.18em] text-highlight",
					"transition-colors hover:border-highlight/50 hover:bg-highlight/5",
					"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-highlight/50",
					className,
				)}
			>
				{loading ? (
					<LoaderCircleIcon
						className="size-3 motion-safe:animate-spin"
						aria-hidden="true"
					/>
				) : (
					<AlertTriangleIcon className="size-3" aria-hidden="true" />
				)}
				{loading ? "Loading…" : resolvedLabel}
			</button>
		);
	},
);
