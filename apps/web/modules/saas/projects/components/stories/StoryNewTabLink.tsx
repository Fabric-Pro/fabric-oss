"use client";

/**
 * A link that opens a work item in a new tab without touching the review
 * state around it: a proposal's merge target, or the ticket an approved item
 * created or updated. Records the same analytics event as the proposal row's
 * "open existing ticket" button.
 */

import { useAnalytics } from "@analytics";
import { useBasePath } from "@saas/organizations/hooks/use-organization-context";
import { cn } from "@ui/lib";
import { ExternalLinkIcon } from "lucide-react";
import {
	BACKLOG_OPEN_EXISTING_EVENT,
	type BacklogProposalPanel,
} from "../../../../analytics/events/backlog-open-existing";
import {
	buildStoryDecisionLogRoute,
	buildStoryDetailsRoute,
} from "../../lib/stories/routes";

type Props = {
	projectId: string;
	storyId: string;
	/** Accessible name; name the ticket and the proposal item it belongs to. */
	label: string;
	/** Visible text; an icon-only link when omitted. */
	children?: React.ReactNode;
	/** Which view of the ticket opens; its details by default. */
	view?: "details" | "decisionLog";
	panel?: BacklogProposalPanel;
	className?: string;
};

function storyRoute(
	view: "details" | "decisionLog",
	basePath: string,
	projectId: string,
	storyId: string,
): string {
	switch (view) {
		case "details":
			return buildStoryDetailsRoute(basePath, projectId, storyId);
		case "decisionLog":
			return buildStoryDecisionLogRoute(basePath, projectId, storyId);
		default: {
			const unhandled: never = view;
			return unhandled;
		}
	}
}

export function StoryNewTabLink({
	projectId,
	storyId,
	label,
	children,
	view = "details",
	panel = "feature-proposals",
	className,
}: Props) {
	const basePath = useBasePath();
	const { trackEvent } = useAnalytics();
	return (
		<a
			href={storyRoute(view, basePath, projectId, storyId)}
			target="_blank"
			rel="noopener noreferrer"
			aria-label={label}
			title={label}
			onClick={() => trackEvent(BACKLOG_OPEN_EXISTING_EVENT, { panel })}
			// min-h-6 / min-w-6: at least a 24x24 target, also icon-only.
			className={cn(
				"inline-flex min-h-6 min-w-6 items-center justify-center gap-1 text-muted-foreground text-xs hover:text-primary focus-visible:text-primary",
				className,
			)}
		>
			{children}
			<ExternalLinkIcon
				className="size-3.5 shrink-0"
				aria-hidden="true"
			/>
		</a>
	);
}
