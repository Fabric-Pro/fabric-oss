"use client";

import type { ConversationListItem } from "@saas/agents/lib/conversation-list";
import { Button } from "@ui/components/button";
import { ArrowLeftIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import { ConversationHistoryPanel } from "./fabric-ai/components/ConversationHistoryPanel";

/**
 * Fabric Agent's conversation history inside the drawer: the same list the full
 * page shows, under a bar that leads back to the chat. Opening a conversation
 * is the drawer's to do, since it owns the chat the conversation opens in.
 * Focus lands on the heading, so a keyboard or screen reader user opens onto
 * the list and not back on the button that hid the chat.
 */
export function LauncherSessionHistory({
	organizationId,
	activeConversationId,
	onSelect,
	onDeleted,
	onBack,
}: {
	organizationId: string | null;
	activeConversationId: string | null;
	onSelect: (conversation: ConversationListItem) => void;
	onDeleted: (id: string) => void;
	onBack: () => void;
}) {
	const heading = useRef<HTMLHeadingElement>(null);
	useEffect(() => {
		heading.current?.focus();
	}, []);

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2">
				<h3
					ref={heading}
					tabIndex={-1}
					className="app-editorial-label focus-visible:outline-none"
				>
					Conversation history
				</h3>
				<Button variant="ghost" size="sm" onClick={onBack}>
					<ArrowLeftIcon className="mr-1.5 size-3.5" aria-hidden />
					Back to chat
				</Button>
			</div>
			<ConversationHistoryPanel
				className="min-h-0 flex-1"
				organizationId={organizationId}
				activeConversationId={activeConversationId}
				onSelect={onSelect}
				onDeleted={onDeleted}
			/>
		</div>
	);
}
