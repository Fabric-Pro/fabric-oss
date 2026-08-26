"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import {
	getPriorityLabel,
	type StoryPriority,
} from "../../../lib/stories/types";

/** What an applied pass reports to its surface. */
export type AiReprioritizeResult = {
	changed: boolean;
	/** The band the AI landed on — null when nothing changed. Surfaces that
	 * hold a local priority DRAFT (the workspace metadata form) sync it from
	 * here, so a later form save can't overwrite the applied move. */
	toPriority: StoryPriority | null;
};

export type AiReprioritizeVars = {
	storyId: string;
	/** Send up to 99 active same-kind peers as read-only context. */
	withListContext: boolean;
};

/**
 * The one client-side path for "let the AI re-assess THIS item's band" —
 * shared by every surface that carries the sparkle (Priority view rows, the
 * feature-detail chip, the roadmap kebab), which must stay indistinguishable:
 * same result toast (band move + rationale, or an explicit "nothing changed"),
 * same error surface, same history-cache refresh. Mirrors
 * {@link useSetStoryPriority}, its manual sibling: callers supply only which
 * of their own views to refresh.
 */
export function useAiReprioritizeStory({
	projectId,
	organizationId,
	onApplied,
}: {
	projectId: string;
	organizationId: string | null;
	/** Runs on every successful pass (changed or not): invalidate the caller's
	 * own view caches, close its surface. Priority-history invalidation is NOT
	 * the caller's job — the hook owns it. */
	onApplied?: (result: AiReprioritizeResult) => void;
}) {
	const t = useTranslations("projects.stories.priority");
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (vars: AiReprioritizeVars) =>
			orpcClient.projects.stories.reprioritizeStory({
				projectId,
				organizationId,
				storyId: vars.storyId,
				withListContext: vars.withListContext,
			}),
		// A loading toast for the multi-second model call — the menu closes on
		// select, so without this the click looks lost (and gets retried). The
		// settle toasts below replace it via its id, and sonner's polite live
		// region doubles as the screen-reader announcement of the run.
		onMutate: () => ({ toastId: toast.loading(t("aiReassessing")) }),
		onSuccess: (result, _vars, mutateContext) => {
			const id = mutateContext?.toastId;
			if (result.changed && result.fromPriority && result.toPriority) {
				toast.success(
					t("aiChanged", {
						from: getPriorityLabel(result.fromPriority),
						to: getPriorityLabel(result.toPriority),
					}),
					// The model's one-sentence why — the same text the history
					// trail records, so the toast and the trail agree.
					{ id, description: result.rationale ?? undefined },
				);
			} else {
				// An explicit no-change answer, not silence: the user asked for
				// an assessment and "it already fits" IS the assessment.
				toast.info(t("aiNoChange"), { id });
			}
			queryClient.invalidateQueries({
				queryKey: orpc.projects.stories.priorityHistory.key(),
			});
			onApplied?.(result);
		},
		onError: (error, _vars, mutateContext) => {
			toast.error(t("aiFailed"), {
				id: mutateContext?.toastId,
				description: (error as Error).message,
			});
		},
	});
}
