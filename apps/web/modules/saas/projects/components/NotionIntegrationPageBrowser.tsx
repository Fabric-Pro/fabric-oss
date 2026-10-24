"use client";

/**
 * Notion Integration Page Browser Dialog
 *
 * Lets users browse and import Notion pages into project context
 * using an active Notion Integration data connection.
 */

import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@ui/components/badge";
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
import { Input } from "@ui/components/input";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import {
	AlertCircleIcon,
	CheckCircleIcon,
	ExternalLinkIcon,
	FileTextIcon,
	Loader2Icon,
	SearchIcon,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

interface NotionIntegrationPage {
	id: string;
	title: string;
	url: string;
	lastEdited: string;
	icon: string | null;
}

type Props = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	connectionId: string | null;
	projectId: string;
	organizationId: string | null;
	syncedPageIds?: string[];
	onResourcesAdded?: () => void;
	reconnectUrl?: string;
};

function normalizePageId(id: string): string {
	return id.replace(/-/g, "").toLowerCase();
}

export function NotionIntegrationPageBrowser({
	open,
	onOpenChange,
	connectionId,
	projectId,
	organizationId,
	syncedPageIds = [],
	onResourcesAdded,
	reconnectUrl,
}: Props) {
	const [searchQuery, setSearchQuery] = useState("");
	const [debouncedQuery, setDebouncedQuery] = useState("");
	const [extraPages, setExtraPages] = useState<NotionIntegrationPage[]>([]);
	const [extraCursor, setExtraCursor] = useState<string | null | undefined>(
		undefined,
	);
	const queryRef = useRef(debouncedQuery);
	queryRef.current = debouncedQuery;
	const [loadingMore, setLoadingMore] = useState(false);
	const [selectedPages, setSelectedPages] = useState<
		Map<string, NotionIntegrationPage>
	>(new Map());
	const [confirmLoading, setConfirmLoading] = useState(false);

	// Debounce search input
	useEffect(() => {
		const timer = setTimeout(() => {
			setDebouncedQuery(searchQuery);
		}, 300);
		return () => clearTimeout(timer);
	}, [searchQuery]);

	// Reset state when dialog closes
	useEffect(() => {
		if (!open) {
			setSearchQuery("");
			setDebouncedQuery("");
			setSelectedPages(new Map());
			setExtraPages([]);
			setExtraCursor(undefined);
		}
	}, [open]);

	const {
		data: initialData,
		isLoading,
		error: queryError,
	} = useQuery({
		queryKey: [
			"data-connections-notion-pages",
			connectionId,
			organizationId,
			debouncedQuery,
		],
		enabled: open && !!connectionId,
		queryFn: async () => {
			if (!connectionId) {
				return { pages: [], nextCursor: null };
			}
			return await orpcClient.dataConnections.notion.pages({
				id: connectionId,
				organizationId: organizationId ?? undefined,
				query: debouncedQuery || undefined,
			});
		},
	});

	useEffect(() => {
		setExtraPages([]);
		setExtraCursor(undefined);
	}, [debouncedQuery]);

	const pages = useMemo(() => {
		const seen = new Set<string>();
		return [...(initialData?.pages ?? []), ...extraPages].filter((p) => {
			if (seen.has(p.id)) {
				return false;
			}
			seen.add(p.id);
			return true;
		});
	}, [initialData, extraPages]);
	const nextCursor =
		extraCursor !== undefined
			? extraCursor
			: (initialData?.nextCursor ?? null);

	const normalizedSyncedPageIds = useMemo(() => {
		return new Set(syncedPageIds.map(normalizePageId));
	}, [syncedPageIds]);

	const selectablePages = useMemo(() => {
		return pages.filter(
			(p) => !normalizedSyncedPageIds.has(normalizePageId(p.id)),
		);
	}, [pages, normalizedSyncedPageIds]);

	const allSelectableSelected =
		selectablePages.length > 0 &&
		selectablePages.every((p) => selectedPages.has(p.id));

	const toggleSelectAll = () => {
		if (allSelectableSelected) {
			setSelectedPages((prev) => {
				const next = new Map(prev);
				for (const p of selectablePages) {
					next.delete(p.id);
				}
				return next;
			});
		} else {
			setSelectedPages((prev) => {
				const next = new Map(prev);
				for (const p of selectablePages) {
					next.set(p.id, p);
				}
				return next;
			});
		}
	};

	const toggleSelection = (page: NotionIntegrationPage) => {
		setSelectedPages((prev) => {
			const next = new Map(prev);
			if (next.has(page.id)) {
				next.delete(page.id);
			} else {
				next.set(page.id, page);
			}
			return next;
		});
	};

	const handleLoadMore = useCallback(async () => {
		if (!connectionId || !nextCursor || loadingMore) {
			return;
		}

		setLoadingMore(true);
		const requestQuery = debouncedQuery;
		try {
			const res = await orpcClient.dataConnections.notion.pages({
				id: connectionId,
				organizationId: organizationId ?? undefined,
				query: debouncedQuery || undefined,
				cursor: nextCursor,
			});

			if (queryRef.current !== requestQuery) {
				return;
			}
			setExtraPages((prev) => [...prev, ...res.pages]);
			setExtraCursor(res.nextCursor);
		} catch (err) {
			toast.error("Failed to load more pages", {
				description:
					err instanceof Error ? err.message : "Unknown error",
			});
		} finally {
			setLoadingMore(false);
		}
	}, [connectionId, nextCursor, loadingMore, debouncedQuery, organizationId]);

	// Confirm handler: fetch text for each page and save to project contexts
	const handleConfirm = useCallback(async () => {
		if (!connectionId || selectedPages.size === 0) {
			return;
		}

		setConfirmLoading(true);
		let addedCount = 0;
		let failedCount = 0;
		let isUnauthorizedError = false;
		const pagesToAdd = Array.from(selectedPages.values());

		try {
			for (const page of pagesToAdd) {
				try {
					const { content } =
						await orpcClient.dataConnections.notion.pageContent({
							id: connectionId,
							pageId: page.id,
							organizationId: organizationId ?? undefined,
						});

					await orpcClient.projects.contexts.create({
						projectId,
						organizationId: organizationId ?? undefined,
						type: "INTEGRATION",
						content,
						metadata: {
							notionPageId: page.id,
							notionType: "page",
							provider: "notion",
							dataConnectionId: connectionId,
							sourceTitle: page.title,
							sourceUrl: page.url || null,
						},
					});

					addedCount++;
					setSelectedPages((prev) => {
						const next = new Map(prev);
						next.delete(page.id);
						return next;
					});
				} catch (err) {
					failedCount++;
					if ((err as any)?.code === "UNAUTHORIZED") {
						isUnauthorizedError = true;
					}
					console.error(
						`[NotionIntegrationPageBrowser] Failed to add page ${page.id}:`,
						err,
					);
				}
			}

			if (addedCount > 0) {
				onResourcesAdded?.();
			}

			if (addedCount > 0 && failedCount === 0) {
				toast.success(
					`Added ${addedCount} page${addedCount === 1 ? "" : "s"} to project`,
				);
				onOpenChange(false);
			} else if (isUnauthorizedError) {
				toast.error("Notion connection expired. Reconnect Notion.");
			} else if (addedCount > 0 && failedCount > 0) {
				toast.warning(
					`Added ${addedCount} page${addedCount === 1 ? "" : "s"}, ${failedCount} failed`,
				);
			} else if (failedCount > 0) {
				toast.error("Failed to add pages");
			}
		} finally {
			setConfirmLoading(false);
		}
	}, [
		connectionId,
		selectedPages,
		projectId,
		organizationId,
		onResourcesAdded,
		onOpenChange,
	]);

	const isUnauthorized = (queryError as any)?.code === "UNAUTHORIZED";

	const handleOpenChange = useCallback(
		(nextOpen: boolean) => {
			if (confirmLoading && !nextOpen) {
				return;
			}
			onOpenChange(nextOpen);
		},
		[confirmLoading, onOpenChange],
	);

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogContent className="max-w-2xl max-h-[85vh] flex flex-col p-6">
				<DialogHeader className="flex-shrink-0">
					<DialogTitle>Browse Notion Pages</DialogTitle>
					<DialogDescription>
						Select Notion pages from your connected workspace to add
						as project context.
					</DialogDescription>
				</DialogHeader>

				<div className="flex items-center gap-3 pt-2 pb-3">
					<div className="relative flex-1">
						<SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
						<Input
							placeholder="Search pages..."
							value={searchQuery}
							onChange={(e) => setSearchQuery(e.target.value)}
							className="pl-9"
						/>
					</div>
					{selectablePages.length > 0 && (
						<Button
							variant="ghost"
							size="sm"
							onClick={toggleSelectAll}
							disabled={confirmLoading}
							className="text-xs"
						>
							{allSelectableSelected
								? "Deselect All"
								: "Select All"}
						</Button>
					)}
				</div>

				<div className="flex-1 overflow-y-auto min-h-[300px] border border-border rounded-lg p-2">
					{isLoading ? (
						<div className="flex items-center justify-center h-full min-h-[260px] text-muted-foreground">
							<Loader2Icon className="size-6 motion-safe:animate-spin" />
						</div>
					) : isUnauthorized ? (
						<div className="flex flex-col items-center justify-center h-full min-h-[260px] text-center p-6 gap-2">
							<AlertCircleIcon className="size-8 text-destructive" />
							<p className="font-medium text-foreground">
								Notion connection expired
							</p>
							<p className="text-sm text-muted-foreground max-w-sm">
								Your Notion authorization token has expired.
								Please reconnect Notion to continue.
							</p>
							{reconnectUrl && (
								<Button
									asChild
									size="sm"
									variant="outline"
									className="mt-2"
								>
									<Link href={reconnectUrl}>
										Reconnect Notion
									</Link>
								</Button>
							)}
						</div>
					) : queryError ? (
						<div className="flex flex-col items-center justify-center h-full min-h-[260px] text-center p-6 gap-2">
							<AlertCircleIcon className="size-8 text-destructive" />
							<p className="font-medium text-foreground">
								Failed to load Notion pages
							</p>
							<p className="text-sm text-muted-foreground max-w-sm">
								{(queryError as Error).message ||
									"An error occurred while fetching pages from Notion."}
							</p>
						</div>
					) : pages.length === 0 ? (
						<div className="flex flex-col items-center justify-center h-full min-h-[260px] text-center p-6 gap-2 text-muted-foreground">
							{debouncedQuery ? (
								<>
									<SearchIcon className="size-8 opacity-50" />
									<p className="font-medium">
										No pages found
									</p>
									<p className="text-xs">
										No pages matched &quot;{debouncedQuery}
										&quot;.
									</p>
								</>
							) : (
								<>
									<FileTextIcon className="size-8 opacity-50" />
									<p className="font-medium text-foreground">
										No pages shared with Fabric
									</p>
									<p className="text-xs max-w-sm">
										Make sure pages are shared with your
										Notion integration. Reconnect Notion to
										share more pages.
									</p>
									{reconnectUrl && (
										<Button
											asChild
											size="sm"
											variant="outline"
											className="mt-2"
										>
											<Link href={reconnectUrl}>
												Reconnect Notion
											</Link>
										</Button>
									)}
								</>
							)}
						</div>
					) : (
						<div className="space-y-1">
							{pages.map((page) => {
								const isSynced = normalizedSyncedPageIds.has(
									normalizePageId(page.id),
								);
								const isSelected = selectedPages.has(page.id);

								return (
									<div
										key={page.id}
										className={cn(
											"flex items-center gap-3 p-3 rounded-lg transition-colors",
											isSynced
												? "opacity-60 bg-muted/30"
												: isSelected
													? "bg-primary/10"
													: "hover:bg-muted/50",
										)}
									>
										{isSynced ? (
											<CheckCircleIcon className="size-4 text-success shrink-0" />
										) : (
											<Checkbox
												aria-label={`Select ${page.title}`}
												checked={isSelected}
												disabled={confirmLoading}
												onCheckedChange={() =>
													toggleSelection(page)
												}
											/>
										)}

										<button
											type="button"
											className={cn(
												"flex-1 min-w-0 flex items-center gap-3 text-left focus-visible:outline-none",
												confirmLoading &&
													"cursor-not-allowed",
											)}
											disabled={confirmLoading}
											onClick={() => {
												if (!isSynced) {
													toggleSelection(page);
												}
											}}
										>
											<div className="shrink-0 text-base">
												{page.icon || (
													<FileTextIcon className="size-4 text-muted-foreground" />
												)}
											</div>

											<div className="flex-1 min-w-0">
												<div className="flex items-center gap-2">
													<span
														className="font-medium text-sm truncate"
														title={page.title}
													>
														{page.title}
													</span>
													{isSynced && (
														<Badge
															variant="secondary"
															className="text-xs shrink-0"
														>
															Synced
														</Badge>
													)}
												</div>
												{page.lastEdited && (
													<span className="text-xs text-muted-foreground">
														Edited{" "}
														{new Date(
															page.lastEdited,
														).toLocaleDateString(
															undefined,
															{
																year: "numeric",
																month: "short",
																day: "numeric",
															},
														)}
													</span>
												)}
											</div>
										</button>

										{page.url && (
											<Tooltip>
												<TooltipTrigger asChild>
													<a
														href={page.url}
														target="_blank"
														rel="noopener noreferrer"
														onClick={(e) =>
															e.stopPropagation()
														}
														className="text-muted-foreground hover:text-foreground p-1"
													>
														<ExternalLinkIcon className="size-4" />
													</a>
												</TooltipTrigger>
												<TooltipContent side="left">
													Open in Notion
												</TooltipContent>
											</Tooltip>
										)}
									</div>
								);
							})}

							{nextCursor && (
								<div className="pt-2 pb-1 text-center">
									<Button
										variant="outline"
										size="sm"
										onClick={handleLoadMore}
										disabled={loadingMore}
										className="w-full"
									>
										{loadingMore ? (
											<>
												<Loader2Icon className="size-4 motion-safe:animate-spin mr-2" />
												Loading more...
											</>
										) : (
											"Load more"
										)}
									</Button>
								</div>
							)}
						</div>
					)}
				</div>

				<DialogFooter className="flex-shrink-0 pt-4 border-t border-border flex justify-between items-center sm:justify-between">
					<div className="text-xs text-muted-foreground">
						{selectedPages.size > 0 && (
							<span>
								{selectedPages.size} page
								{selectedPages.size === 1 ? "" : "s"} selected
							</span>
						)}
					</div>
					<div className="flex items-center gap-2">
						<Button
							variant="outline"
							onClick={() => handleOpenChange(false)}
							disabled={confirmLoading}
						>
							Cancel
						</Button>
						<Button
							onClick={handleConfirm}
							disabled={
								selectedPages.size === 0 || confirmLoading
							}
						>
							{confirmLoading ? (
								<>
									<Loader2Icon className="size-4 motion-safe:animate-spin mr-2" />
									Adding...
								</>
							) : (
								`Add ${selectedPages.size} Page${selectedPages.size === 1 ? "" : "s"}`
							)}
						</Button>
					</div>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
