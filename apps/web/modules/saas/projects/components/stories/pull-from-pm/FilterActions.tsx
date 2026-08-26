"use client";

import { Button } from "@ui/components/button";

interface FilterActionsProps {
	onApply: () => void;
	onClear: () => void;
	applyDisabled: boolean;
	applyDescribedBy?: string;
}

export function FilterActions({
	onApply,
	onClear,
	applyDisabled,
	applyDescribedBy,
}: FilterActionsProps) {
	return (
		<div className="flex items-center justify-end gap-2">
			<Button type="button" variant="ghost" size="sm" onClick={onClear}>
				Clear filters
			</Button>
			<Button
				type="button"
				variant="default"
				size="sm"
				onClick={onApply}
				disabled={applyDisabled}
				aria-describedby={applyDescribedBy}
			>
				Apply
			</Button>
		</div>
	);
}
