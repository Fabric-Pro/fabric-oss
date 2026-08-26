/**
 * ResourceManagementPanel
 *
 * Lets users view and manage synced resources for any connector.
 * Notion gets an extra "Browse" tab to discover and queue unsynced pages.
 * All other providers show a flat list with exclude/re-include toggles.
 */

"use client";

import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { Input } from "@ui/components/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ui/components/tabs";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import {
	ExternalLink,
	Eye,
	EyeOff,
	FileText,
	Loader2,
	RefreshCw,
	Search,
} from "lucide-react";
import { useState } from "react";
import {
	useExcludeResource,
	useIncludeResource,
	useNotionPages,
	useResourceContent,
	useResources,
} from "../hooks/useResources";
import { useStartSync } from "../hooks/useSyncProgress";
import type { DataConnectionProvider } from "../lib/providers";

const BROWSABLE_PROVIDERS: DataConnectionProvider[] = ["NOTION"];

const SYNC_DISABLED_TOOLTIP =
	"Background sync is being retired and is disabled for new operations.";

interface ResourceManagementPanelProps {
	connectionId: string;
	provider: DataConnectionProvider;
	isSyncing: boolean;
	/**
	 * When true, every per-resource mutation (exclude/include toggle, queue
	 * sync) is rendered with `aria-disabled` and the deprecated-sync tooltip.
	 * Read-only surfaces (lists, filters, badges, content viewer) stay
	 * interactive.
	 */
	mutationsDisabled?: boolean;
}

export function ResourceManagementPanel({
	connectionId,
	provider,
	isSyncing,
	mutationsDisabled = false,
}: ResourceManagementPanelProps) {
	const isBrowsable = BROWSABLE_PROVIDERS.includes(provider);

	if (isBrowsable) {
		return (
			<Tabs defaultValue="synced">
				<TabsList>
					<TabsTrigger value="synced">Synced Content</TabsTrigger>
					<TabsTrigger value="browse">Browse</TabsTrigger>
				</TabsList>
				<TabsContent value="synced" className="mt-4">
					<SyncedResourcesList
						connectionId={connectionId}
						isSyncing={isSyncing}
						mutationsDisabled={mutationsDisabled}
					/>
				</TabsContent>
				<TabsContent value="browse" className="mt-4">
					<NotionPagesBrowser
						connectionId={connectionId}
						isSyncing={isSyncing}
						mutationsDisabled={mutationsDisabled}
					/>
				</TabsContent>
			</Tabs>
		);
	}

	return (
		<SyncedResourcesList
			connectionId={connectionId}
			isSyncing={isSyncing}
			mutationsDisabled={mutationsDisabled}
		/>
	);
}

function SyncedResourcesList({
	connectionId,
	isSyncing,
	mutationsDisabled,
}: {
	connectionId: string;
	isSyncing: boolean;
	mutationsDisabled: boolean;
}) {
	const { data: resources, isLoading } = useResources(connectionId);
	const exclude = useExcludeResource(connectionId);
	const include = useIncludeResource(connectionId);
	const [search, setSearch] = useState("");
	const [selectedResourceId, setSelectedResourceId] = useState<string | null>(
		null,
	);

	const filtered = (resources ?? []).filter((r) => {
		const q = search.toLowerCase();
		return !q || (r.title ?? r.externalId).toLowerCase().includes(q);
	});

	const active = filtered.filter((r) => r.syncStatus !== "EXCLUDED");
	const excluded = filtered.filter((r) => r.syncStatus === "EXCLUDED");

	if (isLoading) {
		return (
			<p className="py-6 text-sm text-muted-foreground">
				Loading resources...
			</p>
		);
	}

	if (!resources || resources.length === 0) {
		return (
			<p className="py-6 text-sm text-muted-foreground">
				No resources synced yet. Run a sync to index content.
			</p>
		);
	}

	return (
		<>
			<div className="space-y-4">
				<div className="relative max-w-sm">
					<Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
					<Input
						type="search"
						value={search}
						onChange={(e) => setSearch(e.target.value)}
						placeholder="Filter resources"
						className="pl-9"
					/>
				</div>

				{active.length > 0 && (
					<div className="space-y-1">
						<p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
							Active ({active.length})
						</p>
						{active.map((r) => (
							<ResourceRow
								key={r.id}
								title={r.title ?? r.externalId}
								isExcluded={false}
								isPending={isSyncing}
								mutationsDisabled={mutationsDisabled}
								onToggle={() => exclude.mutate(r.externalId)}
								onView={() => setSelectedResourceId(r.id)}
							/>
						))}
					</div>
				)}

				{excluded.length > 0 && (
					<div className="space-y-1">
						<p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
							Excluded ({excluded.length})
						</p>
						{excluded.map((r) => (
							<ResourceRow
								key={r.id}
								title={r.title ?? r.externalId}
								isExcluded={true}
								isPending={isSyncing}
								mutationsDisabled={mutationsDisabled}
								onToggle={() => include.mutate(r.externalId)}
								onView={() => setSelectedResourceId(r.id)}
							/>
						))}
					</div>
				)}
			</div>

			<ResourceContentDialog
				connectionId={connectionId}
				resourceId={selectedResourceId}
				onClose={() => setSelectedResourceId(null)}
			/>
		</>
	);
}

function ResourceRow({
	title,
	isExcluded,
	isPending,
	mutationsDisabled,
	onToggle,
	onView,
}: {
	title: string;
	isExcluded: boolean;
	isPending: boolean;
	mutationsDisabled: boolean;
	onToggle: () => void;
	onView: () => void;
}) {
	const toggleLabel = isExcluded ? "Re-include resource" : "Exclude resource";
	const disabledToggleLabel = `${toggleLabel} (disabled — background sync is being retired)`;

	return (
		<div className="group flex items-center justify-between rounded-md border px-3 py-2 hover:bg-muted/40">
			<button
				type="button"
				className={cn(
					"flex-1 truncate text-left text-sm",
					isExcluded && "text-muted-foreground line-through",
				)}
				onClick={onView}
			>
				{title}
			</button>
			<div className="ml-2 flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
				<Button
					variant="ghost"
					size="icon"
					className="h-7 w-7"
					onClick={onView}
					aria-label="View content"
				>
					<FileText className="h-3.5 w-3.5" />
				</Button>
				{mutationsDisabled ? (
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								variant="ghost"
								size="icon"
								className="h-7 w-7 opacity-50 aria-disabled:cursor-not-allowed"
								aria-disabled="true"
								aria-label={disabledToggleLabel}
							>
								{isExcluded ? (
									<Eye className="h-3.5 w-3.5" />
								) : (
									<EyeOff className="h-3.5 w-3.5" />
								)}
							</Button>
						</TooltipTrigger>
						<TooltipContent>{SYNC_DISABLED_TOOLTIP}</TooltipContent>
					</Tooltip>
				) : (
					<Button
						variant="ghost"
						size="icon"
						className="h-7 w-7"
						disabled={isPending}
						onClick={onToggle}
						aria-label={toggleLabel}
					>
						{isExcluded ? (
							<Eye className="h-3.5 w-3.5" />
						) : (
							<EyeOff className="h-3.5 w-3.5" />
						)}
					</Button>
				)}
			</div>
		</div>
	);
}

function ResourceContentDialog({
	connectionId,
	resourceId,
	onClose,
}: {
	connectionId: string;
	resourceId: string | null;
	onClose: () => void;
}) {
	const { data, isLoading } = useResourceContent(
		connectionId,
		resourceId ?? undefined,
	);

	return (
		<Dialog open={!!resourceId} onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="flex max-h-[85vh] max-w-2xl flex-col gap-0 p-0">
				<DialogHeader className="shrink-0 border-b px-6 py-4 text-left">
					<DialogTitle className="line-clamp-2 pr-6 text-base leading-snug">
						{data?.title ?? "Resource Content"}
					</DialogTitle>
				</DialogHeader>
				<div className="flex min-h-0 flex-1 flex-col px-6 py-4">
					{isLoading ? (
						<div className="flex items-center justify-center py-12">
							<Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
						</div>
					) : data ? (
						<ResourceContentBody data={data} />
					) : null}
				</div>
			</DialogContent>
		</Dialog>
	);
}

function ResourceContentBody({
	data,
}: {
	data: {
		title: string | null;
		extractedText: string | null;
		contentPreview: string | null;
		wordCount: number | null;
		pageCount: number | null;
		url: string | null;
		repository: string | null;
		author: string | null;
		labels: string[];
	};
}) {
	const displayText = data.extractedText ?? data.contentPreview;

	return (
		<div className="flex min-h-0 flex-1 flex-col gap-3">
			{/* Metadata row */}
			{(data.repository ||
				data.author ||
				data.url ||
				data.labels.length > 0) && (
				<div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
					{data.repository && (
						<span className="font-medium text-foreground/80">
							{data.repository}
						</span>
					)}
					{data.author && <span>by @{data.author}</span>}
					{data.labels.map((l) => (
						<Badge
							key={l}
							variant="outline"
							className="text-[10px]"
						>
							{l}
						</Badge>
					))}
					{data.url && (
						<a
							href={data.url}
							target="_blank"
							rel="noopener noreferrer"
							className="ml-auto inline-flex shrink-0 items-center gap-1 text-primary hover:underline"
						>
							View source
							<ExternalLink className="h-3 w-3" />
						</a>
					)}
				</div>
			)}

			{/* Word / page count */}
			{data.wordCount || data.pageCount ? (
				<div className="flex shrink-0 gap-4 text-xs text-muted-foreground">
					{data.wordCount && (
						<span>{data.wordCount.toLocaleString()} words</span>
					)}
					{data.pageCount && <span>{data.pageCount} pages</span>}
					{!data.extractedText && data.contentPreview && (
						<span className="text-muted-foreground/50">
							preview
						</span>
					)}
				</div>
			) : null}

			{/* Content */}
			{displayText ? (
				<div className="min-h-0 flex-1 overflow-y-auto rounded-md border bg-muted/20 p-4">
					<pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed">
						{displayText}
						{!data.extractedText &&
							data.contentPreview &&
							data.contentPreview.length >= 2000 && (
								<span className="text-muted-foreground/50">
									{" "}
									…
								</span>
							)}
					</pre>
				</div>
			) : (
				<div className="flex flex-1 flex-col justify-center gap-2 py-8">
					<p className="text-sm text-muted-foreground">
						No indexed content yet. Run a sync to index this
						resource.
					</p>
					{data.url && (
						<a
							href={data.url}
							target="_blank"
							rel="noopener noreferrer"
							className="inline-flex w-fit items-center gap-1 text-sm text-primary hover:underline"
						>
							View on source system
							<ExternalLink className="h-3.5 w-3.5" />
						</a>
					)}
				</div>
			)}
		</div>
	);
}

function NotionPagesBrowser({
	connectionId,
	isSyncing,
	mutationsDisabled,
}: {
	connectionId: string;
	isSyncing: boolean;
	mutationsDisabled: boolean;
}) {
	const [query, setQuery] = useState("");
	const { data: syncedResources } = useResources(connectionId);
	const { data: pages, isLoading } = useNotionPages(connectionId, query);
	const startSync = useStartSync();

	const syncedExternalIds = new Set(
		(syncedResources ?? [])
			.filter((r) => r.syncStatus !== "EXCLUDED")
			.map((r) => r.externalId),
	);

	const handleSyncPage = (_pageId: string) => {
		startSync.mutate({
			connectionId,
			type: "SELECTIVE",
		});
	};

	return (
		<div className="space-y-4">
			<div className="relative max-w-sm">
				<Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
				<Input
					type="search"
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					placeholder="Search your Notion pages"
					className="pl-9"
				/>
			</div>

			{isLoading ? (
				<p className="py-6 text-sm text-muted-foreground">
					Loading Notion pages...
				</p>
			) : !pages || pages.length === 0 ? (
				<p className="py-6 text-sm text-muted-foreground">
					No pages found. Try a different search.
				</p>
			) : (
				<div className="space-y-1">
					{pages.map((page) => {
						const isSynced = syncedExternalIds.has(page.id);
						return (
							<div
								key={page.id}
								className="flex items-center justify-between rounded-md border px-3 py-2"
							>
								<div className="flex min-w-0 items-center gap-2">
									{page.icon && (
										<span className="shrink-0 text-base leading-none">
											{page.icon}
										</span>
									)}
									<p className="truncate text-sm">
										{page.title}
									</p>
								</div>
								<div className="ml-3 flex shrink-0 items-center gap-2">
									{isSynced ? (
										<Badge
											variant="outline"
											className="text-[11px] text-success border-success/30"
										>
											Indexed
										</Badge>
									) : (
										<>
											<Badge
												variant="outline"
												className="text-[11px] text-muted-foreground"
											>
												Not synced
											</Badge>
											{mutationsDisabled ? (
												<Tooltip>
													<TooltipTrigger asChild>
														<Button
															variant="ghost"
															size="icon"
															className="h-7 w-7 opacity-50 aria-disabled:cursor-not-allowed"
															aria-disabled="true"
															aria-label="Sync this page (disabled — background sync is being retired)"
														>
															<RefreshCw className="h-3.5 w-3.5" />
														</Button>
													</TooltipTrigger>
													<TooltipContent>
														{SYNC_DISABLED_TOOLTIP}
													</TooltipContent>
												</Tooltip>
											) : (
												<Button
													variant="ghost"
													size="icon"
													className="h-7 w-7"
													disabled={
														isSyncing ||
														startSync.isPending
													}
													onClick={() =>
														handleSyncPage(page.id)
													}
													aria-label="Sync this page"
												>
													<RefreshCw className="h-3.5 w-3.5" />
												</Button>
											)}
										</>
									)}
								</div>
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
}
