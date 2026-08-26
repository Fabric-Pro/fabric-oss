"use client";

/**
 * TeamsChatPickerDialog
 *
 * Dialog for selecting Microsoft Teams group chats (chats only, not channels)
 * to link to the project's Teams Chat Monitor. Lets the user pick one or more
 * chats and choose a backfill mode before confirming.
 *
 * Reuses `orpc.projects.contexts.listAvailableTeamsChats` — it already returns
 * the `chats` array (group chats only). Chats already linked to the monitor
 * are disabled.
 */

import { orpcClient } from "@shared/lib/orpc-client";
import {
	useInfiniteQuery,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Checkbox } from "@ui/components/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { Label } from "@ui/components/label";
import { RadioGroup, RadioGroupItem } from "@ui/components/radio-group";
import { cn } from "@ui/lib";
import {
	AlertCircleIcon,
	AlertTriangleIcon,
	LoaderIcon,
	MessageSquareIcon,
	UserIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

type BackfillMode = "from-now" | "latest-30";

type Props = {
	projectId: string;
	organizationId?: string | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
};

type LinkedChat = {
	id: string;
	chatId: string;
};

export function TeamsChatPickerDialog({
	projectId,
	organizationId,
	open,
	onOpenChange,
}: Props) {
	const queryClient = useQueryClient();
	const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
	const [backfillMode, setBackfillMode] = useState<BackfillMode>("from-now");
	const loadMoreRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		if (open) {
			setSelectedKeys(new Set());
			setBackfillMode("from-now");
		}
	}, [open]);

	const teamsQuery = useInfiniteQuery({
		queryKey: [
			"teams-chat-picker-available",
			projectId,
			organizationId ?? null,
		],
		queryFn: async ({ pageParam }: { pageParam: string | undefined }) => {
			return await orpcClient.projects.contexts.listAvailableTeamsChats({
				projectId,
				organizationId: organizationId ?? null,
				cursor: pageParam,
			});
		},
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (lastPage) => lastPage.nextChatsCursor ?? undefined,
		enabled: open,
	});

	const linkedChatsQuery = useQuery({
		queryKey: [
			"teams-chat-monitor-linked",
			projectId,
			organizationId ?? null,
		],
		queryFn: async () => {
			const result =
				await orpcClient.projects.teamsChatMonitor.listLinkedChats({
					projectId,
					organizationId: organizationId ?? null,
				});
			return (result ?? []) as LinkedChat[];
		},
		enabled: open,
	});

	const chats = useMemo(
		() => teamsQuery.data?.pages.flatMap((p) => p.chats) ?? [],
		[teamsQuery.data],
	);
	const isConnected = teamsQuery.data?.pages[0]?.isConnected ?? true;
	const fetchError = teamsQuery.data?.pages[0]?.error;

	const hasSelectedDirectChat = useMemo(() => {
		return chats.some(
			(chat) => selectedKeys.has(chat.id) && chat.type === "oneOnOne",
		);
	}, [chats, selectedKeys]);

	// Infinite scroll observer — fetches the next page of chats when the
	// sentinel scrolls into view. Mirrors TeamsChatSelectorDialog (wizard).
	const handleObserver = useCallback(
		(entries: IntersectionObserverEntry[]) => {
			if (
				entries[0].isIntersecting &&
				teamsQuery.hasNextPage &&
				!teamsQuery.isFetchingNextPage
			) {
				teamsQuery.fetchNextPage();
			}
		},
		[teamsQuery],
	);

	useEffect(() => {
		const el = loadMoreRef.current;
		if (!el) {
			return;
		}
		const observer = new IntersectionObserver(handleObserver, {
			root: el.parentElement,
			threshold: 0.1,
		});
		observer.observe(el);
		return () => observer.disconnect();
	}, [handleObserver]);

	const linkedKeys = useMemo(() => {
		const keys = new Set<string>();
		for (const row of linkedChatsQuery.data ?? []) {
			keys.add(row.chatId);
		}
		return keys;
	}, [linkedChatsQuery.data]);

	const toggleSelection = useCallback((key: string, isLinked: boolean) => {
		if (isLinked) {
			return;
		}
		setSelectedKeys((prev) => {
			const next = new Set(prev);
			if (next.has(key)) {
				next.delete(key);
			} else {
				next.add(key);
			}
			return next;
		});
	}, []);

	const linkMutation = useMutation({
		mutationFn: async () => {
			const keys = Array.from(selectedKeys);
			const results = await Promise.allSettled(
				keys.map((chatId) => {
					const chat = chats.find((c) => c.id === chatId);
					return orpcClient.projects.teamsChatMonitor.linkChat({
						projectId,
						organizationId: organizationId ?? null,
						chatId,
						chatTopic: chat?.topic,
						chatType: chat?.type,
						backfillMode,
					});
				}),
			);
			const succeeded = results.filter(
				(r) => r.status === "fulfilled",
			).length;
			const failed = results.length - succeeded;
			return { succeeded, failed, total: results.length };
		},
		onSuccess: ({ succeeded, failed, total }) => {
			if (succeeded > 0) {
				toast.success(
					`Linked ${succeeded} chat${succeeded === 1 ? "" : "s"}`,
					failed > 0
						? {
								description: `${failed} failed to link.`,
							}
						: undefined,
				);
			} else if (failed > 0) {
				toast.error(
					`Failed to link ${failed} chat${failed === 1 ? "" : "s"}`,
				);
				return;
			}
			queryClient.invalidateQueries({
				queryKey: [
					"teams-chat-monitor-linked",
					projectId,
					organizationId ?? null,
				],
			});
			queryClient.invalidateQueries({
				queryKey: [
					"teams-chat-monitor-pending-proposals-count",
					projectId,
					organizationId ?? null,
				],
			});
			if (succeeded === total) {
				onOpenChange(false);
			}
		},
		onError: (error) => {
			toast.error("Failed to link chats", {
				description:
					error instanceof Error ? error.message : "Unknown error",
			});
		},
	});

	const isLoading = teamsQuery.isLoading || linkedChatsQuery.isLoading;
	const hasContent = chats.length > 0;
	const selectedCount = selectedKeys.size;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-lg">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<MessageSquareIcon className="size-5 text-primary" />
						Link Teams Chats
					</DialogTitle>
					<DialogDescription>
						Choose group chats or 1:1 direct chats whose
						conversations Fabric should analyze for backlog
						proposals.
					</DialogDescription>
				</DialogHeader>

				{isLoading && (
					<div className="flex flex-col items-center gap-3 py-10 text-center">
						<LoaderIcon className="size-6 animate-spin text-primary" />
						<p className="text-sm text-foreground/70">
							Loading your Teams chats...
						</p>
					</div>
				)}

				{!isLoading && teamsQuery.error && (
					<div className="flex flex-col items-center gap-3 py-8 text-center">
						<AlertCircleIcon className="size-8 text-destructive" />
						<p className="text-foreground/70">
							Failed to load Teams data
						</p>
						<p className="text-foreground/50 text-sm">
							{teamsQuery.error instanceof Error
								? teamsQuery.error.message
								: "An unexpected error occurred"}
						</p>
					</div>
				)}

				{!isLoading && !teamsQuery.error && !isConnected && (
					<div className="flex flex-col items-center gap-4 py-8 text-center">
						<div className="rounded-full bg-highlight/10 p-4">
							<AlertCircleIcon className="size-8 text-highlight" />
						</div>
						<div>
							<p className="font-medium text-foreground/80">
								Microsoft account not connected
							</p>
							<p className="mt-1 text-foreground/50 text-sm">
								{fetchError ||
									"Connect your Microsoft account in Settings → Integrations to access Teams chats."}
							</p>
						</div>
					</div>
				)}

				{!isLoading && !teamsQuery.error && isConnected && (
					<>
						<div className="max-h-[300px] space-y-0.5 overflow-y-auto rounded-lg border p-2">
							{!hasContent ? (
								<div className="flex flex-col items-center gap-3 py-8 text-center">
									<MessageSquareIcon className="size-8 text-foreground/30" />
									<p className="text-foreground/70">
										No chats found
									</p>
									<p className="text-foreground/50 text-sm">
										No group chats or 1:1 direct chats were
										found on your Microsoft account.
									</p>
								</div>
							) : (
								chats.map((chat) => {
									const key = chat.id;
									const isLinked = linkedKeys.has(key);
									const isSelected = selectedKeys.has(key);
									const isDirectChat =
										chat.type === "oneOnOne";
									return (
										// biome-ignore lint/a11y/noLabelWithoutControl: wraps a Radix Checkbox which renders a <button>, not a native <input>
										<label
											key={key}
											className={cn(
												"flex items-center gap-2.5 rounded-md px-2 py-2 transition-colors",
												isLinked
													? "cursor-not-allowed bg-muted/50 opacity-60"
													: isSelected
														? "cursor-pointer bg-primary/10"
														: "cursor-pointer hover:bg-accent/50",
											)}
										>
											<Checkbox
												checked={isSelected || isLinked}
												disabled={isLinked}
												onCheckedChange={() =>
													toggleSelection(
														key,
														isLinked,
													)
												}
											/>
											{isDirectChat ? (
												<UserIcon className="size-3.5 shrink-0 text-amber-500 dark:text-amber-400" />
											) : (
												<MessageSquareIcon className="size-3.5 shrink-0 text-foreground/40" />
											)}
											<div className="min-w-0 flex-1">
												<div className="flex items-center gap-1.5">
													<p className="truncate text-sm font-medium">
														{chat.topic}
													</p>
													{isDirectChat && (
														<span className="shrink-0 rounded-full bg-amber-500/10 px-1.5 py-0.5 font-medium text-[10px] text-amber-600 dark:text-amber-400">
															1:1 Direct
														</span>
													)}
												</div>
												{chat.members && (
													<p className="truncate text-xs text-foreground/50">
														{chat.members}
													</p>
												)}
											</div>
											{isLinked && (
												<span className="ml-auto shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 text-primary text-xs">
													Linked
												</span>
											)}
										</label>
									);
								})
							)}
							<div ref={loadMoreRef} className="h-1 w-full" />
							{teamsQuery.isFetchingNextPage && (
								<div className="flex items-center justify-center gap-2 py-3 text-foreground/60 text-xs">
									<LoaderIcon className="size-3.5 animate-spin" />
									Loading more chats…
								</div>
							)}
						</div>

						{hasSelectedDirectChat && (
							<div className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3.5 text-amber-900 dark:text-amber-200">
								<AlertTriangleIcon className="mt-0.5 size-5 shrink-0 text-amber-600 dark:text-amber-400" />
								<div className="space-y-0.5">
									<p className="font-semibold text-amber-700 text-xs tracking-wider uppercase dark:text-amber-300">
										Direct Chat Selected (1:1)
									</p>
									<p className="text-amber-800/90 text-xs leading-relaxed dark:text-amber-300/90">
										You have selected one or more 1:1 direct
										chats. 1:1 chats contain private
										conversations between two individuals.
										Fabric will analyze messages in this
										chat for backlog proposals.
									</p>
								</div>
							</div>
						)}

						<div className="space-y-3 rounded-lg border border-foreground/10 bg-muted/30 p-4">
							<div>
								<p className="text-sm font-medium">
									Backfill behavior
								</p>
								<p className="mt-0.5 text-xs text-muted-foreground">
									Applies to every chat you link now.
								</p>
							</div>
							<RadioGroup
								value={backfillMode}
								onValueChange={(v) =>
									setBackfillMode(v as BackfillMode)
								}
								className="space-y-2"
							>
								<div className="flex items-start gap-3">
									<RadioGroupItem
										value="from-now"
										id="chat-backfill-from-now"
										className="mt-0.5"
									/>
									<Label
										htmlFor="chat-backfill-from-now"
										className="flex-1 cursor-pointer space-y-0.5 font-normal"
									>
										<span className="block text-sm font-medium">
											Only new messages from now
										</span>
										<span className="block text-xs text-muted-foreground">
											Recommended. Best for busy chats
											with lots of history.
										</span>
									</Label>
								</div>
								<div className="flex items-start gap-3">
									<RadioGroupItem
										value="latest-30"
										id="chat-backfill-latest-30"
										className="mt-0.5"
									/>
									<Label
										htmlFor="chat-backfill-latest-30"
										className="flex-1 cursor-pointer space-y-0.5 font-normal"
									>
										<span className="block text-sm font-medium">
											Include last 30 messages
										</span>
										<span className="block text-xs text-muted-foreground">
											Use when the recent history already
											contains feature discussions worth
											capturing.
										</span>
									</Label>
								</div>
							</RadioGroup>
						</div>

						<div className="text-sm text-muted-foreground">
							{selectedCount} chat
							{selectedCount !== 1 ? "s" : ""} selected
						</div>
					</>
				)}

				<DialogFooter>
					<Button
						variant="outline"
						onClick={() => onOpenChange(false)}
					>
						Cancel
					</Button>
					<Button
						onClick={() => linkMutation.mutate()}
						disabled={
							selectedCount === 0 ||
							linkMutation.isPending ||
							!isConnected
						}
					>
						{linkMutation.isPending ? (
							<>
								<LoaderIcon className="mr-2 size-4 animate-spin" />
								Linking...
							</>
						) : (
							`Link ${selectedCount} Chat${
								selectedCount !== 1 ? "s" : ""
							}`
						)}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
