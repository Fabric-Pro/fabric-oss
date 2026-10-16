"use client";

import { useCallback, useRef, useState } from "react";
import {
	drawerEngineFor,
	restoreFromConversationMetadata,
} from "../lib/conversation-restore";
import type { ConversationDetail } from "../lib/conversation-list";
import { useConversationDetail } from "./useConversationHistory";

interface ResumedConversation {
	id: string;
	title: string | null;
	/** The engine it opens on in the drawer: the one it was conducted with. */
	engine: "direct" | "orchestrator";
	/** Changes with every resume, so a chat keyed on it starts fresh. */
	key: number;
}

/**
 * What the drawer's body shows: a chat (a new one, or a conversation of the
 * reader's own with what it was loaded from the server), another member's
 * shared conversation to read, or the wait, the loss or the failure of
 * opening a stored one. Decided once here so the drawer never infers it from
 * three loose flags.
 */
export type LauncherPane =
	| { kind: "loading" }
	| { kind: "gone" }
	| { kind: "error" }
	| { kind: "shared"; conversation: ConversationDetail }
	| { kind: "chat"; conversation: ConversationDetail | null };

export function launcherPaneOf(
	resumed: ResumedConversation | null,
	detail: { data: ConversationDetail | null | undefined; isError: boolean },
): LauncherPane {
	if (!resumed) {
		return { kind: "chat", conversation: null };
	}
	// What is loaded wins over a refetch that failed: a chat in progress is not
	// replaced by an error because a background refresh could not reach the server.
	if (detail.data) {
		return detail.data.isOwn
			? { kind: "chat", conversation: detail.data }
			: { kind: "shared", conversation: detail.data };
	}
	if (detail.data === null) {
		return { kind: "gone" };
	}
	return detail.isError ? { kind: "error" } : { kind: "loading" };
}

/**
 * The stored conversation the drawer has been asked to reopen, and what its
 * body shows because of it. The drawer holds one chat; reopening a
 * conversation starts that chat over on the conversation's own engine (each
 * engine can only continue its own threads), and the conversation carries on
 * with the context of the page the drawer is open on now.
 */
export function useResumedSession(organizationId: string | null) {
	const [resumed, setResumed] = useState<ResumedConversation | null>(null);
	const counter = useRef(0);
	const detail = useConversationDetail(resumed?.id ?? null, organizationId);

	const resume = useCallback(
		(conversation: {
			id: string;
			title: string | null;
			metadata: unknown;
		}) => {
			counter.current += 1;
			setResumed({
				id: conversation.id,
				title: conversation.title,
				engine: drawerEngineFor(
					restoreFromConversationMetadata(conversation.metadata)
						.engine,
				),
				key: counter.current,
			});
		},
		[],
	);
	const clear = useCallback(() => setResumed(null), []);

	return {
		resumed,
		pane: launcherPaneOf(resumed, {
			data: detail.data,
			isError: detail.isError === true,
		}),
		retry: detail.refetch,
		resume,
		clear,
	};
}
