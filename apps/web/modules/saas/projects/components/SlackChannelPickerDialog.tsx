"use client";

/**
 * SlackChannelPickerDialog
 *
 * Dialog for selecting Slack channels to link to the project's Slack Channel
 * Monitor. Reuses `orpc.projects.contexts.listAvailableSlackChannels` — the
 * same paginated workspace channel list that powers SlackChannelSelectorDialog
 * — so we don't rebuild channel discovery logic.
 *
 * On confirm, calls `linkChannel` once per selected channel. Track 3 of the
 * parent plan delivers the matching procedure.
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
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import {
	AlertCircleIcon,
	HashIcon,
	LoaderIcon,
	LockIcon,
	SearchIcon,
	UsersIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { SlackIcon } from "../../workflows/lib/plugins/slack/icon";
import { getSlackChannelMonitorClient } from "../lib/slack-channel-monitor-client";

type BackfillMode = "from-now" | "latest-7-days";

type Props = {
	projectId: string;
	organizationId?: string | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
};

export function SlackChannelPickerDialog({
	projectId,
	organizationId,
	open,
	onOpenChange,
}: Props) {
	const tTooltips = useTranslations("tooltips.contextSources");
	const queryClient = useQueryClient();
	const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
	const [backfillMode, setBackfillMode] = useState<BackfillMode>("from-now");
	const [searchQuery, setSearchQuery] = useState("");
	const loadMoreRef = useRef<HTMLDivElement>(null);

	// Reset on open
	useEffect(() => {
		if (open) {
			setSelectedIds(new Set());
			setBackfillMode("from-now");
			setSearchQuery("");
		}
	}, [open]);

	// Available workspace channels (paginated via existing contexts procedure).
	const slackQuery = useInfiniteQuery({
		queryKey: [
			"slack-channel-picker-available",
			projectId,
			organizationId ?? null,
		],
		queryFn: async ({ pageParam }: { pageParam: string | undefined }) => {
			return await orpcClient.projects.contexts.listAvailableSlackChannels(
				{
					projectId,
					organizationId: organizationId ?? null,
					cursor: pageParam,
				},
			);
		},
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
		enabled: open,
	});

	const channels = useMemo(
		() => slackQuery.data?.pages.flatMap((p) => p.channels) ?? [],
		[slackQuery.data],
	);
	const isConnected = slackQuery.data?.pages[0]?.isConnected ?? true;
	const botName = slackQuery.data?.pages[0]?.botName;
	const fetchError = slackQuery.data?.pages[0]?.error;
	const isLoading = slackQuery.isLoading;

	// Currently linked channels — disabled in the list so users can't double-link.
	const linkedChannelsQuery = useQuery({
		queryKey: [
			"slack-channel-monitor-linked",
			projectId,
			organizationId ?? null,
		],
		queryFn: async () => {
			const client = getSlackChannelMonitorClient();
			const result = await client.listLinkedChannels({
				projectId,
				organizationId: organizationId ?? null,
			});
			return result ?? [];
		},
		enabled: open,
	});

	const linkedIds = useMemo(() => {
		const ids = new Set<string>();
		for (const row of linkedChannelsQuery.data ?? []) {
			ids.add(row.channelId);
		}
		return ids;
	}, [linkedChannelsQuery.data]);

	// Infinite scroll
	const handleObserver = useCallback(
		(entries: IntersectionObserverEntry[]) => {
			if (
				entries[0].isIntersecting &&
				slackQuery.hasNextPage &&
				!slackQuery.isFetchingNextPage
			) {
				slackQuery.fetchNextPage();
			}
		},
		[slackQuery],
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

	const filteredChannels = useMemo(() => {
		if (!searchQuery.trim()) {
			return channels;
		}
		const q = searchQuery.toLowerCase();
		return channels.filter(
			(ch) =>
				ch.name.toLowerCase().includes(q) ||
				ch.topic.toLowerCase().includes(q) ||
				ch.purpose.toLowerCase().includes(q),
		);
	}, [channels, searchQuery]);

	const toggleSelection = useCallback(
		(channelId: string, isLinked: boolean) => {
			if (isLinked) {
				return;
			}
			setSelectedIds((prev) => {
				const next = new Set(prev);
				if (next.has(channelId)) {
					next.delete(channelId);
				} else {
					next.add(channelId);
				}
				return next;
			});
		},
		[],
	);

	const linkMutation = useMutation({
		mutationFn: async () => {
			const client = getSlackChannelMonitorClient();
			const ids = Array.from(selectedIds);
			const results = await Promise.allSettled(
				ids.map((channelId) => {
					const channel = channels.find((c) => c.id === channelId);
					return client.linkChannel({
						projectId,
						organizationId: organizationId ?? null,
						channelId,
						channelName: channel?.name,
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
					`Linked ${succeeded} channel${succeeded === 1 ? "" : "s"}`,
					failed > 0
						? { description: `${failed} failed to link.` }
						: undefined,
				);
			} else if (failed > 0) {
				toast.error(
					`Failed to link ${failed} channel${failed === 1 ? "" : "s"}`,
				);
				return;
			}
			queryClient.invalidateQueries({
				queryKey: [
					"slack-channel-monitor-linked",
					projectId,
					organizationId ?? null,
				],
			});
			queryClient.invalidateQueries({
				queryKey: [
					"slack-channel-monitor-pending-proposals-count",
					projectId,
					organizationId ?? null,
				],
			});
			if (succeeded === total) {
				onOpenChange(false);
			}
		},
		onError: (error) => {
			toast.error("Failed to link channels", {
				description:
					error instanceof Error ? error.message : "Unknown error",
			});
		},
	});

	const selectedCount = selectedIds.size;
	const hasContent = channels.length > 0;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-lg">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<SlackIcon className="size-5 text-primary" />
						Link Slack Channels
					</DialogTitle>
					<DialogDescription>
						Choose channels whose discussions Fabric should analyze
						for backlog proposals.
					</DialogDescription>
				</DialogHeader>

				{isLoading && (
					<div className="flex flex-col items-center gap-3 py-10 text-center">
						<LoaderIcon className="size-6 animate-spin text-primary" />
						<p className="text-sm text-foreground/70">
							Loading your Slack channels...
						</p>
					</div>
				)}

				{!isLoading && slackQuery.error && (
					<div className="flex flex-col items-center gap-3 py-8 text-center">
						<AlertCircleIcon className="size-8 text-destructive" />
						<p className="text-foreground/70">
							Failed to load Slack data
						</p>
						<p className="text-foreground/50 text-sm">
							{slackQuery.error instanceof Error
								? slackQuery.error.message
								: "An unexpected error occurred"}
						</p>
					</div>
				)}

				{!isLoading && !slackQuery.error && !isConnected && (
					<div className="flex flex-col items-center gap-4 py-8 text-center">
						<div className="rounded-full bg-highlight/10 p-4">
							<AlertCircleIcon className="size-8 text-highlight" />
						</div>
						<div>
							<p className="font-medium text-foreground/80">
								Slack workspace not connected
							</p>
							<p className="mt-1 text-foreground/50 text-sm">
								{fetchError ||
									"Connect your Slack workspace in Settings → Integrations to access channels."}
							</p>
						</div>
					</div>
				)}

				{!isLoading &&
					!slackQuery.error &&
					isConnected &&
					!hasContent && (
						<div className="flex flex-col items-center gap-3 py-8 text-center">
							<HashIcon className="size-8 text-foreground/30" />
							<p className="text-foreground/70">
								No channels found
							</p>
							<p className="text-foreground/50 text-sm">
								No accessible channels were found in your Slack
								workspace.
							</p>
						</div>
					)}

				{!isLoading &&
					!slackQuery.error &&
					isConnected &&
					hasContent && (
						<>
							{/* Search */}
							<div className="relative">
								<SearchIcon className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-foreground/40" />
								<input
									type="search"
									autoComplete="off"
									placeholder="Search channels..."
									value={searchQuery}
									onChange={(e) =>
										setSearchQuery(e.target.value)
									}
									aria-label="Search Slack channels"
									className="w-full rounded-lg border bg-background py-2 pl-9 pr-3 text-sm placeholder:text-foreground/40 focus:outline-none focus:ring-1 focus:ring-ring"
								/>
							</div>

							<div className="max-h-[300px] space-y-1 overflow-y-auto rounded-lg border">
								{filteredChannels.length === 0 ? (
									<div className="flex flex-col items-center gap-2 py-6 text-center">
										<SearchIcon className="size-6 text-foreground/30" />
										<p className="text-foreground/50 text-sm">
											No channels match your search
										</p>
									</div>
								) : (
									<>
										{filteredChannels.map((channel) => {
											const isLinked = linkedIds.has(
												channel.id,
											);
											const isSelected = selectedIds.has(
												channel.id,
											);
											return (
												// biome-ignore lint/a11y/noLabelWithoutControl: wraps a Radix Checkbox which renders a <button>, not a native <input>
												<label
													key={channel.id}
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
														checked={
															isSelected ||
															isLinked
														}
														disabled={isLinked}
														onCheckedChange={() =>
															toggleSelection(
																channel.id,
																isLinked,
															)
														}
													/>
													{channel.isPrivate ? (
														<LockIcon className="size-3.5 shrink-0 text-foreground/40" />
													) : (
														<HashIcon className="size-3.5 shrink-0 text-foreground/40" />
													)}
													<span className="truncate text-sm">
														{channel.name}
													</span>
													{channel.memberCount >
														0 && (
														<span className="ml-auto flex shrink-0 items-center gap-1 text-foreground/50 text-xs">
															<UsersIcon className="size-3" />
															{
																channel.memberCount
															}
														</span>
													)}
													{isLinked && (
														<span className="ml-2 shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 text-primary text-xs">
															Linked
														</span>
													)}
													{!isLinked &&
														channel.isBotMember ===
															false && (
															<Tooltip>
																<TooltipTrigger
																	asChild
																>
																	<span className="ml-2 shrink-0 text-xs text-highlight">
																		Bot not
																		added
																		{/* Not focusable, so the portalled tooltip is
																			pointer-only. `aria-label` would replace the
																			visible "Bot not added"; an `sr-only` child
																			adds the fix alongside it. */}
																		<span className="sr-only">
																			{tTooltips(
																				"slackBotNotInChannel",
																				{
																					botName:
																						botName ||
																						"your_app",
																				},
																			)}
																		</span>
																	</span>
																</TooltipTrigger>
																<TooltipContent>
																	{tTooltips(
																		"slackBotNotInChannel",
																		{
																			botName:
																				botName ||
																				"your_app",
																		},
																	)}
																</TooltipContent>
															</Tooltip>
														)}
												</label>
											);
										})}
										<div
											ref={loadMoreRef}
											className="flex items-center justify-center py-2"
										>
											{slackQuery.isFetchingNextPage && (
												<LoaderIcon className="size-4 animate-spin text-foreground/40" />
											)}
										</div>
									</>
								)}
							</div>

							<div className="space-y-3 rounded-lg border border-foreground/10 bg-muted/30 p-4">
								<div>
									<p className="text-sm font-medium">
										Backfill behavior
									</p>
									<p className="mt-0.5 text-xs text-muted-foreground">
										Applies to every channel you link now.
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
											id="slack-backfill-from-now"
											className="mt-0.5"
										/>
										<Label
											htmlFor="slack-backfill-from-now"
											className="flex-1 cursor-pointer space-y-0.5 font-normal"
										>
											<span className="block text-sm font-medium">
												Only new messages from now
											</span>
											<span className="block text-xs text-muted-foreground">
												Recommended. Best for busy
												channels with lots of history.
											</span>
										</Label>
									</div>
									<div className="flex items-start gap-3">
										<RadioGroupItem
											value="latest-7-days"
											id="slack-backfill-7-days"
											className="mt-0.5"
										/>
										<Label
											htmlFor="slack-backfill-7-days"
											className="flex-1 cursor-pointer space-y-0.5 font-normal"
										>
											<span className="block text-sm font-medium">
												Include last 7 days
											</span>
											<span className="block text-xs text-muted-foreground">
												Use when the recent history
												already contains feature
												discussions worth capturing.
											</span>
										</Label>
									</div>
								</RadioGroup>
							</div>

							<div className="text-sm text-muted-foreground">
								{selectedCount} channel
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
							`Link ${selectedCount} Channel${
								selectedCount !== 1 ? "s" : ""
							}`
						)}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
