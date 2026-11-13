"use client";

import {
	ANTHROPIC_CAPABILITY_BODY,
	ANTHROPIC_CAPABILITY_TITLE,
} from "@saas/shared/lib/anthropic-capability";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { InfoIcon } from "lucide-react";
import { ANTHROPIC_PROVIDER_ID } from "../lib/ai-providers";

/**
 * The capability limitation, stated on the Anthropic card in Direct Providers.
 *
 * Rendered as a compact single-line notice with a keyboard-focusable tooltip
 * trigger so the Anthropic card remains the same height as every other card
 * in the Databricks Marketplace-style grid, while keeping the full body text
 * accessible in the DOM and via tooltip.
 */
export function AnthropicCapabilityNotice({
	providerId,
}: {
	providerId: string;
}) {
	if (providerId !== ANTHROPIC_PROVIDER_ID) {
		return null;
	}

	return (
		<div className="flex items-center justify-between gap-2 rounded-md border border-highlight/20 bg-highlight/5 px-2.5 py-1.5">
			<div className="flex min-w-0 items-center gap-1.5">
				<InfoIcon
					aria-hidden="true"
					className="size-3.5 shrink-0 text-highlight"
				/>
				<p className="truncate font-medium text-foreground text-xs">
					{ANTHROPIC_CAPABILITY_TITLE}
				</p>
				<span className="sr-only">{ANTHROPIC_CAPABILITY_BODY}</span>
			</div>
			<Tooltip>
				<TooltipTrigger asChild>
					<button
						type="button"
						aria-label={ANTHROPIC_CAPABILITY_TITLE}
						className="inline-flex shrink-0 rounded-sm text-highlight hover:text-highlight focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
					>
						<InfoIcon aria-hidden="true" className="size-3.5" />
					</button>
				</TooltipTrigger>
				<TooltipContent side="bottom" className="max-w-xs text-xs">
					{ANTHROPIC_CAPABILITY_BODY}
				</TooltipContent>
			</Tooltip>
		</div>
	);
}
