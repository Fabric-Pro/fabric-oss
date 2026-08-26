"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Checkbox } from "@ui/components/checkbox";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@ui/components/sheet";
import { Skeleton } from "@ui/components/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ui/components/tabs";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { ArrowRightIcon, RotateCcwIcon, XIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useOpenSyncLog } from "../../sync-log-deep-link";
import { type ReviewCenterItem, ReviewCenterRow } from "./ReviewCenterRow";
import {
	useInvalidateReviewCenter,
	useReviewCenterCount,
	useReviewCenterItems,
} from "./use-review-center";

type Props = {
	projectId: string;
	organizationId: string | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
};

type TabKey = "conflicts" | "failures" | "pullDrift";

/**
 * Which loaded rows on the bulk-capable Failures tab can be selected (spec §8.2,
 * FR5): only rows with a resolvable PM tool (a null `pmTool` means Retry is
 * disabled, so the row is not selectable). Sync Drift rows are single-item only.
 */
function isSelectable(item: ReviewCenterItem): boolean {
	if (item.type === "failure") {
		return item.pmTool != null;
	}
	return false;
}

/**
 * Returns the first tab (in priority order Conflicts → Failures → Sync Drift)
 * whose category has at least one item, or `null` when all are empty.
 */
function firstNonEmpty(
	conflictsCount: number,
	failuresCount: number,
	pullDriftCount: number,
): TabKey | null {
	if (conflictsCount > 0) {
		return "conflicts";
	}
	if (failuresCount > 0) {
		return "failures";
	}
	if (pullDriftCount > 0) {
		return "pullDrift";
	}
	return null;
}

/**
 * Unified Review Center slide-over. A `Sheet` — NOT a center modal —
 * with three category tabs (Conflicts / Failures / Sync Drift). The Sync Drift
 * tab always renders.
 *
 * Two queries, two bindings:
 * - **labels + default-tab** bind to the count query (TRUE per-category counts).
 * - **the list** binds to the capped (~50) items query.
 *
 * This decoupling is why a tab label can read "Failures 32" while its rendered
 * list is shorter than 32.
 */
export function ReviewCenterPanel({
	projectId,
	organizationId,
	open,
	onOpenChange,
}: Props) {
	const openSyncLog = useOpenSyncLog(projectId);

	// Counts drive the tab labels + the once-per-open default tab. Same query key
	// as the badge's poll → deduped, and already cached when the panel opens.
	const { data: countData, isLoading: countsLoading } =
		useReviewCenterCount(projectId);
	const conflictsCount = countData?.conflictsCount ?? 0;
	const failuresCount = countData?.failuresCount ?? 0;
	const pullDriftCount = countData?.pullDriftCount ?? 0;
	const countsLoaded = !countsLoading && countData != null;

	// The capped grouped list drives what the active tab renders. Only fetched
	// while the panel is open (the badge owns the always-on count poll).
	const { data: itemsData, isLoading: itemsLoading } = useReviewCenterItems(
		projectId,
		open,
	);
	const invalidate = useInvalidateReviewCenter(projectId);

	// PM-integration awareness for the Sync Drift placeholder. Self-fetched (not
	// threaded from StoriesRoadmap) so the inbox stays prop-free; same query key
	// StoriesRoadmap uses → deduped. `undefined` is treated as falsy.
	const { data: pmCapabilitiesData } = useQuery(
		orpc.projects.stories.pmCapabilities.queryOptions({
			input: { projectId, organizationId },
		}),
	);
	const pmConfigured = pmCapabilitiesData?.configured ?? false;

	const [activeTab, setActiveTab] = useState<TabKey>("conflicts");

	// Default to the first non-empty tab ONCE per open, then never auto-switch.
	// The ref guard is what reconciles "first non-empty at open"
	// with "stay put when the active tab empties": after the first
	// selection later count changes in the same session no-op, so resolving an
	// item that empties the active tab leaves it put. Counts are in the deps (so
	// the effect re-runs and selects exactly once when they first land) which
	// keeps Biome `useExhaustiveDependencies` clean.
	const hasSelectedForThisOpenRef = useRef(false);
	useEffect(() => {
		if (!open) {
			hasSelectedForThisOpenRef.current = false;
		}
	}, [open]);
	useEffect(() => {
		if (open && !hasSelectedForThisOpenRef.current && countsLoaded) {
			setActiveTab(
				firstNonEmpty(conflictsCount, failuresCount, pullDriftCount) ??
					"conflicts",
			);
			hasSelectedForThisOpenRef.current = true;
		}
	}, [open, countsLoaded, conflictsCount, failuresCount, pullDriftCount]);

	// Bulk selection lives only on the Failures tab: a set of row ids.
	// Conflicts and Sync Drift have no bulk surface. Selection clears when the
	// panel closes and whenever the active tab changes.
	const [selectedFailures, setSelectedFailures] = useState<Set<string>>(
		new Set(),
	);

	useEffect(() => {
		if (!open) {
			setSelectedFailures(new Set());
		}
	}, [open]);

	const handleTabChange = useCallback((value: string) => {
		setActiveTab(value as TabKey);
		// Leaving the Failures tab abandons its selection so the toolbar never
		// acts on rows the user can no longer see.
		setSelectedFailures(new Set());
	}, []);

	const clearSelection = useCallback(() => {
		setSelectedFailures(new Set());
	}, []);

	const toggleSelect = useCallback((id: string, next: boolean) => {
		setSelectedFailures((prev) => {
			const updated = new Set(prev);
			if (next) {
				updated.add(id);
			} else {
				updated.delete(id);
			}
			return updated;
		});
	}, []);

	const setSelection = useCallback((ids: string[]) => {
		setSelectedFailures(new Set(ids));
	}, []);

	const t = useTranslations("tooltips.stories");
	const conflictsLabel = countsLoading ? "—" : String(conflictsCount);
	const failuresLabel = countsLoading ? "—" : String(failuresCount);
	const pullDriftLabel = countsLoading ? "—" : String(pullDriftCount);

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent
				side="right"
				className="flex w-full flex-col bg-card border-l border-border sm:max-w-lg p-6 motion-safe:transition-transform"
			>
				<SheetHeader className="space-y-2">
					<span className="editorial-label">REVIEW CENTER</span>
					<SheetTitle
						className="font-normal text-2xl"
						style={{ fontFamily: "var(--font-serif)" }}
					>
						Items to review
					</SheetTitle>
					<SheetDescription>
						Conflicts, failed syncs, and changes detected in your PM
						tool — resolve them here.
					</SheetDescription>
				</SheetHeader>

				<Tabs
					value={activeTab}
					onValueChange={handleTabChange}
					className="mt-6 flex min-h-0 flex-1 flex-col"
				>
					<TabsList>
						<Tooltip>
							<TabsTrigger value="conflicts" asChild>
								<TooltipTrigger>
									Conflicts
									<span className="ml-2 tabular-nums text-muted-foreground">
										{conflictsLabel}
									</span>
								</TooltipTrigger>
							</TabsTrigger>
							<TooltipContent>
								{t("reviewTabConflicts")}
							</TooltipContent>
						</Tooltip>
						<Tooltip>
							<TabsTrigger value="failures" asChild>
								<TooltipTrigger>
									Failures
									<span className="ml-2 tabular-nums text-muted-foreground">
										{failuresLabel}
									</span>
								</TooltipTrigger>
							</TabsTrigger>
							<TooltipContent>
								{t("reviewTabFailures")}
							</TooltipContent>
						</Tooltip>
						<Tooltip>
							<TabsTrigger value="pullDrift" asChild>
								<TooltipTrigger>
									Sync Drift
									<span className="ml-2 tabular-nums text-muted-foreground">
										{pullDriftLabel}
									</span>
								</TooltipTrigger>
							</TabsTrigger>
							<TooltipContent>
								{t("reviewTabSyncDrift")}
							</TooltipContent>
						</Tooltip>
					</TabsList>

					<div className="mt-4 min-h-0 flex-1 overflow-y-auto">
						<TabsContent value="conflicts">
							<TabPanelBody
								loading={itemsLoading}
								items={itemsData?.conflicts ?? []}
								projectId={projectId}
								organizationId={organizationId}
								onActioned={invalidate}
								emptyState={
									<EmptyState
										label="NO CONFLICTS"
										title="Nothing to review here"
										subtext="No sync conflicts need your attention."
									/>
								}
							/>
						</TabsContent>

						<TabsContent value="failures">
							<TabPanelBody
								loading={itemsLoading}
								items={itemsData?.failures ?? []}
								projectId={projectId}
								organizationId={organizationId}
								onActioned={invalidate}
								bulk={{
									selected: selectedFailures,
									onToggleSelect: toggleSelect,
									onSetSelection: setSelection,
									onClear: clearSelection,
								}}
								emptyState={
									<EmptyState
										label="NO FAILURES"
										title="Nothing to review here"
										subtext="No failed syncs need your attention."
									/>
								}
							/>
						</TabsContent>

						<TabsContent value="pullDrift">
							<TabPanelBody
								loading={itemsLoading}
								items={itemsData?.pullDrift ?? []}
								projectId={projectId}
								organizationId={organizationId}
								onActioned={invalidate}
								emptyState={
									pmConfigured ? (
										<EmptyState
											label="NO SYNC DRIFT"
											title="You're all caught up"
											subtext="No PM-side changes are waiting for review."
										/>
									) : (
										<EmptyState
											label="SYNC DRIFT"
											title="No PM tool connected"
											subtext="Sync drift appears here once a PM tool is connected."
										/>
									)
								}
							/>
						</TabsContent>
					</div>
				</Tabs>

				<div className="mt-4 border-t border-border pt-4">
					<button
						type="button"
						onClick={() => {
							onOpenChange(false);
							openSyncLog();
						}}
						className="inline-flex items-center gap-1 text-sm text-primary hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded-sm"
					>
						View all in Sync History
						<ArrowRightIcon className="size-3.5" aria-hidden />
					</button>
				</div>
			</SheetContent>
		</Sheet>
	);
}

type BulkConfig = {
	selected: Set<string>;
	onToggleSelect: (id: string, next: boolean) => void;
	onSetSelection: (ids: string[]) => void;
	onClear: () => void;
};

type TabPanelBodyProps = {
	loading: boolean;
	items: ReviewCenterItem[];
	projectId: string;
	organizationId: string | null;
	onActioned: () => void;
	emptyState: React.ReactNode;
	/** Present only on the bulk-capable Failures tab. */
	bulk?: BulkConfig;
};

/**
 * Renders one tab's content: a shared skeleton while items load, the category's
 * rows when present, or the per-tab empty state. One items query covers all
 * three groups, so a single skeleton covers whichever tab is active. On
 * bulk-capable tabs it also renders the select-all header, per-row checkboxes,
 * and the bulk toolbar.
 */
function TabPanelBody({
	loading,
	items,
	projectId,
	organizationId,
	onActioned,
	emptyState,
	bulk,
}: TabPanelBodyProps) {
	if (loading) {
		return (
			<div className="space-y-3">
				{["a", "b", "c"].map((key) => (
					<Skeleton key={key} className="h-20 w-full rounded-lg" />
				))}
			</div>
		);
	}

	if (items.length === 0) {
		return <>{emptyState}</>;
	}

	if (!bulk) {
		return (
			<ul className="space-y-3">
				{items.map((item) => (
					<ReviewCenterRow
						key={`${item.type}-${item.id}`}
						item={item}
						projectId={projectId}
						organizationId={organizationId}
						onActioned={onActioned}
					/>
				))}
			</ul>
		);
	}

	return (
		<BulkTabPanelBody
			items={items}
			projectId={projectId}
			organizationId={organizationId}
			onActioned={onActioned}
			bulk={bulk}
		/>
	);
}

type BulkTabPanelBodyProps = {
	items: ReviewCenterItem[];
	projectId: string;
	organizationId: string | null;
	onActioned: () => void;
	bulk: BulkConfig;
};

function BulkTabPanelBody({
	items,
	projectId,
	organizationId,
	onActioned,
	bulk,
}: BulkTabPanelBodyProps) {
	const t = useTranslations("tooltips.stories");
	const toolbarRef = useRef<HTMLDivElement>(null);
	const selectAllRef = useRef<HTMLButtonElement>(null);

	const eligible = useMemo(() => items.filter(isSelectable), [items]);
	const eligibleIds = useMemo(
		() => eligible.map((item) => item.id),
		[eligible],
	);
	const selectedCount = bulk.selected.size;
	const hadSelectionRef = useRef(false);

	// Selection cannot outlive the rows it points at: after a refetch drops
	// acted/resolved rows, prune any ids no longer loaded so the toolbar count
	// and the dispatched payloads stay truthful.
	useEffect(() => {
		const loaded = new Set(eligibleIds);
		const pruned = [...bulk.selected].filter((id) => loaded.has(id));
		if (pruned.length !== bulk.selected.size) {
			bulk.onSetSelection(pruned);
		}
	}, [eligibleIds, bulk]);

	const allSelected =
		eligibleIds.length > 0 && selectedCount === eligibleIds.length;
	const someSelected = selectedCount > 0 && !allSelected;

	const toggleAll = (next: boolean) => {
		bulk.onSetSelection(next ? eligibleIds : []);
	};

	// Move focus to the toolbar when it first appears so keyboard users discover
	// it; return focus to the select-all control when it is dismissed. No focus
	// trap.
	useEffect(() => {
		if (selectedCount > 0 && !hadSelectionRef.current) {
			hadSelectionRef.current = true;
			toolbarRef.current?.querySelector<HTMLElement>("button")?.focus();
		} else if (selectedCount === 0 && hadSelectionRef.current) {
			hadSelectionRef.current = false;
			selectAllRef.current?.focus();
		}
	}, [selectedCount]);

	return (
		<div className="space-y-3">
			<div className="flex items-center gap-2 px-1">
				<Checkbox
					ref={selectAllRef}
					checked={
						allSelected
							? true
							: someSelected
								? "indeterminate"
								: false
					}
					disabled={eligibleIds.length === 0}
					onCheckedChange={(next) => toggleAll(next === true)}
					aria-label={t("reviewSelectAll")}
				/>
				<span className="text-xs text-muted-foreground">
					{selectedCount > 0
						? `${selectedCount} selected`
						: t("reviewSelectAll")}
				</span>
			</div>

			{selectedCount > 0 && (
				<BulkToolbar
					ref={toolbarRef}
					items={items}
					selected={bulk.selected}
					projectId={projectId}
					organizationId={organizationId}
					onActioned={onActioned}
					onClear={bulk.onClear}
				/>
			)}

			<ul className="space-y-3">
				{items.map((item) => (
					<ReviewCenterRow
						key={`${item.type}-${item.id}`}
						item={item}
						projectId={projectId}
						organizationId={organizationId}
						onActioned={onActioned}
						selectable={isSelectable(item)}
						selected={bulk.selected.has(item.id)}
						onToggleSelect={bulk.onToggleSelect}
					/>
				))}
			</ul>
		</div>
	);
}

type BulkToolbarProps = {
	items: ReviewCenterItem[];
	selected: Set<string>;
	projectId: string;
	organizationId: string | null;
	onActioned: () => void;
	onClear: () => void;
};

/**
 * Bulk action toolbar for the Failures tab. Two bulk verbs:
 * - **Retry** — re-queues each selected Failures row to its PM tool, best-effort
 *   (each `{ id, itemType }`).
 * - **Dismiss** — clears the FAILED flag on each selected row so it leaves the
 *   queue (the terminal state for failures Retry can't resolve, e.g. a deleted
 *   card). Both fire immediately with no confirm dialog.
 *
 * "Clear selection" only deselects the rows — it never mutates anything (the
 * label was previously the ambiguous "Clear", mistaken for clearing failures).
 */
const BulkToolbar = function BulkToolbar({
	ref,
	items,
	selected,
	projectId,
	organizationId,
	onActioned,
	onClear,
}: BulkToolbarProps & { ref: React.Ref<HTMLDivElement> }) {
	const t = useTranslations("tooltips.stories");
	const [busy, setBusy] = useState(false);

	const selectedItems = useMemo(
		() => items.filter((item) => selected.has(item.id)),
		[items, selected],
	);

	const finish = (queued: number, skipped: number) => {
		toast.success(
			skipped > 0
				? `${queued} queued · ${skipped} skipped`
				: `${queued} queued`,
		);
		onClear();
		onActioned();
	};

	const runBulkRetry = async () => {
		setBusy(true);
		try {
			const result = await orpcClient.projects.stories.retryPmSyncBatch({
				projectId,
				items: selectedItems.map((item) => ({
					id: item.entityId,
					itemType: item.itemType,
				})),
				organizationId: organizationId ?? null,
			});
			const queued = result?.enqueuedCount ?? selectedItems.length;
			finish(queued, selectedItems.length - queued);
		} catch (error) {
			toast.error("Failed to retry syncs", {
				description:
					error instanceof Error ? error.message : String(error),
			});
		} finally {
			setBusy(false);
		}
	};

	const runBulkDismiss = async () => {
		setBusy(true);
		try {
			const result =
				await orpcClient.projects.stories.dismissPmSyncFailureBatch({
					projectId,
					items: selectedItems.map((item) => ({
						id: item.entityId,
						itemType: item.itemType,
					})),
					organizationId: organizationId ?? null,
				});
			const dismissed = result?.dismissedCount ?? selectedItems.length;
			toast.success(`${dismissed} dismissed`);
			onClear();
			onActioned();
		} catch (error) {
			toast.error("Failed to dismiss failures", {
				description:
					error instanceof Error ? error.message : String(error),
			});
		} finally {
			setBusy(false);
		}
	};

	return (
		<div
			ref={ref}
			role="toolbar"
			aria-label="Bulk actions"
			className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/40 p-2"
		>
			<span className="mr-auto text-xs text-muted-foreground">
				{`${selected.size} selected`}
			</span>

			<Tooltip>
				<TooltipTrigger asChild>
					<Button
						variant="outline"
						size="sm"
						className="h-7 text-xs"
						onClick={runBulkRetry}
						disabled={busy}
					>
						<RotateCcwIcon className="size-3 mr-1" aria-hidden />
						Retry
					</Button>
				</TooltipTrigger>
				<TooltipContent>{t("reviewBulkRetry")}</TooltipContent>
			</Tooltip>

			<Tooltip>
				<TooltipTrigger asChild>
					<Button
						variant="outline"
						size="sm"
						className="h-7 text-xs"
						onClick={runBulkDismiss}
						disabled={busy}
					>
						<XIcon className="size-3 mr-1" aria-hidden />
						Dismiss
					</Button>
				</TooltipTrigger>
				<TooltipContent>{t("reviewBulkDismiss")}</TooltipContent>
			</Tooltip>

			<Button
				variant="ghost"
				size="sm"
				className="h-7 text-xs"
				onClick={onClear}
				disabled={busy}
			>
				Clear selection
			</Button>
		</div>
	);
};

type EmptyStateProps = {
	label: string;
	title: string;
	subtext: string;
};

/**
 * Per-tab editorial empty state — warm-neutral surface, uppercase editorial
 * label, serif heading. No glassmorphism, no gradient orbs, design-system
 * tokens only.
 */
function EmptyState({ label, title, subtext }: EmptyStateProps) {
	return (
		<div className="flex flex-col items-center justify-center rounded-lg border border-border bg-muted/40 px-6 py-16 text-center">
			<span className="editorial-label">{label}</span>
			<p
				className="mt-3 text-xl font-normal text-foreground"
				style={{ fontFamily: "var(--font-serif)" }}
			>
				{title}
			</p>
			<p className="mt-2 max-w-xs text-sm text-muted-foreground">
				{subtext}
			</p>
		</div>
	);
}
