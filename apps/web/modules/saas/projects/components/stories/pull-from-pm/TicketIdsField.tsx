"use client";

import type { ParseTicketIdsError } from "@repo/api/modules/projects/procedures/stories/sync/list-pm-tickets-filters.types";
import { Label } from "@ui/components/label";
import { cn } from "@ui/lib";
import { useEffect, useId, useRef } from "react";

interface TicketIdsFieldProps {
	value: string;
	onChange: (next: string) => void;
	errors: ParseTicketIdsError[];
	autoFocus?: boolean;
	/** When provided, the rendered error region uses this id so external
	 * controls (Apply button) can point `aria-describedby` at it. */
	errorRegionId?: string;
}

const MIN_ROWS = 2;
const MAX_ROWS = 6;
const LINE_HEIGHT_PX = 20;

function describeError(err: ParseTicketIdsError): string {
	switch (err.kind) {
		case "range_inversion":
			return `Range start must be ≤ end (${err.token}).`;
		case "not_numeric":
			return `IDs must be numeric (${err.token}).`;
		case "over_cap":
			return "At most 200 IDs per import.";
		case "empty_token":
			return "Remove empty tokens between commas.";
	}
}

export function TicketIdsField({
	value,
	onChange,
	errors,
	autoFocus,
	errorRegionId,
}: TicketIdsFieldProps) {
	const id = useId();
	const helperId = `${id}-helper`;
	const errorId = errorRegionId ?? `${id}-error`;
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	// Auto-grow from MIN_ROWS up to MAX_ROWS based on content.
	useEffect(() => {
		const el = textareaRef.current;
		if (!el) {
			return;
		}
		el.style.height = "auto";
		const maxHeight = LINE_HEIGHT_PX * MAX_ROWS + 16;
		const minHeight = LINE_HEIGHT_PX * MIN_ROWS + 16;
		el.style.height = `${Math.min(Math.max(el.scrollHeight, minHeight), maxHeight)}px`;
	}, [value]);

	const hasError = errors.length > 0;
	const describedBy = hasError ? `${helperId} ${errorId}` : helperId;

	return (
		<div className="flex flex-col gap-1.5">
			<Label htmlFor={id} className="text-xs font-medium">
				Ticket IDs{" "}
				<span className="text-muted-foreground font-normal">
					(optional)
				</span>
			</Label>
			<textarea
				id={id}
				ref={textareaRef}
				value={value}
				onChange={(e) => onChange(e.target.value)}
				placeholder="417, 419-425, 430"
				rows={MIN_ROWS}
				// biome-ignore lint/a11y/noAutofocus: spec §5.5 requires IDs textarea as initial focus target on dialog open
				autoFocus={autoFocus}
				aria-describedby={describedBy}
				aria-invalid={hasError || undefined}
				className={cn(
					"flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-foreground/40 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 resize-none",
					hasError &&
						"border-destructive focus-visible:ring-destructive",
				)}
			/>
			<p id={helperId} className="text-muted-foreground text-xs">
				Comma-separated or ranges. Max 200.
			</p>
			{hasError && (
				<ul
					id={errorId}
					role="alert"
					aria-live="polite"
					className="flex flex-col gap-0.5 text-destructive text-xs"
				>
					{errors.map((err, i) => (
						<li key={`${err.kind}-${i}`}>{describeError(err)}</li>
					))}
				</ul>
			)}
		</div>
	);
}
