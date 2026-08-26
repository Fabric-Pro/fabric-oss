"use client";

import type { PMTicketListNote } from "@repo/api/modules/projects/procedures/stories/sync/list-pm-tickets-filters.types";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@ui/components/collapsible";
import { ChevronDownIcon } from "lucide-react";
import { useState } from "react";

interface NotesRegionProps {
	notes: PMTicketListNote[];
}

function compactIdRanges(ids: (string | number)[]): string {
	const nums = ids
		.map((id) => (typeof id === "number" ? id : Number(id)))
		.filter((n) => Number.isFinite(n))
		.sort((a, b) => a - b);
	if (nums.length === 0) {
		return ids.map((id) => `#${id}`).join(", ");
	}
	const ranges: string[] = [];
	let start = nums[0];
	let prev = nums[0];
	for (let i = 1; i < nums.length; i++) {
		const n = nums[i];
		if (n === prev + 1) {
			prev = n;
			continue;
		}
		ranges.push(start === prev ? `#${start}` : `#${start}–${prev}`);
		start = n;
		prev = n;
	}
	ranges.push(start === prev ? `#${start}` : `#${start}–${prev}`);
	return ranges.join(", ");
}

/**
 * Non-error notes surfaced from the procedure response. Renders a compact,
 * single-line summary with an optional expanded list. Spec §5.2, §5.5, AC-9.
 */
export function NotesRegion({ notes }: NotesRegionProps) {
	const [open, setOpen] = useState(false);
	if (notes.length === 0) {
		return null;
	}
	const ids = notes.map((n) => n.id);
	const summary = compactIdRanges(ids);
	return (
		<Collapsible open={open} onOpenChange={setOpen} asChild>
			<div
				aria-live="polite"
				className="border-b border-border/40 text-sm text-muted-foreground"
			>
				<CollapsibleTrigger className="w-full flex items-center justify-between gap-2 px-4 py-2 hover:bg-muted/40 transition-colors text-left">
					<span className="truncate">
						{notes.length} already imported · {summary}
					</span>
					<ChevronDownIcon
						className={`size-4 shrink-0 transition-transform ${
							open ? "rotate-180" : ""
						}`}
					/>
				</CollapsibleTrigger>
				<CollapsibleContent className="px-4 pb-2">
					<ul className="flex flex-col gap-0.5 text-xs">
						{notes.map((note) => (
							<li key={`${note.kind}-${note.id}`}>
								#{note.id} is already imported
							</li>
						))}
					</ul>
				</CollapsibleContent>
			</div>
		</Collapsible>
	);
}
