"use client";

/**
 * HistoryTabContent - Conversation history list for sidebar
 *
 * Shows list of past conversations with:
 * - Mode indicator (Direct vs Orchestrator)
 * - Pin/unpin functionality
 * - Delete button
 * - Last message preview
 * - Relative timestamps
 */

import { Button } from "@ui/components/button";
import { cn } from "@ui/lib";
import { formatDistanceToNow } from "date-fns";
import {
	Bookmark,
	BookmarkCheck,
	Brain,
	History,
	Loader2,
	Trash,
	Zap,
} from "lucide-react";

interface ConversationItem {
	id: string;
	title: string | null;
	lastMessage?: string | null;
	createdAt: Date | string;
	pinned?: boolean;
	metadata?: { mode?: string };
}

export interface HistoryTabContentProps {
	conversations: ConversationItem[];
	activeConversationId: string | null;
	isLoading?: boolean;
	isDeleting?: boolean;
	onSelectConversation: (id: string) => void;
	onTogglePin: (id: string) => void;
	onDeleteConversation: (id: string) => void;
}

export function HistoryTabContent({
	conversations,
	activeConversationId,
	isLoading = false,
	isDeleting = false,
	onSelectConversation,
	onTogglePin,
	onDeleteConversation,
}: HistoryTabContentProps) {
	if (isLoading) {
		return (
			<div className="p-3">
				<div className="flex items-center justify-center py-8">
					<Loader2 className="h-4 w-4 animate-spin mr-2" />
					<span className="text-xs text-muted-foreground">
						Loading history...
					</span>
				</div>
			</div>
		);
	}

	if (conversations.length === 0) {
		return (
			<div className="p-3">
				<div className="text-center py-8 text-sm text-muted-foreground">
					<div className="h-12 w-12 rounded-xl bg-muted flex items-center justify-center mx-auto mb-3">
						<History className="h-6 w-6 opacity-50" />
					</div>
					<p className="font-medium">No conversations yet</p>
					<p className="text-xs mt-1">Start a new chat to begin</p>
				</div>
			</div>
		);
	}

	return (
		<div className="space-y-5 px-3 py-3">
			{conversations.map((conv) => {
				const isOrchestratorConv =
					conv.metadata?.mode === "orchestrator";
				const isActive = activeConversationId === conv.id;
				const title = conv.title?.trim() || "Untitled conversation";
				const preview =
					conv.lastMessage?.trim() ||
					"Open this run to review the conversation.";
				const timeAgo = formatDistanceToNow(new Date(conv.createdAt), {
					addSuffix: true,
				});

				return (
					<div key={conv.id} className="group relative">
						<button
							type="button"
							onClick={() => onSelectConversation(conv.id)}
							className={cn(
								"w-full overflow-hidden cursor-pointer rounded-xl text-left transition-colors duration-200",
								"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70 focus-visible:ring-offset-2",
								isActive
									? "bg-muted/80 text-foreground"
									: "text-muted-foreground hover:bg-muted/45 hover:text-foreground/85",
							)}
						>
							<div className="flex items-start gap-3 px-2.5 py-2">
								<div
									className={cn(
										"mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg",
										isOrchestratorConv
											? "bg-blue-500/12 text-blue-500"
											: "bg-emerald-500/12 text-emerald-500",
									)}
								>
									{isOrchestratorConv ? (
										<Brain className="h-3.5 w-3.5" />
									) : (
										<Zap className="h-3.5 w-3.5" />
									)}
								</div>

								<div className="min-w-0 flex-1 overflow-hidden">
									<p
										className={cn(
											"truncate text-[13px] font-medium leading-5",
											isActive
												? "text-foreground/90"
												: "text-inherit",
										)}
									>
										{title}
									</p>

									<div className="mt-1.5 flex items-center gap-1.5">
										<span
											className={cn(
												"inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium leading-none",
												isOrchestratorConv
													? "bg-blue-500/10 text-blue-600 dark:text-blue-400"
													: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
											)}
										>
											{isOrchestratorConv
												? "Orchestrator"
												: "Direct"}
										</span>
										<span className="text-[10px] text-muted-foreground/70">
											{timeAgo}
										</span>
									</div>

									<p className="mt-1.5 line-clamp-1 text-[12px] leading-5 text-muted-foreground">
										{preview}
									</p>

									<div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground/75">
										{conv.pinned && (
											<span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-300">
												<BookmarkCheck className="h-2.5 w-2.5" />
												Pinned
											</span>
										)}
									</div>
								</div>
							</div>
						</button>

						<div className="absolute right-1.5 top-1/2 z-10 flex -translate-y-1/2 items-center gap-1 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
							<Button
								variant="ghost"
								size="icon-sm"
								className={cn(
									"h-7 w-7 rounded-md",
									"text-muted-foreground/60 hover:bg-background hover:text-foreground",
									conv.pinned &&
										"text-amber-600 dark:text-amber-300",
								)}
								onClick={(e) => {
									e.stopPropagation();
									onTogglePin(conv.id);
								}}
								aria-label={
									conv.pinned
										? "Unsave conversation"
										: "Save conversation"
								}
							>
								{conv.pinned ? (
									<BookmarkCheck
										className="h-3.5 w-3.5"
										strokeWidth={2.1}
									/>
								) : (
									<Bookmark
										className="h-3.5 w-3.5"
										strokeWidth={2.1}
									/>
								)}
							</Button>
							<Button
								variant="ghost"
								size="icon-sm"
								className="h-7 w-7 rounded-md text-destructive/75 hover:bg-background hover:text-destructive"
								disabled={isDeleting}
								onClick={(e) => {
									e.stopPropagation();
									onDeleteConversation(conv.id);
								}}
								aria-label="Delete conversation"
							>
								<Trash
									className="h-3.5 w-3.5"
									strokeWidth={2.1}
								/>
							</Button>
						</div>
					</div>
				);
			})}
		</div>
	);
}
