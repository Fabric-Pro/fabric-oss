import { Badge } from "@ui/components/badge";
import { CheckCircle2, Link2Icon } from "lucide-react";

/**
 * Says whether a prompt is the one that actually runs, and at which tier.
 *
 * A bare "Default" is not enough once three tiers exist: a personal override and
 * the universal default it shadows are both "a default" to somebody, and the
 * question a user has in front of the library is *which one applies to me*. The
 * tier is therefore part of the badge, not a tooltip.
 *
 * The badge is outlined and coloured by tier, so scanning the library or the
 * action catalog answers two questions at a glance: what is in force, and how
 * far up the ladder its authority reaches. Lives in one component because the
 * grid, the table and the catalog all render it, and they had already drifted
 * apart on colour before this existed.
 */

/** Matches the tier vocabulary the binding dialogs use. PROJECT is an ORG
 *  binding narrowed to one project — it outranks Organization, beneath Personal. */
const TIER_LABEL: Record<"SYSTEM" | "ORG" | "PROJECT" | "USER", string> = {
	SYSTEM: "System",
	ORG: "Organization",
	PROJECT: "Project",
	USER: "Personal",
};

/** Outlined tier colours. Blue has no token in this theme; the Badge's own
 *  `info` variant set that precedent. */
const TIER_STYLE: Record<"SYSTEM" | "ORG" | "PROJECT" | "USER", string> = {
	SYSTEM: "text-primary border-primary/40",
	ORG: "text-highlight border-highlight/50",
	PROJECT: "text-blue-600 dark:text-blue-400 border-blue-500/40",
	USER: "text-success border-success/40",
};

type Props = {
	isDefault?: boolean;
	/** Bound to the target but not the winner — selectable, just not automatic. */
	isBound?: boolean;
	/** Tier the winning default came from. */
	defaultScope?: "SYSTEM" | "ORG" | "PROJECT" | "USER" | null;
	className?: string;
};

export function PromptDefaultBadge({
	isDefault,
	isBound,
	defaultScope,
	className,
}: Props) {
	if (isDefault) {
		return (
			<Badge
				variant="outline"
				className={`shrink-0 ${
					defaultScope
						? TIER_STYLE[defaultScope]
						: "text-muted-foreground"
				} ${className ?? ""}`}
			>
				<CheckCircle2 className="mr-0.5 h-3 w-3" />
				{defaultScope
					? `Default · ${TIER_LABEL[defaultScope]}`
					: "Default"}
			</Badge>
		);
	}

	// FR5: what else is on offer. Without this, a prompt bound to the same action
	// as the default is indistinguishable from one bound to nothing at all.
	if (isBound) {
		return (
			<Badge
				variant="outline"
				className={`shrink-0 text-muted-foreground ${className ?? ""}`}
			>
				<Link2Icon className="mr-0.5 h-3 w-3" />
				Available
			</Badge>
		);
	}

	return null;
}
