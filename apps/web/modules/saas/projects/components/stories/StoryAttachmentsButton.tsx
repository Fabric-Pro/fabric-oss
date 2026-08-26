"use client";

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
import { useQuery } from "@tanstack/react-query";
import { PaperclipIcon } from "lucide-react";
import { useState } from "react";
import { storyAttachmentsQueryOptions } from "../../lib/story-attachments-query";
import type { UserStory } from "../../lib/stories/types";
import { AttachmentsTab } from "./editor/AttachmentsTab";
import { IconCountBadge } from "./IconCountBadge";

type Props = {
	story: UserStory;
	projectId: string;
	organizationId: string | null;
	canEdit: boolean;
};

/**
 * Action-bar entry point for the dedicated story attachments (#1702 / #1347
 * Phase B). A paperclip button opens a modal right-side Sheet hosting the
 * existing `AttachmentsTab`. The button eagerly fetches the attachment list
 * on mount (shared cache key with `AttachmentsTab`) to show a live count
 * badge (#1778).
 */
export function StoryAttachmentsButton({
	story,
	projectId,
	organizationId,
	canEdit,
}: Props) {
	const [open, setOpen] = useState(false);
	// Eager count query. Shares AttachmentsTab's cache key, so the panel's
	// invalidation on upload/remove updates this badge in real time (#1778).
	const listQuery = useQuery(
		storyAttachmentsQueryOptions({
			projectId,
			storyId: story.id,
			organizationId,
		}),
	);

	const count = listQuery.data?.attachments.length ?? 0;
	const ariaLabel =
		count > 0
			? `Attachments, ${count} file${count === 1 ? "" : "s"}`
			: "Attachments";

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
							<PaperclipIcon className="size-4" />
							<IconCountBadge count={count} />
						</Button>
					</TooltipTrigger>
					<TooltipContent>
						<p>Attachments</p>
					</TooltipContent>
				</Tooltip>
			</TooltipProvider>

			<Sheet open={open} onOpenChange={setOpen}>
				<SheetContent
					side="right"
					className="flex flex-col gap-4 sm:max-w-[480px]"
				>
					<SheetTitle className="pr-8">
						Attachments — {story.identifier}
					</SheetTitle>
					<SheetDescription className="sr-only">
						Upload, download, and manage files attached to this
						feature.
					</SheetDescription>
					<div className="min-h-0 flex-1 overflow-y-auto">
						<AttachmentsTab
							story={story}
							projectId={projectId}
							organizationId={organizationId}
							canEdit={canEdit}
						/>
					</div>
				</SheetContent>
			</Sheet>
		</>
	);
}
