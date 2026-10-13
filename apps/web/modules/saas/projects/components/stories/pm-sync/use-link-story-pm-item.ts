"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { useInvalidatePmSyncState } from "./use-invalidate-pm-sync-state";

/**
 * "Link to existing item" for a story: links the unlinked story to the PM
 * item the user names (`projects.stories.linkPmItem`). Shared by the two
 * places that open the failure panel (the editor's PM-sync chip and the
 * roadmap card) so both behave the same.
 *
 * The PM-sync state is refreshed whether the link lands or is refused: a
 * refusal can mean the story changed since it was loaded. A refusal's
 * message is shown by the dialog that called `mutateAsync`, not as a toast.
 */
export function useLinkStoryPmItem({
	projectId,
	storyId,
	organizationId,
	pmToolName,
}: {
	projectId: string;
	storyId: string;
	organizationId: string | null;
	pmToolName: string;
}) {
	const invalidate = useInvalidatePmSyncState(projectId);
	return useMutation({
		mutationFn: async (externalId: string) =>
			orpcClient.projects.stories.linkPmItem({
				projectId,
				storyId,
				externalId,
				organizationId,
			}),
		onSuccess: (res) => {
			toast.success(`Linked to ${pmToolName} item ${res.externalId}`);
			void invalidate();
		},
		onError: () => {
			void invalidate();
		},
	});
}
