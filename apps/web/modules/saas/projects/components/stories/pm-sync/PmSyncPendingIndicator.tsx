"use client";

import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";

type Props = {
	className?: string;
	pmToolName?: string;
	/** Short list label; full provider text remains in the tooltip and name. */
	compactLabel?: string;
};

export function PmSyncPendingIndicator({
	className,
	pmToolName,
	compactLabel,
}: Props) {
	const label = pmToolName ? `Syncing to ${pmToolName}…` : "Syncing to PM…";
	const indicator = (
		<output
			aria-live="polite"
			tabIndex={compactLabel ? 0 : undefined}
			aria-label={compactLabel ? label : undefined}
			className={cn(
				"inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-muted px-2 py-0.5",
				"text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground",
				"motion-safe:animate-pulse",
				className,
			)}
		>
			<span
				aria-hidden="true"
				className="size-1.5 rounded-full bg-muted-foreground/60"
			/>
			{compactLabel ?? label}
		</output>
	);
	return compactLabel ? (
		<Tooltip>
			<TooltipTrigger asChild>{indicator}</TooltipTrigger>
			<TooltipContent>{label}</TooltipContent>
		</Tooltip>
	) : (
		indicator
	);
}
