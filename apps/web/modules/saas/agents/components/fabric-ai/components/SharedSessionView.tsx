"use client";

import type { ConversationDetail } from "@saas/agents/lib/conversation-list";
import type { ChatEngine } from "@saas/agents/lib/interface-mode-engine";
import { userMessageOf } from "@saas/shared/lib/user-message-of";
import { orpcClient } from "@shared/lib/orpc-client";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { formatDistanceToNow } from "date-fns";
import { UsersIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Response } from "../../../../../../components/ai-elements/response";

/**
 * A teammate's transcript can point at an image on any server, and what the
 * reader's browser fetches for it tells that server the reader opened the
 * conversation. So nothing is fetched on the reader's behalf: an image is shown
 * as a link to where it is.
 */
const SHARED_MARKDOWN = {
	img: ({ alt, src }: { alt?: string; src?: string }) =>
		src ? (
			<a
				href={src}
				target="_blank"
				rel="noopener noreferrer"
				className="text-primary underline-offset-4 hover:underline"
			>
				{alt || src}
			</a>
		) : null,
};

/** The reader's own chat, started from a shared conversation, and the engine it opens on. */
export interface ContinuedChat {
	id: string;
	title: string | null;
	engine: ChatEngine;
}

/**
 * A conversation another person shared, read as it was: the transcript and
 * nothing to send or approve into it. It is the owner's, so the only way on is
 * a chat of the reader's own that starts from it and runs with the reader's own
 * tools and permissions. The server builds what the new chat carries over from
 * the conversation itself; this sends nothing of the transcript.
 *
 * `engine` is the engine the reader's own chats run on now (their interface
 * mode and engine choice, not the one the owner used), which the new chat opens
 * on. The same component serves the drawer and the full page, so both continue
 * the same way and refresh the conversation lists the same way.
 */
export function SharedSessionView({
	conversation,
	organizationId,
	engine,
	onContinue,
}: {
	conversation: ConversationDetail;
	organizationId: string | null;
	engine: ChatEngine;
	onContinue: (chat: ContinuedChat) => void;
}) {
	const queryClient = useQueryClient();
	const [starting, setStarting] = useState(false);
	const ownerName = conversation.owner.name;
	const title = conversation.title?.trim() || "Untitled conversation";
	const messages = conversation.messages.filter(
		(message) =>
			(message.role === "user" || message.role === "assistant") &&
			message.content.trim().length > 0,
	);

	const handleContinue = async () => {
		setStarting(true);
		try {
			const started =
				await orpcClient.agents.conversations.continueInNewChat({
					organizationId,
					parentConversationId: conversation.id,
					title: `Continuing: ${title}`.slice(0, 120),
				});
			void queryClient.invalidateQueries({
				queryKey: ["agents", "conversations"],
			});
			onContinue({
				id: started.id,
				title: started.title ?? null,
				engine,
			});
		} catch (error) {
			toast.error("Could not start a chat from this conversation", {
				description: userMessageOf(error, "Please try again."),
			});
			setStarting(false);
		}
	};

	return (
		<div className="flex h-full min-h-0 flex-col bg-background">
			<header className="space-y-1 border-b border-border px-4 py-3">
				<h2 className="font-display text-base font-semibold tracking-tight text-foreground">
					{title}
				</h2>
				<p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
					<span className="inline-flex items-center gap-1">
						<UsersIcon className="size-3" aria-hidden />
						Shared by {ownerName}
					</span>
					<time dateTime={conversation.updatedAt}>
						{formatDistanceToNow(new Date(conversation.updatedAt), {
							addSuffix: true,
						})}
					</time>
					<span>Read only</span>
				</p>
			</header>

			<section
				aria-label="Shared conversation transcript"
				// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling transcript has to be reachable from the keyboard to be read
				tabIndex={0}
				className="min-h-0 flex-1 overflow-y-auto px-4 py-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
			>
				{messages.length === 0 ? (
					<p className="text-sm text-muted-foreground">
						This conversation has no messages yet.
					</p>
				) : (
					<ol className="mx-auto max-w-3xl space-y-5">
						{messages.map((message) => (
							<li key={message.id} className="space-y-1">
								<p className="text-xs font-medium text-muted-foreground">
									{message.role === "user"
										? ownerName
										: "Fabric Agent"}
								</p>
								{message.role === "assistant" ? (
									<Response components={SHARED_MARKDOWN}>
										{message.content}
									</Response>
								) : (
									<p className="whitespace-pre-wrap break-words text-sm text-foreground">
										{message.content}
									</p>
								)}
							</li>
						))}
					</ol>
				)}
			</section>

			<footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3">
				<p className="max-w-md text-xs text-muted-foreground">
					To ask more, carry on in a chat of your own. It starts from
					this conversation and runs with your tools and permissions,
					not {ownerName}&apos;s.
				</p>
				<Button size="sm" loading={starting} onClick={handleContinue}>
					Continue in my own chat
				</Button>
			</footer>
		</div>
	);
}
