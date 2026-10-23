import { Badge } from "@ui/components/badge";
import { cn } from "@ui/lib";
import type { ReactNode } from "react";
import { type PromptTier, TIER_LABEL } from "./prompt-default-model";

function tierClassName(tier: PromptTier): string {
	switch (tier) {
		case "PROJECT":
			return "border-primary/40 bg-primary/10 text-primary-ink";
		case "ORG":
			return "border-[color-mix(in_srgb,var(--fab-warn)_45%,transparent)] text-[var(--fab-warn)]";
		case "USER":
			return "border-[color-mix(in_srgb,var(--success)_40%,transparent)] text-success";
		case "SYSTEM":
			return "border-border text-muted-foreground";
		case "NONE":
			return "border-border border-dashed text-muted-foreground";
		default: {
			const unreachable: never = tier;
			return unreachable;
		}
	}
}

export function PromptTierBadge({
	tier,
	children,
	className,
}: {
	tier: PromptTier;
	/** Defaults to the tier's name. */
	children?: ReactNode;
	className?: string;
}) {
	return (
		<Badge
			variant="outline"
			className={cn("bg-transparent", tierClassName(tier), className)}
		>
			{children ?? TIER_LABEL[tier]}
		</Badge>
	);
}
