"use client";

/**
 * HistoryTabContent - the rows of Fabric Agent's conversation history.
 *
 * A row shows a conversation's title, the engine it ran on, when it last
 * changed, a line of its last message and, where it matters, that it is pinned
 * or shared with the organization and by whom. A conversation the viewer owns
 * offers the changes the viewer can make to it (pin, rename, share, archive or
 * restore, delete); a conversation someone else shared offers none, since it is
 * read-only. The rows hold no state: the panel around them decides what each
 * change does.
 */

import type { ConversationListItem } from "@saas/agents/lib/conversation-list";
import type { ChatEngine } from "@saas/agents/lib/interface-mode-engine";
import { Button } from "@ui/components/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import { cn } from "@ui/lib";
import { formatDistanceToNow } from "date-fns";
import {
	ArchiveIcon,
	ArchiveRestoreIcon,
	Bookmark,
	BookmarkCheck,
	Brain,
	HistoryIcon,
	MoreHorizontalIcon,
	PencilIcon,
	Trash,
	UsersIcon,
	Zap,
} from "lucide-react";

export interface HistoryTabContentProps {
	conversations: ConversationListItem[];
	activeConversationId: string | null;
	/** What to say when there is nothing to list. */
	emptyTitle?: string;
	emptyHint?: string;
	onSelectConversation: (conversation: ConversationListItem) => void;
	/** The changes a person can make to a conversation of their own. Left out, the row offers none. */
	onTogglePin?: (id: string) => void;
	onRenameConversation?: (conversation: ConversationListItem) => void;
	onShareConversation?: (conversation: ConversationListItem) => void;
	onArchiveConversation?: (conversation: ConversationListItem) => void;
	onRestoreConversation?: (conversation: ConversationListItem) => void;
	onDeleteConversation?: (conversation: ConversationListItem) => void;
}

const ENGINE_LABEL: Record<ChatEngine, string> = {
	direct: "Direct",
	orchestrator: "Orchestrator",
	research: "Research",
};

function EngineIcon({ engine }: { engine: ChatEngine }) {
	return engine === "orchestrator" ? (
		<Brain className="h-3.5 w-3.5" aria-hidden />
	) : (
		<Zap className="h-3.5 w-3.5" aria-hidden />
	);
}

function RowMenu({
	conversation,
	onRename,
	onShare,
	onArchive,
	onRestore,
	onDelete,
}: {
	conversation: ConversationListItem;
	onRename?: (conversation: ConversationListItem) => void;
	onShare?: (conversation: ConversationListItem) => void;
	onArchive?: (conversation: ConversationListItem) => void;
	onRestore?: (conversation: ConversationListItem) => void;
	onDelete?: (conversation: ConversationListItem) => void;
}) {
	const archived = conversation.status === "ARCHIVED";
	const shared = conversation.visibility === "ORGANIZATION";
	const title = conversation.title?.trim() || "Untitled conversation";
	if (!(onRename || onShare || onArchive || onRestore || onDelete)) {
		return null;
	}
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					variant="ghost"
					size="icon-sm"
					className="h-7 w-7 rounded-md text-muted-foreground hover:bg-background hover:text-foreground"
					aria-label={`More actions for ${title}`}
					onClick={(event) => event.stopPropagation()}
				>
					<MoreHorizontalIcon className="h-3.5 w-3.5" aria-hidden />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent
				align="end"
				onClick={(e) => e.stopPropagation()}
			>
				{onRename ? (
					<DropdownMenuItem onSelect={() => onRename(conversation)}>
						<PencilIcon className="mr-2 h-3.5 w-3.5" aria-hidden />
						Rename
					</DropdownMenuItem>
				) : null}
				{onShare ? (
					<DropdownMenuItem onSelect={() => onShare(conversation)}>
						<UsersIcon className="mr-2 h-3.5 w-3.5" aria-hidden />
						{shared
							? "Sharing settings"
							: "Share with your organization"}
					</DropdownMenuItem>
				) : null}
				{archived && onRestore ? (
					<DropdownMenuItem onSelect={() => onRestore(conversation)}>
						<ArchiveRestoreIcon
							className="mr-2 h-3.5 w-3.5"
							aria-hidden
						/>
						Restore
					</DropdownMenuItem>
				) : null}
				{!archived && onArchive ? (
					<DropdownMenuItem onSelect={() => onArchive(conversation)}>
						<ArchiveIcon className="mr-2 h-3.5 w-3.5" aria-hidden />
						Archive
					</DropdownMenuItem>
				) : null}
				{onDelete ? (
					<>
						<DropdownMenuSeparator />
						<DropdownMenuItem
							className="text-destructive focus:text-destructive"
							onSelect={() => onDelete(conversation)}
						>
							<Trash className="mr-2 h-3.5 w-3.5" aria-hidden />
							Delete
						</DropdownMenuItem>
					</>
				) : null}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

export function HistoryTabContent({
	conversations,
	activeConversationId,
	emptyTitle = "No conversations yet",
	emptyHint = "Start a new chat to begin",
	onSelectConversation,
	onTogglePin,
	onRenameConversation,
	onShareConversation,
	onArchiveConversation,
	onRestoreConversation,
	onDeleteConversation,
}: HistoryTabContentProps) {
	if (conversations.length === 0) {
		return (
			<div className="p-3">
				<output className="block py-8 text-center text-sm text-muted-foreground">
					<div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-muted">
						<HistoryIcon
							className="h-6 w-6 opacity-50"
							aria-hidden
						/>
					</div>
					<p className="font-medium text-foreground">{emptyTitle}</p>
					<p className="mt-1 text-xs">{emptyHint}</p>
				</output>
			</div>
		);
	}

	return (
		<ul className="space-y-1 px-3 py-3">
			{conversations.map((conv) => {
				const isActive = activeConversationId === conv.id;
				const title = conv.title?.trim() || "Untitled conversation";
				const preview =
					conv.lastMessage?.trim() ||
					"Open this run to review the conversation.";
				const timeAgo = formatDistanceToNow(new Date(conv.updatedAt), {
					addSuffix: true,
				});
				const shared = conv.visibility === "ORGANIZATION";
				const mine = conv.isOwn;

				return (
					<li key={conv.id} className="group relative">
						<button
							type="button"
							onClick={() => onSelectConversation(conv)}
							aria-current={isActive ? "true" : undefined}
							className={cn(
								"w-full cursor-pointer overflow-hidden rounded-xl text-left motion-safe:transition-colors motion-safe:duration-200",
								"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
								isActive
									? "bg-muted text-foreground"
									: "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
							)}
						>
							<div className="flex items-start gap-3 px-2.5 py-2">
								<div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
									<EngineIcon engine={conv.engine} />
								</div>

								<div className="min-w-0 flex-1 overflow-hidden pr-14">
									<p className="truncate text-[13px] font-medium leading-5 text-inherit">
										{title}
									</p>

									<div className="mt-1.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
										<span className="inline-flex items-center rounded-full border border-border px-1.5 py-0.5 font-medium leading-none">
											{ENGINE_LABEL[conv.engine]}
										</span>
										<span>{timeAgo}</span>
									</div>

									<p className="mt-1.5 line-clamp-1 text-[12px] leading-5 text-muted-foreground">
										{preview}
									</p>

									{conv.pinned || shared || !mine ? (
										<div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground">
											{conv.pinned ? (
												<span className="inline-flex items-center gap-1 text-foreground">
													<BookmarkCheck
														className="h-2.5 w-2.5"
														aria-hidden
													/>
													Pinned
												</span>
											) : null}
											{shared || !mine ? (
												<span className="inline-flex items-center gap-1">
													<UsersIcon
														className="h-2.5 w-2.5"
														aria-hidden
													/>
													{mine
														? "Shared with your organization"
														: `Shared by ${conv.owner.name}`}
												</span>
											) : null}
										</div>
									) : null}
								</div>
							</div>
						</button>

						{mine ? (
							<div className="absolute right-1.5 top-2 z-10 flex items-center gap-0.5 opacity-100 motion-safe:transition-opacity sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100">
								{onTogglePin && conv.status === "ACTIVE" ? (
									<Button
										variant="ghost"
										size="icon-sm"
										className={cn(
											"h-7 w-7 rounded-md",
											"text-muted-foreground hover:bg-background hover:text-foreground",
											conv.pinned && "text-foreground",
										)}
										onClick={(event) => {
											event.stopPropagation();
											onTogglePin(conv.id);
										}}
										aria-label={`Pin ${title}`}
										aria-pressed={conv.pinned}
									>
										{conv.pinned ? (
											<BookmarkCheck
												className="h-3.5 w-3.5"
												strokeWidth={2.1}
												aria-hidden
											/>
										) : (
											<Bookmark
												className="h-3.5 w-3.5"
												strokeWidth={2.1}
												aria-hidden
											/>
										)}
									</Button>
								) : null}
								<RowMenu
									conversation={conv}
									onRename={onRenameConversation}
									onShare={onShareConversation}
									onArchive={onArchiveConversation}
									onRestore={onRestoreConversation}
									onDelete={onDeleteConversation}
								/>
							</div>
						) : null}
					</li>
				);
			})}
		</ul>
	);
}
