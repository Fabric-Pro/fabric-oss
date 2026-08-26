"use client";

/**
 * SlackChannelSelectorDialog
 *
 * Dialog for selecting Slack workspace channels to link as project integration
 * contexts. These become searchable context during document generation.
 *
 * Features:
 * - Checks if Slack workspace OAuth is connected
 * - Fetches available channels via API
 * - Infinite scroll for channels (paginated via cursor)
 * - Search filtering on channel name
 * - Multi-select up to 10 channels
 * - Pre-selects already-added Slack contexts
 * - Saves selected items as INTEGRATION type ProjectContexts
 */

import {
	useContextPath,
	useOrganizationContext,
} from "@saas/organizations/hooks/use-organization-context";
import { useSettingsReturnUrl } from "@saas/settings/hooks/use-settings-return-url";
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
	CheckCircleIcon,
	ExternalLinkIcon,
	HashIcon,
	LoaderIcon,
	LockIcon,
	SearchIcon,
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

function SlackIcon({ className }: { className?: string }) {
	return (
		<svg
			className={className}
			viewBox="0 0 24 24"
			fill="currentColor"
			xmlns="http://www.w3.org/2000/svg"
			aria-hidden="true"
		>
			<path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zm1.271 0a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zm0 1.271a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zm10.122 2.521a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zm-1.268 0a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zm-2.523 10.122a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zm0-1.268a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z" />
		</svg>
	);
}

export function SlackChannelSelectorDialog({
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
	const [searchQuery, setSearchQuery] = useState("");
	const loadMoreRef = useRef<HTMLDivElement>(null);
	// Persists unsaved selections across dialog close/reopen within the same page session.
	// Set to null after a successful save so pre-selection resets to DB state on next open.
	const pendingSelectionsRef = useRef<Set<string> | null>(null);
	// True while the dialog is closing due to a successful save (not a user dismiss).
	// Prevents the close-side of the open/close effect from overwriting the nulled ref.
	const closingAfterSaveRef = useRef(false);
	// Tracks the previous value of `open` so we can detect a true open->closed transition.
	const prevOpenRef = useRef(false);

	// Fetch existing project contexts to pre-select already-added Slack channels
	const { data: existingContextsData } = useQuery({
		...orpc.projects.contexts.list.queryOptions({
			input: { projectId, organizationId, type: "INTEGRATION" },
		}),
		enabled: open,
	});

	// Compute keys for existing Slack contexts (already saved in DB)
	const existingSlackKeys = useMemo(() => {
		const keys = new Set<string>();
		const contexts = existingContextsData?.contexts;
		if (!contexts) {
			return keys;
		}
		for (const ctx of contexts) {
			const meta = ctx.metadata as Record<string, unknown> | null;
			if (!meta || meta.provider !== "SLACK") {
				continue;
			}
			if (meta.channelId) {
				keys.add(meta.channelId as string);
			}
		}
		return keys;
	}, [existingContextsData]);

	// Sync selections on open/close transitions only.
	// On open: restore pending (unsaved) selections if available, else fall back to DB state.
	// On close (true open->closed transition only): persist current selections so they survive
	//   a close/reopen within the session.
	// Guard: only run initialization when `open` actually changes, not when
	// existingSlackKeys updates mid-interaction (which would wipe user selections).
	useEffect(() => {
		const wasOpen = prevOpenRef.current;
		prevOpenRef.current = open;

		if (open && !wasOpen) {
			// Dialog just opened — initialize selections
			setSelectedKeys(
				pendingSelectionsRef.current ?? new Set(existingSlackKeys),
			);
			setSearchQuery("");
		} else if (!open && wasOpen && !closingAfterSaveRef.current) {
			// Dialog just closed by user (not by save) — persist selections
			pendingSelectionsRef.current = new Set(selectedKeys);
		}
		closingAfterSaveRef.current = false;
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);

	// Fetch available Slack channels with infinite scroll
	const slackQuery = useInfiniteQuery({
		queryKey: ["available-slack-channels", projectId, organizationId],
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

	// Flatten channels from all pages
	const channels = useMemo(
		() => slackQuery.data?.pages.flatMap((p) => p.channels) ?? [],
		[slackQuery.data],
	);
	const isConnected = slackQuery.data?.pages[0]?.isConnected ?? true;
	const botName = slackQuery.data?.pages[0]?.botName;
	const fetchError = slackQuery.data?.pages[0]?.error;
	const isLoading = slackQuery.isLoading;

	// Filter channels by search query
	const filteredChannels = useMemo(() => {
		if (!searchQuery.trim()) {
			return channels;
		}
		const query = searchQuery.toLowerCase();
		return channels.filter(
			(ch) =>
				ch.name.toLowerCase().includes(query) ||
				ch.topic.toLowerCase().includes(query) ||
				ch.purpose.toLowerCase().includes(query),
		);
	}, [channels, searchQuery]);

	// Infinite scroll observer
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

	const toggleSelection = (channelId: string) => {
		// Don't allow deselecting existing (already saved) items
		if (existingSlackKeys.has(channelId)) {
			toast.info(
				"This channel is already added. Remove it from the context list to deselect.",
			);
			return;
		}
		setSelectedKeys((prev) => {
			const next = new Set(prev);
			if (next.has(channelId)) {
				next.delete(channelId);
			} else if (next.size < MAX_SELECTIONS) {
				next.add(channelId);
			} else {
				toast.error(`Maximum of ${MAX_SELECTIONS} channels allowed`);
			}
			return next;
		});
	};

	// Count only new selections (not already saved)
	const newSelectionCount = useMemo(() => {
		return Array.from(selectedKeys).filter((k) => !existingSlackKeys.has(k))
			.length;
	}, [selectedKeys, existingSlackKeys]);

	const handleSave = async () => {
		// Only save new selections (skip already existing ones)
		const newKeys = Array.from(selectedKeys).filter(
			(k) => !existingSlackKeys.has(k),
		);

		if (newKeys.length === 0) {
			toast.info("No new channels to add");
			onOpenChange(false);
			return;
		}

		setIsSaving(true);
		let successCount = 0;
		const errors: string[] = [];
		// Channels whose context row was created — these still need to be linked
		// to the channel monitor and the monitor enabled (the create procedure
		// can't link Slack: it lacks the Slack workspace id).
		const linkedChannels: { id: string; name: string }[] = [];

		for (const channelId of newKeys) {
			try {
				const channel = channels.find((c) => c.id === channelId);
				if (!channel) {
					continue;
				}

				await orpcClient.projects.contexts.create({
					projectId,
					organizationId,
					type: "INTEGRATION",
					content: "",
					metadata: {
						provider: "SLACK",
						channelId: channel.id,
						channelName: channel.name,
						title: channel.name,
					},
				});
				successCount++;
				linkedChannels.push({ id: channel.id, name: channel.name });
			} catch (error) {
				const message =
					error instanceof Error ? error.message : "Unknown error";
				errors.push(message);
			}
		}

		setIsSaving(false);

		if (successCount > 0) {
			toast.success(
				`Added ${successCount} Slack channel${successCount > 1 ? "s" : ""} as context`,
			);

			// Link each created channel to the project's Slack channel monitor and
			// enable it, so messages actually flow into the project's RAG store.
			// contexts.create only writes a metadata-only PENDING row — it can't
			// link Slack because it has no Slack workspace id. linkChannel resolves
			// the workspace id server-side, creates the ProjectLinkedSlackChannel
			// row, and flips the PENDING context to COMPLETED; enable then starts
			// the monitor workflow. Without this the channel sits "Pending" forever.
			// Best-effort: the context row already exists, so surface failures via a
			// toast rather than blocking the dialog from closing.
			try {
				for (const channel of linkedChannels) {
					await orpcClient.projects.slackChannelMonitor.linkChannel({
						projectId,
						organizationId,
						channelId: channel.id,
						channelName: channel.name,
						backfillMode: "latest-7-days",
					});
				}
				await orpcClient.projects.slackChannelMonitor.enable({
					projectId,
					organizationId,
				});
			} catch (err) {
				console.error(
					"[SlackChannelSelectorDialog] failed to link/enable Slack channel monitor",
					err,
				);
				toast.error(
					"Channels were added but monitoring could not be enabled. Open the project's Slack settings to retry.",
				);
			}

			queryClient.invalidateQueries({
				queryKey: orpc.projects.contexts.list.queryKey({
					input: { projectId, organizationId },
				}),
			});

			closingAfterSaveRef.current = true;
			pendingSelectionsRef.current = null;
			setSelectedKeys(new Set());
			onOpenChange(false);
			onSuccess?.();
		}

		if (errors.length > 0) {
			toast.error(
				`Failed to add ${errors.length} channel${errors.length > 1 ? "s" : ""}`,
			);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-lg">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<SlackIcon className="size-5 text-[#4A154B]" />
						Add Slack Channels
					</DialogTitle>
					<DialogDescription>
						Select Slack channels to include as context for document
						generation.
					</DialogDescription>
				</DialogHeader>

				{/* Loading state -- only for initial load */}
				{isLoading && (
					<div className="flex flex-col items-center gap-3 py-10 text-center">
						<LoaderIcon className="size-6 animate-spin text-[#4A154B]" />
						<p className="font-medium text-sm text-foreground/70">
							Loading your Slack channels...
						</p>
					</div>
				)}

				{/* Error state */}
				{slackQuery.error && (
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

				{/* Not connected state */}
				{!isLoading && !isConnected && (
					<div className="flex flex-col items-center gap-4 py-8 text-center">
						<div className="rounded-full bg-amber-500/10 p-4">
							<AlertCircleIcon className="size-8 text-highlight" />
						</div>
						<div>
							<p className="font-medium text-foreground/70">
								Slack Workspace Not Connected
							</p>
							<p className="mt-1 text-foreground/50 text-sm">
								{fetchError ||
									"Connect your Slack workspace to access channels."}
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
				{!isLoading &&
					isConnected &&
					channels.length === 0 &&
					!slackQuery.error && (
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

				{/* Channel list */}
				{!isLoading && isConnected && channels.length > 0 && (
					<>
						{/* Search input */}
						<div className="relative">
							<SearchIcon className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-foreground/40" />
							<input
								type="search"
								autoComplete="off"
								placeholder="Search channels..."
								value={searchQuery}
								onChange={(e) => setSearchQuery(e.target.value)}
								aria-label="Search Slack channels"
								className="w-full rounded-lg border bg-background py-2 pl-9 pr-3 text-sm placeholder:text-foreground/40 focus:outline-none focus:ring-1 focus:ring-ring"
							/>
						</div>

						{/* Channel list */}
						<div className="max-h-[350px] space-y-2 overflow-y-auto py-1">
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
										const isSelected = selectedKeys.has(
											channel.id,
										);
										const isExisting =
											existingSlackKeys.has(channel.id);

										return (
											// biome-ignore lint/a11y/noLabelWithoutControl: wraps a Radix Checkbox which renders a <button>, not a native <input>; semantics are correct for the pattern
											<label
												key={channel.id}
												className={cn(
													"flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors",
													isExisting
														? "border-[#4A154B]/40 bg-[#4A154B]/5 opacity-70"
														: isSelected
															? "border-[#4A154B] bg-[#4A154B]/5"
															: "border-border hover:border-foreground/20 hover:bg-accent/50",
												)}
											>
												<Checkbox
													checked={isSelected}
													disabled={isExisting}
													onCheckedChange={() =>
														toggleSelection(
															channel.id,
														)
													}
													className="mt-0.5"
												/>
												<div className="min-w-0 flex-1">
													<div className="flex items-center gap-2">
														{channel.isPrivate ? (
															<LockIcon className="size-3.5 shrink-0 text-foreground/40" />
														) : (
															<HashIcon className="size-3.5 shrink-0 text-foreground/40" />
														)}
														<TruncatedText
															as="span"
															text={channel.name}
															className="font-medium text-sm"
														/>
														{isExisting && (
															<span className="shrink-0 rounded-full bg-[#4A154B]/10 px-1.5 py-0.5 text-[#4A154B] text-xs dark:text-[#a855f7]">
																Added
															</span>
														)}
														{channel.memberCount >
															0 && (
															<span className="flex shrink-0 items-center gap-1 text-foreground/50 text-xs">
																<UsersIcon className="size-3" />
																{
																	channel.memberCount
																}
															</span>
														)}
													</div>
													{(channel.purpose ||
														channel.topic) && (
														<TruncatedText
															as="p"
															text={
																channel.purpose ||
																channel.topic ||
																""
															}
															className="mt-1 text-foreground/50 text-xs"
														/>
													)}
													{channel.isBotMember ===
														false && (
														<p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
															{`Bot not in this channel — type /invite @${botName || "your_app"} in Slack to enable message fetching`}
														</p>
													)}
												</div>
											</label>
										);
									})}
									{/* Scroll sentinel for loading more */}
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

						{/* Selection count */}
						<div className="flex items-center justify-between text-foreground/50 text-sm">
							<span>
								{selectedKeys.size} of {MAX_SELECTIONS} selected
								{existingSlackKeys.size > 0 && (
									<span className="text-foreground/40">
										{" "}
										({existingSlackKeys.size} already added)
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
						className="gap-2 bg-gradient-to-r from-[#4A154B] to-[#611f69] hover:from-[#4A154B]/90 hover:to-[#611f69]/90"
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
									? `Add ${newSelectionCount} ${newSelectionCount === 1 ? "Channel" : "Channels"}`
									: "No New Channels"}
							</>
						)}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
