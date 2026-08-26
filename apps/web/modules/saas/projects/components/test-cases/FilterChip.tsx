"use client";

import { Button } from "@ui/components/button";
import { XIcon } from "lucide-react";

/**
 * A removable "narrowed to X" chip for the cases toolbar.
 *
 * One component for every such filter (the feature link, the plan membership),
 * so the two can't drift into two chip designs for one idea. The chip states
 * WHAT it filters by (`label`), the identifier it filters to, and — when the
 * caller can resolve it — the human name; the remove control is the only
 * interactive part, and it names the identifier so an icon-only X still says
 * what it removes.
 */
export function FilterChip({
	label,
	identifier,
	title,
	onRemove,
	removeAriaLabel,
}: {
	/** What this filters by, e.g. "Feature" / "Plan". */
	label: string;
	/** The identifier being filtered to. Rendered verbatim. */
	identifier: string;
	/** Human name, when the caller could resolve one from its options cache. */
	title?: string;
	onRemove: () => void;
	removeAriaLabel: string;
}) {
	return (
		<span className="inline-flex h-9 items-center gap-1 rounded-md border border-primary/30 bg-primary/10 pr-1 pl-2.5 text-sm">
			<span className="text-muted-foreground text-xs">{label}</span>
			<span className="font-mono text-xs tabular-nums">{identifier}</span>
			{title && (
				<span className="max-w-[10rem] truncate text-muted-foreground text-xs">
					{title}
				</span>
			)}
			<Button
				type="button"
				variant="ghost"
				size="icon-sm"
				onClick={onRemove}
				aria-label={removeAriaLabel}
				className="size-6 text-muted-foreground hover:text-foreground"
			>
				<XIcon className="size-3.5" aria-hidden="true" />
			</Button>
		</span>
	);
}
