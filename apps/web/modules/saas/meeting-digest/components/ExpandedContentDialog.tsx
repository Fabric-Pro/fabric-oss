"use client";

/**
 * Expand affordances for digest content (#2108).
 *
 * Two of them, deliberately distinct:
 *   - ExpandButton + ExpandedContentDialog — a per-section ⤢ opening a large
 *     in-place modal over one content type (summary, transcript). Fetch-free
 *     and control-free: the ticket scopes it to enlarging and scrolling.
 *   - PanelExpandButton + panelWidthClass — a panel-level toggle that widens
 *     the whole meeting sheet in place, added as a follow-up on the same
 *     ticket. No modal, so every section stays interactive.
 *
 * Both meeting sheets use both.
 */
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { Maximize2Icon, Minimize2Icon } from "lucide-react";
import type { ReactNode } from "react";

export function ExpandButton({
	label,
	onClick,
}: {
	label: string;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			aria-label={label}
			title={label}
			onClick={onClick}
			className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
		>
			<Maximize2Icon className="size-3.5" aria-hidden="true" />
		</button>
	);
}

export function ExpandedContentDialog({
	open,
	onOpenChange,
	title,
	children,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	children: ReactNode;
}) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			{/* The header row stays pinned; the body is the one scroll region
			    (grid row minmax(0,1fr) is what lets it shrink and scroll). */}
			<DialogContent className="h-[85vh] w-[92vw] max-w-4xl grid-rows-[auto_minmax(0,1fr)] overflow-hidden">
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription className="sr-only">
						Expanded reading view. Press Escape or use the close
						button to return to the meeting panel.
					</DialogDescription>
				</DialogHeader>
				<div className="overflow-y-auto pr-2 text-sm">{children}</div>
			</DialogContent>
		</Dialog>
	);
}

/**
 * Width classes for a meeting panel's SheetContent.
 *
 * Both branches emit a `sm:max-w-*` on purpose. `cn` is tailwind-merge, which
 * de-duplicates per class group *and* modifier — `w-*` and `max-w-*` are
 * different groups, so a bare `w-[480px]` from the caller leaves the sheet
 * variant's `sm:max-w-sm` (384px) standing and the panel renders 20% narrower
 * than the code asks for. That was the shipped behaviour before this change.
 */
export function panelWidthClass(expanded: boolean): string {
	return expanded
		? "w-full sm:w-[clamp(480px,65vw,1000px)] sm:max-w-[clamp(480px,65vw,1000px)]"
		: "w-full sm:w-[480px] sm:max-w-[480px]";
}

/**
 * Panel-level expand toggle, pinned left of SheetContent's own close button
 * (which is `absolute top-4 right-4`, size-4). Hidden below `sm`, where both
 * width states are full-bleed and there is nothing to expand.
 *
 * `top-[13px]` (not `top-4`) lines its icon centre up with the close button's:
 * this icon is wrapped in `p-1` around a `size-3.5` glyph while the close
 * button is unpadded around `size-4`, so matching `top` alone leaves them
 * visibly offset.
 */
export function PanelExpandButton({
	expanded,
	onToggle,
}: {
	expanded: boolean;
	onToggle: () => void;
}) {
	const label = expanded ? "Collapse panel" : "Expand panel";
	return (
		<button
			type="button"
			aria-label={label}
			aria-expanded={expanded}
			title={label}
			onClick={onToggle}
			className="absolute top-[13px] right-10 hidden rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground sm:block"
		>
			{expanded ? (
				<Minimize2Icon className="size-3.5" aria-hidden="true" />
			) : (
				<Maximize2Icon className="size-3.5" aria-hidden="true" />
			)}
		</button>
	);
}
