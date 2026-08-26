"use client";

import { Button } from "@ui/components/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import { SearchInput } from "@ui/components/search-input";
import { Skeleton } from "@ui/components/skeleton";
import {
	Loader2Icon,
	MessageSquareIcon,
	MoreHorizontalIcon,
	PlusIcon,
	SearchIcon,
	Trash2Icon,
} from "lucide-react";
import { useState } from "react";
import { groupChatsByTime } from "../lib/chat-grouping";
import { ChatHistoryGroup } from "./ChatHistoryGroup";

interface ChatHistorySidebarProps {
	chats: any[];
	activeChatId: string | null;
	isLoading: boolean;
	hasNextPage: boolean;
	isFetchingNextPage: boolean;
	onSelectChat: (chatId: string) => void;
	onDeleteChat: (chatId: string) => void;
	onNewChat: () => void;
	onClearAll?: () => void;
	loadMoreRef: React.RefObject<HTMLDivElement | null>;
}

export function ChatHistorySidebar({
	chats,
	activeChatId,
	isLoading,
	hasNextPage,
	isFetchingNextPage,
	onSelectChat,
	onDeleteChat,
	onNewChat,
	onClearAll,
	loadMoreRef,
}: ChatHistorySidebarProps) {
	const [search, setSearch] = useState("");

	const filteredChats = search.trim()
		? chats.filter((c) => {
				const title = (c.title ?? "") as string;
				const q = search.toLowerCase();
				return title.toLowerCase().includes(q);
			})
		: chats;

	const groupedChats = groupChatsByTime(filteredChats);
	const visibleChats = filteredChats.length;

	return (
		<div className="flex h-full w-full flex-col overflow-hidden bg-background">
			{/* Header */}
			<div className="shrink-0 border-b border-border/70 px-3 py-3">
				<div className="relative mb-2.5 flex items-center justify-end gap-2">
					<h2
						className="pointer-events-none absolute left-1/2 -translate-x-1/2 leading-none text-center text-foreground/78"
						style={{
							fontFamily: "var(--font-sans)",
							fontSize: "1.2rem",
							fontWeight: 400,
							letterSpacing: "-0.01em",
						}}
					>
						Threads
					</h2>
					<div className="flex items-center gap-1">
						<Button
							variant="ghost"
							size="sm"
							className="size-8 shrink-0 rounded-lg text-muted-foreground hover:text-foreground"
							onClick={onNewChat}
							title="New thread"
							aria-label="New thread"
						>
							<PlusIcon className="size-3.5" />
						</Button>
						{onClearAll && (
							<DropdownMenu>
								<DropdownMenuTrigger asChild>
									<Button
										variant="ghost"
										size="icon"
										className="size-7 shrink-0 rounded-lg text-muted-foreground hover:text-foreground"
										title="More options"
									>
										<MoreHorizontalIcon className="size-3.5" />
									</Button>
								</DropdownMenuTrigger>
								<DropdownMenuContent
									align="end"
									className="w-52"
								>
									<DropdownMenuItem
										className="cursor-pointer text-xs text-destructive focus:text-destructive"
										onClick={onClearAll}
									>
										<Trash2Icon className="mr-2 size-3.5" />
										Clear thread history
									</DropdownMenuItem>
								</DropdownMenuContent>
							</DropdownMenu>
						)}
					</div>
				</div>

				<div className="relative">
					<SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/50" />
					<SearchInput
						value={search}
						onChange={(e) => setSearch(e.target.value)}
						placeholder="Search..."
						className="h-9 rounded-2xl border-border/70 bg-muted/30 pl-9 text-sm"
					/>
				</div>
			</div>

			{/* Search results count (only when searching) */}
			{search.trim() && (
				<div className="flex shrink-0 items-center justify-between px-4 pt-2 pb-0">
					<span className="text-[10px] text-muted-foreground/40">
						{visibleChats} result{visibleChats !== 1 ? "s" : ""}
					</span>
				</div>
			)}

			{/* Chat list */}
			<div
				className="flex-1 overflow-y-auto pb-4"
				style={{ scrollbarWidth: "none" }}
			>
				{isLoading ? (
					<div className="space-y-1 px-3 py-3">
						<Skeleton className="h-12 w-full rounded-xl" />
						<Skeleton className="h-12 w-full rounded-xl" />
						<Skeleton className="h-12 w-full rounded-xl" />
					</div>
				) : groupedChats.length === 0 ? (
					<div className="mx-3 mt-4 flex flex-col items-center justify-center rounded-xl border border-dashed border-border/70 px-4 py-10 text-center">
						<MessageSquareIcon className="size-5 text-muted-foreground/40" />
						<p className="mt-3 text-sm font-medium text-foreground/85">
							{search ? "No matches found" : "No threads yet"}
						</p>
						{!search && (
							<p className="mt-1 max-w-[22ch] text-xs leading-5 text-muted-foreground">
								Start a new thread to begin working with an
								agent.
							</p>
						)}
					</div>
				) : (
					<div className="space-y-5 pt-3">
						{groupedChats.map((group) => (
							<ChatHistoryGroup
								key={group.group}
								label={group.label}
								items={group.chats.map((chat: any) => ({
									id: chat.id,
									title:
										chat.title ??
										(chat.messages?.at(0) as any)
											?.content ??
										"Untitled chat",
									updatedAt:
										typeof chat.updatedAt === "string"
											? chat.updatedAt
											: chat.updatedAt instanceof Date
												? chat.updatedAt.toISOString()
												: undefined,
								}))}
								selectedId={activeChatId}
								onSelect={onSelectChat}
								onDelete={onDeleteChat}
							/>
						))}

						{hasNextPage && (
							<div ref={loadMoreRef} className="py-3 text-center">
								{isFetchingNextPage ? (
									<Loader2Icon className="mx-auto size-4 animate-spin text-muted-foreground" />
								) : (
									<span className="text-muted-foreground text-xs">
										Load more
									</span>
								)}
							</div>
						)}
					</div>
				)}
			</div>
		</div>
	);
}
