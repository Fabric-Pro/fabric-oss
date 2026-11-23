"use client";

import { useEffect, useRef } from "react";

interface UseUrlConversationSyncOptions {
	/** The conversation the URL names (`?c=`), or null. */
	urlConversationId: string | null;
	activeConversationId: string | null;
	/** The selected conversation as read: null once it is known to be gone. */
	activeConversation: object | null | undefined;
	isLoadingDetail: boolean;
	/** Selects a conversation without touching the URL. */
	selectConversation: (id: string | null) => void;
	/** Writes the URL's conversation; the URL follows later, not at once. */
	onConversationChange: (id: string | null) => void;
}

/**
 * Keeps the selected conversation in step with the URL. A change of the URL
 * selects what it names; the selection itself never pulls the URL's old
 * value back. The URL is replaced after a delay, so a selection cleared
 * while it still names the conversation (a delete, a conversation that is
 * gone) must not select that conversation again, or the two loop.
 */
export function useUrlConversationSync({
	urlConversationId,
	activeConversationId,
	activeConversation,
	isLoadingDetail,
	selectConversation,
	onConversationChange,
}: UseUrlConversationSyncOptions): void {
	const syncedUrlConversationId = useRef<string | null | undefined>(
		undefined,
	);

	useEffect(() => {
		if (syncedUrlConversationId.current === urlConversationId) {
			return;
		}
		syncedUrlConversationId.current = urlConversationId;
		if (urlConversationId !== activeConversationId) {
			selectConversation(urlConversationId);
		}
	}, [urlConversationId, activeConversationId, selectConversation]);

	// A conversation the URL names that is not there (a stale link, a
	// deleted one) is let go of, and the URL with it.
	useEffect(() => {
		if (
			urlConversationId &&
			activeConversationId === urlConversationId &&
			activeConversation === null &&
			!isLoadingDetail
		) {
			console.warn(
				`[FabricChat] Conversation not found, clearing URL: ${urlConversationId}`,
			);
			onConversationChange(null);
			selectConversation(null);
		}
	}, [
		urlConversationId,
		activeConversationId,
		activeConversation,
		isLoadingDetail,
		onConversationChange,
		selectConversation,
	]);
}
