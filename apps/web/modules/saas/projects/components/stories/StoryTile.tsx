"use client";

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Checkbox } from "@ui/components/checkbox";
import { ContextMenu, ContextMenuTrigger } from "@ui/components/context-menu";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import { formatDistanceToNowStrict } from "date-fns";
import { GripVerticalIcon } from "lucide-react";
import { memo, type ReactNode } from "react";
import {
	DEFAULT_ROADMAP_COLUMN_ORDER,
	type RoadmapColumns,
	type RoadmapFieldKey,
} from "../../hooks/useRoadmapView";
import { formatLastEditSource } from "../../lib/last-edit-source-copy";
import { buildStoryDetailsRoute } from "../../lib/stories/routes";
import {
	getMaturationStatus,
	getSizeDescription,
	getSizeLabel,
	MATURATION_STATUS_META,
	type UserStory,
} from "../../lib/stories/types";
import { PmSyncCloudToggle } from "./pm-sync/PmSyncCloudToggle";
import { PmSyncConflictBadge } from "./pm-sync/PmSyncConflictBadge";
import { PmSyncFailureBadge } from "./pm-sync/PmSyncFailureBadge";
import { PmSyncPendingIndicator } from "./pm-sync/PmSyncPendingIndicator";
import { SourceChip } from "./SourceChip";
import { StageProgress } from "./StageProgress";
import { StoryActionsMenu } from "./StoryActionsMenu";
import {
	type StoryBulkActions,
	StoryContextActions,
} from "./StoryContextActions";
import { StoryKindIcon } from "./StoryKindIcon";

function initials(name: string | null | undefined): string {
	const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
	if (parts.length === 0) {
		return "—";
	}
	return parts
		.slice(0, 2)
		.map((w) => w[0]?.toUpperCase() ?? "")
		.join("");
}

/**
 * Compact vertical card for the kanban-style "Board" roadmap view. Mirrors the
 * row's data (identifier, title, stage/status badges, sync state, author +
 * editor provenance) but stacked, with the same column-visibility gating.
 */
function StoryTileImpl({
	story,
	projectId,
	organizationId,
	basePath = "/app",
	creatorName,
	columns,
	columnOrder,
	maturationV2 = false,
	canReorder = false,
	isSelected = false,
	selectedCount = 0,
	bulkActions,
	hasPMIntegration,
	pmToolName,
	onSelectionChange,
	onOpenDetails,
	onDelete,
}: {
	story: UserStory;
	projectId: string;
	organizationId?: string | null;
	basePath?: string;
	status?: { name: string; color: string } | null;
	creatorName?: string | null;
	columns?: Partial<RoadmapColumns>;
	columnOrder?: RoadmapFieldKey[];
	/** Maturation V2: render the dummy maturation status label instead of the
	 * five-stage StageProgress (matches StoryCard). Passed false in the
	 * stage-grouped board, whose columns still use the five-stage vocabulary. */
	maturationV2?: boolean;
	canReorder?: boolean;
	isSelected?: boolean;
	selectedCount?: number;
	bulkActions?: StoryBulkActions;
	hasPMIntegration?: boolean;
	pmToolName?: string;
	onSelectionChange?: (id: string, checked: boolean) => void;
	onOpenDetails?: (id: string) => void;
	onDelete?: (id: string) => void;
}) {
	// Right-click acts on the whole selection when this tile is part of one.
	const bulkMode = isSelected && selectedCount > 1 && bulkActions != null;
	// Open the story in a new browser tab (right-click / middle-click), matching
	// the table row. Programmatic anchor click so a PWA install opens a real tab.
	const openInNewTab = () => {
		if (!projectId || !story.id) {
			return;
		}
		const url = buildStoryDetailsRoute(basePath, projectId, story.id);
		// about:blank PWA workaround (mirrors StoryCard #1531): open a blank
		// same-origin tab first so the URL isn't routed into the installed PWA
		// window; null the opener for security, then navigate. Silent if
		// popup-blocked (window.open returns null).
		const w = window.open("about:blank", "_blank");
		if (!w) {
			return;
		}
		w.opener = null;
		w.location.href = url;
	};

	const {
		attributes,
		listeners,
		setNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({
		id: story.id,
		disabled: !canReorder,
		data: { type: "story" },
	});
	const dragStyle = {
		transform: CSS.Transform.toString(transform),
		transition,
	};
	const lastActivityAt = story.lastEditedAt ?? story.createdAt;

	return (
		<ContextMenu>
			<ContextMenuTrigger asChild>
				<div
					ref={setNodeRef}
					style={dragStyle}
					data-story-id={story.id}
					onMouseDown={(e) => {
						if (e.button === 1) {
							e.preventDefault();
							openInNewTab();
						}
					}}
					className={cn(
						"group rounded-lg border border-border/50 bg-card/40 p-2.5 transition-colors [content-visibility:auto] [contain-intrinsic-size:auto_92px] hover:border-border/80 hover:bg-card/70",
						isSelected && "border-primary/30 bg-primary/[0.06]",
						isDragging && "opacity-50",
					)}
				>
					<div className="flex items-start gap-2">
						{canReorder && (
							<button
								type="button"
								aria-label="Drag to reorder"
								className="mt-0.5 shrink-0 cursor-grab rounded text-muted-foreground/40 transition-colors hover:text-foreground active:cursor-grabbing"
								{...attributes}
								{...listeners}
								onClick={(e) => e.stopPropagation()}
							>
								<GripVerticalIcon className="size-3.5" />
							</button>
						)}
						<Checkbox
							checked={isSelected}
							onCheckedChange={(c) =>
								onSelectionChange?.(story.id, c === true)
							}
							className={cn(
								"mt-0.5 size-3.5 shrink-0 transition-opacity",
								!isSelected &&
									"opacity-0 group-hover:opacity-70",
							)}
							aria-label={`Select ${story.identifier}`}
						/>
						<button
							type="button"
							onClick={() => onOpenDetails?.(story.id)}
							className="min-w-0 flex-1 text-left"
						>
							<span className="flex items-center gap-1 font-mono text-[10px] text-muted-foreground/60">
								<StoryKindIcon
									kind={story.kind}
									priority={story.priority}
									className="size-3"
								/>
								{story.identifier}
							</span>
							<p className="mt-0.5 line-clamp-2 text-sm text-foreground hover:text-primary">
								{story.title}
							</p>
						</button>
						{/* PM sync cloud toggle — always shown (like the kebab), mirrors
				    the table row. Sits on the id row (top-aligned with the
				    kebab); the sync STATUS chip stays configurable below. */}
						<span className="-mt-1 shrink-0">
							<PmSyncCloudToggle
								storyId={story.id}
								projectId={projectId}
								organizationId={organizationId ?? null}
								pmAutoSyncEnabled={story.pmAutoSyncEnabled}
								externalId={story.externalId ?? null}
								externalUrl={story.externalUrl ?? null}
								hasPmIntegration={hasPMIntegration}
								pmToolName={pmToolName ?? "PM Tool"}
								lastPmSyncStatus={
									story.lastPmSyncStatus ?? null
								}
								lastPmSyncError={story.lastPmSyncError ?? null}
								lastSyncedAt={story.lastSyncedAt ?? null}
								source="card"
								size="sm"
								interactive={false}
							/>
						</span>
						<StoryActionsMenu
							story={story}
							projectId={projectId}
							organizationId={organizationId ?? null}
							basePath={basePath}
							onOpenDetails={onOpenDetails}
							onDelete={onDelete}
							triggerClassName="-mr-1 opacity-0 transition-opacity group-hover:opacity-60 hover:!opacity-100"
						/>
					</div>
					{(() => {
						// The inline chips, keyed so they can be emitted in the user's
						// configured column order (provenance is the footer, below).
						const chips: Partial<
							Record<RoadmapFieldKey, ReactNode>
						> = {};
						if (columns?.stage !== false) {
							if (maturationV2) {
								const meta =
									MATURATION_STATUS_META[
										getMaturationStatus(story)
									];
								chips.stage = (
									<span
										key="stage"
										className="inline-flex items-center gap-1.5 text-xs font-medium"
										style={{ color: meta.color }}
									>
										<span
											className="size-2 rounded-full shrink-0"
											style={{
												backgroundColor: meta.color,
											}}
										/>
										{meta.label}
									</span>
								);
							} else {
								chips.stage = (
									<StageProgress
										key="stage"
										stage={story.draftingStage}
										kind={story.kind}
									/>
								);
							}
						}
						if (columns?.size !== false && story.size) {
							chips.size = (
								<Tooltip key="size">
									<TooltipTrigger asChild>
										<span className="rounded-full border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground tabular-nums">
											{getSizeLabel(story.size)}
										</span>
									</TooltipTrigger>
									<TooltipContent>
										Size — {getSizeDescription(story.size)}
									</TooltipContent>
								</Tooltip>
							);
						}
						if (columns?.source !== false) {
							chips.source = (
								<SourceChip
									key="source"
									source={story.source}
									className="max-w-[120px] text-[9px]"
								/>
							);
						}
						// The SAME PM sync status chips as the table/plain rows (full
						// labels, no "Synced" pill — synced is shown by the cloud).
						if (columns?.sync !== false) {
							if (story.lastPmSyncStatus === "PENDING") {
								chips.sync = (
									<PmSyncPendingIndicator
										key="sync"
										pmToolName={pmToolName ?? "PM Tool"}
									/>
								);
							} else if (story.lastPmSyncStatus === "CONFLICT") {
								chips.sync = (
									<PmSyncConflictBadge
										key="sync"
										pmToolName={pmToolName ?? "PM Tool"}
									/>
								);
							} else if (story.lastPmSyncStatus === "FAILED") {
								chips.sync = (
									<PmSyncFailureBadge
										key="sync"
										pmToolName={pmToolName ?? "PM Tool"}
									/>
								);
							}
						}
						const ordered = (
							columnOrder ?? DEFAULT_ROADMAP_COLUMN_ORDER
						).filter((k) => chips[k]);
						if (ordered.length === 0) {
							return null;
						}
						return (
							<div className="mt-2 flex flex-wrap items-center gap-1.5 pl-[22px]">
								{ordered.map((k) => chips[k])}
							</div>
						);
					})()}
					{/* Last activity — one combined date at the bottom-left (matches the
			    table/plain views), with author + created/updated in the tooltip. */}
					<div className="mt-2 flex items-center gap-1 pl-[22px] text-[9px] text-muted-foreground/70">
						<Tooltip>
							<TooltipTrigger asChild>
								<span className="flex items-center gap-1">
									<span className="flex size-3.5 items-center justify-center rounded-full bg-muted text-[7px] font-medium text-muted-foreground/80">
										{initials(
											story.lastEditedAt
												? story.lastEditedByName
												: creatorName,
										)}
									</span>
									{formatDistanceToNowStrict(
										new Date(lastActivityAt),
										{
											addSuffix: true,
										},
									)}
								</span>
							</TooltipTrigger>
							<TooltipContent>
								<div className="space-y-1 text-[11px] leading-snug">
									<p>
										{`Created${
											creatorName
												? ` by ${creatorName}`
												: ""
										} · ${new Date(story.createdAt).toLocaleString()}`}
									</p>
									{story.lastEditedAt ? (
										<p>
											{`Updated${
												story.lastEditedByName
													? ` by ${story.lastEditedByName}`
													: ""
											} · ${new Date(story.lastEditedAt).toLocaleString()} · ${formatLastEditSource(
												story.lastEditedSource,
												pmToolName ?? null,
											)}`}
										</p>
									) : (
										<p className="text-muted-foreground/80">
											No edit recorded yet
										</p>
									)}
								</div>
							</TooltipContent>
						</Tooltip>
					</div>
				</div>
			</ContextMenuTrigger>
			<StoryContextActions
				story={story}
				projectId={projectId}
				organizationId={organizationId}
				basePath={basePath}
				onDelete={onDelete}
				bulkMode={bulkMode}
				selectedCount={selectedCount}
				bulkActions={bulkActions}
			/>
		</ContextMenu>
	);
}

// Memoized so unrelated roadmap-board re-renders don't re-render every tile —
// only those whose props change (story/status/bulkActions are stable; handlers
// are useCallback). Mirrors StoryCard.
export const StoryTile = memo(StoryTileImpl);
