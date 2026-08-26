"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import type { StoryPriority } from "../../../lib/stories/types";

export type SetStoryPriorityVars = {
	storyId: string;
	priority: StoryPriority;
	/** Free text; blank collapses to "no comment" before the wire. */
	comment: string;
};

/**
 * The one client-side write path for "set this item's band, optionally say
 * why" — shared by the Priority view's row editor and the feature-detail chip
 * (StoryPriorityControl), which must stay indistinguishable: same
 * comment-trim rule, same "no toast on a race that changed nothing", same
 * error surface, same history-cache refresh. Callers supply only what
 * genuinely differs — which of their own views to refresh and which local
 * editor state to close.
 */
export function useSetStoryPriority({
	projectId,
	organizationId,
	onSaved,
}: {
	projectId: string;
	organizationId: string | null;
	/** Runs on every successful write (changed or raced): close the editor,
	 * invalidate the caller's own view caches. Priority-history invalidation
	 * is NOT the caller's job — the hook owns it. */
	onSaved: (result: { changed: boolean }) => void;
}) {
	const t = useTranslations("projects.stories.priority");
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (vars: SetStoryPriorityVars) =>
			orpcClient.projects.stories.setPriority({
				projectId,
				organizationId,
				storyId: vars.storyId,
				priority: vars.priority,
				...(vars.comment.trim()
					? { comment: vars.comment.trim() }
					: {}),
			}),
		onSuccess: (result) => {
			// `changed: false` means the band was already what was picked. The
			// editors disable Save in that case, so this only fires on a race —
			// say nothing rather than claim a change that did not happen.
			if (result.changed) {
				toast.success(t("prioritySaved"));
			}
			// Every successful write touches priority history by construction,
			// so the trail/dialog caches are the HOOK's to refresh — a new call
			// site cannot forget it.
			queryClient.invalidateQueries({
				queryKey: orpc.projects.stories.priorityHistory.key(),
			});
			onSaved(result);
		},
		onError: (error) => {
			toast.error(t("prioritySaveFailed"), {
				description: (error as Error).message,
			});
		},
	});
}
