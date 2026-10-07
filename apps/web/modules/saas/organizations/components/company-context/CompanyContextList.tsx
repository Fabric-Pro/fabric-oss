"use client";

import { SourceDetailsDialog } from "@saas/context-sources/components/SourceDetailsDialog";
import { useActiveOrganization } from "@saas/organizations/hooks/use-active-organization";
import {
	ContextSourceMetaLine,
	EditSourceDetailsMenuItem,
} from "@saas/projects/components/ContextSourceDetailsDialog";
import { TruncatedText } from "@shared/components/TruncatedText";
import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import {
	useInfiniteQuery,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { Alert, AlertDescription } from "@ui/components/alert";
import {
	AlertDialog,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@ui/components/alert-dialog";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import { Skeleton } from "@ui/components/skeleton";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import {
	AlertCircleIcon,
	BanIcon,
	CheckCircleIcon,
	ChevronDownIcon,
	ChevronUpIcon,
	ClockIcon,
	DownloadIcon,
	ExternalLinkIcon,
	FileIcon,
	GlobeIcon,
	InfoIcon,
	LoaderIcon,
	type LucideIcon,
	MoreVerticalIcon,
	PlusIcon,
	RefreshCwIcon,
	RotateCcwIcon,
	TextIcon,
	TrashIcon,
	XCircleIcon,
} from "lucide-react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AddCompanyContextDialog } from "./AddCompanyContextDialog";
import {
	type CompanyContextListResult,
	type CompanyContextSource,
	type CompanySourceState,
	companyContextDetailsAdapter,
	companyContextPollInterval,
	companySourceTitle,
	companyUrlPagesPollInterval,
	isCompanySourceDownloadable,
	type PendingCompanyDeletes,
	resolveCompanySourceState,
	settlePendingCompanyDeletes,
	visibleCompanySources,
} from "./company-context-adapter";

type CompanyContextListProps = {
	organizationId: string;
	organizationSlug: string;
	/** Admin or owner: may add, edit, re-process and remove sources. */
	canEdit: boolean;
};

const URL_PAGES_PAGE_SIZE = 50;

/** Colour and icon per state: plain tinted text, as the project list shows. */
const STATE_PRESENTATION: Record<
	CompanySourceState,
	{ icon: LucideIcon; className: string; spin?: boolean }
> = {
	pending: {
		icon: ClockIcon,
		className: "text-muted-foreground",
	},
	processing: {
		icon: LoaderIcon,
		className: "text-highlight",
		spin: true,
	},
	indexing: {
		icon: LoaderIcon,
		className: "text-highlight",
		spin: true,
	},
	ready: { icon: CheckCircleIcon, className: "text-success" },
	needsReprocessing: { icon: RotateCcwIcon, className: "text-highlight" },
	notSearchable: { icon: InfoIcon, className: "text-highlight" },
	failed: { icon: XCircleIcon, className: "text-destructive" },
	cancelled: { icon: BanIcon, className: "text-muted-foreground" },
};

function typeLabelKey(type: string) {
	switch (type) {
		case "LINK":
			return "types.LINK" as const;
		case "TEXT":
			return "types.TEXT" as const;
		default:
			return "types.FILE" as const;
	}
}

function typeIcon(type: string): LucideIcon {
	switch (type) {
		case "LINK":
			return GlobeIcon;
		case "TEXT":
			return TextIcon;
		default:
			return FileIcon;
	}
}

function errorMessage(error: unknown, fallback: string): string {
	return error instanceof Error && error.message ? error.message : fallback;
}

function triggerBrowserDownload(url: string, filename: string): void {
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = filename;
	anchor.rel = "noopener";
	document.body.appendChild(anchor);
	anchor.click();
	document.body.removeChild(anchor);
}

/**
 * The "last edited" name for a company source: a member of the organization,
 * read from the active organization's member list, which the settings pages
 * already hold. Null while unknown, so the dialog shows the date only.
 */
function useOrganizationMemberName(userId: string | null): string | null {
	const { activeOrganization } = useActiveOrganization();
	return useMemo(() => {
		if (!userId) {
			return null;
		}
		const members = (activeOrganization?.members ?? []) as Array<{
			userId?: string;
			user?: { name?: string | null } | null;
		}>;
		return (
			members.find((member) => member.userId === userId)?.user?.name ||
			null
		);
	}, [activeOrganization, userId]);
}

type DetailsTarget = {
	sourceId: string;
	sourceName: string;
};

/**
 * The organization's company context sources (Fizzy #2719): each
 * source's processing state — the project Context tab's states plus "needs
 * re-processing" after an embedding-model change — with its type label and AI
 * instructions. Polls while anything is in flight, or a deleted source has
 * not gone yet, up to the cap.
 *
 * Everyone can open a website's crawled pages and download a source. Admins
 * and owners also add, edit details, sync, cancel, re-process and remove; for
 * anyone else those controls are not rendered at all, and the server refuses
 * them regardless.
 */
export function CompanyContextList({
	organizationId,
	organizationSlug,
	canEdit,
}: CompanyContextListProps) {
	const t = useTranslations("settings.companyContext");
	const queryClient = useQueryClient();
	const client = orpcClient.organizations.companyContext;
	const listKey = orpc.organizations.companyContext.list.queryKey({
		input: { organizationId },
	});

	const [addOpen, setAddOpen] = useState(false);
	const [detailsTarget, setDetailsTarget] = useState<DetailsTarget | null>(
		null,
	);
	const [detailsOpen, setDetailsOpen] = useState(false);
	const [deleteTarget, setDeleteTarget] = useState<DetailsTarget | null>(
		null,
	);
	const [expandedPages, setExpandedPages] = useState<ReadonlySet<string>>(
		() => new Set(),
	);
	// Deleted sources, hidden from here on while the server removes them.
	const [pendingDeletes, setPendingDeletes] = useState<PendingCompanyDeletes>(
		() => new Map(),
	);

	const { data, isLoading, error, refetch } = useQuery({
		queryKey: listKey,
		queryFn: () => client.list({ organizationId }),
		refetchInterval: (query) =>
			companyContextPollInterval(
				query.state.data,
				Date.now(),
				pendingDeletes,
			),
	});

	// A deleted source the server no longer returns is gone for good.
	useEffect(() => {
		if (data) {
			setPendingDeletes((previous) =>
				settlePendingCompanyDeletes(previous, data),
			);
		}
	}, [data]);

	const invalidateList = () =>
		queryClient.invalidateQueries({ queryKey: listKey });

	const detailsAdapter = useMemo(
		() =>
			companyContextDetailsAdapter(
				organizationId,
				queryClient,
				useOrganizationMemberName,
			),
		[organizationId, queryClient],
	);

	const deleteMutation = useMutation({
		mutationFn: (sourceId: string) =>
			client.delete({ organizationId, sourceId }),
		onSuccess: (_result, sourceId) => {
			// The server only starts the deletion; the row goes a little
			// later. Hide it now rather than show a deleted source as live.
			setPendingDeletes((previous) =>
				new Map(previous).set(sourceId, Date.now()),
			);
			toast.success(t("actions.deleted"));
		},
		onError: (mutationError) => {
			// CONFLICT while a website is still crawling says so in its own
			// message ("Cancel it before deleting the source").
			toast.error(errorMessage(mutationError, t("actions.failed")));
		},
		onSettled: () => {
			setDeleteTarget(null);
			void invalidateList();
		},
	});

	const resyncMutation = useMutation({
		mutationFn: (sourceId: string) =>
			client.resyncUrlSource({ organizationId, sourceId }),
		onSuccess: (result) => {
			toast.success(t("actions.syncStarted"));
			// The crawl started, but the website's automatic refresh could
			// still not be scheduled; the server's message says what to do.
			if (result.scheduleWarning) {
				toast.warning(result.scheduleWarning.message);
			}
		},
		onError: (mutationError) =>
			toast.error(errorMessage(mutationError, t("actions.failed"))),
		onSettled: () => void invalidateList(),
	});

	const cancelCrawlMutation = useMutation({
		mutationFn: (sourceId: string) =>
			client.cancelUrlSourceCrawl({ organizationId, sourceId }),
		onSuccess: () => toast.success(t("actions.cancelRequested")),
		onError: (mutationError) =>
			toast.error(errorMessage(mutationError, t("actions.failed"))),
		onSettled: () => void invalidateList(),
	});

	const reprocessMutation = useMutation({
		mutationFn: (sourceId?: string) =>
			client.reprocess({
				organizationId,
				...(sourceId ? { sourceId } : {}),
			}),
		onSuccess: (result, sourceId) => {
			if (sourceId) {
				toast.success(t("actions.reprocessStarted"));
				return;
			}
			toast.success(
				t("actions.reprocessAllStarted", {
					count: result.reprocessed.length,
				}),
			);
			if (result.skipped.length > 0) {
				toast.warning(
					t("actions.reprocessAllSkipped", {
						count: result.skipped.length,
					}),
					{
						description: result.skipped
							.map((skipped) => skipped.reason)
							.join(" "),
					},
				);
			}
		},
		onError: (mutationError) =>
			toast.error(errorMessage(mutationError, t("actions.failed"))),
		onSettled: () => void invalidateList(),
	});

	const handleDownload = async (source: CompanyContextSource) => {
		try {
			const { url, filename } = await client.createDownloadUrl({
				organizationId,
				sourceId: source.id,
			});
			triggerBrowserDownload(url, filename);
		} catch {
			toast.error(t("actions.downloadFailed"));
		}
	};

	const togglePages = (sourceId: string) => {
		setExpandedPages((previous) => {
			const next = new Set(previous);
			if (next.has(sourceId)) {
				next.delete(sourceId);
			} else {
				next.add(sourceId);
			}
			return next;
		});
	};

	const sources = visibleCompanySources(data?.sources ?? [], pendingDeletes);
	const model = data?.embeddingModel ?? null;
	const readyCount = sources.filter((source) => source.ready).length;
	const staleCount = sources.filter(
		(source) => source.needsReprocessing,
	).length;
	// The live row feeds the details dialog, so a save made elsewhere while it
	// is open shows as a conflict instead of being overwritten.
	const detailsSource = detailsTarget
		? sources.find((source) => source.id === detailsTarget.sourceId)
		: undefined;

	return (
		<section
			aria-labelledby="company-context-sources-heading"
			className="space-y-4"
		>
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="space-y-0.5">
					<h2
						id="company-context-sources-heading"
						className="font-medium text-base"
					>
						{t("list.title")}
					</h2>
					{data && sources.length > 0 ? (
						<p className="text-muted-foreground text-sm">
							{t("list.summary", {
								ready: readyCount,
								total: sources.length,
							})}
						</p>
					) : null}
				</div>
				{canEdit ? (
					<div className="flex flex-wrap items-center gap-2">
						{staleCount > 0 ? (
							<Button
								variant="outline"
								size="sm"
								onClick={() =>
									reprocessMutation.mutate(undefined)
								}
								loading={
									reprocessMutation.isPending &&
									reprocessMutation.variables === undefined
								}
								data-testid="company-context-reprocess-all"
							>
								<RotateCcwIcon
									className="size-4"
									aria-hidden="true"
								/>
								{t("list.reprocessAll")}
							</Button>
						) : null}
						<Button
							size="sm"
							onClick={() => setAddOpen(true)}
							data-testid="company-context-add"
						>
							<PlusIcon className="size-4" aria-hidden="true" />
							{t("list.add")}
						</Button>
					</div>
				) : null}
			</div>

			{data ? (
				<ModelNotice
					model={data.embeddingModel}
					staleCount={staleCount}
					organizationSlug={organizationSlug}
					canEdit={canEdit}
				/>
			) : null}

			{isLoading ? (
				<div className="space-y-2" aria-busy="true">
					<output className="sr-only">{t("list.loading")}</output>
					<Skeleton className="h-20 w-full" />
					<Skeleton className="h-20 w-full" />
				</div>
			) : error ? (
				<Alert variant="error">
					<AlertCircleIcon aria-hidden="true" />
					<AlertDescription className="flex flex-wrap items-center gap-3">
						<span>{t("list.loadFailed")}</span>
						<Button
							variant="outline"
							size="sm"
							onClick={() => void refetch()}
						>
							{t("list.retry")}
						</Button>
					</AlertDescription>
				</Alert>
			) : sources.length === 0 ? (
				<div
					className="rounded-lg border border-border border-dashed p-8 text-center"
					data-testid="company-context-empty"
				>
					<h3 className="font-medium text-sm">
						{t("list.emptyTitle")}
					</h3>
					<p className="mt-1 text-muted-foreground text-sm">
						{canEdit ? t("list.emptyAdmin") : t("list.emptyMember")}
					</p>
				</div>
			) : (
				<ul className="space-y-2" data-testid="company-context-sources">
					{sources.map((source) => (
						<CompanySourceRow
							key={source.id}
							source={source}
							model={model}
							organizationId={organizationId}
							canEdit={canEdit}
							pagesExpanded={expandedPages.has(source.id)}
							onTogglePages={() => togglePages(source.id)}
							onDownload={() => handleDownload(source)}
							onEditDetails={() => {
								setDetailsTarget({
									sourceId: source.id,
									sourceName: companySourceTitle(source),
								});
								setDetailsOpen(true);
							}}
							onSync={() => resyncMutation.mutate(source.id)}
							onCancelCrawl={() =>
								cancelCrawlMutation.mutate(source.id)
							}
							onReprocess={() =>
								reprocessMutation.mutate(source.id)
							}
							onDelete={() =>
								setDeleteTarget({
									sourceId: source.id,
									sourceName: companySourceTitle(source),
								})
							}
							busy={
								(resyncMutation.isPending &&
									resyncMutation.variables === source.id) ||
								(cancelCrawlMutation.isPending &&
									cancelCrawlMutation.variables ===
										source.id) ||
								(reprocessMutation.isPending &&
									(reprocessMutation.variables ===
										source.id ||
										reprocessMutation.variables ===
											undefined))
							}
						/>
					))}
				</ul>
			)}

			{canEdit ? (
				<>
					<AddCompanyContextDialog
						organizationId={organizationId}
						organizationSlug={organizationSlug}
						open={addOpen}
						onOpenChange={setAddOpen}
					/>

					{/* One details dialog, outside every row menu: Radix unmounts
					    a menu's content, and anything inside it, on close. */}
					{detailsTarget ? (
						<SourceDetailsDialog
							open={detailsOpen}
							onOpenChange={setDetailsOpen}
							adapter={detailsAdapter}
							contextId={detailsTarget.sourceId}
							sourceName={detailsTarget.sourceName}
							initialSourceType={
								detailsSource?.sourceType ?? null
							}
							initialAiInstructions={
								detailsSource?.aiInstructions ?? null
							}
							initialMetadataUpdatedAt={
								detailsSource?.metadataUpdatedAt ?? null
							}
							initialMetadataUpdatedByUserId={
								detailsSource?.metadataUpdatedByUserId ?? null
							}
						/>
					) : null}

					<AlertDialog
						open={deleteTarget !== null}
						onOpenChange={(open) => {
							if (!open && !deleteMutation.isPending) {
								setDeleteTarget(null);
							}
						}}
					>
						<AlertDialogContent>
							<AlertDialogHeader>
								<AlertDialogTitle>
									{t("deleteDialog.title")}
								</AlertDialogTitle>
								<AlertDialogDescription>
									{t("deleteDialog.description", {
										name: deleteTarget?.sourceName ?? "",
									})}
								</AlertDialogDescription>
							</AlertDialogHeader>
							<AlertDialogFooter>
								<AlertDialogCancel
									disabled={deleteMutation.isPending}
								>
									{t("deleteDialog.cancel")}
								</AlertDialogCancel>
								{/* A plain button, not AlertDialogAction: the
								    dialog stays open until the delete settles. */}
								<Button
									variant="error"
									onClick={() => {
										if (deleteTarget) {
											deleteMutation.mutate(
												deleteTarget.sourceId,
											);
										}
									}}
									loading={deleteMutation.isPending}
									data-testid="company-context-confirm-delete"
								>
									{deleteMutation.isPending
										? t("deleteDialog.deleting")
										: t("deleteDialog.confirm")}
								</Button>
							</AlertDialogFooter>
						</AlertDialogContent>
					</AlertDialog>
				</>
			) : null}
		</section>
	);
}

/**
 * Why sources cannot be used, when the reason is the organization's embedding
 * model rather than any one source: none configured, one that cannot be
 * stored, or sources indexed with an earlier one.
 */
function ModelNotice({
	model,
	staleCount,
	organizationSlug,
	canEdit,
}: {
	model: CompanyContextListResult["embeddingModel"];
	staleCount: number;
	organizationSlug: string;
	canEdit: boolean;
}) {
	const t = useTranslations("settings.companyContext.model");

	if (!model || !model.supported) {
		return (
			<Alert variant="warning" data-testid="company-context-model-notice">
				<AlertCircleIcon aria-hidden="true" />
				<AlertDescription className="space-y-2">
					<p>{model ? t("unsupported") : t("missing")}</p>
					{canEdit ? (
						<Button asChild variant="outline" size="sm">
							<Link
								href={`/app/${organizationSlug}/settings/ai-providers`}
							>
								{t("openProviders")}
							</Link>
						</Button>
					) : null}
				</AlertDescription>
			</Alert>
		);
	}
	if (staleCount > 0) {
		return (
			<Alert variant="warning" data-testid="company-context-stale-notice">
				<RotateCcwIcon aria-hidden="true" />
				<AlertDescription>
					{t("stale", { count: staleCount })}
				</AlertDescription>
			</Alert>
		);
	}
	return null;
}

type CompanySourceRowProps = {
	source: CompanyContextSource;
	model: CompanyContextListResult["embeddingModel"];
	organizationId: string;
	canEdit: boolean;
	pagesExpanded: boolean;
	onTogglePages: () => void;
	/** Resolves when the download has started (or failed). */
	onDownload: () => Promise<void>;
	onEditDetails: () => void;
	onSync: () => void;
	onCancelCrawl: () => void;
	onReprocess: () => void;
	onDelete: () => void;
	/** An action on this source is in flight. */
	busy: boolean;
};

function CompanySourceRow({
	source,
	model,
	organizationId,
	canEdit,
	pagesExpanded,
	onTogglePages,
	onDownload,
	onEditDetails,
	onSync,
	onCancelCrawl,
	onReprocess,
	onDelete,
	busy,
}: CompanySourceRowProps) {
	const t = useTranslations("settings.companyContext");
	const format = useFormatter();

	const title = companySourceTitle(source);
	const state = resolveCompanySourceState(source, model);
	const presentation = STATE_PRESENTATION[state];
	const StateIcon = presentation.icon;
	const TypeIcon = typeIcon(source.type);
	const isLink = source.type === "LINK";
	// A website saved as LIVE before company context stopped offering it is
	// re-fetched by nothing, so it reads as what it does: no automatic
	// refresh.
	const refreshMode =
		source.urlRefreshMode === "LIVE" ? "ONCE" : source.urlRefreshMode;
	const crawling =
		source.crawlInProgress ||
		source.extractionStatus === "PENDING" ||
		source.extractionStatus === "EXTRACTING";
	const inFlight =
		state === "pending" || state === "processing" || state === "indexing";
	// A delete has started: the server refuses new work on the source, so
	// only deleting it again is offered.
	const deleting = source.deleting;
	const canReprocess =
		!deleting &&
		!inFlight &&
		(state === "needsReprocessing" ||
			state === "failed" ||
			state === "notSearchable" ||
			state === "cancelled");
	const pagesPanelId = `company-source-pages-${source.id}`;
	const showError =
		(state === "failed" || state === "notSearchable") &&
		source.extractionError;
	const formatDate = (value: Date | string) =>
		format.dateTime(new Date(value), { dateStyle: "medium" });

	return (
		<li
			className="rounded-lg border border-border bg-card"
			data-testid={`company-source-${source.id}`}
			data-state={state}
		>
			<div className="flex items-start gap-3 p-4">
				<div
					className="shrink-0 rounded-md border border-border bg-muted p-2 text-primary"
					aria-hidden="true"
				>
					<TypeIcon className="size-4" />
				</div>

				<div className="min-w-0 flex-1 space-y-1">
					<div className="flex min-w-0 flex-wrap items-center gap-2">
						<TruncatedText
							as="h3"
							text={title}
							className="max-w-full font-medium text-sm"
						/>
						<Badge variant="outline">
							{t(typeLabelKey(source.type))}
						</Badge>
					</div>

					<ContextSourceMetaLine
						sourceType={source.sourceType}
						aiInstructions={source.aiInstructions}
					/>

					<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-xs">
						<span
							className={cn(
								"flex items-center gap-1",
								presentation.className,
							)}
							data-testid="company-source-status"
						>
							<StateIcon
								className={cn(
									"size-3.5",
									presentation.spin &&
										"motion-safe:animate-spin",
								)}
								aria-hidden="true"
							/>
							{t(`status.${state}`)}
						</span>
						{source.crawlProgress ? (
							<span data-testid="company-source-crawl-progress">
								{t("row.crawlProgress", {
									processed:
										source.crawlProgress.processedPages,
									total: source.crawlProgress.totalPages,
								})}
							</span>
						) : isLink && source.urlPageCount > 0 ? (
							<span>
								{t("row.pageCount", {
									count: source.urlPageCount,
								})}
							</span>
						) : null}
						{isLink && refreshMode ? (
							<span>{t(`row.refresh.${refreshMode}`)}</span>
						) : null}
						{isLink && source.urlLastSyncedAt ? (
							<span>
								{t("row.lastSynced", {
									date: formatDate(source.urlLastSyncedAt),
								})}
							</span>
						) : (
							<span>
								{t("row.added", {
									date: formatDate(source.createdAt),
								})}
							</span>
						)}
					</div>

					{isLink && source.crawlInProgress && !source.ready ? (
						<p
							className="text-muted-foreground text-xs"
							data-testid="company-source-crawl-hint"
						>
							{t("row.crawlHint")}
						</p>
					) : null}

					{showError ? (
						<p
							className="text-destructive text-xs"
							data-testid="company-source-error"
						>
							{source.extractionError}
						</p>
					) : null}

					{isLink && source.sourceUrl ? (
						<a
							href={source.sourceUrl}
							target="_blank"
							rel="noopener noreferrer"
							className="flex w-fit max-w-full items-center gap-1 text-primary text-xs hover:underline"
						>
							<ExternalLinkIcon
								className="size-3 shrink-0"
								aria-hidden="true"
							/>
							<TruncatedText
								as="span"
								text={source.sourceUrl}
								className="max-w-[260px]"
							/>
						</a>
					) : null}
				</div>

				<div className="flex shrink-0 items-center gap-1">
					{isLink ? (
						<IconAction
							label={
								pagesExpanded
									? t("actions.hidePages", { name: title })
									: t("actions.showPages", { name: title })
							}
							onClick={onTogglePages}
							ariaExpanded={pagesExpanded}
							ariaControls={pagesPanelId}
							testId="company-source-toggle-pages"
						>
							{pagesExpanded ? (
								<ChevronUpIcon
									className="size-4"
									aria-hidden="true"
								/>
							) : (
								<ChevronDownIcon
									className="size-4"
									aria-hidden="true"
								/>
							)}
						</IconAction>
					) : null}
					{isCompanySourceDownloadable(source) ? (
						<IconAction
							label={t("actions.download", { name: title })}
							onClick={onDownload}
							testId="company-source-download"
						>
							<DownloadIcon
								className="size-4"
								aria-hidden="true"
							/>
						</IconAction>
					) : null}
					{canEdit ? (
						<DropdownMenu>
							<DropdownMenuTrigger asChild>
								<Button
									type="button"
									variant="ghost"
									size="icon"
									className="size-8"
									aria-label={t("actions.more", {
										name: title,
									})}
									disabled={busy}
									data-testid="company-source-more"
								>
									<MoreVerticalIcon
										className="size-4"
										aria-hidden="true"
									/>
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end">
								<EditSourceDetailsMenuItem
									testId={`company-source-edit-details-${source.id}`}
									onOpen={onEditDetails}
								/>
								{isLink && !crawling && !deleting ? (
									<DropdownMenuItem
										onSelect={onSync}
										data-testid="company-source-sync"
									>
										<RefreshCwIcon
											className="mr-2 size-4"
											aria-hidden="true"
										/>
										{t("actions.sync")}
									</DropdownMenuItem>
								) : null}
								{isLink && source.crawlInProgress ? (
									<DropdownMenuItem
										onSelect={onCancelCrawl}
										data-testid="company-source-cancel-crawl"
									>
										<BanIcon
											className="mr-2 size-4"
											aria-hidden="true"
										/>
										{t("actions.cancelCrawl")}
									</DropdownMenuItem>
								) : null}
								{canReprocess ? (
									<DropdownMenuItem
										onSelect={onReprocess}
										data-testid="company-source-reprocess"
									>
										<RotateCcwIcon
											className="mr-2 size-4"
											aria-hidden="true"
										/>
										{t("actions.reprocess")}
									</DropdownMenuItem>
								) : null}
								<DropdownMenuSeparator />
								{/* A website mid-crawl is refused by the server
								    until the crawl is cancelled; say so here
								    rather than offer a delete that fails. */}
								<DropdownMenuItem
									onSelect={onDelete}
									disabled={isLink && crawling}
									className="text-destructive focus:text-destructive"
									data-testid="company-source-delete"
								>
									<TrashIcon
										className="mr-2 size-4"
										aria-hidden="true"
									/>
									{isLink && crawling
										? t("actions.deleteBlocked")
										: t("actions.delete")}
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					) : null}
				</div>
			</div>

			{isLink && pagesExpanded ? (
				<CompanySourceUrlPages
					id={pagesPanelId}
					organizationId={organizationId}
					sourceId={source.id}
					sourceName={title}
					crawling={crawling}
				/>
			) : null}
		</li>
	);
}

function IconAction({
	label,
	onClick,
	children,
	testId,
	ariaExpanded,
	ariaControls,
}: {
	label: string;
	/** A returned promise keeps the button in its loading state until it settles. */
	onClick: () => unknown;
	children: ReactNode;
	testId: string;
	ariaExpanded?: boolean;
	ariaControls?: string;
}) {
	return (
		<Tooltip delayDuration={150}>
			<TooltipTrigger asChild>
				<Button
					type="button"
					variant="ghost"
					size="icon"
					className="size-8"
					aria-label={label}
					aria-expanded={ariaExpanded}
					aria-controls={ariaControls}
					onClick={onClick}
					data-testid={testId}
				>
					{children}
				</Button>
			</TooltipTrigger>
			<TooltipContent side="top">{label}</TooltipContent>
		</Tooltip>
	);
}

/**
 * The pages a website crawl indexed, 50 at a time. Refreshes while the crawl
 * runs so new pages appear without reopening — only while the first few
 * pages are loaded, since each refresh re-reads every loaded page — and once
 * more, in full, when the crawl ends.
 */
function CompanySourceUrlPages({
	id,
	organizationId,
	sourceId,
	sourceName,
	crawling,
}: {
	id: string;
	organizationId: string;
	sourceId: string;
	sourceName: string;
	crawling: boolean;
}) {
	const t = useTranslations("settings.companyContext.pages");

	const pageInput = (cursor: string | null) => ({
		organizationId,
		sourceId,
		limit: URL_PAGES_PAGE_SIZE,
		statusFilter: "all" as const,
		...(cursor ? { cursor } : {}),
	});
	const pagesQuery = useInfiniteQuery({
		queryKey: orpc.organizations.companyContext.listUrlPages.infiniteKey({
			input: pageInput,
			initialPageParam: null,
		}),
		queryFn: ({ pageParam }) =>
			orpcClient.organizations.companyContext.listUrlPages(
				pageInput(pageParam),
			),
		initialPageParam: null as string | null,
		getNextPageParam: (lastPage) => lastPage.nextCursor ?? null,
		refetchInterval: (query) =>
			companyUrlPagesPollInterval(
				crawling,
				query.state.data?.pages.length ?? 0,
			),
	});

	// The last tick can land before the crawl's final writes, and a list
	// paged past the live cap was not refreshing at all.
	const { refetch: refetchPages } = pagesQuery;
	const wasCrawling = useRef(crawling);
	useEffect(() => {
		if (wasCrawling.current && !crawling) {
			void refetchPages();
		}
		wasCrawling.current = crawling;
	}, [crawling, refetchPages]);

	const items = pagesQuery.data?.pages.flatMap((page) => page.items) ?? [];
	const total = pagesQuery.data?.pages.at(-1)?.total ?? 0;

	return (
		<section
			id={id}
			aria-label={t("label", { name: sourceName })}
			className="border-border border-t px-4 py-3"
			data-testid="company-source-pages"
		>
			{pagesQuery.isLoading ? (
				<p className="text-muted-foreground text-xs">{t("loading")}</p>
			) : pagesQuery.error ? (
				<p className="text-destructive text-xs">{t("loadFailed")}</p>
			) : items.length === 0 ? (
				<p className="text-muted-foreground text-xs">{t("empty")}</p>
			) : (
				<div className="space-y-2">
					<ul className="space-y-1">
						{items.map((page) => (
							<li
								key={page.id}
								className="flex min-w-0 items-center justify-between gap-3 text-xs"
							>
								<a
									href={page.pageUrl}
									target="_blank"
									rel="noopener noreferrer"
									className="min-w-0 text-primary hover:underline"
								>
									<TruncatedText
										as="span"
										text={page.pageTitle || page.pageUrl}
										className="max-w-full"
									/>
								</a>
								<span
									className={cn(
										"shrink-0",
										page.extractionStatus === "FAILED"
											? "text-destructive"
											: "text-muted-foreground",
									)}
									title={page.extractionError ?? undefined}
								>
									{t(`status.${page.extractionStatus}`)}
								</span>
							</li>
						))}
					</ul>
					<div className="flex flex-wrap items-center justify-between gap-2">
						<span className="text-muted-foreground text-xs">
							{t("shown", { shown: items.length, total })}
						</span>
						{pagesQuery.hasNextPage ? (
							<Button
								variant="outline"
								size="sm"
								onClick={() => void pagesQuery.fetchNextPage()}
								loading={pagesQuery.isFetchingNextPage}
							>
								{t("loadMore")}
							</Button>
						) : null}
					</div>
				</div>
			)}
		</section>
	);
}
