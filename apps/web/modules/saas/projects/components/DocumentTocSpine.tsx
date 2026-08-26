"use client";

import { cn } from "@ui/lib";
import { ChevronRightIcon, ListIcon } from "lucide-react";

interface DocumentTocSpineProps {
	isExpanded: boolean;
	onToggle: () => void;
	/** Id of the `<nav>` this button shows and hides. */
	controlsId: string;
	/** Vertical caption — the same string the rail used as its heading. */
	label: string;
	expandLabel: string;
	collapseLabel: string;
	className?: string;
}

/**
 * The always-visible spine of the table-of-contents rail: icon, vertical
 * caption, direction chevron. The whole 36px column is the button.
 *
 * Deliberately NOT built on `SidebarEdgeHandle`. That component is a 12x32
 * pill floating on the panel's edge, shared with the AI assistant panel, and
 * its whole geometry (absolute, half-width offset, edge-straddling) is the
 * opposite of what this needs — a spine that occupies real layout width so a
 * collapsed rail still says what it holds. Changing the shared handle would
 * change the assistant panel too.
 *
 * The caption is rendered in every state on purpose: collapsed is exactly when
 * it is the only thing explaining what the column opens. On a short rail it
 * clips from the bottom rather than disappearing — `min-h-0` lets it shrink
 * past its min-content size and `whitespace-nowrap` keeps a multi-word caption
 * from wrapping into extra vertical columns — so the icon and chevron keep
 * their size and the accessible name still carries the meaning.
 */
export function DocumentTocSpine({
	isExpanded,
	onToggle,
	controlsId,
	label,
	expandLabel,
	collapseLabel,
	className,
}: DocumentTocSpineProps) {
	const actionLabel = isExpanded ? collapseLabel : expandLabel;

	return (
		<button
			type="button"
			onClick={onToggle}
			aria-expanded={isExpanded}
			aria-controls={controlsId}
			aria-label={actionLabel}
			className={cn(
				"flex w-9 shrink-0 flex-col items-center gap-3 border-border border-r py-3.5",
				"text-muted-foreground motion-safe:transition-colors hover:bg-muted/60 hover:text-foreground",
				// Inset ring: the spine sits flush against the work area edge,
				// so an outset ring would be clipped by the parent's
				// overflow-hidden — the same clipping that cut the old pill in
				// half while the rail was 0px wide.
				"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
				isExpanded ? "bg-card" : "bg-background",
				className,
			)}
		>
			<ListIcon
				className="size-4 shrink-0 text-primary"
				aria-hidden="true"
			/>
			<span
				aria-hidden="true"
				className={cn(
					"[writing-mode:vertical-rl] whitespace-nowrap text-[11px] font-medium uppercase tracking-[0.18em] motion-safe:transition-colors",
					// Let the caption give up height instead of pushing the
					// chevron out of the column on a short rail.
					"min-h-0 overflow-hidden",
					isExpanded && "text-foreground",
				)}
			>
				{label}
			</span>
			<ChevronRightIcon
				className={cn(
					"mt-auto size-3.5 shrink-0 motion-safe:transition-transform motion-safe:duration-200",
					isExpanded && "rotate-180",
				)}
				aria-hidden="true"
			/>
		</button>
	);
}
