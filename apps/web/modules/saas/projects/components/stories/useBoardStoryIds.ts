import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

/**
 * The project's tickets on the board, for deciding whether a ticket can be
 * linked. `unavailable`: no board is checked (the AI Update sidebar), so
 * every ticket is linked. `loading`: the board has not loaded, so nothing is
 * linked yet and nothing reads as missing.
 */
export type BoardStoryIds =
	| { status: "loading" }
	| { status: "ready"; ids: ReadonlySet<string> }
	| { status: "unavailable" };

export const BOARD_NOT_CHECKED: BoardStoryIds = { status: "unavailable" };

const BOARD_LOADING: BoardStoryIds = { status: "loading" };

/** Whether a ticket may be linked: on the board, or no board to check. */
export function canLinkBoardStory(
	board: BoardStoryIds,
	storyId: string,
): boolean {
	switch (board.status) {
		case "unavailable":
			return true;
		case "loading":
			return false;
		case "ready":
			return board.ids.has(storyId);
		default: {
			const unhandled: never = board;
			return unhandled;
		}
	}
}

/** Whether the loaded board no longer lists a ticket ("Ticket not found"). */
export function isMissingFromBoard(
	board: BoardStoryIds,
	storyId: string,
): boolean {
	return board.status === "ready" && !board.ids.has(storyId);
}

/**
 * The project's tickets on the board, loading until the board loads (or
 * when it cannot). Shares the routing picker's query, so a merge-target link
 * is offered only for a ticket that still exists: a deleted one would open
 * "Ticket not found".
 */
export function useBoardStoryIds(params: {
	projectId?: string;
	organizationId?: string | null;
	enabled: boolean;
}): BoardStoryIds {
	const { data } = useQuery({
		...orpc.projects.stories.board.queryOptions({
			input: {
				projectId: params.projectId ?? "",
				organizationId: params.organizationId ?? null,
			},
		}),
		enabled: params.enabled && !!params.projectId,
		staleTime: 60_000,
	});
	return useMemo<BoardStoryIds>(
		() =>
			data
				? {
						status: "ready",
						ids: new Set(data.stories.map((story) => story.id)),
					}
				: BOARD_LOADING,
		[data],
	);
}
