"use client";

import { Button } from "@ui/components/button";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import { BellIcon, BellOffIcon, Loader2Icon } from "lucide-react";
import {
	type SubscriptionSubjectType,
	useSubscription,
} from "../hooks/use-subscription";

type SubscribeToggleProps = {
	subjectType: SubscriptionSubjectType;
	subjectId: string;
	projectId: string;
	className?: string;
};

/**
 * Opt-in "watch this item" toggle for a document or feature. Subscribed state
 * is signalled by colour (→ `--primary`) and a filled bell, never a scale
 * transform (per design system). Icon-only, so it carries an `aria-label` +
 * `aria-pressed` and a Tooltip for sighted users.
 */
export function SubscribeToggle({
	subjectType,
	subjectId,
	projectId,
	className,
}: SubscribeToggleProps) {
	const { subscribed, isLoading, isMutating, toggle } = useSubscription({
		subjectType,
		subjectId,
		projectId,
	});

	const label = subscribed
		? "Unsubscribe from updates"
		: "Subscribe to updates";
	const Icon = isMutating ? Loader2Icon : subscribed ? BellIcon : BellOffIcon;

	return (
		<TooltipProvider>
			<Tooltip>
				<TooltipTrigger asChild>
					<Button
						type="button"
						variant="ghost"
						size="icon"
						onClick={toggle}
						disabled={isLoading || isMutating}
						aria-label={label}
						aria-pressed={subscribed}
						className={cn(
							"shrink-0 size-8 text-muted-foreground transition-colors hover:text-foreground",
							subscribed && "text-primary hover:text-primary",
							className,
						)}
					>
						<Icon
							className={cn(
								"size-4",
								isMutating && "motion-safe:animate-spin",
							)}
						/>
					</Button>
				</TooltipTrigger>
				<TooltipContent>
					<p>{label}</p>
				</TooltipContent>
			</Tooltip>
		</TooltipProvider>
	);
}
