"use client";

import { ChevronRightIcon, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/**
 * One collapsible row of the dialog's advanced group, on the native
 * `<details>` element: its keyboard and screen-reader behaviour are the
 * browser's own, and its content stays in the DOM while closed, which is what
 * keeps state that lives in a child (a minted key) from being lost to a toggle.
 *
 * The row carries no border of its own; the group around the rows draws the
 * outline and the dividers.
 */
export function DisclosureRow({
	icon: Icon,
	label,
	testId,
	open,
	onOpenChange,
	children,
}: {
	icon: LucideIcon;
	label: string;
	testId: string;
	/** Set to control the row; left out, the row opens and closes by itself. */
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
	children: ReactNode;
}) {
	return (
		<details
			className="group"
			data-testid={testId}
			onToggle={(event) => onOpenChange?.(event.currentTarget.open)}
			open={open}
		>
			<summary className="flex list-none items-center gap-2.5 px-3.5 py-3 font-medium text-sm outline-none transition-colors hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset [&::-webkit-details-marker]:hidden">
				<Icon
					aria-hidden="true"
					className="size-4 shrink-0 text-muted-foreground"
				/>
				<span className="flex-1">{label}</span>
				<ChevronRightIcon
					aria-hidden="true"
					className="size-4 shrink-0 text-muted-foreground motion-safe:transition-transform group-open:rotate-90"
				/>
			</summary>
			<div className="space-y-3 pr-3.5 pb-3.5 pl-3.5 sm:pl-10">
				{children}
			</div>
		</details>
	);
}
