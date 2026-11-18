"use client";

/**
 * Search field for the Proposal Inbox list, with a polite live region that
 * announces how many proposals the query keeps. The region stays mounted
 * (empty while nothing is searched) because several screen readers skip a
 * live region that is inserted at the moment it first has content.
 */

import { Button } from "@ui/components/button";
import { SearchInput } from "@ui/components/search-input";
import { SearchIcon } from "lucide-react";
import { useId } from "react";

/** The empty state for a search that keeps nothing (not "All caught up"). */
export function ProposalSearchNoMatches({
	query,
	onClear,
}: {
	query: string;
	onClear: () => void;
}) {
	return (
		<div className="rounded-lg border border-dashed p-8 text-center">
			<p className="font-medium text-foreground text-sm">
				No proposals match “{query.trim()}”
			</p>
			<p className="mt-1 text-muted-foreground text-xs">
				Search looks at each proposal's summary and at the titles and
				ticket IDs of its items.
			</p>
			<Button
				type="button"
				variant="ghost"
				size="sm"
				className="mt-3"
				onClick={onClear}
			>
				Clear search
			</Button>
		</div>
	);
}

type Props = {
	value: string;
	onChange: (value: string) => void;
	/** Rows the query keeps, across every visible group. */
	matchCount: number;
	label: string;
};

export function ProposalInboxSearch({
	value,
	onChange,
	matchCount,
	label,
}: Props) {
	const inputId = useId();
	const searching = value.trim().length > 0;
	return (
		<div className="space-y-1">
			<label htmlFor={inputId} className="sr-only">
				{label}
			</label>
			<div className="relative">
				<SearchIcon
					aria-hidden
					className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
				/>
				<SearchInput
					id={inputId}
					value={value}
					onChange={(event) => onChange(event.target.value)}
					// Short enough to stay whole on a phone.
					placeholder="Search proposals and items"
					className="h-9 pl-8"
				/>
			</div>
			<output aria-live="polite" className="sr-only">
				{searching
					? matchCount === 1
						? "1 proposal matches"
						: `${matchCount} proposals match`
					: ""}
			</output>
		</div>
	);
}
