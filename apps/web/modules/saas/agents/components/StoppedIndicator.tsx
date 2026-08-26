"use client";

import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import { CircleStop } from "lucide-react";
import { useTranslations } from "next-intl";

interface StoppedIndicatorProps {
	/** Optional className appended to the wrapper for surface-specific spacing tweaks. */
	className?: string;
}

/**
 * Editorial chip rendered inline at the end of an assistant turn that the
 * user halted (Send→Stop morph in the composer / Esc shortcut). Replaces
 * the earlier free-floating uppercase caption with a contained badge so
 * the cancellation reads as message metadata, not a layout block.
 *
 * Lives in `<output aria-live="polite">` so screen readers announce only
 * the cancellation — not every streaming text delta from the surrounding
 * body. The chip is not interactive, so the explanation reaches pointer
 * users through the tooltip and everyone else through the `sr-only` child;
 * a `title` would have been pointer-only, and an `aria-label` would have
 * replaced the visible "Stopped" as the chip's name.
 */
export function StoppedIndicator({ className }: StoppedIndicatorProps) {
	const t = useTranslations("tooltips.agents");
	const stoppedCopy = t("responseStopped");

	return (
		<output
			aria-live="polite"
			className={cn("mt-2 inline-block", className)}
		>
			<Tooltip>
				<TooltipTrigger asChild>
					<span className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-muted/50 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
						<CircleStop className="size-3" aria-hidden="true" />
						Stopped
						<span className="sr-only">{` — ${stoppedCopy}`}</span>
					</span>
				</TooltipTrigger>
				<TooltipContent>{stoppedCopy}</TooltipContent>
			</Tooltip>
		</output>
	);
}
