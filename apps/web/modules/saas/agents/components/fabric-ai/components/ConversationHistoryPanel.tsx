"use client";

import { FABRIC_AGENT_ID } from "@repo/utils/page-limits";
import { useConversationList } from "@saas/agents/hooks/useConversationList";
import type {
	ConversationListItem,
	ConversationView,
} from "@saas/agents/lib/conversation-list";
import { RenameChatDialog } from "@saas/ai/components/RenameChatDialog";
import { userMessageOf } from "@saas/shared/lib/user-message-of";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@ui/components/alert-dialog";
import { Button } from "@ui/components/button";
import { SearchInput } from "@ui/components/search-input";
import { Skeleton } from "@ui/components/skeleton";
import { cn } from "@ui/lib";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ConversationVisibilityDialog } from "./ConversationVisibilityDialog";
import { HistoryTabContent } from "./HistoryTabContent";

const SEARCH_DEBOUNCE_MS = 300;

const VIEWS: ReadonlyArray<{ id: ConversationView; label: string }> = [
	{ id: "mine", label: "Mine" },
	{ id: "shared", label: "Shared with your organization" },
	{ id: "archived", label: "Archived" },
];

function emptyCopy(
	view: ConversationView,
	search: string,
): { title: string; hint: string } {
	if (search) {
		return {
			title: `No conversations match "${search}"`,
			hint: "Search looks at titles only.",
		};
	}
	switch (view) {
		case "mine":
			return {
				title: "No conversations yet",
				hint: "Start a new chat to begin",
			};
		case "shared":
			return {
				title: "Nothing is shared yet",
				hint: "A conversation its owner shares with your organization appears here.",
			};
		case "archived":
			return {
				title: "No archived conversations",
				hint: "An archived conversation can be restored from here.",
			};
		default: {
			const unreachable: never = view;
			return unreachable;
		}
	}
}

/**
 * Fabric Agent's conversation history, one list wherever it is shown (the full
 * page and the drawer): the viewer's own conversations, those shared with the
 * organization, and the viewer's archived ones, searchable by title, a page at
 * a time. A change to a conversation (rename, share, archive, restore, delete)
 * is made here and refreshes every list; opening one is left to whoever shows
 * the panel, which knows what opening means there.
 */
export function ConversationHistoryPanel({
	organizationId,
	activeConversationId,
	onSelect,
	onDeleted,
	className,
}: {
	organizationId: string | null;
	activeConversationId: string | null;
	onSelect: (conversation: ConversationListItem) => void;
	/** Called after a conversation is deleted, so whoever has it open can let go of it. */
	onDeleted?: (id: string) => void;
	className?: string;
}) {
	const [view, setView] = useState<ConversationView>("mine");
	const [searchText, setSearchText] = useState("");
	const [search, setSearch] = useState("");
	const [renaming, setRenaming] = useState<ConversationListItem | null>(null);
	const [sharing, setSharing] = useState<ConversationListItem | null>(null);
	const [deleting, setDeleting] = useState<ConversationListItem | null>(null);
	// The delete question fades out after it is answered, when `deleting` is
	// already null: it keeps naming the conversation until it has gone.
	const lastDeleting = useRef(deleting);
	if (deleting) {
		lastDeleting.current = deleting;
	}
	const deletingShown = deleting ?? lastDeleting.current;

	useEffect(() => {
		const timer = setTimeout(
			() => setSearch(searchText.trim()),
			SEARCH_DEBOUNCE_MS,
		);
		return () => clearTimeout(timer);
	}, [searchText]);

	const list = useConversationList({
		organizationId,
		agentId: FABRIC_AGENT_ID,
		view,
		search,
	});

	const attempt = async (
		work: () => Promise<unknown>,
		success: string,
		failure: string,
	) => {
		try {
			await work();
			toast.success(success);
			return true;
		} catch (error) {
			toast.error(failure, {
				description: userMessageOf(error, "Please try again."),
			});
			return false;
		}
	};

	const togglePin = (id: string) => {
		const pinned = list.items.find((item) => item.id === id)?.pinned;
		void attempt(
			() => list.togglePin(id),
			pinned ? "Unpinned" : "Pinned",
			pinned
				? "Could not unpin this conversation"
				: "Could not pin this conversation",
		);
	};

	const empty = emptyCopy(view, search);
	// A refresh or the next page that fails leaves the conversations already
	// read on screen, with a way to try again beside them.
	const failedWithItems = list.isError && list.items.length > 0;

	return (
		<div className={cn("flex min-h-0 flex-col", className)}>
			<div className="space-y-3 border-b border-border px-3 py-3">
				<fieldset className="flex flex-wrap gap-1 border-0 p-0">
					<legend className="sr-only">
						Which conversations to list
					</legend>
					{VIEWS.map((option) => (
						<button
							key={option.id}
							type="button"
							aria-pressed={view === option.id}
							onClick={() => setView(option.id)}
							className={cn(
								"cursor-pointer rounded-[4px] border px-2 py-1 text-[12px] motion-safe:transition-colors",
								"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
								view === option.id
									? "border-border bg-accent text-foreground"
									: "border-transparent text-muted-foreground hover:bg-accent/60 hover:text-foreground",
							)}
						>
							{option.label}
						</button>
					))}
				</fieldset>
				<SearchInput
					value={searchText}
					onChange={(event) => setSearchText(event.target.value)}
					placeholder="Search by title"
					aria-label="Search conversations by title"
					className="h-8 text-sm"
				/>
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto">
				{list.isLoading ? (
					<output
						className="block space-y-2 px-3 py-3"
						aria-label="Loading history"
					>
						{[0, 1, 2].map((key) => (
							<Skeleton key={key} className="h-16 rounded-xl" />
						))}
					</output>
				) : list.isError && list.items.length === 0 ? (
					<div className="space-y-2 px-3 py-4">
						<p role="alert" className="text-sm text-destructive">
							The history could not be loaded.
						</p>
						<Button
							variant="outline"
							size="sm"
							onClick={() => list.refetch()}
						>
							Try again
						</Button>
					</div>
				) : (
					<>
						<HistoryTabContent
							conversations={list.items}
							activeConversationId={activeConversationId}
							emptyTitle={empty.title}
							emptyHint={empty.hint}
							onSelectConversation={onSelect}
							onTogglePin={togglePin}
							onRenameConversation={setRenaming}
							onShareConversation={setSharing}
							onArchiveConversation={(conversation) => {
								void attempt(
									() => list.archive(conversation.id),
									"Conversation archived",
									"Could not archive this conversation",
								);
							}}
							onRestoreConversation={(conversation) => {
								void attempt(
									() => list.restore(conversation.id),
									"Conversation restored",
									"Could not restore this conversation",
								);
							}}
							onDeleteConversation={setDeleting}
						/>
						{failedWithItems ? (
							<div className="flex items-center justify-between gap-3 px-3 pb-4">
								<p
									role="alert"
									className="text-sm text-destructive"
								>
									{list.isLoadMoreError
										? "More conversations could not be loaded."
										: "The history could not be refreshed."}
								</p>
								<Button
									variant="outline"
									size="sm"
									onClick={() =>
										list.isLoadMoreError
											? list.loadMore()
											: list.refetch()
									}
								>
									Try again
								</Button>
							</div>
						) : list.hasMore ? (
							<div className="px-3 pb-4">
								<Button
									variant="outline"
									size="sm"
									className="w-full"
									loading={list.isLoadingMore}
									onClick={() => list.loadMore()}
								>
									Load more
								</Button>
							</div>
						) : null}
					</>
				)}
			</div>

			<RenameChatDialog
				open={renaming !== null}
				onOpenChange={(open) => {
					if (!open) {
						setRenaming(null);
					}
				}}
				currentTitle={renaming?.title?.trim() || ""}
				onConfirm={(title) => {
					const target = renaming;
					if (target) {
						void attempt(
							() => list.rename(target.id, title),
							"Conversation renamed",
							"Could not rename this conversation",
						);
					}
				}}
			/>

			<ConversationVisibilityDialog
				conversation={sharing}
				onOpenChange={(open) => {
					if (!open) {
						setSharing(null);
					}
				}}
				onConfirm={async (conversation, visibility) => {
					const saved = await attempt(
						() => list.setVisibility(conversation.id, visibility),
						visibility === "ORGANIZATION"
							? "Shared with your organization"
							: "Conversation is private",
						"Could not change who can read this conversation",
					);
					if (saved) {
						setSharing(null);
					}
				}}
			/>

			<AlertDialog
				open={deleting !== null}
				onOpenChange={(open) => {
					if (!open) {
						setDeleting(null);
					}
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							Delete this conversation?
						</AlertDialogTitle>
						<AlertDialogDescription>
							&ldquo;
							{deletingShown?.title?.trim() ||
								"Untitled conversation"}
							&rdquo; and its messages are removed for good.
							Archive it instead to keep it out of the way and
							bring it back later.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							onClick={() => {
								const target = deleting;
								if (!target) {
									return;
								}
								void attempt(
									async () => {
										await list.remove(target.id);
										onDeleted?.(target.id);
									},
									"Conversation deleted",
									"Could not delete this conversation",
								);
							}}
						>
							Delete
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}
