import { orderStoriesBySemanticActivity } from "@repo/database/prisma/queries/projects/story-semantic-activity";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

/**
 * A project's work items for a picker, most recently edited first
 * (`lastEditedAt`, or `createdAt` for an item nobody has edited).
 *
 * Reads the whole board, so the ranking covers every item before a picker
 * filters or caps the list. The board itself stays in backlog order for the
 * kanban and roadmap; only the pickers re-rank it, here, once per load rather
 * than on every keystroke.
 */
export function useStoriesByLastEdit({
	projectId,
	organizationId,
	enabled,
	staleTime,
}: {
	projectId: string;
	organizationId: string | null;
	enabled: boolean;
	staleTime?: number;
}) {
	const query = useQuery({
		...orpc.projects.stories.board.queryOptions({
			input: { projectId, organizationId },
		}),
		enabled,
		staleTime,
	});
	const stories = useMemo(
		() => orderStoriesBySemanticActivity(query.data?.stories ?? []),
		[query.data],
	);
	return { stories, isLoading: query.isLoading, isError: query.isError };
}
