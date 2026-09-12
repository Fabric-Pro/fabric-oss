"use client";

import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import type { LucideIcon } from "lucide-react";

type Props = {
	label: string;
	icon: LucideIcon;
	isActive: boolean;
	/** Paint the icon. False only when the viewer asked for the title alone. */
	showIcon: boolean;
	/** Paint the title. False only when the viewer asked for the icon alone. */
	showTitle: boolean;
	/** `data-onboarding-target` value — the Get Started anchor for this tab. */
	anchor: string;
	/** Mark this tab's feature as still work in progress (Fizzy #2348). */
	beta: boolean;
	/**
	 * The tab did not fit on the row and is offered from the "More" menu
	 * instead. It stays mounted, out of flow and invisible, so the row can
	 * still measure it; it drops out of the tab order and gives up its
	 * onboarding anchor to the menu trigger.
	 */
	overflowed?: boolean;
	onSelect: () => void;
	registerRef: (element: HTMLButtonElement | null) => void;
};

/**
 * One tab in the project tab bar.
 *
 * A tab paints its icon and its title unless the viewer dropped one of them
 * for this tab. Dropping both is not a state this component renders: it means
 * the tab is hidden, and resolution removes it from the bar before we get
 * here.
 *
 * The title is the button's accessible name whichever way it paints, so an
 * icon-only tab still reads correctly to a screen reader, and the tooltip
 * carries the name for sighted viewers only when the bar stops showing it.
 *
 * A beta tab says so in that same name, for the same reason: the name is the
 * only thing every paint mode has. What it paints varies, because there is no
 * one mark that works in both modes — a chip beside a title that may not be
 * there is invisible, and a dot on an icon that may not be there is too.
 */
export function ProjectTabButton({
	label,
	icon: Icon,
	isActive,
	showIcon,
	showTitle,
	anchor,
	beta,
	overflowed = false,
	onSelect,
	registerRef,
}: Props) {
	const accessibleName = beta ? `${label} (Beta)` : label;
	const button = (
		<button
			ref={registerRef}
			type="button"
			aria-label={accessibleName}
			data-onboarding-target={overflowed ? undefined : anchor}
			tabIndex={overflowed ? -1 : undefined}
			onClick={onSelect}
			className={cn(
				// An underline tab: ink and weight carry the state, no fill.
				"-mb-px flex shrink-0 items-center gap-2 whitespace-nowrap border-b-2 pt-2 pb-2.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
				showTitle ? "px-3" : "px-2.5",
				isActive
					? "border-foreground font-medium text-foreground"
					: "border-transparent text-muted-foreground hover:text-foreground",
				overflowed && "invisible absolute pointer-events-none",
			)}
		>
			{showIcon && (
				<span className="relative flex shrink-0">
					<Icon aria-hidden="true" className="size-4 shrink-0" />
					{/* Only when no title is painted — otherwise the chip
					 * below says it in words, and both at once reads as two
					 * different claims. */}
					{beta && !showTitle && (
						<span
							aria-hidden="true"
							data-testid="tab-beta-dot"
							className="-right-0.5 -top-0.5 absolute size-1.5 rounded-full bg-highlight"
						/>
					)}
				</span>
			)}
			{showTitle && (
				<span className="relative flex items-center gap-1.5">
					{label}
					{beta && (
						<span className="rounded-sm bg-highlight/15 px-1 py-px font-medium text-[10px] text-highlight uppercase tracking-wide">
							Beta
						</span>
					)}
				</span>
			)}
		</button>
	);

	if (showTitle) {
		return button;
	}

	// 200ms rather than the shared 500ms default: a viewer scanning a row of
	// icon-only tabs sweeps across them, and every tab pays the delay on its
	// own because the shared Tooltip mounts a provider per instance.
	return (
		<Tooltip delayDuration={200}>
			<TooltipTrigger asChild>{button}</TooltipTrigger>
			<TooltipContent side="bottom">{accessibleName}</TooltipContent>
		</Tooltip>
	);
}
