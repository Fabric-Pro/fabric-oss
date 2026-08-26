"use client";

import type { ParseTicketIdsError } from "@repo/api/modules/projects/procedures/stories/sync/list-pm-tickets-filters.types";
import { useId } from "react";
import { FilterActions } from "./FilterActions";
import { TicketIdsField } from "./TicketIdsField";

interface FiltersSectionProps {
	/** Draft state (updated on keystroke) */
	idsText: string;
	onIdsTextChange: (next: string) => void;

	/** Client-side parse errors (empty = none). Blocks Apply when non-empty. */
	parseErrors: ParseTicketIdsError[];

	onApply: () => void;
	onClear: () => void;
}

/**
 * `FILTERS` shell above the ticket list. Owns layout + field wiring only;
 * draft/applied state lives in the parent dialog so TanStack Query's queryKey
 * can depend solely on applied filters (typing fires no network, per §5.3).
 */
export function FiltersSection({
	idsText,
	onIdsTextChange,
	parseErrors,
	onApply,
	onClear,
}: FiltersSectionProps) {
	const errorRegionId = useId();
	const hasBlockingError = parseErrors.length > 0;
	const isEmpty = idsText.trim().length === 0;

	return (
		<section
			aria-labelledby={`${errorRegionId}-label`}
			className="border-b border-border/60 bg-muted/40 px-4 pt-2 pb-3 flex flex-col gap-3"
		>
			<span id={`${errorRegionId}-label`} className="editorial-label">
				Filters
			</span>
			<TicketIdsField
				value={idsText}
				onChange={onIdsTextChange}
				errors={parseErrors}
				autoFocus
				errorRegionId={errorRegionId}
			/>
			<FilterActions
				onApply={onApply}
				onClear={onClear}
				applyDisabled={hasBlockingError || isEmpty}
				applyDescribedBy={hasBlockingError ? errorRegionId : undefined}
			/>
		</section>
	);
}
