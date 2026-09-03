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
 */
export function ProjectTabButton({
	label,
	icon: Icon,
	isActive,
	showIcon,
	showTitle,
	anchor,
	onSelect,
	registerRef,
}: Props) {
	const button = (
		<button
			ref={registerRef}
			type="button"
			aria-label={label}
			data-onboarding-target={anchor}
			onClick={onSelect}
			className={cn(
				"group relative flex shrink-0 items-center gap-2 rounded-xl py-2.5 font-medium text-sm transition-colors",
				showTitle ? "px-4" : "px-3",
				isActive
					? "text-foreground"
					: "text-foreground/60 hover:text-foreground/80",
			)}
		>
			{isActive && (
				<div
					aria-hidden="true"
					className="absolute inset-0 rounded-xl border border-primary/15 bg-primary/10"
				/>
			)}
			{showIcon && (
				<Icon
					aria-hidden="true"
					className={cn(
						"relative z-10 size-4 shrink-0",
						isActive && "text-primary",
					)}
				/>
			)}
			{showTitle && <span className="relative z-10">{label}</span>}
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
			<TooltipContent side="bottom">{label}</TooltipContent>
		</Tooltip>
	);
}
