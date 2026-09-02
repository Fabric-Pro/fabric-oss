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
	/** `data-onboarding-target` value — the Get Started anchor for this tab. */
	anchor: string;
	onSelect: () => void;
	registerRef: (element: HTMLButtonElement | null) => void;
};

/**
 * One tab in the project tab bar.
 *
 * The bar shows icons only so a long tab list stays readable; the name arrives
 * on hover or keyboard focus. The label is therefore always the button's
 * accessible name, never only painted text. The selected tab additionally
 * renders its label inline — it is the bar's only textual "you are here" — and
 * so needs no tooltip repeating it.
 */
export function ProjectTabButton({
	label,
	icon: Icon,
	isActive,
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
				isActive
					? "px-4 text-foreground"
					: "px-3 text-foreground/60 hover:text-foreground/80",
			)}
		>
			{isActive && (
				<div
					aria-hidden="true"
					className="absolute inset-0 rounded-xl border border-primary/15 bg-primary/10"
				/>
			)}
			<Icon
				aria-hidden="true"
				className={cn(
					"relative z-10 size-4 shrink-0",
					isActive && "text-primary",
				)}
			/>
			{isActive && <span className="relative z-10">{label}</span>}
		</button>
	);

	if (isActive) {
		return button;
	}

	// 200ms rather than the shared 500ms default: this bar is scanned by
	// sweeping across it, and every tab pays the delay independently — the
	// shared Tooltip mounts its own provider, so there is no skip-delay group
	// to inherit.
	return (
		<Tooltip delayDuration={200}>
			<TooltipTrigger asChild>{button}</TooltipTrigger>
			<TooltipContent side="bottom">{label}</TooltipContent>
		</Tooltip>
	);
}
