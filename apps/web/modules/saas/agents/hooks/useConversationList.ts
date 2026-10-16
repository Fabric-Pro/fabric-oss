"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import {
	useInfiniteQuery,
	useMutation,
	useQueryClient,
} from "@tanstack/react-query";
import {
	type ConversationView,
	type ConversationVisibility,
	conversationListKey,
	conversationListPageOf,
	listFilterFor,
} from "../lib/conversation-list";

const PAGE_SIZE = 30;

interface UseConversationListOptions {
	organizationId: string | null | undefined;
	agentId: string;
	view: ConversationView;
	/** The title to look for; empty for every conversation. */
	search: string;
	enabled?: boolean;
}

/**
 * A page at a time of the sessions the viewer can see, for one view and one
 * search, and the changes a person makes to one of their own sessions from the
 * list. Every change refreshes every list of conversations, since the same
 * session shows in the page's list and the drawer's.
 */
export function useConversationList({
	organizationId,
	agentId,
	view,
	search,
	enabled = true,
}: UseConversationListOptions) {
	const queryClient = useQueryClient();
	const term = search.trim();
	const { scope, status } = listFilterFor(view);

	const list = useInfiniteQuery({
		queryKey: conversationListKey({
			organizationId,
			agentId,
			view,
			search: term,
		}),
		initialPageParam: undefined as string | undefined,
		queryFn: async ({ pageParam }) => {
			const request = {
				organizationId,
				agentId,
				status,
				scope,
				limit: PAGE_SIZE,
				...(term ? { search: term } : {}),
				...(pageParam ? { cursor: pageParam } : {}),
			};
			return conversationListPageOf(
				await orpcClient.agents.conversations.list(request),
			);
		},
		getNextPageParam: (last) => last.nextCursor ?? undefined,
		enabled,
		retry: false,
		staleTime: 10_000,
	});

	const refreshLists = () =>
		queryClient.invalidateQueries({
			queryKey: ["agents", "conversations"],
		});

	const rename = useMutation({
		mutationFn: (input: { id: string; title: string }) =>
			orpcClient.agents.conversations.update(input),
		onSuccess: refreshLists,
	});
	const archive = useMutation({
		mutationFn: (id: string) =>
			orpcClient.agents.conversations.archive({ id }),
		onSuccess: refreshLists,
	});
	const restore = useMutation({
		mutationFn: (id: string) =>
			orpcClient.agents.conversations.update({ id, status: "ACTIVE" }),
		onSuccess: refreshLists,
	});
	const togglePin = useMutation({
		mutationFn: (id: string) =>
			orpcClient.agents.conversations.togglePin({ id }),
		onSuccess: refreshLists,
	});
	const remove = useMutation({
		mutationFn: (id: string) =>
			orpcClient.agents.conversations.delete({ id }),
		onSuccess: refreshLists,
	});
	const setVisibility = useMutation({
		mutationFn: (input: {
			id: string;
			visibility: ConversationVisibility;
		}) =>
			orpcClient.agents.conversations.setVisibility({
				...input,
				organizationId,
			}),
		onSuccess: refreshLists,
	});

	return {
		items: list.data?.pages.flatMap((page) => page.items) ?? [],
		isLoading: list.isLoading,
		isError: list.isError,
		/** The failure was in reading the next page, not the list itself. */
		isLoadMoreError: list.isFetchNextPageError,
		refetch: list.refetch,
		hasMore: list.hasNextPage,
		isLoadingMore: list.isFetchingNextPage,
		loadMore: list.fetchNextPage,
		rename: (id: string, title: string) =>
			rename.mutateAsync({ id, title }),
		archive: archive.mutateAsync,
		restore: restore.mutateAsync,
		togglePin: togglePin.mutateAsync,
		remove: remove.mutateAsync,
		setVisibility: (id: string, visibility: ConversationVisibility) =>
			setVisibility.mutateAsync({ id, visibility }),
	};
}
