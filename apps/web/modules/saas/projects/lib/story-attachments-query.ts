import { orpcClient } from "@shared/lib/orpc-client";

/**
 * Single source of truth for the story-attachments list query. Both
 * AttachmentsTab (list + mutations) and StoryAttachmentsButton (count badge)
 * use these so they share ONE React Query cache entry — that shared key is what
 * makes the badge update in real time when the tab uploads/removes. #1778.
 */
export function storyAttachmentsQueryKey(
	projectId: string,
	storyId: string,
	organizationId: string | null,
) {
	return ["story-attachments", projectId, storyId, organizationId] as const;
}

export function storyAttachmentsQueryOptions(params: {
	projectId: string;
	storyId: string;
	organizationId: string | null;
}) {
	const { projectId, storyId, organizationId } = params;
	return {
		queryKey: storyAttachmentsQueryKey(projectId, storyId, organizationId),
		queryFn: () =>
			orpcClient.projects.stories.listAttachments({
				projectId,
				userStoryId: storyId,
				organizationId,
			}),
	};
}
