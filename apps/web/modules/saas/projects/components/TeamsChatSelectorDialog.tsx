"use client";

/**
 * TeamsChatSelectorDialog
 *
 * Dialog for selecting Microsoft Teams group chats and team channels to link
 * as project integration contexts. These become searchable context during
 * document generation.
 *
 * Features:
 * - Checks if Microsoft Graph OAuth is connected
 * - Fetches available group chats and team channels via API
 * - Infinite scroll for group chats (paginated via cursor)
 * - Tabbed UI: Group Chats / Team Channels
 * - Multi-select up to 10 items (across both tabs)
 * - Pre-selects already-added Teams contexts
 * - Saves selected items as INTEGRATION type ProjectContexts
 */

import {
	useContextPath,
	useOrganizationContext,
} from "@saas/organizations/hooks/use-organization-context";
import { useSettingsReturnUrl } from "@saas/settings/hooks/use-settings-return-url";
import { MicrosoftTeamsIcon } from "@saas/workflows/lib/plugins/microsoft-teams/icon";
import { TruncatedText } from "@shared/components/TruncatedText";
import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import {
	useInfiniteQuery,
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
import { cn } from "@ui/lib";
import {
	AlertCircleIcon,
	AlertTriangleIcon,
	CheckCircleIcon,
	ChevronDownIcon,
	ChevronRightIcon,
	ExternalLinkIcon,
	HashIcon,
	LoaderIcon,
	MessageSquareIcon,
	UsersIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

type Props = {
	projectId: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onSuccess?: () => void;
};

const MAX_SELECTIONS = 10;

export function TeamsChatSelectorDialog({
	projectId,
	open,
	onOpenChange,
	onSuccess,
}: Props) {
	const queryClient = useQueryClient();
	const { organizationId } = useOrganizationContext();
	const integrationsPathRaw = useContextPath("settings/integrations");
	const buildReturnUrl = useSettingsReturnUrl();
	const integrationsPath = buildReturnUrl(integrationsPathRaw);

	const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
	const [isSaving, setIsSaving] = useState(false);
	const [activeTab, setActiveTab] = useState<"chats" | "channels">("chats");
	const [expandedTeams, setExpandedTeams] = useState<Set<string>>(new Set());
	const loadMoreRef = useRef<HTMLDivElement>(null);
	// Persists unsaved selections across dialog close/reopen within the same page session.
	// Set to null after a successful save so pre-selection resets to DB state on next open.
	const pendingSelectionsRef = useRef<Set<string> | null>(null);
	// True while the dialog is closing due to a successful save (not a user dismiss).
	// Prevents the close-side of the open/close effect from overwriting the nulled ref.
	const closingAfterSaveRef = useRef(false);
	// Tracks the previous value of `open` so we can detect a true open→closed transition.
	const prevOpenRef = useRef(false);

	// Fetch existing project contexts to pre-select already-added Teams items
	const { data: existingContextsData } = useQuery({
		...orpc.projects.contexts.list.queryOptions({
			input: { projectId, organizationId, type: "INTEGRATION" },
		}),
		enabled: open,
	});

	// Compute keys for existing Teams contexts (already saved in DB)
	const existingTeamsKeys = useMemo(() => {
		const keys = new Set<string>();
		const contexts = existingContextsData?.contexts;
		if (!contexts) {
			return keys;
		}
		for (const ctx of contexts) {
			const meta = ctx.metadata as Record<string, unknown> | null;
			if (!meta || meta.provider !== "MICROSOFT_TEAMS") {
				continue;
			}

			if (meta.chatType === "channel" && meta.teamId && meta.channelId) {
				keys.add(
					`channel:${meta.teamId as string}:${meta.channelId as string}`,
				);
			} else if (meta.chatId) {
				keys.add(`chat:${meta.chatId as string}`);
			}
		}
		return keys;
	}, [existingContextsData]);

	// Sync selections when dialog opens or closes.
	// On open: restore pending (unsaved) selections if available, else fall back to DB state.
	//   existingTeamsKeys is kept in deps so the pre-selection updates when the query loads.
	// On close (true open→closed transition only): persist current selections so they survive
	//   a close/reopen within the session. We guard with prevOpenRef to avoid writing an empty
	//   Set on initial mount or when existingTeamsKeys updates while the dialog is already closed.
	//   selectedKeys is intentionally omitted from deps — the effect callback is recreated
	//   on every render, so it captures the current value when open changes to false.
	useEffect(() => {
		if (open) {
			setSelectedKeys(
				pendingSelectionsRef.current ?? new Set(existingTeamsKeys),
			);
		} else if (prevOpenRef.current && !closingAfterSaveRef.current) {
			// Only persist on a real open→closed transition (not initial mount / query updates).
			pendingSelectionsRef.current = new Set(selectedKeys);
		}
		closingAfterSaveRef.current = false;
		prevOpenRef.current = open;
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open, existingTeamsKeys]);

	// Fetch available Teams chats and channels with infinite scroll
	const teamsQuery = useInfiniteQuery({
		queryKey: ["available-teams-chats", projectId, organizationId],
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

	// Flatten chats from all pages; channels come from the first page only
	const chats = useMemo(
		() => teamsQuery.data?.pages.flatMap((p) => p.chats) ?? [],
		[teamsQuery.data],
	);
	const channels = useMemo(
		() => teamsQuery.data?.pages[0]?.channels ?? [],
		[teamsQuery.data],
	);
	const isConnected = teamsQuery.data?.pages[0]?.isConnected ?? true;
	const fetchError = teamsQuery.data?.pages[0]?.error;
	const isLoading = teamsQuery.isLoading;

	// Infinite scroll observer for group chats tab
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
	}, [handleObserver, activeTab]);

	// Group channels by team
	const channelsByTeam = useMemo(() => {
		const grouped = new Map<
			string,
			{
				teamId: string;
				teamName: string;
				channels: typeof channels;
			}
		>();
		for (const ch of channels) {
			const existing = grouped.get(ch.teamId);
			if (existing) {
				existing.channels.push(ch);
			} else {
				grouped.set(ch.teamId, {
					teamId: ch.teamId,
					teamName: ch.teamName,
					channels: [ch],
				});
			}
		}
		return grouped;
	}, [channels]);

	const toggleSelection = (key: string) => {
		// Don't allow deselecting existing (already saved) items
		if (existingTeamsKeys.has(key)) {
			toast.info(
				"This item is already added. Remove it from the context list to deselect.",
			);
			return;
		}
		setSelectedKeys((prev) => {
			const next = new Set(prev);
			if (next.has(key)) {
				next.delete(key);
			} else if (next.size < MAX_SELECTIONS) {
				next.add(key);
			} else {
				toast.error(`Maximum of ${MAX_SELECTIONS} items allowed`);
			}
			return next;
		});
	};

	const toggleTeamExpanded = (teamId: string) => {
		setExpandedTeams((prev) => {
			const next = new Set(prev);
			if (next.has(teamId)) {
				next.delete(teamId);
			} else {
				next.add(teamId);
			}
			return next;
		});
	};

	// Count selections per tab
	const chatSelectionCount = Array.from(selectedKeys).filter((k) =>
		k.startsWith("chat:"),
	).length;
	const channelSelectionCount = Array.from(selectedKeys).filter((k) =>
		k.startsWith("channel:"),
	).length;

	const hasSelectedDirectChat = useMemo(() => {
		return chats.some(
			(chat) =>
				selectedKeys.has(`chat:${chat.id}`) && chat.type === "oneOnOne",
		);
	}, [chats, selectedKeys]);

	// Count only new selections (not already saved)
	const newSelectionCount = useMemo(() => {
		return Array.from(selectedKeys).filter((k) => !existingTeamsKeys.has(k))
			.length;
	}, [selectedKeys, existingTeamsKeys]);

	const handleSave = async () => {
		// Only save new selections (skip already existing ones)
		const newKeys = Array.from(selectedKeys).filter(
			(k) => !existingTeamsKeys.has(k),
		);

		if (newKeys.length === 0) {
			toast.info("No new items to add");
			onOpenChange(false);
			return;
		}

		setIsSaving(true);
		let successCount = 0;
		const errors: string[] = [];

		for (const key of newKeys) {
			try {
				if (key.startsWith("chat:")) {
					const chatId = key.replace("chat:", "");
					const chat = chats.find((c) => c.id === chatId);
					if (!chat) {
						continue;
					}

					await orpcClient.projects.contexts.create({
						projectId,
						organizationId,
						type: "INTEGRATION",
						content: "",
						metadata: {
							provider: "MICROSOFT_TEAMS",
							chatId: chat.id,
							chatType: chat.type,
							chatTopic: chat.topic,
							title: chat.topic,
						},
					});
					successCount++;
				} else if (key.startsWith("channel:")) {
					// key format: channel:{teamId}:{channelId}
					const parts = key.split(":");
					const teamId = parts[1];
					const channelId = parts.slice(2).join(":");
					const channel = channels.find(
						(c) => c.teamId === teamId && c.id === channelId,
					);
					if (!channel) {
						continue;
					}

					const displayName = `${channel.teamName} - ${channel.name}`;
					await orpcClient.projects.contexts.create({
						projectId,
						organizationId,
						type: "INTEGRATION",
						content: "",
						metadata: {
							provider: "MICROSOFT_TEAMS",
							chatType: "channel",
							teamId: channel.teamId,
							channelId: channel.id,
							channelName: channel.name,
							teamName: channel.teamName,
							chatTopic: displayName,
							title: displayName,
						},
					});
					successCount++;
				}
			} catch (error) {
				const message =
					error instanceof Error ? error.message : "Unknown error";
				errors.push(message);
			}
		}

		setIsSaving(false);

		if (successCount > 0) {
			toast.success(
				`Added ${successCount} Teams source${successCount > 1 ? "s" : ""} as context`,
			);

			queryClient.invalidateQueries({
				queryKey: orpc.projects.contexts.list.queryKey({
					input: { projectId, organizationId },
				}),
			});

			// Start the monitor workflows for the chat/channel families we
			// just added. Each context create links the row server-side; the
			// monitor still has to be enabled or no messages poll into the
			// project's RAG store. Best-effort: a failed start must not block
			// the dialog close.
			const addedChats = newKeys.filter((k) =>
				k.startsWith("chat:"),
			).length;
			const addedChannels = newKeys.filter((k) =>
				k.startsWith("channel:"),
			).length;
			if (addedChats > 0) {
				try {
					await orpcClient.projects.teamsChatMonitor.enable({
						projectId,
						organizationId,
					});
				} catch (err) {
					console.error("[Teams] enable chat monitor failed", err);
				}
			}
			if (addedChannels > 0) {
				try {
					await orpcClient.projects.teamsChannelMonitor.enable({
						projectId,
						organizationId,
					});
				} catch (err) {
					console.error("[Teams] enable channel monitor failed", err);
				}
			}

			closingAfterSaveRef.current = true;
			pendingSelectionsRef.current = null;
			setSelectedKeys(new Set());
			onOpenChange(false);
			onSuccess?.();
		}

		if (errors.length > 0) {
			toast.error(
				`Failed to add ${errors.length} item${errors.length > 1 ? "s" : ""}`,
			);
		}
	};

	const hasContent = chats.length > 0 || channels.length > 0;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-lg">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<MicrosoftTeamsIcon className="size-5 text-violet-500" />
						Add Microsoft Teams Context
					</DialogTitle>
					<DialogDescription>
						Select group chats or team channels to include as
						context for document generation.
					</DialogDescription>
				</DialogHeader>

				{/* Loading state — only for initial load */}
				{isLoading && (
					<div className="flex flex-col items-center gap-3 py-10 text-center">
						<LoaderIcon className="size-6 animate-spin text-violet-500" />
						<p className="font-medium text-sm text-foreground/70">
							Loading your Teams chats...
						</p>
					</div>
				)}

				{/* Error state */}
				{teamsQuery.error && (
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

				{/* Not connected state */}
				{!isLoading && !isConnected && (
					<div className="flex flex-col items-center gap-4 py-8 text-center">
						<div className="rounded-full bg-amber-500/10 p-4">
							<AlertCircleIcon className="size-8 text-highlight" />
						</div>
						<div>
							<p className="font-medium text-foreground/70">
								Microsoft Account Not Connected
							</p>
							<p className="mt-1 text-foreground/50 text-sm">
								{fetchError ||
									"Connect your Microsoft account to access Teams chats."}
							</p>
						</div>
						<Button asChild variant="outline">
							<a href={integrationsPath} className="gap-2">
								<ExternalLinkIcon className="size-4" />
								Go to Integrations
							</a>
						</Button>
					</div>
				)}

				{/* Empty state */}
				{!isLoading && isConnected && !hasContent && (
					<div className="flex flex-col items-center gap-3 py-8 text-center">
						<MicrosoftTeamsIcon className="size-8 text-foreground/30" />
						<p className="text-foreground/70">
							No group chats or channels found
						</p>
						<p className="text-foreground/50 text-sm">
							You need to be a member of group chats or teams in
							Microsoft Teams.
						</p>
					</div>
				)}

				{/* Tabbed content */}
				{!isLoading && isConnected && hasContent && (
					<>
						{/* Tab switcher */}
						<div className="flex gap-1 rounded-lg border bg-muted/50 p-1">
							<button
								type="button"
								onClick={() => setActiveTab("chats")}
								className={cn(
									"flex flex-1 items-center justify-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
									activeTab === "chats"
										? "bg-background text-foreground shadow-sm"
										: "text-foreground/60 hover:text-foreground/80",
								)}
							>
								<MessageSquareIcon className="size-3.5" />
								Chats
								{chats.length > 0 && (
									<span className="rounded-full bg-foreground/10 px-1.5 py-0.5 text-xs">
										{chats.length}
									</span>
								)}
								{chatSelectionCount > 0 && (
									<span className="rounded-full bg-violet-500/20 px-1.5 py-0.5 text-violet-600 text-xs dark:text-violet-400">
										{chatSelectionCount}
									</span>
								)}
							</button>
							<button
								type="button"
								onClick={() => setActiveTab("channels")}
								className={cn(
									"flex flex-1 items-center justify-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
									activeTab === "channels"
										? "bg-background text-foreground shadow-sm"
										: "text-foreground/60 hover:text-foreground/80",
								)}
							>
								<HashIcon className="size-3.5" />
								Team Channels
								{channels.length > 0 && (
									<span className="rounded-full bg-foreground/10 px-1.5 py-0.5 text-xs">
										{channels.length}
									</span>
								)}
								{channelSelectionCount > 0 && (
									<span className="rounded-full bg-violet-500/20 px-1.5 py-0.5 text-violet-600 text-xs dark:text-violet-400">
										{channelSelectionCount}
									</span>
								)}
							</button>
						</div>

						{hasSelectedDirectChat && (
							<div className="mb-2 flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-amber-900 dark:text-amber-200">
								<AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
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

						{/* Group & 1:1 Chats tab */}
						{activeTab === "chats" && (
							<div className="max-h-[350px] space-y-2 overflow-y-auto py-1">
								{chats.length === 0 ? (
									<div className="flex flex-col items-center gap-2 py-6 text-center">
										<MicrosoftTeamsIcon className="size-6 text-foreground/30" />
										<p className="text-foreground/50 text-sm">
											No chats found
										</p>
									</div>
								) : (
									chats.map((chat) => {
										const key = `chat:${chat.id}`;
										const isSelected =
											selectedKeys.has(key);
										const isExisting =
											existingTeamsKeys.has(key);
										const isDirectChat =
											chat.type === "oneOnOne";

										return (
											// biome-ignore lint/a11y/noLabelWithoutControl: wraps a Radix Checkbox which renders a <button>, not a native <input>; semantics are correct for the pattern
											<label
												key={key}
												className={cn(
													"flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors",
													isExisting
														? "border-violet-500/40 bg-violet-500/5 opacity-70"
														: isSelected
															? "border-violet-500 bg-violet-500/5"
															: "border-border hover:border-foreground/20 hover:bg-accent/50",
												)}
											>
												<Checkbox
													checked={isSelected}
													disabled={isExisting}
													onCheckedChange={() =>
														toggleSelection(key)
													}
													className="mt-0.5"
												/>
												<div className="min-w-0 flex-1">
													<div className="flex items-center gap-2">
														<TruncatedText
															as="span"
															text={chat.topic}
															className="font-medium text-sm"
														/>
														{isDirectChat && (
															<span className="shrink-0 rounded-full bg-amber-500/10 px-1.5 py-0.5 text-amber-600 text-xs dark:text-amber-400">
																1:1 Direct
															</span>
														)}
														{isExisting && (
															<span className="shrink-0 rounded-full bg-violet-500/10 px-1.5 py-0.5 text-violet-600 text-xs dark:text-violet-400">
																Added
															</span>
														)}
														{chat.memberCount >
															0 && (
															<span className="flex shrink-0 items-center gap-1 text-foreground/50 text-xs">
																<UsersIcon className="size-3" />
																{
																	chat.memberCount
																}
															</span>
														)}
													</div>
													{chat.lastMessage && (
														<TruncatedText
															as="p"
															text={`${chat.lastMessage.from}: ${chat.lastMessage.preview}`}
															className="mt-1 text-foreground/50 text-xs"
														>
															<span className="font-medium">
																{
																	chat
																		.lastMessage
																		.from
																}
																:
															</span>{" "}
															{
																chat.lastMessage
																	.preview
															}
														</TruncatedText>
													)}
												</div>
											</label>
										);
									})
								)}
								{/* Scroll sentinel for loading more */}
								<div
									ref={loadMoreRef}
									className="flex items-center justify-center py-2"
								>
									{teamsQuery.isFetchingNextPage && (
										<LoaderIcon className="size-4 animate-spin text-foreground/40" />
									)}
								</div>
							</div>
						)}

						{/* Team Channels tab */}
						{activeTab === "channels" && (
							<div className="max-h-[350px] space-y-1 overflow-y-auto py-1">
								{channelsByTeam.size === 0 ? (
									<div className="flex flex-col items-center gap-2 py-6 text-center">
										<HashIcon className="size-6 text-foreground/30" />
										<p className="text-foreground/50 text-sm">
											No team channels found
										</p>
									</div>
								) : (
									Array.from(channelsByTeam.values()).map(
										(team) => {
											const isExpanded =
												expandedTeams.has(team.teamId);

											return (
												<div
													key={team.teamId}
													className="rounded-lg border"
												>
													<button
														type="button"
														onClick={() =>
															toggleTeamExpanded(
																team.teamId,
															)
														}
														className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-accent/50"
													>
														{isExpanded ? (
															<ChevronDownIcon className="size-4 shrink-0 text-foreground/50" />
														) : (
															<ChevronRightIcon className="size-4 shrink-0 text-foreground/50" />
														)}
														<UsersIcon className="size-4 shrink-0 text-foreground/50" />
														<TruncatedText
															as="span"
															text={team.teamName}
															className="font-medium text-sm"
														/>
														<span className="ml-auto shrink-0 text-foreground/40 text-xs">
															{
																team.channels
																	.length
															}{" "}
															channel
															{team.channels
																.length !== 1
																? "s"
																: ""}
														</span>
													</button>
													{isExpanded && (
														<div className="space-y-1 border-t px-2 py-1.5">
															{team.channels.map(
																(ch) => {
																	const key = `channel:${ch.teamId}:${ch.id}`;
																	const isSelected =
																		selectedKeys.has(
																			key,
																		);
																	const isExisting =
																		existingTeamsKeys.has(
																			key,
																		);

																	return (
																		// biome-ignore lint/a11y/noLabelWithoutControl: wraps a Radix Checkbox which renders a <button>, not a native <input>
																		<label
																			key={
																				key
																			}
																			className={cn(
																				"flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-2 transition-colors",
																				isExisting
																					? "bg-violet-500/10 opacity-70"
																					: isSelected
																						? "bg-violet-500/10"
																						: "hover:bg-accent/50",
																			)}
																		>
																			<Checkbox
																				checked={
																					isSelected
																				}
																				disabled={
																					isExisting
																				}
																				onCheckedChange={() =>
																					toggleSelection(
																						key,
																					)
																				}
																			/>
																			<HashIcon className="size-3.5 shrink-0 text-foreground/40" />
																			<TruncatedText
																				as="span"
																				text={
																					ch.name
																				}
																				className="text-sm"
																			/>
																			{isExisting && (
																				<span className="shrink-0 rounded-full bg-violet-500/10 px-1.5 py-0.5 text-violet-600 text-xs dark:text-violet-400">
																					Added
																				</span>
																			)}
																			{ch.description &&
																				!isExisting && (
																					<TruncatedText
																						as="span"
																						text={
																							ch.description
																						}
																						className="ml-auto text-foreground/40 text-xs"
																					/>
																				)}
																		</label>
																	);
																},
															)}
														</div>
													)}
												</div>
											);
										},
									)
								)}
							</div>
						)}

						{/* Selection count */}
						<div className="flex items-center justify-between text-foreground/50 text-sm">
							<span>
								{selectedKeys.size} of {MAX_SELECTIONS} selected
								{existingTeamsKeys.size > 0 && (
									<span className="text-foreground/40">
										{" "}
										({existingTeamsKeys.size} already added)
									</span>
								)}
							</span>
							{selectedKeys.size >= MAX_SELECTIONS && (
								<span className="flex items-center gap-1 text-highlight">
									<AlertCircleIcon className="size-3" />
									Maximum reached
								</span>
							)}
						</div>
					</>
				)}

				<DialogFooter>
					<Button
						variant="outline"
						onClick={() => {
							// Mark as intentional close so the close-side of the effect
							// does not overwrite the null ref with stale selectedKeys.
							closingAfterSaveRef.current = true;
							pendingSelectionsRef.current = null;
							setSelectedKeys(new Set());
							onOpenChange(false);
						}}
					>
						Cancel
					</Button>
					<Button
						onClick={handleSave}
						disabled={
							newSelectionCount === 0 || isSaving || !isConnected
						}
						className="gap-2 bg-gradient-to-r from-violet-500 to-purple-600 hover:from-violet-500/90 hover:to-purple-600/90"
					>
						{isSaving ? (
							<>
								<LoaderIcon className="size-4 animate-spin" />
								Adding...
							</>
						) : (
							<>
								<CheckCircleIcon className="size-4" />
								{newSelectionCount > 0
									? `Add ${newSelectionCount} ${newSelectionCount === 1 ? "Source" : "Sources"}`
									: "No New Sources"}
							</>
						)}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
