"use client";

import {
	type CollisionDetection,
	closestCenter,
	DndContext,
	type DragEndEvent,
	type DragOverEvent,
	DragOverlay,
	type DragStartEvent,
	type DropAnimation,
	defaultDropAnimationSideEffects,
	getFirstCollision,
	KeyboardSensor,
	PointerSensor,
	pointerWithin,
	rectIntersection,
	type UniqueIdentifier,
	useDroppable,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import {
	arrayMove,
	SortableContext,
	sortableKeyboardCoordinates,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { pmDetectedTypeDisplayName } from "@repo/utils";
import { PageTourButton } from "@saas/get-started/components/PageTourButton";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { PromptSelector } from "@saas/prompts/components/PromptSelector";
import { ExecuteWithWeaveButton } from "@saas/weave/components";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, AlertDescription, AlertTitle } from "@ui/components/alert";
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
import { Checkbox } from "@ui/components/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import { Label } from "@ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { Skeleton } from "@ui/components/skeleton";
import { Textarea } from "@ui/components/textarea";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import {
	AlertTriangleIcon,
	ChevronDownIcon,
	CloudDownloadIcon,
	CloudUploadIcon,
	CopyIcon,
	EyeIcon,
	EyeOffIcon,
	FlagIcon,
	GitBranchIcon,
	HistoryIcon,
	Loader2Icon,
	PlusIcon,
	RefreshCwIcon,
	SettingsIcon,
	SparklesIcon,
	Trash2Icon,
} from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import {
	type HTMLAttributes,
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { orpcClient } from "../../../../shared/lib/orpc-client";
import { useDuplicateScan } from "../../hooks/useDuplicateScan";
import { useFeatureMaturationV2Enabled } from "../../hooks/useFeatureMaturationV2Enabled";
import { useRoadmapFilters } from "../../hooks/useRoadmapFilters";
import {
	PRIORITY_VIEW_ENABLED,
	type RoadmapViewMode,
	useRoadmapStoryOrder,
	useRoadmapView,
} from "../../hooks/useRoadmapView";
import { uploadStoryAttachment } from "../../lib/attachment-upload-utils";
import { uploadStoryImage } from "../../lib/image-upload-utils";
import {
	applyRoadmapFilters,
	partitionByNameMatch,
	selectHiddenMatches,
} from "../../lib/roadmap-filters";
import {
	compareStoriesByRelevance,
	computeMatchPercentById,
	narrowToNameMatches,
	scoreStoryAgainstQuery,
} from "../../lib/roadmap-search-relevance";
import {
	compareStoriesBy,
	DEFAULT_ROADMAP_SORT,
} from "../../lib/roadmap-sorts";
import { PRIORITY_SECTIONS, type PriorityKey } from "../../lib/roadmap-utils";
import {
	buildStoryDetailsRoute,
	PROPOSAL_PARAM,
} from "../../lib/stories/routes";
import type {
	CreateStoryInput,
	FeatureDraftingStage,
	MaturationStatus,
	StoryStatus,
	UserStory,
} from "../../lib/stories/types";
import {
	buildMaturationStatusMutationPayload,
	coverageBlockedToastMessage,
	getMaturationStatus,
	getSizeLabel,
	MATURATION_STATUS_META,
	PRIORITY_OPTIONS,
	SIZE_OPTIONS,
	transformStatus,
	transformStory,
} from "../../lib/stories/types";
import { submitCreateStoryWithAttachments } from "../../lib/submit-create-story-with-attachments";
import type { PendingDocAttachment } from "../../lib/text-attachment-validation";
import { CodingRunDialog } from "../coding-runs/CodingRunDialog";
import { StartImplementationSessionButton } from "../coding-runs/StartImplementationSessionButton";
import { AttachmentsField } from "./AttachmentsField";
import { BacklogAuditDialog, type HistoryView } from "./BacklogAuditDialog";
import { BacklogSessionHistoryDialog } from "./BacklogSessionHistoryDialog";
import { BulkUndoToast } from "./BulkUndoToast";
import { CreateStoryDocAttachmentsField } from "./CreateStoryDocAttachmentsField";
import { pullLifecycleSuffix } from "./lib/pull-lifecycle-suffix";
import { PendingBacklogProposalsInbox } from "./PendingBacklogProposalsInbox";
import { PendingProposalsBanner } from "./PendingProposalsBanner";
import { PullFromPMDialog } from "./PullFromPMDialog";
import { ReviewCenterPanel } from "./pm-sync/review-center/ReviewCenterPanel";
import { PriorityRankedList } from "./priority/PriorityRankedList";
import { RoadmapContextStrip, type RoadmapStats } from "./RoadmapContextStrip";
import { RoadmapEmptyState } from "./RoadmapEmptyState";
import { RoadmapFilterToolbar } from "./RoadmapFilterToolbar";
import { RoadmapSectionSwitcher } from "./RoadmapSectionSwitcher";
import { RoadmapSettingsMenu } from "./RoadmapSettingsMenu";
import { RoadmapSortControl } from "./RoadmapSortControl";
import { StoryCard } from "./StoryCard";
import { StoryKindIcon } from "./StoryKindIcon";
import { StoryTile } from "./StoryTile";
import { useSyncLogDeepLink } from "./sync-log-deep-link";
import { useConsumeSearchParam } from "./use-consume-search-param";

// The AI Backlog chat pulls in the full CopilotKit runtime (react-core +
// react-ui). Load it lazily on first open so it stays out of the roadmap's
// initial bundle.
const BacklogChatPanel = dynamic(
	() => import("./BacklogChatPanel").then((m) => m.BacklogChatPanel),
	{
		ssr: false,
		loading: () => (
			<div className="fixed inset-y-0 right-0 z-50 flex w-full items-center justify-center border-l bg-background sm:max-w-md">
				<Loader2Icon className="size-6 text-muted-foreground motion-safe:animate-spin" />
				<span className="sr-only">Loading AI Backlog…</span>
			</div>
		),
	},
);

// Smooth settle: the overlay eases back into the slot while the placeholder it
// leaves behind fades, instead of the item snapping into place.
const DRAG_DROP_ANIMATION: DropAnimation = {
	duration: 220,
	easing: "cubic-bezier(0.18, 0.67, 0.3, 1)",
	sideEffects: defaultDropAnimationSideEffects({
		styles: { active: { opacity: "0.4" } },
	}),
};

// ---- Query key helpers ----
const getStoriesQueryKey = (projectId: string, organizationId: string | null) =>
	orpc.projects.stories.list.queryKey({
		input: { projectId, organizationId },
	});
const _getStatusesQueryKey = (
	projectId: string,
	organizationId: string | null,
) =>
	orpc.projects.stories.statuses.list.queryKey({
		input: { projectId, organizationId },
	});

const PRIORITY_SECTION_DOT: Record<string, string> = {
	P0_CRITICAL: "bg-destructive",
	P1_HIGH: "bg-orange-500",
	P2_MEDIUM: "bg-yellow-500",
	P3_LOW: "bg-success",
};

// Left accent rail per priority lane (the section's "side line").
const PRIORITY_SECTION_RAIL: Record<string, string> = {
	P0_CRITICAL: "border-destructive/40",
	P1_HIGH: "border-orange-500/40",
	P2_MEDIUM: "border-yellow-500/40",
	P3_LOW: "border-success/40",
};

// Coding-run statuses that count as "active work" (drive the roadmap's
// auto-refresh poll). Module-level Set: O(1) membership + a stable identity so
// the active-work scan can be memoized.
const ACTIVE_CODING_RUN_STATUSES = new Set([
	"QUEUED",
	"STARTING",
	"RUNNING",
	"AWAITING_REVIEW",
	"PR_OPENED",
]);

// Stage lanes for the "Group by: Stage" mode, in drafting-flow order.
const STAGE_SECTIONS: { key: MaturationStatus; label: string }[] = [
	{ key: "TO_DO", label: "To Do" },
	{ key: "DISCOVERY", label: "Discovery" },
	{ key: "DONE", label: "Requirements Complete" },
];

// Below this length an embedded query carries no usable semantic signal and
// would only cost a paid model call per debounced keystroke.
const ROADMAP_AI_SEARCH_MIN_QUERY_LENGTH = 3;

// ---- Priority order for flat list sorting ----
const PRIORITY_ORDER: Record<string, number> = {
	P0_CRITICAL: 0,
	P1_HIGH: 1,
	P2_MEDIUM: 2,
	P3_LOW: 3,
};

// ---- Sync Selected Dialog ----
function SyncSelectedDialog({
	open,
	onOpenChange,
	stories,
	selectedStoryIds,
	pmToolName,
	isPending,
	onConfirm,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	stories: UserStory[];
	selectedStoryIds: Set<string>;
	pmToolName: string;
	isPending: boolean;
	onConfirm: () => void;
}) {
	const { newCount, updateCount } = useMemo(() => {
		let newCount = 0;
		let updateCount = 0;
		for (const id of selectedStoryIds) {
			const story = stories.find((s) => s.id === id);
			if (story?.externalId) {
				updateCount++;
			} else {
				newCount++;
			}
		}
		return { newCount, updateCount };
	}, [stories, selectedStoryIds]);

	const descriptionText =
		newCount > 0 && updateCount > 0
			? `Push ${newCount} new and update ${updateCount} existing work item${updateCount === 1 ? "" : "s"} to ${pmToolName}.`
			: updateCount > 0
				? `Update ${updateCount} existing work item${updateCount === 1 ? "" : "s"} in ${pmToolName}.`
				: `Push ${newCount} new work item${newCount === 1 ? "" : "s"} to ${pmToolName}.`;

	const confirmLabel =
		newCount > 0 && updateCount > 0
			? `Push ${newCount} new + update ${updateCount}`
			: updateCount > 0
				? `Update ${updateCount} work item${updateCount === 1 ? "" : "s"}`
				: `Push to ${pmToolName}`;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Sync selected work items</DialogTitle>
					<DialogDescription>{descriptionText}</DialogDescription>
				</DialogHeader>
				{updateCount > 0 && (
					<div className="border border-highlight/30 bg-highlight/5 rounded-lg p-3 flex items-start gap-2">
						<AlertTriangleIcon className="size-4 text-highlight shrink-0 mt-0.5" />
						<p className="text-sm text-foreground">
							Updating pushes your Fabric content to {pmToolName}.
							Any item that changed in {pmToolName} since the last
							sync is sent to the Review Center to resolve instead
							of being overwritten.
						</p>
					</div>
				)}
				<DialogFooter>
					<Button
						variant="outline"
						onClick={() => onOpenChange(false)}
					>
						Cancel
					</Button>
					<Button onClick={onConfirm} disabled={isPending}>
						{isPending ? (
							<>
								<Loader2Icon className="size-4 mr-2 animate-spin" />
								Syncing...
							</>
						) : (
							<>
								<CloudUploadIcon className="size-4 mr-2" />
								{confirmLabel}
							</>
						)}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

// A lane drop zone. Registering every lane (including a collapsed/empty one) as
// a dnd-kit droppable is what lets the cross-lane drag detect a hover over a
// lane that has no card targets of its own — so an empty lane is droppable and a
// collapsed lane can auto-expand on drag-over. `laneId` is the section key; the
// rest (className, data-*) pass through to the wrapper element.
function DroppableLane({
	laneId,
	className,
	children,
	...rest
}: {
	laneId: string;
	className?: string;
	children: ReactNode;
} & Omit<HTMLAttributes<HTMLDivElement>, "id">) {
	const { setNodeRef } = useDroppable({ id: laneId });
	return (
		<div ref={setNodeRef} className={className} {...rest}>
			{children}
		</div>
	);
}

// ---- Main component ----
type Props = {
	projectId: string;
	organizationSlug?: string | null;
};

export function StoriesRoadmap({ projectId }: Props) {
	const queryClient = useQueryClient();
	const router = useRouter();
	const searchParams = useSearchParams();
	// Deep-link target. When the user clicks the PM-sync conflict overlay on a
	// feature card or in the workspace breadcrumb, we route them to
	// `?tab=stories&storyId=<id>` so the existing `PmSyncConflictBadge` row is
	// the single resolution surface. The card key is exposed via
	// `id="story-<id>"` and `data-story-id` on StoryCard's outer node so this
	// effect can scroll the row into view and pulse a highlight ring once the
	// stories query has rendered.
	const focusStoryId = searchParams.get("storyId");
	const { organizationId, basePath } = useOrganizationContext();
	const tStories = useTranslations("tooltips.stories");
	const tCreateRoadmap = useTranslations("projects.stories.create");
	const tDuplicates = useTranslations("projects.stories.duplicates");
	const {
		filters: roadmapFilters,
		setFilters: setRoadmapFilters,
		clearAll: clearRoadmapFilters,
		removeFilter: removeRoadmapFilter,
		isActive: hasActiveRoadmapFilters,
		aiSearch,
		setAiSearch,
	} = useRoadmapFilters();
	const handleViewDuplicates = useCallback(() => {
		setRoadmapFilters({ duplicatesOnly: true });
	}, [setRoadmapFilters]);
	// Persisted view prefs (layout / grouping / fields + show-hidden), per
	// user+project in the DB. Sort is a live toolbar control (not persisted);
	// show-hidden persists immediately on toggle.
	const {
		mode,
		groupBy,
		columns,
		columnOrder,
		sort,
		setMode,
		setGroupBy,
		setColumns,
		setColumnOrder,
		setSort,
		showClosed,
		setShowClosed,
		toggleShowClosed,
		commitView,
		revertView,
		isViewDirty,
	} = useRoadmapView(projectId, organizationId);
	// Maturation V2: cards show the maturation status label when maturationV2 is enabled.
	const maturationV2Enabled = useFeatureMaturationV2Enabled();
	const showMaturationStatusChip = maturationV2Enabled;
	// Per-user manual order (drag-to-reorder) — personal to each teammate; the
	// shared story.roadmapOrder is the fallback for stories not yet placed.
	const { orderMap: roadmapOrderMap, reorderStories } = useRoadmapStoryOrder(
		projectId,
		organizationId,
	);
	const isSortDefault =
		sort.key === DEFAULT_ROADMAP_SORT.key &&
		sort.direction === DEFAULT_ROADMAP_SORT.direction;
	// Only the "Plain" layout flattens into a single list (global sort). Table
	// and Board keep their lanes and sort WITHIN each lane.
	const useFlatList = mode === "plain";
	// Priority is a peer SECTION of the roadmap, not a fourth way to draw the
	// work-item list — see RoadmapSectionSwitcher. It still rides on the
	// persisted `mode` so a teammate's saved choice survives, and so the
	// existing kill-switch (PRIORITY_VIEW_ENABLED) keeps working unchanged.
	const showingPriority = mode === "priority";
	// Where "Work items" returns you. Without it, leaving Priority would always
	// dump you on Table even if you had been on Board all week.
	const [lastLayoutMode, setLastLayoutMode] = useState<RoadmapViewMode>(() =>
		mode === "priority" ? "table" : mode,
	);
	const handleSectionChange = useCallback(
		(next: "items" | "priority") => {
			if (next === "priority") {
				setLastLayoutMode(mode === "priority" ? lastLayoutMode : mode);
				setMode("priority");
			} else {
				setMode(lastLayoutMode);
			}
		},
		[mode, lastLayoutMode, setMode],
	);
	// When the active sort matches the grouping dimension (in a grouped view),
	// the sort orders the LANES/GROUPS themselves (asc = canonical order, desc =
	// reversed) rather than items within a lane. Within-lane order then falls
	// back to the manual roadmap order.
	const sortsGroups =
		!useFlatList &&
		((groupBy === "priority" && sort.key === "priority") ||
			(groupBy === "stage" && sort.key === "stage"));

	const [activeStory, setActiveStory] = useState<UserStory | null>(null);
	const [selectedStoryIds, setSelectedStoryIds] = useState<Set<string>>(
		new Set(),
	);
	// Mirror the latest selection into a ref so the bulk-action callbacks can stay
	// referentially stable. Without this, `cardBulkActions` changes identity on
	// every select/deselect, which breaks the React.memo on every StoryCard and
	// re-renders the whole list on each selection change.
	const selectedStoryIdsRef = useRef(selectedStoryIds);
	selectedStoryIdsRef.current = selectedStoryIds;
	const [syncSelectedDialogOpen, setSyncSelectedDialogOpen] = useState(false);
	const [createDialogOpen, setCreateDialogOpen] = useState(false);
	const [createDialogStatusId, setCreateDialogStatusId] = useState<
		string | null
	>(null);

	// Coding run state
	const [activeCodingRunId, setActiveCodingRunId] = useState<string | null>(
		null,
	);
	// Guard: when a coding run dialog is about to open, suppress the
	// spurious navigation that Radix DropdownMenu close events can trigger
	// by passing pointer events through to the card title button.
	const codingRunPendingRef = useRef(false);

	// Weave execution state
	const [weaveStoryId, setWeaveStoryId] = useState<string | null>(null);
	const [weaveDialogOpen, setWeaveDialogOpen] = useState(false);
	const [implementationStoryId, setImplementationStoryId] = useState<
		string | null
	>(null);
	const [implementationDialogOpen, setImplementationDialogOpen] =
		useState(false);

	const handleCodingRunClick = useCallback((codingRunId: string) => {
		setActiveCodingRunId(codingRunId);
	}, []);

	const handleStartImplementationSession = useCallback((storyId: string) => {
		setImplementationStoryId(storyId);
		setImplementationDialogOpen(true);
	}, []);

	// Sync workflow state
	const [chatOpen, setChatOpen] = useState(false);
	const [pullFromPMDialogOpen, setPullFromPMDialogOpen] = useState(false);
	const [inboxOpen, setInboxOpen] = useState(false);
	// `?proposal=<id>` — how a work item links back to the proposal that created
	// it. The hook reports the id once (and strips the param); this state holds
	// it only for as long as the drawer it opened is on screen.
	//
	// Clearing it on close matters: the drawer selects whatever
	// `initialProposalId` it is given whenever it opens, so a value left behind
	// would make every LATER open — from the toolbar button, the failed banner,
	// anywhere — silently reopen the linked proposal instead of the list.
	const deepLinkedProposal = useConsumeSearchParam(PROPOSAL_PARAM);
	const [pendingProposalId, setPendingProposalId] = useState<string | null>(
		null,
	);
	useEffect(() => {
		if (deepLinkedProposal) {
			setPendingProposalId(deepLinkedProposal.value);
			setInboxOpen(true);
		}
	}, [deepLinkedProposal]);
	const handleInboxOpenChange = useCallback((next: boolean) => {
		setInboxOpen(next);
		if (!next) {
			setPendingProposalId(null);
		}
	}, []);
	// When the failed-proposals banner opens the inbox we want the Failed
	// group expanded and scrolled into view; the default "all" preserves
	// the existing behavior for every other inbox entry point.
	const [inboxDefaultFilter, setInboxDefaultFilter] = useState<
		"all" | "failed" | "backlog"
	>("all");
	// AI Backlog history surfaces (read-only). The Audit window (every change to
	// the roadmap's tickets) opens from the toolbar; the Session history (AI
	// Update runs) opens from inside the AI Update window, or from an Audit
	// "View AI session" link that deep-links to one session.
	// One piece of state for the history window: which log it is showing, or
	// null when closed. Open/closed and the selected tab always move together,
	// so splitting them just creates a pair that can disagree.
	// Open-ness and the selected tab are separate on purpose. Collapsing them
	// into one nullable state makes closing ALSO reset the view, and Radix keeps
	// the dialog mounted for its 200ms exit animation — so closing from Sync
	// History flashed the Change History title/panel and fired that tab's two
	// queries for data nobody would see. Both live here, in one owner, with no
	// mirrored copy inside the dialog; the view is only ever set when opening.
	const [historyOpen, setHistoryOpen] = useState(false);
	const [historyView, setHistoryView] = useState<HistoryView>("changes");
	const [sessionHistoryOpen, setSessionHistoryOpen] = useState(false);
	const [sessionFocusId, setSessionFocusId] = useState<string | null>(null);

	// `?history=sync` (from Project Management settings, or the Review Center
	// footer) opens the same window on its Sync History tab.
	const syncLogRequests = useSyncLogDeepLink();
	useEffect(() => {
		if (syncLogRequests > 0) {
			setHistoryView("sync");
			setHistoryOpen(true);
		}
	}, [syncLogRequests]);

	// Sync workflow state
	const [syncWorkflowId, setSyncWorkflowId] = useState<string | null>(null);
	const [syncDirection, setSyncDirection] = useState<"push" | "pull" | null>(
		null,
	);
	const [syncProgress, setSyncProgress] = useState<{
		status: string;
		syncedCount: number;
		totalStories: number;
		message: string;
	} | null>(null);
	// Opened from the post-sync "Review conflicts" toast CTA when a batch push
	// routes drifted items to the Review Center instead of overwriting them.
	const [reviewCenterOpen, setReviewCenterOpen] = useState(false);
	const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);

	// DnD sensors. The 8px activation distance keeps clicks/taps from starting a
	// drag; the keyboard sensor makes reordering operable without a pointer.
	const sensors = useSensors(
		useSensor(PointerSensor, {
			activationConstraint: { distance: 8 },
		}),
		useSensor(KeyboardSensor, {
			coordinateGetter: sortableKeyboardCoordinates,
		}),
	);

	// Pointer-based collision detection (the canonical multi-lane / kanban
	// strategy). Resolving the drop target under the POINTER — rather than by the
	// dragged rect's centre (closestCenter) — is what lets a card be dropped onto
	// a DIFFERENT lane (so a cross-lane drop changes priority/stage again), and it
	// feels snappier because it tracks the cursor, not the card's settled body.
	const recentlyMovedToNewContainer = useRef(false);
	const lastOverId = useRef<UniqueIdentifier | null>(null);
	const collisionDetectionStrategy: CollisionDetection = useCallback(
		(args) => {
			const pointerIntersections = pointerWithin(args);
			const intersections =
				pointerIntersections.length > 0
					? pointerIntersections
					: rectIntersection(args);
			let overId = getFirstCollision(intersections, "id");
			if (overId != null) {
				// When the pointer is over a LANE container (an empty/collapsed
				// lane has no card targets of its own), keep the container as the
				// target so the card migrates in. When the lane DOES have cards,
				// resolve to the nearest card so the insert index is precise.
				const lanes = dndLanesRef.current;
				if (lanes && (overId as string) in lanes) {
					const laneItemIds = lanes[overId as string];
					if (laneItemIds.length > 0) {
						const inner = getFirstCollision(
							closestCenter({
								...args,
								droppableContainers:
									args.droppableContainers.filter(
										(c) =>
											c.id !== overId &&
											laneItemIds.includes(
												c.id as string,
											),
									),
							}),
							"id",
						);
						if (inner != null) {
							overId = inner;
						}
					}
				}
				lastOverId.current = overId;
				return [{ id: overId }];
			}
			// A card that just hopped into a new lane can momentarily sit over
			// nothing — hold the last target so the gap doesn't flicker.
			if (recentlyMovedToNewContainer.current) {
				lastOverId.current = activeStory?.id ?? null;
			}
			return lastOverId.current
				? [{ id: lastOverId.current }]
				: closestCenter(args);
		},
		[activeStory],
	);

	// Fetch stories
	const {
		data: storiesData,
		isLoading: storiesLoading,
		refetch: refetchStories,
	} = useQuery({
		...orpc.projects.stories.list.queryOptions({
			input: { projectId, organizationId },
		}),
		refetchInterval: (query) => {
			const stories = query.state.data?.stories;
			if (stories?.some((s) => s.lastPmSyncStatus === "PENDING")) {
				return 3000;
			}
			return false;
		},
	});

	// ---- Duplicate detection (semantic scan + resolve) ----
	const {
		getDuplicateInfo,
		runScan: runDuplicateScan,
		isScanning: isScanningDuplicates,
		resolveDialog: duplicateResolveDialog,
		scanCompletionDialog: duplicateScanCompletionDialog,
	} = useDuplicateScan(projectId, organizationId, {
		onViewDuplicates: handleViewDuplicates,
	});

	// ---- AI (semantic) search mode (Fizzy #1937) ----
	// While the toggle is on and the debounced query clears the minimum
	// length, ranking comes from embedding similarity instead of the keyword
	// sort. The `q` URL value is already debounce-written by the toolbar, so
	// no second debounce here.
	const trimmedSearchQuery = roadmapFilters.q.trim();
	const aiSearchActive =
		aiSearch &&
		trimmedSearchQuery.length >= ROADMAP_AI_SEARCH_MIN_QUERY_LENGTH;
	const semanticSearch = useQuery({
		...orpc.projects.stories.semanticSearch.queryOptions({
			input: {
				projectId,
				query: trimmedSearchQuery,
			},
		}),
		enabled: aiSearchActive,
		refetchOnWindowFocus: false,
		// Each query's ranking stays fresh briefly so toggling modes or editing
		// back to an earlier query doesn't re-pay the embedding call.
		staleTime: 60_000,
	});
	// storyId → similarity score; present only once results are in hand. Until
	// then the roadmap keeps its keyword-ranked list and the toggle's spinner
	// signals that AI ranking is on its way.
	const semanticRankById = useMemo(() => {
		if (!aiSearchActive || !semanticSearch.data) {
			return null;
		}
		return new Map<string, number>(
			semanticSearch.data.results.map((r) => [r.storyId, r.score]),
		);
	}, [aiSearchActive, semanticSearch.data]);

	// Cold-backfill transparency: when the per-request embed cap left part of
	// the backlog unwarmed, say so instead of presenting partial ranking as
	// complete. Repeated searches warm more (most-recently-updated first).
	const aiCoverageNote = (() => {
		const coverage = semanticSearch.data?.coverage;
		if (!aiSearchActive || !coverage || coverage.skipped <= 0) {
			return null;
		}
		return `AI search warmed ${coverage.total - coverage.skipped} of ${coverage.total} work items — run it again to cover the rest`;
	})();

	// Scroll the deep-linked story (e.g. arrived from the PM-sync conflict
	// overlay → `?storyId=<id>`) into view and pulse a highlight ring so the
	// user can locate it on a long roadmap without scrolling manually. The
	// effect waits for the stories query to settle, then walks the DOM for
	// the matching card and applies a temporary `ring-2 ring-primary` class
	// for ~2 seconds. We only run it the FIRST time the param resolves
	// against the loaded data set; subsequent renders inside the same view
	// (drag, optimistic updates, refetch) won't re-scroll.
	const focusHandledRef = useRef<string | null>(null);
	useEffect(() => {
		if (!focusStoryId) {
			focusHandledRef.current = null;
			return;
		}
		if (focusHandledRef.current === focusStoryId) {
			return;
		}
		if (storiesLoading || !storiesData?.stories) {
			return;
		}
		const hasStory = storiesData.stories.some((s) => s.id === focusStoryId);
		if (!hasStory) {
			return;
		}
		// rAF to give the DOM one paint to render the card before we measure.
		const raf = requestAnimationFrame(() => {
			const node = document.getElementById(`story-${focusStoryId}`);
			if (!node) {
				return;
			}
			node.scrollIntoView({ behavior: "smooth", block: "center" });
			const inner = node.firstElementChild;
			if (inner instanceof HTMLElement) {
				inner.classList.add(
					"ring-2",
					"ring-primary",
					"ring-offset-2",
					"ring-offset-background",
				);
				window.setTimeout(() => {
					inner.classList.remove(
						"ring-2",
						"ring-primary",
						"ring-offset-2",
						"ring-offset-background",
					);
				}, 2000);
			}
			focusHandledRef.current = focusStoryId;
		});
		return () => cancelAnimationFrame(raf);
	}, [focusStoryId, storiesData?.stories, storiesLoading]);

	// Fetch statuses (needed for Add Feature)
	const { data: statusesData, isLoading: statusesLoading } = useQuery(
		orpc.projects.stories.statuses.list.queryOptions({
			input: { projectId, organizationId },
		}),
	);
	const statuses: StoryStatus[] = useMemo(
		() => (statusesData?.statuses ?? []).map(transformStatus),
		[statusesData?.statuses],
	);

	// Fetch PM capabilities
	const { data: pmCapabilitiesData } = useQuery(
		orpc.projects.stories.pmCapabilities.queryOptions({
			input: { projectId, organizationId },
		}),
	);

	// Fetch project members for assignee names
	const { data: membersData } = useQuery({
		...orpc.projects.members.list.queryOptions({
			input: { projectId, organizationId },
		}),
		enabled: !!projectId,
	});

	const assigneeNames = useMemo(() => {
		const members = membersData?.members;
		if (!members) {
			return {};
		}
		const map: Record<string, string> = {};
		for (const m of members) {
			const user = (m as { user?: { name?: string }; userId?: string })
				.user;
			const userId = (m as { userId?: string }).userId;
			if (userId && user?.name) {
				map[userId] = user.name;
			}
		}
		return map;
	}, [membersData?.members]);

	// Resolve workflow status (name + color) by id for the roadmap status badge.
	const statusById = useMemo(() => {
		const map: Record<string, { name: string; color: string }> = {};
		for (const s of statuses) {
			map[s.id] = { name: s.name, color: s.color };
		}
		return map;
	}, [statuses]);

	// Transform data. Memoized on the raw query data so the transformed array
	// (and every memo/selector + row keyed on it) keeps a stable identity
	// between renders — without this the whole filter/sort/group pipeline and
	// every card recompute on each render.
	const stories: UserStory[] = useMemo(
		() =>
			(storiesData?.stories ?? []).map((story) =>
				transformStory(story as Parameters<typeof transformStory>[0]),
			),
		[storiesData?.stories],
	);

	// Resolve a discarded duplicate's survivor identifier for the "Declined
	// duplicate" chip tooltip ("Merged into F-XXX"). Cheap memoized id→identifier
	// map over the loaded stories; survivors stay active so they're in the list.
	const identifierById = useMemo(
		() => new Map(stories.map((s) => [s.id, s.identifier])),
		[stories],
	);
	const mergedIntoIdentifierOf = useCallback(
		(s: UserStory): string | null =>
			s.mergedIntoStoryId
				? (identifierById.get(s.mergedIntoStoryId) ?? null)
				: null,
		[identifierById],
	);

	// Fetch project data (for name and organizationId in CopilotKit URL)
	const { data: projectData } = useQuery(
		orpc.projects.get.queryOptions({
			input: { id: projectId, organizationId },
		}),
	);

	// Detect Teams integration via project contexts
	const { data: integrationContexts } = useQuery(
		orpc.projects.contexts.list.queryOptions({
			input: { projectId, organizationId, type: "INTEGRATION" },
		}),
	);
	const hasTeamsIntegration = (integrationContexts?.contexts ?? []).some(
		(ctx: { metadata: unknown }) =>
			(ctx.metadata as Record<string, unknown>)?.provider ===
			"MICROSOFT_TEAMS",
	);

	const hasSlackIntegration = (integrationContexts?.contexts ?? []).some(
		(ctx: { metadata: unknown }) =>
			(ctx.metadata as Record<string, unknown>)?.provider === "SLACK",
	);

	// Detect Notion integration via MCP configs
	const { data: notionMcpConfigs } = useQuery({
		queryKey: ["mcp-configs-notion", organizationId],
		queryFn: async () => {
			const allConfigs = await orpcClient.mcp.configs.list({
				organizationId: organizationId ?? undefined,
			});
			return allConfigs.filter((cfg: (typeof allConfigs)[number]) => {
				if (!cfg.enabled) {
					return false;
				}
				const server = cfg.mcpServer;
				if (!server) {
					return false;
				}
				const key = server.key?.toLowerCase() || "";
				const name = server.name?.toLowerCase() || "";
				return key.includes("notion") || name.includes("notion");
			});
		},
	});
	const hasNotionIntegration = (notionMcpConfigs?.length ?? 0) > 0;

	// PM integration info. Keep `undefined` while the query is in flight so
	// downstream consumers (StoryCard → PmSyncCloudToggle) can render an
	// invisible placeholder rather than flashing the Red/Not-configured state.
	// `hasPMIntegration && ...` checks below treat undefined as falsy (JS
	// semantics), so the conditional renders elsewhere in this file are
	// unaffected.
	const hasPMIntegration: boolean | undefined =
		pmCapabilitiesData?.configured;
	const pmToolName =
		pmDetectedTypeDisplayName(pmCapabilitiesData?.detectedType) ??
		"PM Tool";
	const canPull = pmCapabilitiesData?.capabilities?.canList ?? false;

	// Flat sorted list, before user-applied filter UI is taken into account.
	// Used to compute the "of N" denominator in the result count.
	const visibleStories = useMemo(() => {
		return stories
			.filter(
				(s) =>
					s.draftingStage !== "DECLINED" &&
					(showClosed ||
						roadmapFilters.hiddenOnly ||
						s.draftingStage !== "CLOSED"),
			)
			.sort((a, b) => {
				const pa = PRIORITY_ORDER[a.priority] ?? 99;
				const pb = PRIORITY_ORDER[b.priority] ?? 99;
				if (pa !== pb) {
					return pa - pb;
				}
				const od = a.roadmapOrder - b.roadmapOrder;
				if (od !== 0) {
					return od;
				}
				// Locale-free string comparison: matches the global comparator's id
				// tiebreaker at roadmap-sorts.ts:140 and roadmap-utils.ts's compareRoadmap.
				return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
			});
	}, [stories, showClosed, roadmapFilters.hiddenOnly]);

	// Stats for the slim roadmap context strip. All four describe the SAME set —
	// `visibleStories` (what's on the roadmap now: declined always excluded, closed
	// excluded unless "show closed"/hidden-only is on) — so synced + unsynced always
	// equals work items, and the counts never disagree with each other. "Lanes"
	// counts groups that actually hold work in the ACTIVE grouping (priority or
	// stage); empty lanes only render as collapsed placeholders, so they don't count.
	const roadmapStats: RoadmapStats = useMemo(() => {
		const synced = visibleStories.filter((s) => !!s.externalId).length;
		const usedKeys = new Set<string>(
			visibleStories.map((s) =>
				groupBy === "stage"
					? s.draftingStage === "CLOSED"
						? "CLOSED"
						: getMaturationStatus(s)
					: (s.priority as string),
			),
		);
		const lanes =
			groupBy === "stage"
				? STAGE_SECTIONS.filter((s) => usedKeys.has(s.key)).length
				: PRIORITY_SECTIONS.filter((s) =>
						usedKeys.has(s.priority as string),
					).length;
		return {
			workItems: visibleStories.length,
			lanes,
			synced,
			unsynced: visibleStories.length - synced,
		};
	}, [visibleStories, groupBy]);

	// Body-only matches are collapsed behind a count, never dropped, and the
	// reveal is scoped to the query that produced it — retyping starts
	// collapsed again rather than silently carrying a stale reveal forward.
	const [bodyMatchesRevealedFor, setBodyMatchesRevealedFor] = useState<
		string | null
	>(null);
	const showBodyMatches = bodyMatchesRevealedFor === roadmapFilters.q;

	const searchResult = useMemo(() => {
		// AI mode drops the keyword tokens from filtering (FR6: semantic, not
		// keyword matching); every other facet still applies as usual.
		let filtered = applyRoadmapFilters(
			visibleStories,
			semanticRankById ? { ...roadmapFilters, q: "" } : roadmapFilters,
		);
		// The "Possible duplicates" facet is applied here rather than inside the
		// pure `applyRoadmapFilters` because the duplicate-link data lives in the
		// `useDuplicateScan` hook (client-only), not on the story rows. A story
		// qualifies when it is a member of at least one PENDING duplicate link.
		if (roadmapFilters.duplicatesOnly) {
			filtered = filtered.filter(
				(s) => getDuplicateInfo(s.id) !== undefined,
			);
		}
		// When the sort orders the lanes themselves, items within each lane keep
		// the manual roadmap order. The per-user order map overrides the shared
		// story.roadmapOrder so each teammate's drag sequence is personal.
		const fallbackSort = compareStoriesBy(
			sortsGroups ? DEFAULT_ROADMAP_SORT : sort,
			roadmapOrderMap,
		);
		// Revealing keeps the collapsed COUNT so the control can toggle back.
		const narrow = (ranked: UserStory[]) => {
			const result = narrowToNameMatches(ranked, roadmapFilters.q);
			return showBodyMatches ? { ...result, stories: ranked } : result;
		};
		// A search query replaces the active sort with title-weighted relevance;
		// equal scores fall back through the active sort. Clearing the query
		// restores the plain sort (FR9). Loaded AI results override both — and
		// narrow the list to what semantic matching surfaced. When semantic
		// matching surfaces NOTHING, fall back to the keyword-ranked list with
		// an honest notice rather than an empty roadmap: embeddings miss
		// complaint-style queries that vocabulary overlap would have caught.
		if (semanticRankById) {
			const semanticHits = filtered.filter((s) =>
				semanticRankById.has(s.id),
			);
			// AI ranking is never narrowed by name: it exists to find items
			// whose titles share no words with the query, so name-gating it
			// would defeat the mode.
			if (semanticHits.length > 0) {
				return {
					stories: semanticHits.sort(
						(a, b) =>
							(semanticRankById.get(b.id) ?? 0) -
							(semanticRankById.get(a.id) ?? 0),
					),
					collapsedCount: 0,
					narrowed: false,
				};
			}
			// Semantic matched nothing and the list fell back to KEYWORD
			// ranking — so it narrows like any other keyword ranking.
			return narrow(
				filtered.sort(
					compareStoriesByRelevance(roadmapFilters.q, fallbackSort),
				),
			);
		}
		if (roadmapFilters.q.trim().length === 0) {
			return {
				stories: filtered.sort(fallbackSort),
				collapsedCount: 0,
				narrowed: false,
			};
		}
		// Ranking alone reorders; narrowing is what shortens the list to the
		// items the query actually names (Fizzy #1937 follow-up).
		return narrow(
			filtered.sort(
				compareStoriesByRelevance(roadmapFilters.q, fallbackSort),
			),
		);
	}, [
		visibleStories,
		roadmapFilters,
		sort,
		sortsGroups,
		getDuplicateInfo,
		roadmapOrderMap,
		semanticRankById,
		showBodyMatches,
	]);
	const sortedStories = searchResult.stories;
	const bodyMatchCount = searchResult.collapsedCount;

	// True when AI mode ran, matched nothing above the floor, and the list
	// fell back to keyword ranking — the notice says so instead of silently
	// mixing modes.
	const semanticEmptyFallback = useMemo(() => {
		if (!semanticRankById) {
			return false;
		}
		return !visibleStories.some((s) => semanticRankById.has(s.id));
	}, [semanticRankById, visibleStories]);

	// Relative match strength (best result = 100) for the active search, in
	// either mode: raw scores are meaningless to users (keyword scores are
	// small integers, embedding scores are cosine similarities), but "how
	// strong is this hit vs the top hit" is honest in both.
	const matchPercentById = useMemo(() => {
		if (roadmapFilters.q.trim().length === 0) {
			return new Map<string, number>();
		}
		if (semanticRankById) {
			return computeMatchPercentById(sortedStories, semanticRankById);
		}
		const scoreById = new Map<string, number>();
		const score = scoreStoryAgainstQuery(roadmapFilters.q);
		for (const s of sortedStories) {
			const value = score(s);
			if (value > 0) {
				scoreById.set(s.id, value);
			}
		}
		return computeMatchPercentById(sortedStories, scoreById);
	}, [roadmapFilters.q, semanticRankById, sortedStories]);

	// Count of closed features in the project (for empty-state hint)
	const closedFeatureCount = useMemo(
		() => stories.filter((s) => s.draftingStage === "CLOSED").length,
		[stories],
	);

	// Hidden matches — HIDDEN (closed) items that satisfy the current
	// search/filters. They're excluded from the default view, so we surface a
	// count and an opt-in inline reveal instead of auto-showing them. Inert when
	// "Show hidden" is already on, OR when the "Hidden" filter (hiddenOnly) is
	// active, OR when an active Stage filter is set (which isolates active board items).
	// `duplicatesOnly` is applied here, where the client-only scan data is in scope.
	const hiddenMatches = useMemo(() => {
		if (
			showClosed ||
			roadmapFilters.hiddenOnly ||
			roadmapFilters.stage.length > 0
		) {
			return [];
		}
		// AI mode: hidden hits are CLOSED items among the semantic results,
		// facet-filtered WITHOUT the keyword tokens — the same rule the visible
		// list applies.
		if (semanticRankById) {
			const closedRanked = applyRoadmapFilters(
				stories.filter(
					(s) =>
						s.draftingStage === "CLOSED" &&
						semanticRankById.has(s.id),
				),
				{ ...roadmapFilters, q: "" },
				{ allowClosedInStageFilter: true },
			);
			const deduped = roadmapFilters.duplicatesOnly
				? closedRanked.filter(
						(s) => getDuplicateInfo(s.id) !== undefined,
					)
				: closedRanked;
			return [...deduped].sort(
				(a, b) =>
					(semanticRankById.get(b.id) ?? 0) -
					(semanticRankById.get(a.id) ?? 0),
			);
		}
		const matched = selectHiddenMatches(stories, roadmapFilters);
		const scoped = roadmapFilters.duplicatesOnly
			? matched.filter((s) => getDuplicateInfo(s.id) !== undefined)
			: matched;
		// Gate the hidden count exactly where the visible list is gated. Without
		// this the count could promise more rows than revealing hidden shows —
		// the revealed rows rejoin the visible list and are narrowed there.
		return searchResult.narrowed && !showBodyMatches
			? partitionByNameMatch(scoped, roadmapFilters.q).nameMatches
			: scoped;
	}, [
		stories,
		showClosed,
		roadmapFilters,
		getDuplicateInfo,
		semanticRankById,
		searchResult.narrowed,
		showBodyMatches,
	]);
	const hiddenMatchCount = hiddenMatches.length;

	const showHiddenMatchAffordance = !showClosed && hiddenMatchCount > 0;

	// Collapsible sections (grouped view). Component-local; defaults expanded.
	const [collapsedSections, setCollapsedSections] = useState<
		ReadonlySet<string>
	>(() => new Set<string>());
	const toggleSectionCollapsed = useCallback((key: string) => {
		setCollapsedSections((prev) => {
			const next = new Set(prev);
			if (next.has(key)) {
				next.delete(key);
			} else {
				next.add(key);
			}
			return next;
		});
	}, []);
	// Board (kanban) columns can be collapsed to a narrow rotated label —
	// manually, or automatically when a filter/search leaves them empty.
	const [collapsedBoardColumns, setCollapsedBoardColumns] = useState<
		ReadonlySet<string>
	>(() => new Set<string>());
	const toggleBoardColumnCollapsed = useCallback((key: string) => {
		setCollapsedBoardColumns((prev) => {
			const next = new Set(prev);
			if (next.has(key)) {
				next.delete(key);
			} else {
				next.add(key);
			}
			return next;
		});
	}, []);
	// An empty lane defaults to collapsed, but the user can still open it (e.g.
	// to drop a card in). This holds the empty lanes they explicitly expanded;
	// the same key space serves table + board (only one view is active). The
	// toggle on an empty lane flips its membership here instead of the normal
	// collapsed set.
	const [expandedEmptyKeys, setExpandedEmptyKeys] = useState<
		ReadonlySet<string>
	>(() => new Set<string>());
	const toggleExpandedEmpty = useCallback((key: string) => {
		setExpandedEmptyKeys((prev) => {
			const next = new Set(prev);
			if (next.has(key)) {
				next.delete(key);
			} else {
				next.add(key);
			}
			return next;
		});
	}, []);

	// Sections + grouping for the active group-by mode. Show-empty: every lane
	// renders even with 0 items.
	const sections = useMemo(() => {
		const base: { key: string; label: string }[] =
			groupBy === "stage"
				? STAGE_SECTIONS.map((s) => ({ key: s.key, label: s.label }))
				: PRIORITY_SECTIONS.map((s) => ({
						key: s.priority as string,
						label: s.label,
					}));
		if (groupBy === "stage" && (showClosed || roadmapFilters.hiddenOnly)) {
			base.push({ key: "CLOSED", label: "Hidden" });
		}
		// A group-ordering sort (sort dimension == group dimension) reverses the
		// canonical lane order on "desc"; "asc" keeps the canonical order.
		return sortsGroups && sort.direction === "desc"
			? [...base].reverse()
			: base;
	}, [
		groupBy,
		sortsGroups,
		sort.direction,
		showClosed,
		roadmapFilters.hiddenOnly,
	]);
	// Group the already-sorted list into lanes, PRESERVING the active sort order
	// within each lane (so "sort within sections" works for every sort key).
	const baseGroupedDisplay = useMemo<Record<string, UserStory[]>>(() => {
		const map: Record<string, UserStory[]> = {};
		if (groupBy === "stage") {
			for (const s of STAGE_SECTIONS) {
				map[s.key] = [];
			}
			if (showClosed || roadmapFilters.hiddenOnly) {
				map["CLOSED"] = [];
			}
			for (const story of sortedStories) {
				if (story.draftingStage === "CLOSED") {
					if (showClosed || roadmapFilters.hiddenOnly) {
						(map["CLOSED"] ??= []).push(story);
					}
				} else {
					(map[getMaturationStatus(story)] ??= []).push(story);
				}
			}
		} else {
			for (const s of PRIORITY_SECTIONS) {
				map[s.priority] = [];
			}
			for (const story of sortedStories) {
				(map[story.priority] ??= []).push(story);
			}
		}
		return map;
	}, [groupBy, sortedStories, showClosed, roadmapFilters.hiddenOnly]);

	// ---- Drag-to-reorder lane state (kanban multi-container pattern) ----
	// During a drag, `dndLanes` holds the LIVE lane→storyIds membership so that
	// `onDragOver` can migrate the dragged card into a different lane and the card
	// visibly glides there. Null when not dragging (render the derived grouping).
	const [dndLanes, setDndLanes] = useState<Record<string, string[]> | null>(
		null,
	);
	// The live lanes as a ref — the SYNCHRONOUS source of truth during a drag.
	// onDragStart/onDragOver write it immediately (not only via the post-render
	// effect, which lags a fast pointerup), so onDragEnd always reads the final
	// migration even when the drop fires before React commits the last state
	// update. Without this, fast cross-lane drops silently no-op.
	const dndLanesRef = useRef<Record<string, string[]> | null>(null);
	const storyById = useMemo(() => {
		const m = new Map<string, UserStory>();
		for (const s of sortedStories) {
			m.set(s.id, s);
		}
		return m;
	}, [sortedStories]);
	// The grouping the views actually render: the live drag state (so a cross-lane
	// migration is visible mid-drag), else the derived grouping.
	const groupedDisplay = useMemo<Record<string, UserStory[]>>(() => {
		if (!dndLanes) {
			return baseGroupedDisplay;
		}
		const map: Record<string, UserStory[]> = {};
		for (const key of Object.keys(dndLanes)) {
			map[key] = dndLanes[key]
				.map((id) => storyById.get(id))
				.filter((s): s is UserStory => s != null);
		}
		return map;
	}, [dndLanes, baseGroupedDisplay, storyById]);
	// Lane → storyIds derived from the saved grouping (the drag's starting point).
	const baseLaneIds = useMemo(() => {
		const out: Record<string, string[]> = {};
		for (const key of Object.keys(baseGroupedDisplay)) {
			out[key] = baseGroupedDisplay[key].map((s) => s.id);
		}
		return out;
	}, [baseGroupedDisplay]);
	// Which lane an id belongs to (a story id → its lane; a lane id → itself).
	const findContainer = useCallback(
		(id: UniqueIdentifier): string | undefined => {
			const lanes = dndLanesRef.current ?? baseLaneIds;
			if ((id as string) in lanes) {
				return id as string;
			}
			return Object.keys(lanes).find((k) =>
				lanes[k].includes(id as string),
			);
		},
		[baseLaneIds],
	);
	useEffect(() => {
		// Backstop: keep the ref in agreement with committed state after every
		// render, and clear the cross-lane flicker guard one frame later. The
		// handlers also write the ref synchronously (see dndLanesRef above).
		dndLanesRef.current = dndLanes;
		const raf = requestAnimationFrame(() => {
			recentlyMovedToNewContainer.current = false;
		});
		return () => cancelAnimationFrame(raf);
	}, [dndLanes]);

	// Deferred clear of the drag lanes. On drop we KEEP the dropped layout on
	// screen for two frames so the mutation's optimistic cache update lands first.
	// Clearing immediately would revert groupedDisplay to the (still-stale) server
	// grouping — the card would snap back to its origin and then teleport to the
	// drop target once the optimistic update arrived (the visible flicker).
	const dropClearRaf = useRef<number | null>(null);
	const cancelDropClear = useCallback(() => {
		if (dropClearRaf.current != null) {
			cancelAnimationFrame(dropClearRaf.current);
			dropClearRaf.current = null;
		}
	}, []);
	const clearDndLanes = useCallback(() => {
		cancelDropClear();
		dndLanesRef.current = null;
		setDndLanes(null);
	}, [cancelDropClear]);
	const scheduleDndLanesClear = useCallback(() => {
		cancelDropClear();
		dropClearRaf.current = requestAnimationFrame(() => {
			dropClearRaf.current = requestAnimationFrame(() => {
				dropClearRaf.current = null;
				dndLanesRef.current = null;
				setDndLanes(null);
			});
		});
	}, [cancelDropClear]);
	useEffect(() => cancelDropClear, [cancelDropClear]);

	// Active agents/coding-runs detection for auto-refresh. Memoized on `stories`
	// so this O(stories × tasks) scan doesn't re-run on every render (including
	// each drag-over state commit).
	const hasActiveWork = useMemo(
		() =>
			stories.some(
				(story) =>
					story.tasks.some(
						(task) =>
							task.agentStatus &&
							task.agentStatus !== "idle" &&
							task.agentStatus !== "completed" &&
							task.agentStatus !== "failed" &&
							task.agentStatus !== "cancelled",
					) ||
					(story.latestCodingRun != null &&
						ACTIVE_CODING_RUN_STATUSES.has(
							story.latestCodingRun.status,
						)),
			),
		[stories],
	);

	const agentRefreshRef = useRef<NodeJS.Timeout | null>(null);
	useEffect(() => {
		if (hasActiveWork) {
			agentRefreshRef.current = setInterval(() => {
				refetchStories();
			}, 5000);
		} else {
			if (agentRefreshRef.current) {
				clearInterval(agentRefreshRef.current);
				agentRefreshRef.current = null;
			}
		}
		return () => {
			if (agentRefreshRef.current) {
				clearInterval(agentRefreshRef.current);
				agentRefreshRef.current = null;
			}
		};
	}, [hasActiveWork, refetchStories]);

	// Clear selection when project changes
	useEffect(() => {
		setSelectedStoryIds(new Set());
	}, [projectId]);

	// Poll for sync progress
	useEffect(() => {
		if (!syncWorkflowId) {
			return;
		}

		// Tolerate transient errors (e.g. a one-off 500 from the progress endpoint
		// during a worker deploy or gRPC blip) instead of treating the first failure
		// as a hard "Sync failed". Bulk syncs poll for a while — especially with the
		// per-item conflict check — so an occasional blip is likely; only give up
		// after several consecutive failures.
		let consecutivePollErrors = 0;
		const pollProgress = async () => {
			try {
				const progress = await orpcClient.projects.stories.syncProgress(
					{
						projectId,
						workflowId: syncWorkflowId,
						organizationId,
					},
				);
				consecutivePollErrors = 0;

				setSyncProgress({
					status: progress.status,
					syncedCount: progress.syncedCount,
					totalStories: progress.totalStories,
					message: progress.message,
				});

				if (progress.syncedCount > 0) {
					queryClient.invalidateQueries({
						queryKey: getStoriesQueryKey(projectId, organizationId),
					});
				}

				if (
					progress.status === "completed" ||
					progress.status === "failed" ||
					progress.status === "cancelled"
				) {
					if (pollIntervalRef.current) {
						clearInterval(pollIntervalRef.current);
						pollIntervalRef.current = null;
					}
					setSyncWorkflowId(null);

					if (progress.status === "completed") {
						const conflicted = progress.conflictedCount ?? 0;
						const failed = progress.failedCount ?? 0;
						const synced = progress.syncedCount;
						if (conflicted > 0) {
							// Some items drifted in the PM tool and were routed to
							// the Review Center instead of being overwritten. Show a
							// clear synced/needs-review/failed breakdown plus a
							// direct resolution path (AC1–AC3).
							const parts: string[] = [];
							if (synced > 0) {
								parts.push(`${synced} synced`);
							}
							parts.push(`${conflicted} need review`);
							if (failed > 0) {
								parts.push(`${failed} failed`);
							}
							toast.warning(
								`Sync finished — ${parts.join(" · ")}`,
								{
									description: `${conflicted} item${
										conflicted === 1 ? "" : "s"
									} changed in ${pmToolName} since the last sync. Choose which version to keep in the Review Center.`,
									action: {
										label: "Review conflicts",
										onClick: () =>
											setReviewCenterOpen(true),
									},
									duration: 10000,
								},
							);
						} else if (failed > 0) {
							// Partial failure (no conflicts) — don't mask it behind
							// a green success toast.
							const parts: string[] = [];
							if (synced > 0) {
								parts.push(`${synced} synced`);
							}
							parts.push(`${failed} failed`);
							toast.error(
								`Sync finished — ${parts.join(" · ")}`,
								{
									description: progress.message,
								},
							);
						} else if (synced > 0) {
							const prep =
								syncDirection === "pull" ? "from" : "to";
							toast.success(
								`Synced ${synced} stories ${prep} ${pmToolName}`,
							);
						} else {
							toast.success("Sync finished");
						}
					} else if (progress.status === "cancelled") {
						toast.info("Sync cancelled");
					} else {
						toast.error("Sync failed", {
							description: progress.message,
						});
					}
					setSyncDirection(null);
					queryClient.invalidateQueries({
						queryKey: getStoriesQueryKey(projectId, organizationId),
					});
					setSyncProgress(null);
				}
			} catch (error) {
				const errorMessage =
					error instanceof Error ? error.message : "Unknown error";
				const workflowGone =
					errorMessage.includes("not found") ||
					errorMessage.includes("already completed");

				// A transient endpoint error (e.g. a 500 during a worker deploy) is
				// not a real failure — keep polling unless the workflow is gone or
				// the errors persist across several consecutive polls.
				if (!workflowGone && ++consecutivePollErrors < 4) {
					return;
				}

				if (pollIntervalRef.current) {
					clearInterval(pollIntervalRef.current);
					pollIntervalRef.current = null;
				}
				setSyncWorkflowId(null);
				setSyncDirection(null);
				setSyncProgress(null);

				if (workflowGone) {
					toast.info("Sync finished");
				} else {
					toast.error("Sync failed", { description: errorMessage });
				}
				queryClient.invalidateQueries({
					queryKey: getStoriesQueryKey(projectId, organizationId),
				});
			}
		};

		pollProgress();
		pollIntervalRef.current = setInterval(pollProgress, 1000);

		return () => {
			if (pollIntervalRef.current) {
				clearInterval(pollIntervalRef.current);
				pollIntervalRef.current = null;
			}
		};
	}, [
		syncWorkflowId,
		syncDirection,
		projectId,
		organizationId,
		pmToolName,
		queryClient,
	]);

	// ---- Mutations ----
	const moveStoryRoadmapMutation = useMutation({
		mutationFn: async (args: {
			storyId: string;
			newPriority: PriorityKey;
			insertBeforeId: string | null;
			// Optimistic-update support: client-computed reorder of the VISIBLE
			// peers. Server doesn't see this; it's used only to mutate the local
			// React Query cache so the dragged card snaps to its new spot
			// instantly. The server computes its own canonical ordering
			// (including hidden CLOSED peers) from `insertBeforeId`.
			optimisticTargetOrders: { id: string; roadmapOrder: number }[];
		}) => {
			return await orpcClient.projects.stories.moveRoadmap({
				projectId,
				organizationId: organizationId ?? null,
				storyId: args.storyId,
				newPriority: args.newPriority,
				insertBeforeId: args.insertBeforeId,
			});
		},
		onMutate: async (vars) => {
			const key = getStoriesQueryKey(projectId, organizationId);
			await queryClient.cancelQueries({ queryKey: key });
			const previous = queryClient.getQueryData(key);
			if (
				!previous ||
				typeof previous !== "object" ||
				!("stories" in previous)
			) {
				return { previous };
			}
			const prev = previous as unknown as { stories: UserStory[] };
			const map = new Map(
				vars.optimisticTargetOrders.map((o) => [o.id, o.roadmapOrder]),
			);
			const updatedStories = prev.stories.map((s) => {
				if (s.id === vars.storyId) {
					return {
						...s,
						priority: vars.newPriority,
						roadmapOrder: map.get(s.id) ?? s.roadmapOrder,
					};
				}
				if (map.has(s.id)) {
					return { ...s, roadmapOrder: map.get(s.id)! };
				}
				return s;
			});
			queryClient.setQueryData(key, {
				...prev,
				stories: updatedStories,
			} as unknown as typeof previous);
			return { previous };
		},
		// onSuccess invalidate is still critical: the server may have written
		// CLOSED peers we never touched optimistically.
		onSuccess: (_data, vars) => {
			const label =
				PRIORITY_OPTIONS.find((p) => p.value === vars.newPriority)
					?.label ?? vars.newPriority;
			toast.success(`Priority changed to ${label}`);
			queryClient.invalidateQueries({
				queryKey: getStoriesQueryKey(projectId, organizationId),
			});
		},
		onError: (error, _vars, context) => {
			if (context?.previous) {
				queryClient.setQueryData(
					getStoriesQueryKey(projectId, organizationId),
					context.previous,
				);
			}
			toast.error("Failed to move work item", {
				description: (error as Error).message,
			});
		},
	});

	// Cross-lane move while grouping by STAGE: set the story's drafting stage to
	// the lane it was dropped into (optimistic, so the card stays where dropped).
	const moveStoryStageMutation = useMutation({
		mutationFn: async (args: {
			storyId: string;
			targetStage: MaturationStatus | "CLOSED";
			isCurrentlyClosed: boolean;
		}) => {
			if (args.targetStage === "CLOSED") {
				return await orpcClient.projects.stories.updateDraftingStage({
					projectId,
					storyId: args.storyId,
					organizationId: organizationId ?? null,
					targetStage: "CLOSED",
				});
			}
			return await orpcClient.projects.stories.update({
				projectId,
				organizationId: organizationId ?? null,
				storyId: args.storyId,
				...buildMaturationStatusMutationPayload({
					mode: "set",
					targetMaturationStatus: args.targetStage,
					isCurrentlyClosed: args.isCurrentlyClosed,
				}),
			});
		},
		onMutate: async (vars) => {
			const key = getStoriesQueryKey(projectId, organizationId);
			await queryClient.cancelQueries({ queryKey: key });
			const previous = queryClient.getQueryData(key);
			if (
				!previous ||
				typeof previous !== "object" ||
				!("stories" in previous)
			) {
				return { previous };
			}
			const prev = previous as unknown as { stories: UserStory[] };
			const updated = prev.stories.map((s) => {
				if (s.id !== vars.storyId) return s;
				if (vars.targetStage === "CLOSED") {
					return { ...s, draftingStage: "CLOSED" };
				}
				const payload = buildMaturationStatusMutationPayload({
					mode: "set",
					targetMaturationStatus: vars.targetStage,
					isCurrentlyClosed: vars.isCurrentlyClosed,
				});
				return { ...s, ...payload };
			});
			queryClient.setQueryData(key, {
				...prev,
				stories: updated,
			} as unknown as typeof previous);
			return { previous };
		},
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: getStoriesQueryKey(projectId, organizationId),
			});
		},
		onError: (error, _vars, context) => {
			if (context?.previous) {
				queryClient.setQueryData(
					getStoriesQueryKey(projectId, organizationId),
					context.previous,
				);
			}
			const coverageMessage = coverageBlockedToastMessage(error);
			if (coverageMessage) {
				toast.error("Can't mark Requirements Complete yet", {
					description: coverageMessage,
				});
			} else {
				toast.error("Failed to move work item", {
					description: (error as Error).message,
				});
			}
		},
	});

	// Type-aware noun for single-item toasts. Mirrors StoryCard's "Hide bug" /
	// "Change to feature" labels so a deleted or synced Bug reads "Bug …" rather
	// than "Feature …". Delete has no optimistic removal, so the row is still in
	// `stories` when onSuccess runs.
	const storyKindNoun = (storyId: string): "Bug" | "Feature" =>
		stories.find((s) => s.id === storyId)?.kind === "BUG"
			? "Bug"
			: "Feature";

	const deleteStoryMutation = useMutation({
		mutationFn: async (storyId: string) => {
			return await orpcClient.projects.stories.delete({
				projectId,
				storyId,
			});
		},
		onSuccess: (_data, storyId) => {
			queryClient.invalidateQueries({
				queryKey: getStoriesQueryKey(projectId, organizationId),
			});
			toast.success(`${storyKindNoun(storyId)} deleted`);
		},
		onError: (error) => {
			toast.error("Failed to delete story", {
				description:
					error instanceof Error ? error.message : String(error),
			});
		},
	});

	// When a push hits PM_TOOL_MISMATCH the user is prompted to confirm
	// migration. The pending push is held here while the modal is open.
	const [migrationConfirm, setMigrationConfirm] = useState<{
		storyId: string;
	} | null>(null);

	const syncStoryMutation = useMutation({
		mutationFn: async ({
			storyId,
			direction,
			overrideMismatch,
		}: {
			storyId: string;
			direction: "push" | "pull";
			overrideMismatch?: boolean;
		}) => {
			return await orpcClient.projects.stories.sync({
				projectId,
				storyId,
				direction,
				organizationId,
				overrideMismatch,
			});
		},
		onSuccess: (data, variables) => {
			queryClient.invalidateQueries({
				queryKey: getStoriesQueryKey(projectId, organizationId),
			});
			if (variables.direction === "pull") {
				const lifecycleAction = (
					data as { lifecycleAction?: string } | undefined
				)?.lifecycleAction;
				const extra = pullLifecycleSuffix(lifecycleAction);
				toast.success(
					`${storyKindNoun(variables.storyId)} pulled from ${pmToolName}${extra}`,
				);
			} else {
				toast.success(
					`${storyKindNoun(variables.storyId)} pushed to ${pmToolName}`,
				);
			}
		},
		onError: (error, variables) => {
			const errorCode = (
				error as { data?: { errorCode?: string } } | undefined
			)?.data?.errorCode;
			// On push, surface a migration confirmation instead of a toast
			// — the user explicitly opts in to dropping the previous link.
			if (
				errorCode === "PM_TOOL_MISMATCH" &&
				variables.direction === "push" &&
				!variables.overrideMismatch
			) {
				setMigrationConfirm({ storyId: variables.storyId });
				return;
			}
			// A pull not-found that preserved a stamped link is informational, not
			// a hard failure — deletion is owned by the scheduled poll's review flag.
			const linkPreserved = (
				error as { data?: { linkPreserved?: boolean } } | undefined
			)?.data?.linkPreserved;
			if (errorCode === "EXTERNAL_ID_NOT_FOUND" && linkPreserved) {
				toast.warning(
					"Ticket not found in the PM tool — link kept. The scheduled sync will flag it if it was deleted.",
				);
				return;
			}
			toast.error("Failed to sync story", {
				description:
					error instanceof Error ? error.message : String(error),
			});
		},
	});

	// ---- Bulk actions on the current selection ----
	// Each action applies to every selected id and registers an Undo entry.
	// Priority / stage / visibility commit immediately and undo by re-applying
	// the captured old values; DELETE is deferred — the rows leave the UI at once
	// but the real server delete only fires when the 8s undo window expires, so
	// Undo just restores them. Undoing ANY active toast reverts ALL of them.
	const undoStackRef = useRef<
		Map<
			string,
			{
				onUndo: () => void | Promise<void>;
				onCommit?: () => void | Promise<void>;
			}
		>
	>(new Map());
	const undoIdRef = useRef(0);

	const runBulk = useCallback(
		async (ids: string[], perItem: (id: string) => Promise<unknown>) => {
			const results = await Promise.allSettled(ids.map(perItem));
			const ok = results.filter((r) => r.status === "fulfilled").length;
			return { ok, failed: results.length - ok };
		},
		[],
	);
	const patchStoriesCache = useCallback(
		(ids: Set<string>, patch: (s: UserStory) => UserStory) => {
			const key = getStoriesQueryKey(projectId, organizationId);
			const previous = queryClient.getQueryData(key);
			const prev = previous as { stories?: UserStory[] } | undefined;
			if (prev?.stories) {
				queryClient.setQueryData(key, {
					...prev,
					stories: prev.stories.map((s) =>
						ids.has(s.id) ? patch(s) : s,
					),
				} as unknown as typeof previous);
			}
			return previous;
		},
		[projectId, organizationId, queryClient],
	);
	const undoAllBulk = useCallback(() => {
		// Newest→oldest: each onUndo restores the cache snapshot it captured, and
		// the snapshots nest (a later op's snapshot already includes the earlier
		// ops' optimistic patches). Reverting in REVERSE applies the oldest
		// (pre-everything) snapshot last so it wins — stacking ops then "Undo"
		// lands on the clean baseline instead of an intermediate state, and for
		// same-field stacks the original-value server revert is the one fired last.
		const entries = Array.from(undoStackRef.current.entries()).reverse();
		undoStackRef.current.clear();
		for (const [id, entry] of entries) {
			toast.dismiss(id);
			void entry.onUndo();
		}
		if (entries.length > 0) {
			toast.success("Reverted");
		}
	}, []);
	// Show a 10s countdown toast with Undo. `onUndo` restores the change;
	// `onCommit` (delete only) runs the real, deferred server delete when the
	// window expires un-undone. Undo on ANY toast reverts ALL of them.
	const registerBulkUndo = useCallback(
		(
			message: string,
			onUndo: () => void | Promise<void>,
			onCommit?: () => void | Promise<void>,
		) => {
			undoIdRef.current += 1;
			const id = `bulk-undo-${undoIdRef.current}`;
			undoStackRef.current.set(id, { onUndo, onCommit });
			toast.custom(
				() => (
					<BulkUndoToast
						message={message}
						durationMs={10000}
						onUndo={undoAllBulk}
					/>
				),
				{
					id,
					duration: 10000,
					onAutoClose: () => {
						const entry = undoStackRef.current.get(id);
						undoStackRef.current.delete(id);
						void entry?.onCommit?.();
					},
					onDismiss: () => {
						undoStackRef.current.delete(id);
					},
				},
			);
		},
		[undoAllBulk],
	);

	// Snapshot the cache, apply `patch` to the selected stories, fire the
	// per-item update now, and register an undo that re-applies the captured old
	// field values to both the cache and the server.
	const applyBulkFieldChange = useCallback(
		(
			patch: (s: UserStory) => UserStory,
			perItem: (storyId: string, old?: UserStory) => Promise<unknown>,
			restore: (storyId: string, old: UserStory) => Promise<unknown>,
			message: (count: number) => string,
		) => {
			const ids = Array.from(selectedStoryIdsRef.current);
			if (ids.length === 0) {
				return;
			}
			const key = getStoriesQueryKey(projectId, organizationId);
			const previous = queryClient.getQueryData(key);
			const idSet = new Set(ids);
			const oldById = new Map(
				(
					(previous as { stories?: UserStory[] } | undefined)
						?.stories ?? []
				)
					.filter((s) => idSet.has(s.id))
					.map((s) => [s.id, s] as const),
			);
			patchStoriesCache(idSet, patch);
			setSelectedStoryIds(new Set());
			void runBulk(ids, (id) => perItem(id, oldById.get(id))).then(
				(res) => {
					if (res.failed > 0) {
						toast.error(`${res.failed} items failed to update`);
					}
					queryClient.invalidateQueries({ queryKey: key });
				},
			);
			registerBulkUndo(message(ids.length), async () => {
				if (previous !== undefined) {
					queryClient.setQueryData(key, previous as never);
				}
				const res = await runBulk(ids, (storyId) => {
					const old = oldById.get(storyId);
					return old ? restore(storyId, old) : Promise.resolve();
				});
				if (res.failed > 0) {
					toast.error(`${res.failed} items failed to restore`);
				}
				queryClient.invalidateQueries({ queryKey: key });
			});
		},
		[
			projectId,
			organizationId,
			queryClient,
			patchStoriesCache,
			runBulk,
			registerBulkUndo,
		],
	);

	const applyBulkPriority = useCallback(
		(priority: PriorityKey) => {
			const label =
				PRIORITY_OPTIONS.find((p) => p.value === priority)?.label ??
				priority;
			applyBulkFieldChange(
				(s) => ({ ...s, priority }),
				(storyId) =>
					orpcClient.projects.stories.update({
						projectId,
						storyId,
						organizationId: organizationId ?? null,
						priority,
					}),
				(storyId, old) =>
					orpcClient.projects.stories.update({
						projectId,
						storyId,
						organizationId: organizationId ?? null,
						priority: old.priority,
					}),
				(n) => `${n} moved to ${label}`,
			);
		},
		[applyBulkFieldChange, projectId, organizationId],
	);
	const applyBulkStage = useCallback(
		(targetStage: MaturationStatus) => {
			const label =
				MATURATION_STATUS_META[targetStage]?.label ?? targetStage;
			applyBulkFieldChange(
				(s) => ({
					...s,
					...buildMaturationStatusMutationPayload({
						mode: "set",
						targetMaturationStatus: targetStage,
						isCurrentlyClosed: s.draftingStage === "CLOSED",
					}),
				}),
				(storyId, old) =>
					orpcClient.projects.stories.update({
						projectId,
						storyId,
						organizationId: organizationId ?? null,
						...buildMaturationStatusMutationPayload({
							mode: "set",
							targetMaturationStatus: targetStage,
							isCurrentlyClosed: old?.draftingStage === "CLOSED",
						}),
					}),
				(storyId, old) =>
					orpcClient.projects.stories.update({
						projectId,
						storyId,
						organizationId: organizationId ?? null,
						maturationStatus: old.maturationStatus || null,
						draftingStage: old.draftingStage,
					}),
				(n) => `${n} moved to ${label}`,
			);
		},
		[applyBulkFieldChange, projectId, organizationId],
	);
	const applyBulkHideShow = useCallback(
		(hidden: boolean) => {
			const targetStage: FeatureDraftingStage = hidden
				? "CLOSED"
				: "DRAFT";
			applyBulkFieldChange(
				(s) => ({ ...s, draftingStage: targetStage }),
				(storyId) =>
					orpcClient.projects.stories.updateDraftingStage({
						projectId,
						storyId,
						organizationId: organizationId ?? null,
						targetStage,
					}),
				(storyId, old) =>
					orpcClient.projects.stories.updateDraftingStage({
						projectId,
						storyId,
						organizationId: organizationId ?? null,
						targetStage: old.draftingStage,
					}),
				(n) => `${n} ${hidden ? "hidden" : "shown"}`,
			);
		},
		[applyBulkFieldChange, projectId, organizationId],
	);
	// Delete is DEFERRED: rows leave the UI immediately, but the real server
	// delete only runs when the 8s undo window closes un-undone. Undo restores
	// the cache (nothing was deleted server-side yet).
	const applyBulkDelete = useCallback(() => {
		const ids = Array.from(selectedStoryIds);
		if (ids.length === 0) {
			return;
		}
		const key = getStoriesQueryKey(projectId, organizationId);
		const previous = queryClient.getQueryData(key);
		const prev = previous as { stories?: UserStory[] } | undefined;
		if (prev?.stories) {
			const idSet = new Set(ids);
			queryClient.setQueryData(key, {
				...prev,
				stories: prev.stories.filter((s) => !idSet.has(s.id)),
			} as unknown as typeof previous);
		}
		setSelectedStoryIds(new Set());
		registerBulkUndo(
			`${ids.length} deleted`,
			() => {
				if (previous !== undefined) {
					queryClient.setQueryData(key, previous as never);
				}
			},
			async () => {
				await runBulk(ids, (storyId) =>
					orpcClient.projects.stories.delete({ projectId, storyId }),
				);
				queryClient.invalidateQueries({ queryKey: key });
			},
		);
	}, [projectId, organizationId, queryClient, runBulk, registerBulkUndo]);
	// Bulk operations on the current selection, handed to each card so its
	// right-click menu can act on the whole selection (not just that row).
	const cardBulkActions = useMemo(
		() => ({
			setPriority: applyBulkPriority,
			setStage: applyBulkStage,
			hide: () => applyBulkHideShow(true),
			show: () => applyBulkHideShow(false),
			requestDelete: applyBulkDelete,
		}),
		[applyBulkPriority, applyBulkStage, applyBulkHideShow, applyBulkDelete],
	);

	const bulkSyncMutation = useMutation({
		mutationFn: async ({
			direction,
			storyIds,
			pmExternalIds,
		}: {
			direction?: "push" | "pull";
			storyIds?: string[];
			pmExternalIds?: string[];
		} = {}) => {
			return await orpcClient.projects.stories.syncBulk({
				projectId,
				organizationId,
				unsyncedOnly: storyIds ? false : direction !== "pull",
				storyIds,
				direction: direction ?? "push",
				pmExternalIds,
			});
		},
		onSuccess: (data, variables) => {
			if (data.workflowId) {
				const dir = variables.direction ?? "push";
				setSyncWorkflowId(data.workflowId);
				setSyncDirection(dir);
				setSyncProgress({
					status: "initializing",
					syncedCount: 0,
					totalStories: variables.storyIds?.length ?? 0,
					message:
						dir === "push"
							? "Starting push..."
							: "Listing work items from PM...",
				});
				toast.info(
					dir === "push"
						? `Pushing ${variables.storyIds?.length ?? "selected"} stories to ${pmToolName}...`
						: `Pulling from ${pmToolName}...`,
				);
			} else {
				toast.error("Failed to start sync", {
					description:
						"Workflow could not be created. Check PM tool configuration.",
				});
			}
		},
		onError: (error) => {
			toast.error("Failed to start sync", {
				description:
					error instanceof Error ? error.message : String(error),
			});
		},
	});

	const toggleTaskMutation = useMutation({
		mutationFn: async ({
			storyId,
			taskId,
		}: {
			storyId: string;
			taskId: string;
		}) => {
			return await orpcClient.projects.stories.tasks.toggle({
				projectId,
				storyId,
				taskId,
			});
		},
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: getStoriesQueryKey(projectId, organizationId),
			});
		},
	});

	const createStoryMutation = useMutation({
		mutationFn: async (
			input: CreateStoryInput & { organizationId: string | null },
		) => {
			return await orpcClient.projects.stories.create(input);
		},
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: getStoriesQueryKey(projectId, organizationId),
			});
			// Dialog close is now driven by submitCreateStoryWithAttachments
			// AFTER the deferred-upload + updateStory pipeline resolves. Closing
			// here would race the uploads (silent data loss).
			// Success / failure / soft-warn toasts are owned by the
			// CreateStoryDialog (spec §4.2 — "Generating title…" → "Title
			// generated." or "Title generation failed — …"). The dialog
			// drives them via its own async submit handler so the loading
			// toast and the success toast share the same sonner id; this
			// onSuccess only handles non-toast side effects.
			// router.push moved into the dialog's onSubmit chain (below) so
			// navigation only fires AFTER uploads + updateStory finish
			// (Codex review of PR 1 caught this race — see also the parallel
			// fix in Kanban where setCreateDialogOpen(false) was removed
			// from this same callback).
		},
		// onError intentionally omitted: the dialog's submit handler awaits
		// `mutateAsync` and routes the rejection to `toast.error` with the
		// loading-toast id, avoiding a duplicate generic error toast here.
	});

	// Used by submitCreateStoryWithAttachments to patch the new story's
	// description with the ## Attachments markdown block after image uploads
	// resolve. Mirrors the shape of other stories.update call sites in the
	// codebase (see StoryCard.tsx).
	const updateStoryMutation = useMutation({
		mutationFn: async (input: {
			projectId: string;
			storyId: string;
			organizationId: string | null;
			description: string;
		}) => {
			return await orpcClient.projects.stories.update(input);
		},
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: getStoriesQueryKey(projectId, organizationId),
			});
		},
	});

	// ---- Handlers ----
	// F-171: single +Add button (no kind discriminator). The classifier in
	// createStoryFromProposal decides BUG vs FEATURE server-side from the
	// description text the user enters.
	const handleAddStory = useCallback(() => {
		const defaultStatus = statuses.find((s) => s.isDefault) ?? statuses[0];
		if (!defaultStatus) {
			return;
		}
		setCreateDialogStatusId(defaultStatus.id);
		setCreateDialogOpen(true);
	}, [statuses]);

	const handleSelectStory = useCallback(
		(storyId: string) => {
			if (codingRunPendingRef.current) {
				return;
			}
			router.push(buildStoryDetailsRoute(basePath, projectId, storyId));
		},
		[router, basePath, projectId],
	);

	const handleOpenDetails = useCallback(
		(storyId: string) => {
			if (codingRunPendingRef.current) {
				return;
			}
			router.push(buildStoryDetailsRoute(basePath, projectId, storyId));
		},
		[router, basePath, projectId],
	);

	const handleDeleteStory = useCallback(
		(storyId: string) => {
			deleteStoryMutation.mutate(storyId);
		},
		[deleteStoryMutation],
	);

	const handleSyncStory = useCallback(
		(storyId: string, direction: "push" | "pull") => {
			syncStoryMutation.mutate({ storyId, direction });
		},
		[syncStoryMutation],
	);

	const handleTaskToggle = useCallback(
		(storyId: string, taskId: string) => {
			toggleTaskMutation.mutate({ storyId, taskId });
		},
		[toggleTaskMutation],
	);

	const handleStorySelectionChange = useCallback(
		(storyId: string, checked: boolean) => {
			setSelectedStoryIds((prev) => {
				const next = new Set(prev);
				if (checked) {
					next.add(storyId);
				} else {
					next.delete(storyId);
				}
				return next;
			});
		},
		[],
	);
	// Selection helpers: global select-all + per-lane select-all + clear.
	const allVisibleIds = useMemo(
		() => sortedStories.map((s) => s.id),
		[sortedStories],
	);
	const allSelected =
		allVisibleIds.length > 0 &&
		allVisibleIds.every((id) => selectedStoryIds.has(id));
	const toggleSelectAll = useCallback(() => {
		setSelectedStoryIds((prev) =>
			allVisibleIds.every((id) => prev.has(id))
				? new Set()
				: new Set(allVisibleIds),
		);
	}, [allVisibleIds]);
	const setSectionSelected = useCallback(
		(ids: string[], checked: boolean) => {
			setSelectedStoryIds((prev) => {
				const next = new Set(prev);
				for (const id of ids) {
					if (checked) {
						next.add(id);
					} else {
						next.delete(id);
					}
				}
				return next;
			});
		},
		[],
	);
	const clearSelection = useCallback(
		() => setSelectedStoryIds(new Set()),
		[],
	);

	const handleExecuteWithWeave = useCallback((storyId: string) => {
		codingRunPendingRef.current = true;
		requestAnimationFrame(() => {
			setWeaveStoryId(storyId);
			setWeaveDialogOpen(true);
			codingRunPendingRef.current = false;
		});
	}, []);

	const handleRefresh = useCallback(() => {
		setSelectedStoryIds(new Set());
		refetchStories();
	}, [refetchStories]);

	const handleBulkPull = useCallback(() => {
		setPullFromPMDialogOpen(true);
	}, []);

	const handlePullFromPMConfirm = useCallback(
		(pmExternalIds: string[]) => {
			setPullFromPMDialogOpen(false);
			bulkSyncMutation.mutate({ direction: "pull", pmExternalIds });
		},
		[bulkSyncMutation],
	);

	// ---- DnD handlers ----
	const handleDragStart = useCallback(
		(event: DragStartEvent) => {
			// Reorder is disabled while filters are active because the visible
			// bucket is a subset of the persisted bucket. Suppress the drag
			// overlay so the gesture has no visual feedback. Also disabled
			// when sort is non-default — the visible order no longer matches
			// the persisted roadmapOrder.
			if (hasActiveRoadmapFilters || !isSortDefault) {
				return;
			}
			// A drop may have a deferred lane-clear still pending — cancel it so it
			// can't wipe the snapshot we're about to take for this new drag.
			cancelDropClear();
			// Clear selection on drag-start so the checkbox selection and the
			// drag gesture never collide.
			setSelectedStoryIds(new Set());
			const story = stories.find((s) => s.id === event.active.id);
			if (story) {
				setActiveStory(story);
			}
			// Snapshot the lanes so onDragOver can migrate the card between them.
			// Write the ref synchronously too — onDragEnd reads it, and the
			// post-render effect would otherwise be a frame behind.
			dndLanesRef.current = baseLaneIds;
			setDndLanes(baseLaneIds);
		},
		[
			stories,
			hasActiveRoadmapFilters,
			isSortDefault,
			baseLaneIds,
			cancelDropClear,
		],
	);

	// Kanban migration: as the card is dragged over a different lane, move it into
	// that lane in the live state so it visibly glides across (the canonical
	// dnd-kit multiple-containers handler).
	const handleDragOver = useCallback(
		(event: DragOverEvent) => {
			const { active, over } = event;
			const overId = over?.id;
			if (overId == null) {
				return;
			}
			// Read the live lanes from the ref (the synchronous source of truth) so
			// successive onDragOver calls within one drag compose correctly.
			const lanes = dndLanesRef.current;
			if (!lanes) {
				return;
			}
			const overContainer = findContainer(overId);
			const activeContainer = findContainer(active.id);
			if (
				!overContainer ||
				!activeContainer ||
				activeContainer === overContainer
			) {
				return;
			}
			const activeItems = lanes[activeContainer];
			const overItems = lanes[overContainer];
			const overIndex = overItems.indexOf(String(overId));
			const activeId = String(active.id);
			let newIndex: number;
			if ((overId as string) in lanes) {
				// Dropped onto the lane itself (e.g. empty area) → append.
				newIndex = overItems.length + 1;
			} else {
				const isBelowOverItem =
					over &&
					active.rect.current.translated &&
					active.rect.current.translated.top >
						over.rect.top + over.rect.height;
				newIndex =
					overIndex >= 0
						? overIndex + (isBelowOverItem ? 1 : 0)
						: overItems.length + 1;
			}
			recentlyMovedToNewContainer.current = true;
			const next = {
				...lanes,
				[activeContainer]: activeItems.filter((id) => id !== activeId),
				[overContainer]: [
					...overItems.slice(0, newIndex),
					activeId,
					...overItems.slice(newIndex),
				],
			};
			// Commit to the ref synchronously, then re-render. onDragEnd reading the
			// ref therefore sees the final migration even if the drop fires before
			// React commits this update — the cause of dropped cross-lane moves.
			dndLanesRef.current = next;
			setDndLanes(next);
		},
		[findContainer],
	);

	const handleDragEnd = useCallback(
		(event: DragEndEvent) => {
			const { active, over } = event;
			const finalLanes = dndLanesRef.current;
			// Do NOT clear dndLanes synchronously on a real drop. Clearing reverts
			// groupedDisplay to the (still-stale) server grouping, so the card snaps
			// back to its origin and then teleports once the optimistic update lands.
			// Instead we hold the dropped layout and clear it a couple of frames
			// later (scheduleDndLanesClear), by which point the optimistic cache
			// write has caught up and the swap is seamless.
			setActiveStory(null);
			if (hasActiveRoadmapFilters || !isSortDefault) {
				clearDndLanes();
				toast.info(
					hasActiveRoadmapFilters
						? "Clear filters to reorder work items."
						: "Switch to Roadmap order to reorder work items.",
				);
				return;
			}
			if (!finalLanes) {
				clearDndLanes();
				return;
			}
			const activeId = String(active.id);
			// Resolve the dragged story from the canonical map (useSortable only
			// carries { type } in its drag data, so reading active.data.current.story
			// would always be undefined and skip the move).
			const activeStoryData = storyById.get(activeId);
			if (!activeStoryData) {
				clearDndLanes();
				return;
			}
			const finalLane = Object.keys(finalLanes).find((k) =>
				finalLanes[k].includes(activeId),
			);
			if (!finalLane) {
				clearDndLanes();
				return;
			}
			// The lane the card started in (its real priority/stage before drag).
			const originalLane =
				groupBy === "stage"
					? activeStoryData.draftingStage === "CLOSED"
						? "CLOSED"
						: getMaturationStatus(activeStoryData)
					: (activeStoryData.priority as string);
			const laneOrder = finalLanes[finalLane];

			if (finalLane !== originalLane) {
				// Cross-lane: change the grouping dimension to the dropped lane. The
				// migrated layout already sits in dndLanes — hold it until the
				// optimistic update lands, then clear.
				if (groupBy === "stage") {
					moveStoryStageMutation.mutate({
						storyId: activeId,
						targetStage: finalLane as MaturationStatus | "CLOSED",
						isCurrentlyClosed:
							activeStoryData.draftingStage === "CLOSED",
					});
				} else {
					const idx = laneOrder.indexOf(activeId);
					const insertBeforeId =
						idx >= 0 && idx < laneOrder.length - 1
							? laneOrder[idx + 1]
							: null;
					moveStoryRoadmapMutation.mutate({
						storyId: activeId,
						newPriority: finalLane as PriorityKey,
						insertBeforeId,
						optimisticTargetOrders: laneOrder.map((id, i) => ({
							id,
							roadmapOrder: i + 1,
						})),
					});
				}
				scheduleDndLanesClear();
				return;
			}

			// Within-lane: per-user reorder (never writes the shared order).
			// onDragOver only migrates across lanes, so for a same-lane drag the
			// lane order is still the pre-drag sequence — compute the move here from
			// the drop target (the canonical kanban commits within-lane in onDragEnd).
			const overId = over?.id != null ? String(over.id) : null;
			const fromIndex = laneOrder.indexOf(activeId);
			const toIndex = overId ? laneOrder.indexOf(overId) : -1;
			if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) {
				// Dropped in place or outside any card — nothing to persist.
				clearDndLanes();
				return;
			}
			const reordered = arrayMove(laneOrder, fromIndex, toIndex);
			// Reflect the reorder in the live lanes so the card holds its dropped
			// slot until the per-user order settles (no snap-back), then clear.
			dndLanesRef.current = { ...finalLanes, [finalLane]: reordered };
			setDndLanes(dndLanesRef.current);
			reorderStories(
				reordered.map((id, i) => ({ storyId: id, order: i + 1 })),
			);
			scheduleDndLanesClear();
		},
		[
			groupBy,
			storyById,
			reorderStories,
			moveStoryRoadmapMutation,
			moveStoryStageMutation,
			hasActiveRoadmapFilters,
			isSortDefault,
			clearDndLanes,
			scheduleDndLanesClear,
		],
	);

	const handleDragCancel = useCallback(() => {
		setActiveStory(null);
		clearDndLanes();
	}, [clearDndLanes]);

	// Render one roadmap row. `index` drives the zebra striping; the roadmap
	// resolves the workflow status + author name and opts into the provenance
	// (author/editor) metadata that replaces the assignee on this surface.
	const renderStoryRow = (story: UserStory, index: number) => (
		<StoryCard
			key={story.id}
			story={story}
			matchPercent={matchPercentById.get(story.id)}
			canReorder={isSortDefault && !hasActiveRoadmapFilters}
			projectId={projectId}
			basePath={basePath}
			organizationId={organizationId}
			onSelect={handleSelectStory}
			onOpenDetails={handleOpenDetails}
			onDelete={handleDeleteStory}
			onSync={handleSyncStory}
			onTaskToggle={handleTaskToggle}
			hasPMIntegration={hasPMIntegration}
			pmToolName={pmToolName}
			assigneeNames={assigneeNames}
			isSelected={selectedStoryIds.has(story.id)}
			onSelectionChange={handleStorySelectionChange}
			selectedCount={
				selectedStoryIds.has(story.id) ? selectedStoryIds.size : 0
			}
			bulkActions={cardBulkActions}
			disableInlineRename={true}
			onExecuteWithWeave={handleExecuteWithWeave}
			onStartImplementationSession={handleStartImplementationSession}
			hasRepository={!!projectData?.project?.repositoryUrl}
			onCodingRunClick={handleCodingRunClick}
			mergedIntoIdentifier={mergedIntoIdentifierOf(story)}
			duplicateInfo={getDuplicateInfo(story.id)}
			status={statusById[story.statusId]}
			creatorName={assigneeNames[story.createdById]}
			showProvenance
			zebra={index % 2 === 1}
			columns={columns}
			columnOrder={columnOrder}
			maturationV2={showMaturationStatusChip}
		/>
	);

	// Render one board (kanban) tile.
	const renderStoryTile = (story: UserStory) => (
		<StoryTile
			key={story.id}
			story={story}
			canReorder={isSortDefault && !hasActiveRoadmapFilters}
			projectId={projectId}
			organizationId={organizationId}
			basePath={basePath}
			status={statusById[story.statusId]}
			creatorName={assigneeNames[story.createdById]}
			columns={columns}
			columnOrder={columnOrder}
			maturationV2={showMaturationStatusChip}
			hasPMIntegration={hasPMIntegration}
			pmToolName={pmToolName}
			isSelected={selectedStoryIds.has(story.id)}
			onSelectionChange={handleStorySelectionChange}
			selectedCount={
				selectedStoryIds.has(story.id) ? selectedStoryIds.size : 0
			}
			bulkActions={cardBulkActions}
			onOpenDetails={handleOpenDetails}
			onDelete={handleDeleteStory}
		/>
	);

	// ---- Loading state ----
	if (storiesLoading) {
		return (
			<div className="space-y-4">
				{[1, 2, 3, 4].map((i) => (
					<Skeleton key={i} className="h-32 w-full rounded-xl" />
				))}
			</div>
		);
	}

	return (
		<div className="space-y-4">
			<div className="space-y-4">
				<PendingProposalsBanner
					projectId={projectId}
					organizationId={organizationId}
					onOpenInbox={() => {
						setInboxDefaultFilter("all");
						setInboxOpen(true);
					}}
				/>
				<RoadmapContextStrip stats={roadmapStats} groupBy={groupBy} />

				{/* Toolbar */}
				<div className="flex items-center justify-end gap-4">
					<div className="flex items-center gap-2">
						{/* Get started with this page */}
						<PageTourButton pageId="stories" />
						{/* AI Update */}
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									variant="outline"
									size="sm"
									onClick={() => setChatOpen((prev) => !prev)}
									className="gap-2"
									data-onboarding-target="roadmap-ai-update"
								>
									<SparklesIcon className="size-4" />
									AI Update
								</Button>
							</TooltipTrigger>
							<TooltipContent>
								{tStories("aiUpdateRoadmap")}
							</TooltipContent>
						</Tooltip>

						{/* Scan for duplicates */}
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									variant="outline"
									size="sm"
									className="gap-2"
									disabled={isScanningDuplicates}
									onClick={() => runDuplicateScan()}
								>
									{isScanningDuplicates ? (
										<Loader2Icon className="size-4 motion-safe:animate-spin" />
									) : (
										<CopyIcon className="size-4" />
									)}
									{tDuplicates("scanButton")}
								</Button>
							</TooltipTrigger>
							<TooltipContent>
								{tDuplicates("scanTooltip")}
							</TooltipContent>
						</Tooltip>

						{/* Pull from PM tool */}
						{hasPMIntegration && canPull && !syncWorkflowId && (
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										variant="outline"
										size="sm"
										onClick={handleBulkPull}
										disabled={bulkSyncMutation.isPending}
										aria-label={`Pull items from ${pmToolName}`}
										className="gap-2"
									>
										<CloudDownloadIcon className="size-4" />
										Pull from {pmToolName}
									</Button>
								</TooltipTrigger>
								<TooltipContent>
									{tStories("pullFromPmTool")}
								</TooltipContent>
							</Tooltip>
						)}

						{/* F-171: single +Add button — classifier decides BUG vs FEATURE */}
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									variant="outline"
									size="sm"
									className="gap-2"
									disabled={
										statusesLoading || statuses.length === 0
									}
									onClick={handleAddStory}
									data-onboarding-target="roadmap-add"
								>
									<PlusIcon className="size-4" />
									Add
								</Button>
							</TooltipTrigger>
							<TooltipContent>
								{tStories("addFeature")}
							</TooltipContent>
						</Tooltip>

						{/* Refresh */}
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									variant="outline"
									size="sm"
									onClick={handleRefresh}
									className="gap-2"
								>
									<RefreshCwIcon className="size-4" />
									Refresh
								</Button>
							</TooltipTrigger>
							<TooltipContent>
								{tStories("refreshRoadmap")}
							</TooltipContent>
						</Tooltip>

						{/* Bulk sync */}
						{hasPMIntegration && selectedStoryIds.size > 0 && (
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										variant="outline"
										size="sm"
										onClick={() =>
											setSyncSelectedDialogOpen(true)
										}
										className="gap-2"
									>
										<CloudUploadIcon className="size-4" />
										Sync selected ({selectedStoryIds.size})
									</Button>
								</TooltipTrigger>
								<TooltipContent>
									{tStories("syncSelectedToPm")}
								</TooltipContent>
							</Tooltip>
						)}

						{/* Sync progress indicator */}
						{syncProgress && (
							<div className="flex items-center gap-2 text-sm text-muted-foreground">
								<Loader2Icon className="size-4 animate-spin" />
								<span>{syncProgress.message}</span>
								{syncProgress.totalStories > 0 && (
									<span>
										({syncProgress.syncedCount}/
										{syncProgress.totalStories})
									</span>
								)}
							</div>
						)}
					</div>
				</div>

				{/* Filters */}
				<RoadmapFilterToolbar
					// Work items | Priority shares the result-count lane: the
					// switcher chooses which view of the counted set you get, so
					// the two belong on one line.
					viewSwitcher={
						PRIORITY_VIEW_ENABLED ? (
							<RoadmapSectionSwitcher
								value={showingPriority ? "priority" : "items"}
								onChange={handleSectionChange}
							/>
						) : undefined
					}
					filters={roadmapFilters}
					onFiltersChange={setRoadmapFilters}
					onClearAll={clearRoadmapFilters}
					onRemoveFilter={removeRoadmapFilter}
					aiMode={aiSearch}
					onToggleAiMode={() => setAiSearch(!aiSearch)}
					aiSearching={aiSearchActive && semanticSearch.isFetching}
					aiSearchError={aiSearchActive && semanticSearch.isError}
					aiCoverageNote={aiCoverageNote}
					aiFallbackNote={
						semanticEmptyFallback
							? "No semantic matches — showing keyword results."
							: null
					}
					aiQueryTooShort={aiSearch && !aiSearchActive}
					aiMinQueryLength={ROADMAP_AI_SEARCH_MIN_QUERY_LENGTH}
					totalCount={visibleStories.length}
					filteredCount={sortedStories.length}
					hiddenMatchCount={
						showHiddenMatchAffordance ? hiddenMatchCount : 0
					}
					onShowHidden={() => setShowClosed(true)}
					bodyMatchCount={bodyMatchCount}
					bodyMatchesShown={showBodyMatches}
					onToggleBodyMatches={() =>
						setBodyMatchesRevealedFor(
							showBodyMatches ? null : roadmapFilters.q,
						)
					}
					hasActiveFilters={hasActiveRoadmapFilters}
					projectId={projectId}
					organizationId={organizationId}
					onOpenProposalsInbox={() => {
						setInboxDefaultFilter("all");
						setInboxOpen(true);
					}}
					onOpenBacklog={() => {
						setInboxDefaultFilter("backlog");
						setInboxOpen(true);
					}}
					trailing={
						<>
							{/* Sort has no effect on the Priority section's ranked
							    list, so showing it there was a control that
							    silently did nothing. */}
							{!showingPriority && (
								<RoadmapSortControl
									sort={sort}
									onSortChange={setSort}
									mode={mode}
									groupBy={groupBy}
								/>
							)}
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										variant="ghost"
										size="icon"
										onClick={() => {
											setHistoryView("changes");
											setHistoryOpen(true);
										}}
										className="size-8"
										aria-label="View roadmap history"
									>
										<HistoryIcon className="size-4" />
									</Button>
								</TooltipTrigger>
								<TooltipContent>
									History — every change to these tickets, and
									the PM sync log
								</TooltipContent>
							</Tooltip>
							{/* Eye: show/hide hidden tickets — between history and settings. */}
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										variant="ghost"
										size="icon"
										aria-pressed={showClosed}
										aria-label={
											showClosed
												? tStories("hideClosedFeatures")
												: tStories("showClosedFeatures")
										}
										onClick={() =>
											setShowClosed(!showClosed)
										}
										className={cn(
											"size-8",
											// Active state uses the project's
											// primary token, not a fixed green.
											showClosed &&
												"border border-primary/40 bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary",
										)}
									>
										{showClosed ? (
											<EyeIcon className="size-4" />
										) : (
											<EyeOffIcon className="size-4" />
										)}
									</Button>
								</TooltipTrigger>
								<TooltipContent>
									{showClosed
										? tStories("hideClosedFeatures")
										: tStories("showClosedFeatures")}
								</TooltipContent>
							</Tooltip>
							<RoadmapSettingsMenu
								mode={mode}
								onModeChange={setMode}
								groupBy={groupBy}
								onGroupByChange={setGroupBy}
								columns={columns}
								onColumnsChange={setColumns}
								columnOrder={columnOrder}
								onColumnOrderChange={setColumnOrder}
								isDirty={isViewDirty}
								onSave={commitView}
								onCancel={revertView}
							/>
						</>
					}
				/>

				{/* DnD context wrapping all sections. Default measuring (once, at
				    drag start) keeps sibling reflow stable — re-measuring on every
				    frame fed back into the transforms and made the whole list
				    jitter/reorder. */}
				<DndContext
					sensors={sensors}
					collisionDetection={collisionDetectionStrategy}
					onDragStart={handleDragStart}
					onDragOver={handleDragOver}
					onDragEnd={handleDragEnd}
					onDragCancel={handleDragCancel}
				>
					<div
						className="border-t border-border/40"
						data-onboarding-target="roadmap-board"
					>
						{sortedStories.length === 0 ? (
							hasActiveRoadmapFilters ? (
								showHiddenMatchAffordance ? (
									<div className="flex flex-col items-center gap-3 px-4 py-14 text-center">
										<EyeOffIcon
											aria-hidden
											className="size-5 text-muted-foreground/60"
										/>
										<p className="max-w-sm text-sm text-muted-foreground">
											No visible results —{" "}
											<span className="font-medium tabular-nums text-foreground">
												{hiddenMatchCount}
											</span>{" "}
											hidden item
											{hiddenMatchCount === 1 ? "" : "s"}.
											Use the Show hidden eye toggle above
											to view.
										</p>
										<Button
											type="button"
											variant="outline"
											size="sm"
											onClick={() => setShowClosed(true)}
										>
											<EyeIcon className="mr-2 size-4" />
											Show hidden
										</Button>
									</div>
								) : (
									<RoadmapEmptyState
										filters={roadmapFilters}
										onClearFilters={clearRoadmapFilters}
										aiMode={aiSearchActive}
										onDisableAiMode={
											aiSearch
												? () => setAiSearch(false)
												: undefined
										}
									/>
								)
							) : !showClosed && closedFeatureCount > 0 ? (
								<div className="py-12 text-center">
									<p className="text-sm text-muted-foreground">
										You have {closedFeatureCount} hidden
										work item
										{closedFeatureCount === 1 ? "" : "s"}.{" "}
										<button
											type="button"
											onClick={toggleShowClosed}
											className="underline underline-offset-2 text-primary hover:text-primary/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
										>
											Show hidden work items
										</button>
									</p>
								</div>
							) : (
								<div className="py-12 text-center">
									<p className="text-sm text-muted-foreground">
										No work items yet
									</p>
								</div>
							)
						) : (
							<>
								{/* Bulk-action bar — appears when tickets are selected.
								    Bulk priority / stage / hide-show / delete run on
								    every selected item; PM sync (push/pull) is added
								    when the project has a PM tool connected. */}
								{selectedStoryIds.size > 0 && (
									<div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-lg border border-primary/30 bg-primary/[0.08] px-3 py-2 text-xs shadow-sm motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-1">
										<span className="font-semibold tabular-nums text-foreground">
											{selectedStoryIds.size} selected
										</span>
										<button
											type="button"
											onClick={toggleSelectAll}
											className="rounded px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
										>
											{allSelected
												? "Deselect all"
												: `Select all ${allVisibleIds.length}`}
										</button>

										<span className="text-border">|</span>

										{/* Priority */}
										<DropdownMenu>
											<DropdownMenuTrigger asChild>
												<button
													type="button"
													className="flex items-center gap-1 rounded px-2 py-0.5 font-medium text-foreground transition-colors hover:bg-accent"
												>
													<FlagIcon className="size-3.5" />
													Priority
													<ChevronDownIcon className="size-3 opacity-60" />
												</button>
											</DropdownMenuTrigger>
											<DropdownMenuContent align="start">
												<DropdownMenuLabel>
													Set priority
												</DropdownMenuLabel>
												{PRIORITY_OPTIONS.map((opt) => (
													<DropdownMenuItem
														key={opt.value}
														onClick={() =>
															applyBulkPriority(
																opt.value as PriorityKey,
															)
														}
													>
														<span
															className="mr-2 size-2 shrink-0 rounded-full"
															style={{
																backgroundColor:
																	opt.color,
															}}
														/>
														{opt.label}
													</DropdownMenuItem>
												))}
											</DropdownMenuContent>
										</DropdownMenu>

										{/* Stage */}
										<DropdownMenu>
											<DropdownMenuTrigger asChild>
												<button
													type="button"
													className="flex items-center gap-1 rounded px-2 py-0.5 font-medium text-foreground transition-colors hover:bg-accent"
												>
													<GitBranchIcon className="size-3.5" />
													Stage
													<ChevronDownIcon className="size-3 opacity-60" />
												</button>
											</DropdownMenuTrigger>
											<DropdownMenuContent align="start">
												<DropdownMenuLabel>
													Move to stage
												</DropdownMenuLabel>
												{STAGE_SECTIONS.map((s) => (
													<DropdownMenuItem
														key={s.key}
														onClick={() =>
															applyBulkStage(
																s.key as MaturationStatus,
															)
														}
													>
														<span
															className="mr-2 size-2 shrink-0 rounded-full"
															style={{
																backgroundColor:
																	MATURATION_STATUS_META[
																		s.key as MaturationStatus
																	]?.color,
															}}
														/>
														{s.label}
													</DropdownMenuItem>
												))}
											</DropdownMenuContent>
										</DropdownMenu>

										{/* Hide / Show */}
										<button
											type="button"
											onClick={() =>
												applyBulkHideShow(true)
											}
											className="flex items-center gap-1 rounded px-2 py-0.5 text-foreground transition-colors hover:bg-accent"
										>
											<EyeOffIcon className="size-3.5" />
											Hide
										</button>
										<button
											type="button"
											onClick={() =>
												applyBulkHideShow(false)
											}
											className="flex items-center gap-1 rounded px-2 py-0.5 text-foreground transition-colors hover:bg-accent"
										>
											<EyeIcon className="size-3.5" />
											Show
										</button>

										{/* Delete */}
										<button
											type="button"
											onClick={applyBulkDelete}
											className="flex items-center gap-1 rounded px-2 py-0.5 text-destructive transition-colors hover:bg-destructive/10"
										>
											<Trash2Icon className="size-3.5" />
											Delete
										</button>

										{hasPMIntegration && (
											<>
												<span className="text-border">
													|
												</span>
												<button
													type="button"
													onClick={() =>
														setSyncSelectedDialogOpen(
															true,
														)
													}
													className="flex items-center gap-1 rounded bg-primary px-2 py-0.5 font-medium text-primary-foreground transition-opacity hover:opacity-90"
												>
													<CloudUploadIcon className="size-3.5" />
													Sync to {pmToolName}
												</button>
												<button
													type="button"
													onClick={handleBulkPull}
													className="flex items-center gap-1 rounded px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
												>
													<CloudDownloadIcon className="size-3.5" />
													Pull
												</button>
											</>
										)}
										<button
											type="button"
											onClick={clearSelection}
											className="ml-auto rounded px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
										>
											Clear
										</button>
									</div>
								)}
								{useFlatList ? (
									<div>
										<SortableContext
											items={sortedStories.map(
												(s) => s.id,
											)}
											strategy={
												verticalListSortingStrategy
											}
										>
											{sortedStories.map(renderStoryRow)}
										</SortableContext>
									</div>
								) : mode === "board" ? (
									<div className="flex gap-3 overflow-x-auto p-3">
										{sections.map((section) => {
											const items =
												groupedDisplay[section.key] ??
												[];
											const sectionIds = items.map(
												(s) => s.id,
											);
											const allSectionSelected =
												sectionIds.length > 0 &&
												sectionIds.every((id) =>
													selectedStoryIds.has(id),
												);
											const dotColor =
												groupBy === "stage"
													? MATURATION_STATUS_META[
															section.key as MaturationStatus
														]?.color
													: undefined;
											// While a card is being dragged INTO this lane it
											// must render expanded so the user can see and drop
											// there; it re-collapses when the drag leaves or
											// ends (activeStory/dndLanes reset).
											const isDragTarget =
												activeStory != null &&
												items.some(
													(s) =>
														s.id === activeStory.id,
												);
											const isEmptyLane =
												items.length === 0;
											// Empty lane: default collapsed, but
											// honor an explicit expand. Non-empty:
											// the normal manual-collapse set.
											const collapsed =
												!isDragTarget &&
												(isEmptyLane
													? !expandedEmptyKeys.has(
															section.key,
														)
													: collapsedBoardColumns.has(
															section.key,
														));
											if (collapsed) {
												return (
													<DroppableLane
														key={section.key}
														laneId={section.key}
														className="flex w-11 shrink-0 rounded-lg border border-border/50 bg-muted/10 transition-colors hover:bg-muted/20 motion-safe:animate-in motion-safe:fade-in-0"
													>
														<Tooltip>
															<TooltipTrigger
																asChild
															>
																{/* The lane label and count are visible
															inside the button, so it names itself —
															no `aria-label` here. */}
																<button
																	type="button"
																	onClick={() =>
																		isEmptyLane
																			? toggleExpandedEmpty(
																					section.key,
																				)
																			: toggleBoardColumnCollapsed(
																					section.key,
																				)
																	}
																	className="flex w-full flex-col items-center gap-2 py-3"
																>
																	<span
																		aria-hidden
																		className={cn(
																			"size-1.5 rounded-full",
																			groupBy !==
																				"stage" &&
																				PRIORITY_SECTION_DOT[
																					section
																						.key
																				],
																		)}
																		style={
																			dotColor
																				? {
																						backgroundColor:
																							dotColor,
																					}
																				: undefined
																		}
																	/>
																	<span className="text-[11px] tabular-nums text-muted-foreground/60">
																		{
																			items.length
																		}
																	</span>
																	<span className="[writing-mode:vertical-rl] text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
																		{
																			section.label
																		}
																	</span>
																</button>
															</TooltipTrigger>
															<TooltipContent>
																{tStories(
																	"expandLane",
																	{
																		label: section.label,
																	},
																)}
															</TooltipContent>
														</Tooltip>
													</DroppableLane>
												);
											}
											return (
												<DroppableLane
													key={section.key}
													laneId={section.key}
													className="group/lane flex min-w-[220px] flex-1 flex-col rounded-lg border border-border/50 bg-muted/10 motion-safe:animate-in motion-safe:fade-in-0"
												>
													<div className="flex items-center gap-2 border-b border-border/40 px-2.5 py-2">
														<Checkbox
															checked={
																allSectionSelected
															}
															disabled={
																sectionIds.length ===
																0
															}
															onCheckedChange={(
																c,
															) =>
																setSectionSelected(
																	sectionIds,
																	c === true,
																)
															}
															className="size-3.5 shrink-0 opacity-0 transition-opacity focus-visible:opacity-100 group-hover/lane:opacity-70"
															aria-label={`Select all in ${section.label}`}
														/>
														<Tooltip>
															<TooltipTrigger
																asChild
															>
																{/* The lane label and count are visible
															inside the button, so it names itself —
															no `aria-label` here. */}
																<button
																	type="button"
																	onClick={() =>
																		isEmptyLane
																			? toggleExpandedEmpty(
																					section.key,
																				)
																			: toggleBoardColumnCollapsed(
																					section.key,
																				)
																	}
																	className="flex flex-1 items-center gap-2 text-left transition-colors hover:text-foreground"
																>
																	<span
																		aria-hidden
																		className={cn(
																			"size-1.5 rounded-full",
																			groupBy !==
																				"stage" &&
																				PRIORITY_SECTION_DOT[
																					section
																						.key
																				],
																		)}
																		style={
																			dotColor
																				? {
																						backgroundColor:
																							dotColor,
																					}
																				: undefined
																		}
																	/>
																	<span className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
																		{
																			section.label
																		}
																	</span>
																	<span className="ml-auto text-[11px] tabular-nums text-muted-foreground/50">
																		{
																			items.length
																		}
																	</span>
																</button>
															</TooltipTrigger>
															<TooltipContent>
																{tStories(
																	"collapseLane",
																	{
																		label: section.label,
																	},
																)}
															</TooltipContent>
														</Tooltip>
													</div>
													<div className="flex flex-col gap-2 p-2">
														{items.length > 0 ? (
															<SortableContext
																items={
																	sectionIds
																}
																strategy={
																	verticalListSortingStrategy
																}
															>
																{items.map(
																	renderStoryTile,
																)}
															</SortableContext>
														) : (
															<p className="px-1 py-4 text-center text-[11px] text-muted-foreground/50">
																No items
															</p>
														)}
													</div>
												</DroppableLane>
											);
										})}
									</div>
								) : mode === "priority" ? (
									// A single ranked worklist with its own ordering,
									// bug/feature switcher and drag context — see
									// PriorityRankedList. It reads the already-filtered
									// stories so the filter panel still applies.
									<PriorityRankedList
										projectId={projectId}
										organizationId={organizationId ?? null}
										basePath={basePath}
										stories={sortedStories}
										// The unfiltered active set (declined/
										// hidden already excluded) — the "entire
										// roadmap" scope the re-prioritize dialog
										// offers when filters narrow the view.
										allStories={visibleStories}
										hasActiveFilters={
											hasActiveRoadmapFilters
										}
									/>
								) : (
									<div>
										{sections.map((section) => {
											const items =
												groupedDisplay[section.key] ??
												[];
											const sectionIds = items.map(
												(s) => s.id,
											);
											const allSectionSelected =
												sectionIds.length > 0 &&
												sectionIds.every((id) =>
													selectedStoryIds.has(id),
												);
											// An empty lane is always collapsed (in every view) so
											// it reads as a closed header and never takes up space.
											// While a card is dragged into the lane it expands so
											// the user can drop there, then re-collapses on drag end.
											const isDragTarget =
												activeStory != null &&
												items.some(
													(s) =>
														s.id === activeStory.id,
												);
											const isEmptyLane =
												items.length === 0;
											// Empty lane: default collapsed but
											// honor an explicit expand; non-empty:
											// the normal manual-collapse set.
											const isCollapsed =
												!isDragTarget &&
												(isEmptyLane
													? !expandedEmptyKeys.has(
															section.key,
														)
													: collapsedSections.has(
															section.key,
														));
											const railClass =
												groupBy === "stage"
													? "border-border/50"
													: PRIORITY_SECTION_RAIL[
															section.key
														];
											const dotColor =
												groupBy === "stage"
													? MATURATION_STATUS_META[
															section.key as MaturationStatus
														]?.color
													: undefined;
											return (
												<DroppableLane
													key={section.key}
													laneId={section.key}
													data-priority-section={
														section.key
													}
													className="group/lane"
												>
													<div className="flex items-center gap-2 pr-2 pl-3">
														<Checkbox
															checked={
																allSectionSelected
															}
															disabled={
																sectionIds.length ===
																0
															}
															onCheckedChange={(
																c,
															) =>
																setSectionSelected(
																	sectionIds,
																	c === true,
																)
															}
															className="size-3.5 shrink-0 opacity-0 transition-opacity focus-visible:opacity-100 group-hover/lane:opacity-70"
															aria-label={`Select all in ${section.label}`}
														/>
														<button
															type="button"
															onClick={() =>
																isEmptyLane
																	? toggleExpandedEmpty(
																			section.key,
																		)
																	: toggleSectionCollapsed(
																			section.key,
																		)
															}
															aria-expanded={
																!isCollapsed
															}
															className="group/section flex flex-1 items-center gap-2 py-2 text-left transition-colors hover:text-foreground focus-visible:outline-none"
														>
															<ChevronDownIcon
																aria-hidden
																className={cn(
																	"size-3.5 shrink-0 text-muted-foreground/60 transition-transform",
																	isCollapsed &&
																		"-rotate-90",
																)}
															/>
															<span
																aria-hidden
																className={cn(
																	"size-1.5 rounded-full",
																	groupBy !==
																		"stage" &&
																		PRIORITY_SECTION_DOT[
																			section
																				.key
																		],
																)}
																style={
																	dotColor
																		? {
																				backgroundColor:
																					dotColor,
																			}
																		: undefined
																}
															/>
															<span className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
																{section.label}
															</span>
															<span className="text-[11px] tabular-nums text-muted-foreground/50">
																{items.length}
															</span>
														</button>
													</div>
													{!isCollapsed && (
														<div
															className={cn(
																"border-l-2 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-1 motion-safe:duration-200",
																railClass,
															)}
														>
															{items.length >
															0 ? (
																<SortableContext
																	items={
																		sectionIds
																	}
																	strategy={
																		verticalListSortingStrategy
																	}
																>
																	{items.map(
																		renderStoryRow,
																	)}
																</SortableContext>
															) : (
																<p className="px-3 py-3 pl-9 text-[11px] text-muted-foreground/50">
																	No items in
																	this lane.
																</p>
															)}
														</div>
													)}
												</DroppableLane>
											);
										})}
									</div>
								)}
							</>
						)}
					</div>

					{/* Drag overlay — the lifted card that tracks the pointer. A
					    faithful, compact representation of the row (kind icon +
					    id + title + size) on a raised surface, so the gesture
					    reads as "carrying this item" instead of a bare label. */}
					{typeof window !== "undefined" &&
						createPortal(
							<DragOverlay dropAnimation={DRAG_DROP_ANIMATION}>
								{activeStory && (
									<div className="flex w-full max-w-xl items-center gap-2.5 rounded-xl border border-primary/40 bg-card px-3 py-2.5 shadow-2xl ring-1 ring-primary/10 cursor-grabbing">
										<StoryKindIcon
											kind={activeStory.kind}
											priority={activeStory.priority}
											className="size-4 shrink-0"
										/>
										<span className="shrink-0 font-mono text-[11px] text-muted-foreground/60 tabular-nums">
											{activeStory.identifier}
										</span>
										<span className="truncate text-sm font-medium text-foreground">
											{activeStory.title}
										</span>
										{activeStory.size && (
											<span className="ml-auto shrink-0 rounded-full border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground tabular-nums">
												{getSizeLabel(activeStory.size)}
											</span>
										)}
									</div>
								)}
							</DragOverlay>,
							document.body,
						)}
				</DndContext>

				{/* Sync selected dialog */}
				<SyncSelectedDialog
					open={syncSelectedDialogOpen}
					onOpenChange={setSyncSelectedDialogOpen}
					stories={stories}
					selectedStoryIds={selectedStoryIds}
					pmToolName={pmToolName}
					isPending={bulkSyncMutation.isPending}
					onConfirm={() => {
						setSyncSelectedDialogOpen(false);
						bulkSyncMutation.mutate({
							direction: "push",
							storyIds: Array.from(selectedStoryIds),
						});
						setSelectedStoryIds(new Set());
					}}
				/>

				{/* Create Feature/Bug Dialog */}
				<CreateStoryDialog
					open={createDialogOpen}
					onOpenChange={setCreateDialogOpen}
					statusId={createDialogStatusId}
					statuses={statuses}
					projectId={projectId}
					onSubmit={async (data, files, docAttachments) => {
						const result = await submitCreateStoryWithAttachments({
							data,
							files,
							docAttachments,
							organizationId,
							deps: {
								createStoryMutateAsync:
									createStoryMutation.mutateAsync,
								uploadStoryImage,
								uploadStoryAttachment,
								updateStoryMutateAsync:
									updateStoryMutation.mutateAsync,
								closeDialog: () => setCreateDialogOpen(false),
								toast,
							},
						});
						// Navigate AFTER the orchestrator resolves so uploads +
						// updateStory complete before the route changes. Previously
						// this lived in createStoryMutation.onSuccess and fired
						// before uploads finished (Codex review of PR 1).
						router.push(
							buildStoryDetailsRoute(
								basePath,
								projectId,
								result.storyId,
							),
						);
						return {
							titleSource:
								result.titleSource as RoadmapCreateStoryDialogResult["titleSource"],
						};
					}}
					isSubmitting={createStoryMutation.isPending}
					tCreate={tCreateRoadmap}
				/>

				{duplicateResolveDialog}
				{duplicateScanCompletionDialog}
				<CodingRunDialog
					open={!!activeCodingRunId}
					onOpenChange={(open) => !open && setActiveCodingRunId(null)}
					codingRunId={activeCodingRunId ?? ""}
					organizationId={organizationId}
					featureTitle={
						stories.find(
							(story) =>
								story.latestCodingRun?.id === activeCodingRunId,
						)?.title ?? null
					}
				/>

				{/* Weave Execution Dialog — triggered from StoryCard dropdown */}
				{weaveStoryId &&
					(() => {
						const weaveStory = stories.find(
							(s) => s.id === weaveStoryId,
						);
						return (
							<ExecuteWithWeaveButton
								projectId={projectId}
								implementationDefaultProvider={
									projectData?.project
										?.implementationDefaultProvider as
										| "BACKGROUND_AGENTS"
										| "KANBAN_LOCAL"
										| null
										| undefined
								}
								storyId={weaveStoryId}
								repoUrl={
									projectData?.project?.repositoryUrl || ""
								}
								open={weaveDialogOpen}
								onOpenChange={(open) => {
									setWeaveDialogOpen(open);
									if (!open) {
										setWeaveStoryId(null);
									}
								}}
								hideTrigger
								storyContext={
									weaveStory
										? {
												title: weaveStory.title,
												description:
													weaveStory.description ??
													undefined,
												acceptanceCriteria:
													weaveStory.acceptanceCriteria ??
													undefined,
											}
										: undefined
								}
							/>
						);
					})()}

				{implementationStoryId &&
					(() => {
						const implementationStory = stories.find(
							(story) => story.id === implementationStoryId,
						);
						if (!implementationStory) {
							return null;
						}
						return (
							<StartImplementationSessionButton
								projectId={projectId}
								story={implementationStory}
								repositoryOwner={
									projectData?.project?.repositoryOwner
								}
								repositoryName={
									projectData?.project?.repositoryName
								}
								defaultBranch={
									projectData?.project?.defaultBranch
								}
								implementationDefaultChannel={
									projectData?.project
										?.implementationDefaultChannel as
										| "BACKGROUND_AGENTS"
										| "LOCAL_AGENTS"
										| null
										| undefined
								}
								implementationDefaultProvider={
									projectData?.project
										?.implementationDefaultProvider as
										| "BACKGROUND_AGENTS"
										| "KANBAN_LOCAL"
										| null
										| undefined
								}
								open={implementationDialogOpen}
								onOpenChange={(open) => {
									setImplementationDialogOpen(open);
									if (!open) {
										setImplementationStoryId(null);
									}
								}}
								hideTrigger
								onStarted={(codingRunId) => {
									setActiveCodingRunId(codingRunId);
									refetchStories();
								}}
							/>
						);
					})()}

				{/* Pull from PM: selective ticket import */}
				<PullFromPMDialog
					open={pullFromPMDialogOpen}
					onClose={() => setPullFromPMDialogOpen(false)}
					onConfirm={handlePullFromPMConfirm}
					projectId={projectId}
					organizationId={organizationId}
					pmToolName={pmToolName}
					isPulling={bulkSyncMutation.isPending}
				/>

				{/* Review Center — opened from the post-sync "Review conflicts" CTA */}
				<ReviewCenterPanel
					projectId={projectId}
					organizationId={organizationId}
					open={reviewCenterOpen}
					onOpenChange={setReviewCenterOpen}
				/>

				{/* Inbox for pending backlog proposals from the Teams channel monitor */}
				<PendingBacklogProposalsInbox
					projectId={projectId}
					organizationId={organizationId}
					open={inboxOpen}
					onOpenChange={handleInboxOpenChange}
					defaultFilter={inboxDefaultFilter}
					initialProposalId={pendingProposalId}
					hasPMTool={hasPMIntegration ?? false}
					pmToolName={pmToolName}
					pmConfig={
						pmCapabilitiesData?.mcpConfigId &&
						pmCapabilitiesData?.containerId
							? {
									mcpConfigId: pmCapabilitiesData.mcpConfigId,
									containerId: pmCapabilitiesData.containerId,
									additionalContext:
										pmCapabilitiesData.additionalContext ??
										undefined,
								}
							: undefined
					}
				/>

				{/* Read-only roadmap history: ticket changes + the PM sync log */}
				<BacklogAuditDialog
					open={historyOpen}
					onOpenChange={setHistoryOpen}
					projectId={projectId}
					organizationId={organizationId ?? null}
					view={historyView}
					onViewChange={setHistoryView}
				/>

				{/* Read-only AI Update session history */}
				<BacklogSessionHistoryDialog
					open={sessionHistoryOpen}
					onOpenChange={setSessionHistoryOpen}
					projectId={projectId}
					organizationId={organizationId ?? null}
					focusSessionId={sessionFocusId}
				/>

				{/* AI Backlog Update */}
				{chatOpen && (
					<BacklogChatPanel
						organizationId={organizationId ?? null}
						projectId={projectId}
						projectName={projectData?.project?.name ?? "Project"}
						hasTeamsIntegration={hasTeamsIntegration}
						hasSlackIntegration={hasSlackIntegration}
						hasNotionIntegration={hasNotionIntegration}
						hasPMTool={hasPMIntegration ?? false}
						pmToolName={pmToolName}
						pmConfig={
							pmCapabilitiesData?.mcpConfigId &&
							pmCapabilitiesData?.containerId
								? {
										mcpConfigId:
											pmCapabilitiesData.mcpConfigId,
										containerId:
											pmCapabilitiesData.containerId,
										additionalContext:
											pmCapabilitiesData.additionalContext ??
											undefined,
									}
								: undefined
						}
						backlogSummary={`${stories.length} work items across ${statuses.length} statuses`}
						onClose={() => setChatOpen(false)}
						onChangesApplied={() => {
							queryClient.invalidateQueries({
								queryKey: getStoriesQueryKey(
									projectId,
									organizationId,
								),
							});
						}}
						onOpenSessionHistory={() => {
							setSessionFocusId(null);
							setSessionHistoryOpen(true);
						}}
					/>
				)}
			</div>

			{/* PM tool migration confirmation (push-only override) */}
			<AlertDialog
				open={!!migrationConfirm}
				onOpenChange={(open) => !open && setMigrationConfirm(null)}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							Migrate this work item to {pmToolName}?
						</AlertDialogTitle>
						<AlertDialogDescription>
							This work item is currently linked to a different PM
							tool. Pushing now will create a new item in{" "}
							{pmToolName} and remove the existing link. The item
							in the previous tool will not be deleted, but this
							work item will no longer track it.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							onClick={() => {
								if (migrationConfirm) {
									syncStoryMutation.mutate({
										storyId: migrationConfirm.storyId,
										direction: "push",
										overrideMismatch: true,
									});
								}
								setMigrationConfirm(null);
							}}
						>
							Push & relink to {pmToolName}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}

// ---- Create Story Dialog ----
// Title is server-generated from `description` via the AI title-generator
// helper (see packages/ai/lib/story-title-generator.ts) — keep the form-shape
// in sync with the Kanban variant in ./CreateStoryDialog.tsx. The Roadmap
// variant retains the Stage and PromptSelector controls (Decision 6) which
// drive description-drafting independently of title generation.
//
// Toast lifecycle: `toast.loading` fires on submit and is
// upgraded in-place to `toast.success` or `toast.error` via the sonner
// `{ id }` idiom. A separate `toast.warning` fires after success when the
// server returns the timestamped-untitled fallback. We intentionally do NOT
// differentiate `is_insufficient` from system-failure at the UI — both produce
// `titleSource: UNTITLED_FALLBACK` on the wire. Telemetry distinguishes via
// `logModelUsageAsync.metadata.isInsufficient` server-side.
type RoadmapCreateStoryDialogResult = {
	titleSource?:
		| "ai"
		| "description-fallback"
		| "untitled-fallback"
		| "AI"
		| "DESCRIPTION_FALLBACK"
		| "UNTITLED_FALLBACK"
		| null;
};

function CreateStoryDialog({
	open,
	onOpenChange,
	statusId,
	statuses: _statuses,
	projectId,
	onSubmit,
	isSubmitting,
	tCreate,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	statusId: string | null;
	statuses: StoryStatus[];
	projectId: string;
	/**
	 * Caller drives the create mutation and resolves with the new row's
	 * `titleSource` so the dialog can fire the loading / success / warning
	 * toasts. Returning `void` is still tolerated (treated as "title source
	 * unknown" — no soft-warn fires). Rejecting transitions the loading toast
	 * to the failure toast.
	 */
	onSubmit: (
		data: CreateStoryInput,
		files: File[],
		docAttachments: PendingDocAttachment[],
	) =>
		| RoadmapCreateStoryDialogResult
		| undefined
		| Promise<RoadmapCreateStoryDialogResult | undefined>;
	isSubmitting: boolean;
	tCreate: (key: string) => string;
}) {
	const [description, setDescription] = useState("");
	const [priority, setPriority] = useState<string>("P2_MEDIUM");
	const [size, setSize] = useState<string>("");
	const [pendingFiles, setPendingFiles] = useState<File[]>([]);
	const [pendingDocs, setPendingDocs] = useState<PendingDocAttachment[]>([]);
	const [draftingStage, setDraftingStage] =
		useState<FeatureDraftingStage>("PLACEHOLDER");
	const [selectedPromptId, setSelectedPromptId] = useState<
		string | undefined
	>();
	const [selectedPromptVersionId, setSelectedPromptVersionId] = useState<
		string | undefined
	>();
	// Tracks the entire async onSubmit chain (create + uploads + updateStory
	// + router.push). `isSubmitting` only mirrors the create mutation's
	// isPending, so it would re-enable the button as soon as create resolved
	// — leaving a window for double-clicks while uploads/update were still in
	// flight (Codex review of PR 1: double-submit guard).
	const [isOrchestrating, setIsOrchestrating] = useState(false);
	const dialogContentRef = useRef<HTMLDivElement>(null);

	// Preflight: verify an AI provider is configured for the current context.
	// The server-side feature-creation flow eventually calls the CopilotKit
	// runtime at /api/copilotkit which returns `{ code: "AI_GATEWAY_MISSING" }`
	// when no provider is set; without this check the user would see the raw
	// 400 in the dev console (or a bubbled CopilotKit `useAgent` error). We
	// surface a clear inline Alert *before* the user spends time on the form.
	const { organizationId, basePath } = useOrganizationContext();
	const { data: aiConfigStatus, isLoading: isLoadingAiConfig } = useQuery({
		queryKey: ["aiConfigStatus", organizationId],
		queryFn: async () =>
			await orpcClient.aiConfig.resolution.getStatus({
				organizationId,
			}),
		enabled: open,
		staleTime: 30_000,
	});
	const isAiNotConfigured =
		!isLoadingAiConfig &&
		aiConfigStatus !== undefined &&
		!aiConfigStatus.isConfigured;
	const aiProviderSettingsUrl = `${basePath}/settings/ai-providers`;

	// FMW v2: Map the three user-facing maturation statuses to their underlying
	// drafting stages for creation and prompt binding.
	const CREATE_STAGE_OPTIONS: {
		maturationStatus: MaturationStatus;
		draftingStage: FeatureDraftingStage;
	}[] = [
		{ maturationStatus: "TO_DO", draftingStage: "PLACEHOLDER" },
		{ maturationStatus: "DISCOVERY", draftingStage: "ACTIVE_ANALYSIS" },
		{ maturationStatus: "DONE", draftingStage: "PUBLISHED" },
	];

	// Prompt bindings are per-stage. When the user picks a different stage,
	// any previously-selected prompt no longer matches — clear it so the
	// selector falls back to the new stage's default.
	useEffect(() => {
		setSelectedPromptId(undefined);
		setSelectedPromptVersionId(undefined);
	}, [draftingStage]);

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!description.trim() || isAiNotConfigured) {
			return;
		}

		// F-171: NEVER submit promptId/promptVersionId from this dialog.
		// The PromptSelector below is hardcoded to storyKind=FEATURE
		// (visible to the user for transparency), but the classifier may
		// route the work item to BUG. resolvePrompt server-side honors any
		// explicit prompt before bound-prompt lookup — so passing a
		// FEATURE-bound prompt id would short-circuit bug_creation and
		// skip the Original Description preservation + needsMoreInfo
		// pipeline. Power-user prompt overrides happen post-creation in
		// the story workspace, where kind is known.

		// Title is intentionally omitted — the server generates it from the
		// description. F-171: `kind` is omitted too; the classifier in
		// createStoryFromProposal decides BUG vs FEATURE from the description.
		const payload: CreateStoryInput = {
			projectId,
			statusId: statusId ?? undefined,
			description: description.trim(),
			priority: priority as CreateStoryInput["priority"],
			size: size ? (size as CreateStoryInput["size"]) : undefined,
			draftingStage,
		};

		// TODO(Group 8 — i18n): once the new keys land in `de.json`, drop the
		// hardcoded English fallbacks. The keys already exist in `en.json` so
		// `tCreate(...)` resolves correctly today.
		const toastId = toast.loading(tCreate("titleGenerating"));

		setIsOrchestrating(true);
		try {
			const result = await onSubmit(payload, pendingFiles, pendingDocs);
			toast.success(tCreate("titleGenerated"), { id: toastId });

			// Wire-shape tolerance: helper emits kebab-case, Prisma enum emits
			// SCREAMING_SNAKE. Accept both so a future procedure-return change
			// doesn't silently break the soft-warn.
			const titleSource = result?.titleSource;
			if (
				titleSource === "untitled-fallback" ||
				titleSource === "UNTITLED_FALLBACK"
			) {
				toast.warning(tCreate("titleInsufficient"));
			}

			setDescription("");
			setPriority("P2_MEDIUM");
			setSize("");
			setPendingFiles([]);
			setPendingDocs([]);
			setDraftingStage("PLACEHOLDER");
			setSelectedPromptId(undefined);
			setSelectedPromptVersionId(undefined);
		} catch {
			toast.error(tCreate("titleGenerationFailed"), { id: toastId });
		} finally {
			setIsOrchestrating(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				ref={dialogContentRef}
				className="sm:max-w-2xl [&>*]:min-w-0"
			>
				<DialogHeader>
					<DialogTitle>Create work item</DialogTitle>
					<DialogDescription>
						Describe what's needed or what's broken — the system
						classifies it as a feature or a bug and drafts the card
						for you.
					</DialogDescription>
				</DialogHeader>

				{isAiNotConfigured && (
					<Alert
						variant="error"
						data-testid="ai-provider-required-alert"
					>
						<AlertTriangleIcon className="size-4" />
						<AlertTitle>No AI provider configured</AlertTitle>
						<AlertDescription className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
							<span>
								Work item creation uses AI to draft the title
								and description for you. Connect an AI provider
								to continue.
							</span>
							<Button
								asChild
								size="sm"
								variant="outline"
								className="shrink-0 border-destructive hover:bg-destructive/10"
							>
								<Link href={aiProviderSettingsUrl}>
									<SettingsIcon className="mr-2 size-4" />
									Connect provider
								</Link>
							</Button>
						</AlertDescription>
					</Alert>
				)}

				<form onSubmit={handleSubmit} className="space-y-4 min-w-0">
					<div className="space-y-2">
						<Label htmlFor="create-description">
							{tCreate("descriptionLabel")}
						</Label>
						<Textarea
							id="create-description"
							placeholder="Describe what's needed or what's broken…"
							value={description}
							onChange={(e) => setDescription(e.target.value)}
							rows={3}
							required
						/>
					</div>

					<AttachmentsField
						files={pendingFiles}
						onChange={setPendingFiles}
						onValidationError={(msg) => toast.error(msg)}
						disabled={isSubmitting || isOrchestrating}
					/>

					<CreateStoryDocAttachmentsField
						items={pendingDocs}
						onChange={setPendingDocs}
						onValidationError={(msg) => toast.error(msg)}
						disabled={isSubmitting || isOrchestrating}
					/>

					<div className="space-y-2">
						<Label>Prompt (default for features)</Label>
						{/* F-171: kind isn't known until the classifier runs server-side.
						    This selector only manages the FEATURE-stage default
						    binding (via "Bind as default") — it does NOT drive this
						    particular submission. The server-side classifier picks
						    the BUG or FEATURE prompt at submit time based on the
						    description. Power-user prompt overrides for this story
						    happen post-creation in the story workspace where kind is
						    known. */}
						<PromptSelector
							agentName="project_document_generator"
							documentType={draftingStage}
							storyKind="FEATURE"
							value={selectedPromptId}
							onValueChange={setSelectedPromptId}
							onPromptVersionChange={setSelectedPromptVersionId}
							disabled={isSubmitting}
							placeholder="Use default prompt"
							showBindAction
							tooltipCollisionBoundaryRef={dialogContentRef}
						/>
						<p className="text-xs text-muted-foreground">
							AI picks the appropriate prompt (bug vs feature)
							from the description. Use this selector to manage
							the default prompt for features at this stage.
						</p>
					</div>

					<div className="space-y-2">
						<Label htmlFor="create-stage">Stage</Label>
						<Select
							value={draftingStage}
							onValueChange={(v) =>
								setDraftingStage(v as FeatureDraftingStage)
							}
						>
							<SelectTrigger id="create-stage">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{CREATE_STAGE_OPTIONS.map((opt) => {
									const meta =
										MATURATION_STATUS_META[
											opt.maturationStatus
										];
									return (
										<SelectItem
											key={opt.draftingStage}
											value={opt.draftingStage}
										>
											<div className="flex items-center gap-2">
												<div
													className="size-2 rounded-full"
													style={{
														backgroundColor:
															meta.color,
													}}
												/>
												{meta.label}
											</div>
										</SelectItem>
									);
								})}
							</SelectContent>
						</Select>
					</div>

					<div className="grid grid-cols-2 gap-4">
						<div className="space-y-2">
							<Label htmlFor="create-priority">Priority</Label>
							<Select
								value={priority}
								onValueChange={setPriority}
							>
								<SelectTrigger id="create-priority">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{PRIORITY_OPTIONS.map((opt) => (
										<SelectItem
											key={opt.value}
											value={opt.value}
										>
											<div className="flex items-center gap-2">
												<div
													className="size-2 rounded-full"
													style={{
														backgroundColor:
															opt.color,
													}}
												/>
												{opt.label}
											</div>
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>

						<div className="space-y-2">
							<Label htmlFor="create-size">Size</Label>
							<Select value={size} onValueChange={setSize}>
								<SelectTrigger id="create-size">
									<SelectValue placeholder="Select size" />
								</SelectTrigger>
								<SelectContent>
									{SIZE_OPTIONS.map((opt) => (
										<SelectItem
											key={opt.value}
											value={opt.value}
										>
											{opt.label} - {opt.description}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					</div>

					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							onClick={() => onOpenChange(false)}
						>
							Cancel
						</Button>
						<Button
							type="submit"
							disabled={
								isSubmitting ||
								isOrchestrating ||
								!description.trim() ||
								isAiNotConfigured
							}
						>
							{isSubmitting || isOrchestrating ? (
								<>
									<Loader2Icon className="mr-2 size-4 animate-spin motion-safe:animate-spin" />
									{selectedPromptId
										? "Drafting with AI…"
										: "Creating…"}
								</>
							) : selectedPromptId ? (
								<>
									<SparklesIcon className="mr-2 size-4" />
									Create
								</>
							) : (
								"Create"
							)}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
