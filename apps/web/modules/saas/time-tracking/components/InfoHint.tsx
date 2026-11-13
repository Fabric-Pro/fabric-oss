"use client";

import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import { InfoIcon } from "lucide-react";
import type { ReactNode } from "react";

/**
 * A small (i) button beside a title that holds the title's explanation.
 *
 * Help text is never left standing on the page; it lives here and opens on
 * hover and on keyboard focus (Radix opens a tooltip when its trigger is
 * focused), so it is reachable without a pointer.
 */
export function InfoHint({
	label,
	children,
	className,
}: {
	/** Names the button for assistive technology, e.g. "About My time". */
	label: string;
	children: ReactNode;
	className?: string;
}) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<button
					type="button"
					aria-label={label}
					className={cn(
						"inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground",
						"motion-safe:transition-colors motion-safe:duration-150 hover:text-foreground",
						"focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
						className,
					)}
				>
					<InfoIcon className="size-3.5" aria-hidden="true" />
				</button>
			</TooltipTrigger>
			<TooltipContent>{children}</TooltipContent>
		</Tooltip>
	);
}
