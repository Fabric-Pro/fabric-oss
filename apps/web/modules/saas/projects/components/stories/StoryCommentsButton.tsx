"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetTitle,
} from "@ui/components/sheet";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { MessageSquareIcon } from "lucide-react";
import { useState } from "react";
import {
	type FabricMentionComment,
	hasRecentPendingFabricComment,
} from "../../lib/pending-fabric-comments";
import type { UserStory } from "../../lib/stories/types";
import { CommentsPanel } from "./CommentsPanel";
import { IconCountBadge } from "./IconCountBadge";

type Props = {
	story: UserStory;
	projectId: string;
	organizationId: string | null;
};

/**
 * Action-bar entry point for story-level comments (#1347 follow-up). A message
 * icon opens a modal right-side Sheet hosting the existing `CommentsPanel`
 * rendered WITHOUT a taskId, so it targets the feature's own comments
 * (orpc.projects.stories.comments.*). Org id is passed explicitly from
 * `project.organizationId` (the #1759 lesson) rather than read from ambient
 * context. Unflagged — it surfaces an existing, production backend.
 */
export function StoryCommentsButton({
	story,
	projectId,
	organizationId,
}: Props) {
	const [open, setOpen] = useState(false);
	const commentsQuery = useQuery({
		...orpc.projects.stories.comments.list.queryOptions({
			input: { projectId, storyId: story.id, organizationId },
		}),
		// @fabric agent replies are persisted asynchronously by the Temporal
		// workflow with no client invalidation. While a RECENT mention is in
		// flight, poll so the badge stays accurate even with the sidebar closed;
		// stop once the reply lands, none is pending, or the mention ages out of
		// the poll window (a stalled/failed workflow must not poll forever).
		refetchInterval: (query) => {
			const comments = ((
				query.state.data as
					| { comments?: FabricMentionComment[] }
					| undefined
			)?.comments ?? []) as FabricMentionComment[];
			return hasRecentPendingFabricComment(comments, Date.now())
				? 3000
				: false;
		},
	});
	const count =
		(commentsQuery.data?.comments as unknown[] | undefined)?.length ?? 0;
	const ariaLabel =
		count > 0
			? `Comments, ${count} comment${count === 1 ? "" : "s"}`
			: "Comments";

	return (
		<>
			<TooltipProvider>
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							variant="ghost"
							size="icon"
							className="relative size-8 text-muted-foreground hover:text-foreground"
							onClick={() => setOpen(true)}
							aria-label={ariaLabel}
						>
							<MessageSquareIcon className="size-4" />
							<IconCountBadge count={count} />
						</Button>
					</TooltipTrigger>
					<TooltipContent>
						<p>Comments</p>
					</TooltipContent>
				</Tooltip>
			</TooltipProvider>

			<Sheet open={open} onOpenChange={setOpen}>
				<SheetContent
					side="right"
					className="flex flex-col gap-4 sm:max-w-[480px]"
				>
					<SheetTitle className="pr-8">
						Comments — {story.identifier}
					</SheetTitle>
					<SheetDescription className="sr-only">
						Read and post comments on this feature.
					</SheetDescription>
					<div className="min-h-0 flex-1 overflow-y-auto">
						<CommentsPanel
							projectId={projectId}
							storyId={story.id}
							organizationId={organizationId}
						/>
					</div>
				</SheetContent>
			</Sheet>
		</>
	);
}
