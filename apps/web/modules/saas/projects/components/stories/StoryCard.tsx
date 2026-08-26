"use client";

import { useAnalytics } from "@analytics";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
	detectPMTypeFromUrl,
	normalizeAdoWebUrl,
	pmDetectedTypeDisplayName,
} from "@repo/utils";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
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
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Checkbox } from "@ui/components/checkbox";
import { ContextMenu, ContextMenuTrigger } from "@ui/components/context-menu";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import { formatDistanceToNowStrict } from "date-fns";
import {
	ArrowDownIcon,
	ArrowLeftRightIcon,
	ArrowUpIcon,
	CheckIcon,
	ChevronDownIcon,
	ChevronRightIcon,
	CircleCheckBigIcon,
	CircleSlashIcon,
	CodeIcon,
	DownloadIcon,
	ExternalLink,
	ExternalLinkIcon,
	FileCodeIcon,
	FileTextIcon,
	FlagIcon,
	FolderKanbanIcon,
	GitPullRequestArrowIcon,
	GripVerticalIcon,
	Loader2Icon,
	MoreHorizontalIcon,
	PauseIcon,
	PencilIcon,
	RotateCcwIcon,
	SparklesIcon,
	Trash2Icon,
	XIcon,
} from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { memo, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
	BACKLOG_CONTEXT_MENU_EVENT,
	type BacklogContextMenuPayload,
} from "../../../../analytics/events/backlog-context-menu";
import { orpcClient } from "../../../../shared/lib/orpc-client";
import {
	DEFAULT_ROADMAP_COLUMN_ORDER,
	type RoadmapColumnKey,
	type RoadmapFieldKey,
} from "../../hooks/useRoadmapView";
import {
	formatPrimaryTaskLabel,
	getImplementationSessionLinks,
	summarizeTaskSessionVisibility,
} from "../../lib/implementation-session-runtime";
import { formatLastEditSource } from "../../lib/last-edit-source-copy";
import {
	buildProjectSettingsRoute,
	buildStoryDetailsRoute,
} from "../../lib/stories/routes";
import type {
	LatestCodingRun,
	MaturationStatus,
	StoryTask,
	UserStory,
} from "../../lib/stories/types";
import {
	getMaturationStatus,
	getPriorityLabel,
	getSizeDescription,
	getSizeLabel,
	MATURATION_STATUS_META,
	PRIORITY_OPTIONS,
} from "../../lib/stories/types";
import { CodingRunStatusBadge } from "../coding-runs/CodingRunStatusBadge";
import { BlockedBadge } from "./BlockedBadge";
import {
	type ConflictPreview,
	ConflictResolveDialog,
} from "./ConflictResolveDialog";
import { ConvertKindConfirmDialog } from "./ConvertKindConfirmDialog";
import { DeclinedDuplicateBadge } from "./DeclinedDuplicateBadge";
import { DuplicateBadge } from "./DuplicateBadge";
import { NeedsMoreInfoBadge } from "./NeedsMoreInfoBadge";
import { PmSyncCloudToggle } from "./pm-sync/PmSyncCloudToggle";
import { PmSyncConflictBadge } from "./pm-sync/PmSyncConflictBadge";
import { PmSyncFailureBadge } from "./pm-sync/PmSyncFailureBadge";
import { PmSyncFailureSidePanel } from "./pm-sync/PmSyncFailureSidePanel";
import { PmSyncPendingIndicator } from "./pm-sync/PmSyncPendingIndicator";
import { useInvalidatePmSyncState } from "./pm-sync/use-invalidate-pm-sync-state";
import { useAiReassessEligibility } from "./priority/useAiReassessEligibility";
import { useAiReprioritizeStory } from "./priority/useAiReprioritizeStory";
import { SourceChip } from "./SourceChip";
import { StageProgress } from "./StageProgress";
import { StoryContextActions } from "./StoryContextActions";
import { useStoryDownloadActions } from "./StoryDownloadDropdown";
import { StoryKindIcon } from "./StoryKindIcon";
import { StoryKindRegenerationBadge } from "./StoryKindRegenerationBadge";
import {
	useInvalidateStoryAfterRegeneration,
	useStoryKindRegeneration,
	watchStoryKindRegeneration,
} from "./useStoryKindRegeneration";

const ACTIVE_CODING_RUN_STATUSES = new Set([
	"QUEUED",
	"STARTING",
	"RUNNING",
	"AWAITING_REVIEW",
	"PR_OPENED",
]);

const ACTIVE_AGENT_STATUSES = new Set(["running", "working", "executing"]);

const AWAITING_AGENT_STATUSES = new Set([
	"paused",
	"checkpoint",
	"awaiting_approval",
]);

function shouldShowCodingRun(run: LatestCodingRun | null | undefined): boolean {
	if (!run) {
		return false;
	}
	if (ACTIVE_CODING_RUN_STATUSES.has(run.status)) {
		return true;
	}
	// Show terminal statuses only if recent (within 24h)
	const ageMs = Date.now() - new Date(run.createdAt).getTime();
	return ageMs < 24 * 60 * 60 * 1000;
}

/**
 * Validate that a URL is a valid external URL (absolute http/https).
 * Returns undefined for invalid URLs to prevent 404s from relative paths.
 *
 * Also rewrites legacy Azure DevOps REST-API URLs
 * (`/_apis/wit/workItems/<id>`) to their web-UI equivalent
 * (`/_workitems/edit/<id>`) so rows synced before the extractor fix
 * still open in a browser instead of dumping JSON.
 */
function getValidExternalUrl(
	url: string | null | undefined,
): string | undefined {
	if (!url) {
		return undefined;
	}
	const trimmed = url.trim();
	if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
		return normalizeAdoWebUrl(trimmed);
	}
	// Invalid URL - don't render it
	return undefined;
}

function buildProjectKanbanRoute(pathname: string, storyId: string): string {
	const normalizedPath = pathname.replace(/\/+$/, "");
	const route = `${normalizedPath}/kanban`;
	const params = new URLSearchParams({ storyId });
	return `${route}?${params.toString()}`;
}

type Props = {
	story: UserStory;
	/**
	 * Relative match strength for the active search (best result = 100).
	 * Rendered as a small badge by the title; absent outside search results.
	 */
	matchPercent?: number;
	projectId: string;
	/**
	 * Org-or-personal route base (e.g., "/app/acme" or "/app"). Passed by
	 * the parent (`StoriesRoadmap` / `StoryWorkspacePage`) which reads it from
	 * `useOrganizationContext()`. Used to build the story-details URL
	 * for the right-click "Open in new tab" action — see spec
	 * `2026-05-25-backlog-context-menu-open-in-new-tab` §7.4. Optional
	 * with a `"/app"` fallback so callers that have not been updated
	 * yet continue to behave correctly (the menu just opens the
	 * personal-context URL).
	 */
	basePath?: string;
	/** Project display name. Used by the Download submenu for the export footer. */
	projectName?: string;
	organizationId?: string | null;
	onSelect: (storyId: string) => void;
	onDelete: (storyId: string) => void;
	onSync?: (storyId: string, direction: "push" | "pull") => void;
	onTaskToggle?: (storyId: string, taskId: string) => void;
	hasPMIntegration?: boolean;
	pmToolName?: string;
	/** Map assigneeId -> display name for showing assignee on card */
	assigneeNames?: Record<string, string>;
	/** Card selection for bulk actions (UI state only) */
	isSelected?: boolean;
	onSelectionChange?: (storyId: string, checked: boolean) => void;
	/** Number of rows currently selected — drives the right-click menu's
	 * single-vs-bulk mode (bulk when this card is part of a multi-selection). */
	selectedCount?: number;
	/** Bulk operations on the CURRENT selection, invoked from the right-click
	 * menu when this card is one of several selected rows. */
	bulkActions?: {
		setPriority: (
			priority: "P0_CRITICAL" | "P1_HIGH" | "P2_MEDIUM" | "P3_LOW",
		) => void;
		setStage: (stage: MaturationStatus) => void;
		hide: () => void;
		show: () => void;
		requestDelete: () => void;
	};
	/** When true, clicking the title or card body opens details (onSelect) instead of inline rename */
	disableInlineRename?: boolean;
	/** When provided, the "Open details" dropdown item calls this instead of onSelect */
	onOpenDetails?: (storyId: string) => void;
	/** Callback to execute this feature with Weave multi-agent orchestration */
	onExecuteWithWeave?: (storyId: string) => void;
	/** Callback to start an implementation session for this feature */
	onStartImplementationSession?: (storyId: string) => void;
	/** Whether the project has a GitHub repository configured */
	hasRepository?: boolean;
	/** Callback when the coding run indicator is clicked */
	onCodingRunClick?: (codingRunId: string) => void;
	/** Potential-duplicate info from the roadmap scan. When present, a
	 * "possible duplicate" chip is shown; clicking it opens the resolve dialog.
	 * `overlapOnly` = every link is an OVERLAP (overlapping scope, not a true
	 * duplicate) — the chip label reflects the softer relationship. */
	duplicateInfo?: {
		count: number;
		partnerTitles: string[];
		overlapOnly?: boolean;
		onResolve: () => void;
	};
	/** Identifier of the survivor a declined-duplicate was merged into (e.g.
	 * "F-098"), for the "Declined duplicate" chip tooltip. Resolved by the
	 * roadmap from the loaded stories; omitted → a generic tooltip. */
	mergedIntoIdentifier?: string | null;
	/** Resolved workflow status (ProjectStoryStatus) for the status badge.
	 * The roadmap resolves it from `statusId`; omit to hide the badge. */
	status?: { name: string; color: string } | null;
	/** Display name of the story's author (`createdById`), resolved by the parent. */
	creatorName?: string | null;
	/** When true, the row shows author+created / editor+updated provenance instead
	 * of the assignee (the roadmap opts in; the Kanban keeps the assignee). */
	showProvenance?: boolean;
	/** Apply the zebra (alternating-row) background tint. */
	zebra?: boolean;
	/** Drag-to-reorder is only enabled in manual Roadmap-order sort. */
	canReorder?: boolean;
	/** Optional per-column visibility (roadmap settings gear). Omitted columns
	 * default to visible; only gates roadmap-specific columns. */
	columns?: {
		stage?: boolean;
		sync?: boolean;
		size?: boolean;
		source?: boolean;
		tags?: boolean;
		flags?: boolean;
	};
	/** Left-to-right order of the optional columns (drag-reorderable in the
	 * settings gear). Defaults to the canonical order. */
	columnOrder?: RoadmapFieldKey[];
	/** Maturation V2: render the dummy maturation status label (To Do /
	 * Discovery / Done) in place of the five-stage StageProgress. Only passed
	 * true outside the stage-grouped roadmap view, where the stage lanes still
	 * carry the five-stage vocabulary (the 5→3 lane collapse ships later with
	 * the kanban swim-lane work). */
	maturationV2?: boolean;
};

function StoryCardImpl({
	story,
	matchPercent,
	projectId,
	projectName,
	organizationId,
	basePath = "/app",
	onSelect,
	onDelete,
	onSync,
	onTaskToggle,
	hasPMIntegration,
	pmToolName = "your PM tool",
	isSelected = false,
	onSelectionChange,
	selectedCount = 0,
	bulkActions,
	disableInlineRename = false,
	onOpenDetails,
	onExecuteWithWeave,
	onStartImplementationSession,
	hasRepository = false,
	onCodingRunClick,
	duplicateInfo,
	mergedIntoIdentifier,
	creatorName,
	showProvenance = false,
	zebra = false,
	canReorder = false,
	columns,
	columnOrder,
	maturationV2 = false,
}: Props) {
	const router = useRouter();
	const pathname = usePathname();
	const analytics = useAnalytics();
	const tStories = useTranslations("tooltips.stories");
	const tCommon = useTranslations("tooltips.common");
	const tDownload = useTranslations("projects.stories.download");
	const tDuplicates = useTranslations("projects.stories.duplicates");
	const tConvert = useTranslations("projects.stories.convertKind");
	const queryClient = useQueryClient();
	const lastActivityAt = story.lastEditedAt ?? story.createdAt;
	// Per-format download actions for the kebab Download submenu. The hook
	// is the same one `StoryDownloadDropdown` consumes, so the kebab and the
	// in-context dropdowns always behave identically.
	const downloadActions = useStoryDownloadActions(story, {
		id: projectId,
		name: projectName ?? story.identifier,
	});
	const [tasksExpanded, setTasksExpanded] = useState(false);
	const [isRenaming, setIsRenaming] = useState(false);
	const [renameValue, setRenameValue] = useState(story.title);
	const [isOpeningDetails, setIsOpeningDetails] = useState(false);
	const [syncConfirm, setSyncConfirm] = useState<{
		direction: "push" | "pull";
	} | null>(null);
	const [pmFailurePanelOpen, setPmFailurePanelOpen] = useState(false);
	const [conflictDialogOpen, setConflictDialogOpen] = useState(false);
	const [pmConflictPreview, setPmConflictPreview] =
		useState<ConflictPreview | null>(null);
	const inputRef = useRef<HTMLInputElement>(null);

	// Kanban integration — queue the story then navigate (auto-pull fires on kanban:ready)
	const { mutateAsync: queueForKanban, isPending: isQueuingForKanban } =
		useMutation(orpc.projects.stories.queueForKanban.mutationOptions());

	const handleOpenInKanban = async (): Promise<void> => {
		try {
			await queueForKanban({
				projectId,
				storyId: story.id,
				organizationId: organizationId ?? null,
			});
		} catch {
			// Queue failure is non-fatal — still open kanban, pull will retry next time
		}
		router.push(buildProjectKanbanRoute(pathname, story.id));
	};

	const completedTasks = story.tasks.filter((t) => t.isCompleted).length;
	const totalTasks = story.tasks.length;
	const taskSessionSummary = summarizeTaskSessionVisibility(story.tasks);
	const storyRunLinks = story.latestCodingRun
		? getImplementationSessionLinks({
				provider: story.latestCodingRun.provider,
				externalUrl: story.latestCodingRun.externalUrl,
				providerMetadata: story.latestCodingRun.providerMetadata,
			})
		: null;
	const primaryTaskLabel = formatPrimaryTaskLabel(
		story.latestCodingRun?.storyTask,
	);
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

	const openStoryDetails = () => {
		if (isOpeningDetails) {
			return;
		}
		setIsOpeningDetails(true);
		// Safety: if we're still mounted after 400ms, navigation was blocked
		// (e.g. by codingRunPendingRef guard) — unlock the card.
		setTimeout(() => setIsOpeningDetails(false), 400);
		if (onOpenDetails) {
			onOpenDetails(story.id);
			return;
		}
		onSelect(story.id);
	};

	// Right-click / middle-click / keyboard "Open in new tab" handler. Uses the
	// shared `buildStoryDetailsRoute` helper so the destination is guaranteed
	// to match the row's left-click navigation (FR-14). Silent no-op when the
	// inputs are not yet resolved (FR-13).
	//
	// When fabric.pro is installed as a PWA, modern Chrome routes any in-scope
	// navigation — declarative `<a target="_blank">`, programmatic anchor
	// clicks, and `window.open(url, '_blank', ...)` — into the standalone
	// Fabric PWA window. The only reliable source-side bypass is to open
	// `about:blank` first (a same-origin `about:` window not in any PWA
	// scope) and then assign `w.location.href` to navigate the new tab to
	// the target URL. `w.opener = null` severs the backref so the opened
	// tab cannot manipulate this one via `window.opener`, preserving the
	// security guarantee normally provided by `rel="noopener"`. Early-return
	// when the initial `window.open` returns `null` so popup-blocked clicks
	// stay silent instead of leaving a stuck-on-about:blank tab.
	const openInNewTab = (trigger: BacklogContextMenuPayload["trigger"]) => {
		if (!projectId || !story.id) {
			return;
		}
		const url = buildStoryDetailsRoute(basePath, projectId, story.id);
		const w = window.open("about:blank", "_blank");
		if (!w) {
			return;
		}
		w.opener = null;
		w.location.href = url;
		analytics.trackEvent(BACKLOG_CONTEXT_MENU_EVENT, { trigger });
	};

	// Focus input when rename mode starts
	useEffect(() => {
		if (isRenaming) {
			inputRef.current?.focus();
		}
	}, [isRenaming]);

	// Reset transient opening state when this component is showing a different story.
	useEffect(() => {
		setIsOpeningDetails(false);
	}, [story.id]);

	const renameMutation = useMutation({
		mutationFn: async (title: string) => {
			return await orpcClient.projects.stories.update({
				projectId,
				storyId: story.id,
				title,
				organizationId: organizationId ?? null,
			});
		},
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: orpc.projects.stories.list.queryKey({
					input: {
						projectId,
						organizationId: organizationId ?? null,
					},
				}),
			});
		},
		onError: (error) => {
			toast.error(
				`Failed to rename ${story.kind === "BUG" ? "bug" : "feature"}`,
				{
					description:
						error instanceof Error ? error.message : String(error),
				},
			);
		},
	});

	const handleRenameCommit = () => {
		const trimmed = renameValue.trim();
		if (!trimmed || trimmed === story.title) {
			setIsRenaming(false);
			setRenameValue(story.title);
			return;
		}
		setIsRenaming(false);
		renameMutation.mutate(trimmed);
	};

	const handleRenameKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "Enter") {
			handleRenameCommit();
		} else if (e.key === "Escape") {
			setIsRenaming(false);
			setRenameValue(story.title);
		}
	};

	const isClosed = story.draftingStage === "CLOSED";
	// Right-click acts on the whole selection when this row is part of a
	// multi-selection; otherwise it acts on just this card.
	const bulkMode = isSelected && selectedCount > 1 && bulkActions != null;
	const storiesListQueryKey = orpc.projects.stories.list.queryKey({
		input: {
			projectId,
			organizationId: organizationId ?? null,
		},
	});
	const invalidatePmSyncState = useInvalidatePmSyncState(projectId);

	// F-171 convert-type action (REQ-11, AC10). Flips kind via a dedicated
	// procedure that snaps draftingStage to DRAFT.
	//
	// Fizzy #2048: that procedure now also starts a redraft of the body through
	// the new type's template, asynchronously — so the flip resolving is NOT
	// the conversion finishing. The card follows the redraft through the
	// persisted job row (`useStoryKindRegeneration`), never a local flag: this
	// row unmounts and remounts freely as the roadmap re-renders and filters.
	const [convertDialogOpen, setConvertDialogOpen] = useState(false);
	const targetKind: "BUG" | "FEATURE" =
		story.kind === "BUG" ? "FEATURE" : "BUG";
	const invalidateAfterRegeneration = useInvalidateStoryAfterRegeneration(
		projectId,
		story.id,
		organizationId ?? null,
	);
	const regeneration = useStoryKindRegeneration({
		projectId,
		storyId: story.id,
		organizationId: organizationId ?? null,
		onCompleted: invalidateAfterRegeneration,
		onFailed: invalidateAfterRegeneration,
	});
	const convertKindMutation = useMutation({
		mutationFn: async () => {
			return await orpcClient.projects.stories.convertKind({
				projectId,
				storyId: story.id,
				organizationId: organizationId ?? null,
				targetKind,
			});
		},
		onSuccess: (result) => {
			// The type has changed; the rewrite has not run. The previous copy
			// ("Converted to bug") claimed a finished conversion.
			toast.success(
				targetKind === "BUG"
					? tConvert("startedBug")
					: tConvert("startedFeature"),
				{ description: tConvert("startedDescription") },
			);
			setConvertDialogOpen(false);
			if (result?.regeneration?.workflowId) {
				watchStoryKindRegeneration(story.id);
			}
			queryClient.invalidateQueries({ queryKey: storiesListQueryKey });
		},
		onError: (error) => {
			toast.error(
				error instanceof Error ? error.message : "Failed to convert",
			);
		},
	});

	const changePriorityMutation = useMutation({
		mutationFn: async (
			newPriority: "P0_CRITICAL" | "P1_HIGH" | "P2_MEDIUM" | "P3_LOW",
		) => {
			return await orpcClient.projects.stories.update({
				projectId,
				storyId: story.id,
				organizationId: organizationId ?? null,
				priority: newPriority,
			});
		},
		onSuccess: (_data, newPriority) => {
			const label =
				PRIORITY_OPTIONS.find((p) => p.value === newPriority)?.label ??
				newPriority;
			toast.success(`Priority changed to ${label}`);
			queryClient.invalidateQueries({ queryKey: storiesListQueryKey });
		},
		onError: (error) => {
			toast.error("Failed to change priority", {
				description: (error as Error).message,
			});
		},
	});

	// The per-item AI pass — shared hook, so the toast (band move + rationale)
	// and history-cache refresh match the Priority view's sparkle exactly.
	const aiReassessEligible = useAiReassessEligibility({
		projectId,
		organizationId: organizationId ?? null,
		draftingStage: story.draftingStage,
		statusId: story.statusId,
	});
	const aiReprioritizeMutation = useAiReprioritizeStory({
		projectId,
		organizationId: organizationId ?? null,
		onApplied: () => {
			queryClient.invalidateQueries({ queryKey: storiesListQueryKey });
		},
	});

	const closeReopenMutation = useMutation({
		mutationFn: async (targetStage: "CLOSED" | "DRAFT") => {
			return await orpcClient.projects.stories.updateDraftingStage({
				projectId,
				storyId: story.id,
				organizationId: organizationId ?? null,
				targetStage,
			});
		},
		onMutate: async (targetStage) => {
			await queryClient.cancelQueries({ queryKey: storiesListQueryKey });
			const previousList = queryClient.getQueryData(storiesListQueryKey);
			queryClient.setQueryData<{ stories: UserStory[] } | undefined>(
				storiesListQueryKey,
				(old) => {
					if (!old || !Array.isArray(old.stories)) {
						return old;
					}
					return {
						...old,
						stories: old.stories.map((s) =>
							s.id === story.id
								? { ...s, draftingStage: targetStage }
								: s,
						),
					};
				},
			);
			return { previousList };
		},
		onError: (error, _vars, context) => {
			if (context?.previousList !== undefined) {
				queryClient.setQueryData(
					storiesListQueryKey,
					context.previousList,
				);
			}
			toast.error(
				error instanceof Error
					? error.message
					: `Failed to update ${story.kind === "BUG" ? "bug" : "feature"}`,
			);
		},
		onSuccess: (_data, targetStage) => {
			toast.success(
				targetStage === "CLOSED"
					? `${story.kind === "BUG" ? "Bug" : "Feature"} hidden`
					: `${story.kind === "BUG" ? "Bug" : "Feature"} unhidden`,
			);
		},
		onSettled: () => {
			queryClient.invalidateQueries({ queryKey: storiesListQueryKey });
		},
	});

	const retryPmSyncMutation = useMutation({
		mutationFn: async (pushAnyway: boolean) => {
			return await orpcClient.projects.stories.retryPmSync({
				projectId,
				storyId: story.id,
				pushAnyway,
				organizationId: organizationId ?? null,
			});
		},
		onSuccess: () => {
			toast.success("Sync queued");
			invalidatePmSyncState();
		},
		onError: (error) => {
			toast.error("Failed to queue sync", {
				description:
					error instanceof Error ? error.message : String(error),
			});
		},
	});

	// "Unlink & re-create" for a deleted PM card: severs the dead link then
	// re-syncs, so the push takes the CREATE path and makes a fresh card. A
	// deliberate user action (the failure panel's primary CTA for a missing card).
	const unlinkRecreateMutation = useMutation({
		mutationFn: async () => {
			return await orpcClient.projects.stories.retryPmSync({
				projectId,
				storyId: story.id,
				unlinkFirst: true,
				organizationId: organizationId ?? null,
			});
		},
		onSuccess: () => {
			toast.success("Unlinked — re-creating in your PM tool");
			invalidatePmSyncState();
		},
		onError: (error) => {
			toast.error("Failed to unlink & re-create", {
				description:
					error instanceof Error ? error.message : String(error),
			});
		},
	});

	// Relink: an override push that drops the link to the OTHER PM tool and
	// creates a fresh card in the project's current tool. The failure panel's
	// primary CTA for a "synced to a different PM tool" (PM_TOOL_MISMATCH) error,
	// where a plain retry can never clear the mismatch. Mirrors the roadmap's
	// migrate-confirm flow so the editor chip + roadmap card behave the same.
	const relinkMutation = useMutation({
		mutationFn: async () => {
			return await orpcClient.projects.stories.sync({
				projectId,
				storyId: story.id,
				organizationId: organizationId ?? null,
				direction: "push",
				overrideMismatch: true,
			});
		},
		onSuccess: () => {
			toast.success(`Re-linking to ${pmToolName}…`);
			invalidatePmSyncState();
		},
		onError: (error) => {
			toast.error("Failed to relink", {
				description:
					error instanceof Error ? error.message : String(error),
			});
		},
	});

	const previewConflictMutation = useMutation({
		mutationFn: async () => {
			return await orpcClient.projects.stories.checkPmSyncConflicts({
				projectId,
				items: [{ id: story.id, itemType: "story" }],
				organizationId: organizationId ?? null,
			});
		},
		onSuccess: async (data) => {
			const result = data.results[0];
			// The current user's PM connection couldn't load the PM side
			// (credentials missing/expired, no board access, …). Do NOT
			// auto-dismiss the conflict below — that would silently clear an
			// unresolved conflict for a teammate who simply hasn't connected
			// their own PM account. Open the dialog with an actionable error.
			if (result?.pmError) {
				setPmConflictPreview({
					pmTool: result.pmTool ?? null,
					pmError: result.pmError,
				});
				setConflictDialogOpen(true);
				return;
			}
			if (result?.hasConflict && result.pmCurrent) {
				setPmConflictPreview({
					pmCurrent: result.pmCurrent,
					pmUrl: result.pmUrl,
					pmTool: result.pmTool,
				});
				setConflictDialogOpen(true);
				return;
			}
			// Preview just verified PM matches the Fabric baseline, so the
			// stored CONFLICT flag is stale. Auto-clear it so the badge does
			// not persist as a dead-end the user cannot dismiss.
			try {
				await orpcClient.projects.stories.dismissPmSyncConflict({
					projectId,
					storyId: story.id,
					organizationId: organizationId ?? null,
				});
			} catch {
				// Best-effort: if the dismiss call fails, fall through to the
				// refetch — the badge stays but the user is no worse off.
			}
			toast.info("No conflict detected", {
				description:
					"PM ticket matches Fabric — clearing the conflict.",
			});
			// Clearing a conflict must also refresh the Review Center count,
			// not just the roadmap list — same contract as a dialog resolve.
			invalidatePmSyncState();
		},
		onError: (error) => {
			toast.error("Failed to load PM ticket", {
				description:
					error instanceof Error ? error.message : String(error),
			});
		},
	});

	const priorityLabel = getPriorityLabel(story.priority).replace(
		/^P\d+\s*-\s*/i,
		"",
	);

	// "Synced to {X}" must describe the tool that this specific row was
	// actually synced to, not the project's currently configured PM tool.
	// When a project switches integrations (e.g. Fizzy → ADO) historical
	// rows keep their externalUrl pointing at the old tool; showing the
	// new tool's name above a link that opens the old tool is the bug.
	// Falls back to the project-level pmToolName when the URL host is
	// unknown or the story isn't synced.
	const linkedPmToolName =
		pmDetectedTypeDisplayName(detectPMTypeFromUrl(story.externalUrl)) ??
		pmToolName;

	// PM terminal-status checkmark (card #1360 Phase A). Reuse the friendlier
	// `linkedPmToolName` (with its project-level fallback) rather than a weaker
	// "PM tool" default.
	const pmTerminalTooltip = story.pmTicketTerminalStatus
		? `Marked ${story.pmTicketTerminalStatus} in ${linkedPmToolName}`
		: `Reached a terminal status in ${linkedPmToolName}`;

	// The optional columns, in the user's chosen order, filtered to those that
	// are enabled. Rendered as fixed-width cells (contiguous, just left of the
	// kebab) so they line up into straight columns across every row regardless
	// of how many sporadic badges precede them.
	const fieldOrder = columnOrder ?? DEFAULT_ROADMAP_COLUMN_ORDER;
	// Flex `order` for a field. The leading checkbox/icon/identifier stay at
	// 0 (always first) and the kebab at 999 (always last); the orderable
	// fields (Title + columns) sit between, by their position in fieldOrder.
	const orderOf = (key: RoadmapFieldKey) => {
		const i = fieldOrder.indexOf(key);
		return i < 0 ? 50 : i + 1;
	};
	const effectiveColumnOrder = fieldOrder.filter(
		(key): key is Exclude<RoadmapFieldKey, "title"> =>
			key !== "title" && columns?.[key as RoadmapColumnKey] !== false,
	);

	const renderColumnCell = (key: RoadmapColumnKey) => {
		switch (key) {
			case "stage":
				return (
					<div
						key="stage"
						style={{ order: orderOf("stage") }}
						className="hidden w-40 shrink-0 items-center md:flex"
					>
						{maturationV2 ? (
							(() => {
								const meta =
									MATURATION_STATUS_META[
										getMaturationStatus(story)
									];
								return (
									<span
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
							})()
						) : (
							<StageProgress
								stage={story.draftingStage}
								kind={story.kind}
							/>
						)}
					</div>
				);
			case "size":
				return (
					<div
						key="size"
						style={{ order: orderOf("size") }}
						className="hidden w-12 shrink-0 items-center md:flex"
					>
						{story.size && (
							<Tooltip>
								<TooltipTrigger asChild>
									<span className="rounded-full border border-border/60 bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">
										{getSizeLabel(story.size)}
									</span>
								</TooltipTrigger>
								<TooltipContent>
									Size — {getSizeDescription(story.size)}
								</TooltipContent>
							</Tooltip>
						)}
					</div>
				);
			case "source":
				return (
					<div
						key="source"
						style={{ order: orderOf("source") }}
						className="hidden w-28 shrink-0 items-center md:flex"
					>
						<SourceChip
							source={story.source}
							className="text-[10px]"
						/>
					</div>
				);
			case "sync":
				// The PM sync STATUS chip (configurable + reorderable). Sits in a
				// fixed-width column just before the always-on cloud toggle, so the
				// chip reads as "near the cloud". The cloud itself is rendered in a
				// permanent slot outside this switch (never hidden by config).
				return (
					<div
						key="sync"
						style={{ order: orderOf("sync") }}
						className="hidden w-40 shrink-0 items-center justify-end gap-2 md:flex"
					>
						{story.lastPmSyncStatus === "PENDING" && (
							<PmSyncPendingIndicator
								className="shrink-0"
								pmToolName={pmToolName}
							/>
						)}
						{story.lastPmSyncStatus === "CONFLICT" && (
							<PmSyncConflictBadge
								className="shrink-0"
								pmToolName={pmToolName}
								loading={previewConflictMutation.isPending}
								onClick={() => setConflictDialogOpen(true)}
							/>
						)}
						{story.lastPmSyncStatus === "FAILED" && (
							<PmSyncFailureBadge
								className="shrink-0"
								pmToolName={pmToolName}
								onClick={() => setPmFailurePanelOpen(true)}
							/>
						)}
					</div>
				);
			case "tags": {
				// Read defensively for symmetry with StoryWorkspace — `tags`
				// may be absent on partially-hydrated story payloads.
				const tags = story.tags ?? [];
				if (tags.length === 0) {
					return null;
				}
				const VISIBLE = 3;
				const shown = tags.slice(0, VISIBLE);
				const overflow = tags.length - shown.length;
				return (
					<div
						key="tags"
						style={{ order: orderOf("tags") }}
						className="hidden w-40 shrink-0 flex-wrap items-center gap-1 md:flex"
					>
						{shown.map((tag) => (
							<Badge
								key={tag.id}
								variant="secondary"
								className="max-w-[7rem] truncate text-[10px]"
							>
								{tag.value}
							</Badge>
						))}
						{overflow > 0 && (
							<span className="text-[10px] text-muted-foreground">
								+{overflow} more
							</span>
						)}
					</div>
				);
			}
			default:
				return null;
		}
	};

	if (isDragging) {
		return (
			<div
				ref={setNodeRef}
				style={dragStyle}
				className="h-[58px] rounded-xl border border-dashed border-primary/40 bg-primary/[0.06]"
			/>
		);
	}

	return (
		<div
			ref={setNodeRef}
			id={`story-${story.id}`}
			data-story-id={story.id}
			style={dragStyle}
			// content-visibility lets the browser skip layout/paint for rows
			// scrolled out of view (native render virtualization) — the main
			// fix for scroll jank on large backlogs. The intrinsic-size hint
			// keeps the scrollbar stable; `auto` remembers each row's last
			// rendered height. dnd-kit is unaffected: the actively dragged row
			// renders via the placeholder branch above (no containment).
			className="group scroll-mt-32 [content-visibility:auto] [contain-intrinsic-size:auto_58px]"
		>
			{/* Main row */}
			<ContextMenu>
				<ContextMenuTrigger asChild>
					<div
						className={cn(
							"flex min-h-[58px] flex-wrap items-center gap-x-2 gap-y-1.5 rounded-xl border border-border/50 px-2.5 py-1.5 transition-colors cursor-pointer",
							// Zebra striping: alternate rows get a subtle tint so
							// the dense list scans row-by-row.
							zebra ? "bg-muted/25" : "bg-background/35",
							"hover:border-border/70 hover:bg-background/60",
							isSelected &&
								"border-primary/20 bg-primary/[0.08] hover:bg-primary/[0.1]",
							tasksExpanded && "rounded-b-none border-b-0",
							isOpeningDetails &&
								"pointer-events-none opacity-70",
						)}
						onMouseDown={(e) => {
							// FR-9: middle-click (button 1) opens the same destination in
							// a new tab. Listening on `mousedown` instead of `auxclick`
							// because Chromium does not reliably fire `auxclick` on
							// non-anchor elements (<div role="button">); mousedown fires
							// universally. `preventDefault()` suppresses the browser's
							// middle-click autoscroll default.
							if (e.button !== 1) {
								return;
							}
							e.preventDefault();
							openInNewTab("middle-click");
						}}
						// FR-10: `tabIndex={0}` is kept on both rename-enabled and
						// rename-disabled branches so the keyboard context-menu
						// trigger (Shift+F10 / application key, handled by Radix)
						// works regardless of `disableInlineRename`. `role="button"`
						// stays ONLY on the rename-disabled branch where the row
						// itself acts as the open-details affordance — adding it
						// elsewhere would break `getAllByRole("button")` filtering in
						// the existing `StoryCard.kebab.test.tsx` (which picks the
						// kebab via a descendant SVG selector and would otherwise
						// resolve to the row first).
						{...(disableInlineRename
							? {
									onClick: openStoryDetails,
									onKeyDown: (
										e: React.KeyboardEvent<HTMLDivElement>,
									) => {
										if (
											e.key === "Enter" ||
											e.key === " "
										) {
											e.preventDefault();
											openStoryDetails();
										}
									},
									role: "button" as const,
									tabIndex: 0,
								}
							: { tabIndex: 0 })}
					>
						{/* Drag handle — active only in manual Roadmap order. */}
						{canReorder ? (
							<button
								type="button"
								data-testid="story-card-drag-handle"
								aria-label="Drag to reorder"
								className="shrink-0 cursor-grab rounded-md p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-background/70 group-hover:opacity-50 hover:!opacity-100 active:cursor-grabbing"
								{...attributes}
								{...listeners}
								onClick={(e) => e.stopPropagation()}
								onMouseDown={(e) => {
									if (e.button === 1) {
										e.stopPropagation();
									}
								}}
							>
								<GripVerticalIcon className="size-3.5" />
							</button>
						) : (
							<Tooltip>
								<TooltipTrigger asChild>
									<span className="flex shrink-0 cursor-not-allowed items-center p-0.5 text-muted-foreground/20">
										<GripVerticalIcon className="size-3.5" />
									</span>
								</TooltipTrigger>
								<TooltipContent>
									Switch sort to “Roadmap order” to
									drag-reorder.
								</TooltipContent>
							</Tooltip>
						)}

						{/* Checkbox */}
						<div
							className="shrink-0"
							onMouseDown={(e) => {
								if (e.button === 1) {
									e.stopPropagation();
								}
							}}
						>
							<Checkbox
								checked={isSelected}
								onCheckedChange={(checked) =>
									onSelectionChange?.(
										story.id,
										checked === true,
									)
								}
								onClick={(e) => e.stopPropagation()}
								className={cn(
									"size-3.5 transition-opacity",
									!isSelected &&
										"opacity-0 group-hover:opacity-60",
								)}
								aria-label={`Select ${story.identifier}`}
							/>
						</div>

						{/* Leading kind indicator — Feature (Layers, tinted by
						    priority) or Bug (destructive red). Replaces the old
						    priority dot; the tooltip names the priority. */}
						<Tooltip>
							<TooltipTrigger asChild>
								<span className="flex shrink-0 items-center">
									<StoryKindIcon
										kind={story.kind}
										priority={story.priority}
										className="size-3.5"
									/>
								</span>
							</TooltipTrigger>
							<TooltipContent>
								{story.kind === "BUG"
									? `Bug · ${priorityLabel}`
									: priorityLabel}
							</TooltipContent>
						</Tooltip>

						{/* Identifier — with the always-on "last activity" date
						    stacked beneath it on the roadmap (showProvenance). */}
						{showProvenance ? (
							<div className="flex w-[92px] shrink-0 flex-col justify-center leading-tight">
								<span className="font-mono text-[11px] text-muted-foreground/50 tabular-nums">
									{story.identifier}
								</span>
								<Tooltip>
									<TooltipTrigger asChild>
										<span className="truncate text-[10px] text-muted-foreground/60 tabular-nums">
											{formatDistanceToNowStrict(
												new Date(lastActivityAt),
												{ addSuffix: true },
											)}
										</span>
									</TooltipTrigger>
									<TooltipContent>
										<div className="space-y-1.5 text-[11px] leading-snug">
											<p>
												<span className="font-medium">
													Created
												</span>
												{creatorName
													? ` by ${creatorName}`
													: ""}
												<br />
												{new Date(
													story.createdAt,
												).toLocaleString()}
												<br />
												<span className="text-muted-foreground/80">
													{new Date(
														story.createdAt,
													).toUTCString()}
												</span>
											</p>
											{story.lastEditedAt ? (
												<p>
													<span className="font-medium">
														Updated
													</span>
													{story.lastEditedByName
														? ` by ${story.lastEditedByName}`
														: ""}
													<br />
													{new Date(
														story.lastEditedAt,
													).toLocaleString()}
													<br />
													<span className="text-muted-foreground/80">
														{new Date(
															story.lastEditedAt,
														).toUTCString()}
													</span>
													<br />
													<span className="text-muted-foreground/80">
														{formatLastEditSource(
															story.lastEditedSource,
															pmToolName ?? null,
														)}
													</span>
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
						) : (
							<span className="w-[54px] shrink-0 font-mono text-[11px] text-muted-foreground/50 tabular-nums">
								{story.identifier}
							</span>
						)}

						{/* Title */}
						<div
							className="flex-1 min-w-0"
							style={{ order: orderOf("title") }}
						>
							{isRenaming && !disableInlineRename ? (
								<input
									ref={inputRef}
									value={renameValue}
									onChange={(e) =>
										setRenameValue(e.target.value)
									}
									onKeyDown={handleRenameKeyDown}
									onBlur={handleRenameCommit}
									className="w-full rounded border border-primary/40 bg-background px-1 py-0.5 text-sm text-foreground outline-none focus:ring-1 focus:ring-primary/50"
									onClick={(e) => e.stopPropagation()}
									onMouseDown={(e) => {
										if (e.button === 1) {
											e.stopPropagation();
										}
									}}
									onPointerDown={(e) => e.stopPropagation()}
								/>
							) : (
								<span className="group/title flex min-w-0 items-center gap-1">
									<button
										type="button"
										onClick={(e) => {
											e.stopPropagation();
											openStoryDetails();
										}}
										className="block min-w-0 text-left"
										aria-label={`Open details for ${story.title}`}
									>
										<span
											data-testid="story-card-title"
											title={story.title}
											className="text-sm text-foreground truncate leading-none hover:text-primary transition-colors block"
										>
											{story.title}
										</span>
									</button>
									{typeof matchPercent === "number" && (
										<span
											data-testid="story-match-percent"
											title="Relevance relative to the best match for this search"
											className="shrink-0 rounded-sm bg-muted px-1 py-px text-[10px] text-muted-foreground tabular-nums"
										>
											{matchPercent}%
										</span>
									)}
									{!disableInlineRename && (
										<Tooltip>
											<TooltipTrigger asChild>
												<button
													type="button"
													onClick={(e) => {
														e.stopPropagation();
														setIsRenaming(true);
														setRenameValue(
															story.title,
														);
													}}
													onPointerDown={(e) =>
														e.stopPropagation()
													}
													className="shrink-0 rounded p-0.5 opacity-0 group-hover/title:opacity-50 hover:!opacity-100 transition-opacity cursor-pointer text-muted-foreground"
													aria-label={`Rename ${story.kind === "BUG" ? "bug" : "feature"}`}
												>
													<PencilIcon className="size-3" />
												</button>
											</TooltipTrigger>
											<TooltipContent>
												{tCommon("clickToRename", {
													subject:
														story.kind === "BUG"
															? "bug"
															: "feature",
												})}
											</TooltipContent>
										</Tooltip>
									)}
								</span>
							)}
						</div>

						{/* Status-badge group (Needs more info, duplicates, story
						    points, tasks, agent status). Positioned by the reorderable
						    "flags" field — defaults to right after the title. */}
						<div className="contents md:order-[60] md:flex md:basis-full md:flex-wrap md:items-center md:gap-x-2 md:gap-y-1.5 xl:contents xl:order-none">
							<div
								className="flex shrink-0 items-center gap-2"
								style={{ order: orderOf("flags") }}
							>
								{isOpeningDetails && (
									<Loader2Icon className="size-3.5 animate-spin text-primary" />
								)}

								{/* Fizzy #2048 — the body redraft a type change
								    started. Ungated by `columns.flags`: this is
								    transient state about work happening right
								    now, not a display preference, and a refused
								    redraft is the only signal that the content
								    on this card is still the old type's. */}
								<StoryKindRegenerationBadge
									state={regeneration}
								/>

								{columns?.flags !== false && story.blocked && (
									<BlockedBadge
										tooltip={
											story.blockedReason ??
											"This work item is blocked."
										}
									/>
								)}

								{columns?.flags !== false &&
									story.kind === "BUG" &&
									story.needsMoreInfo && (
										<NeedsMoreInfoBadge
											tooltip={
												<>
													The AI couldn't act on this
													report yet. Edit the
													description and click
													"Re-evaluate Bug".
												</>
											}
										/>
									)}

								{/* Possible-duplicate chip (from the roadmap duplicate scan) */}
								{columns?.flags !== false &&
									duplicateInfo &&
									duplicateInfo.count > 0 && (
										<DuplicateBadge
											count={duplicateInfo.count}
											variant={
												duplicateInfo.overlapOnly
													? "overlap"
													: "duplicate"
											}
											tooltip={
												duplicateInfo.partnerTitles
													.length > 0
													? tDuplicates(
															duplicateInfo.overlapOnly
																? "chipTooltipOverlapKnown"
																: "chipTooltipKnown",
															{
																titles: duplicateInfo.partnerTitles.join(
																	"; ",
																),
															},
														)
													: tDuplicates(
															duplicateInfo.overlapOnly
																? "chipTooltipOverlapGeneric"
																: "chipTooltipGeneric",
														)
											}
											onClick={duplicateInfo.onResolve}
										/>
									)}

								{/* Declined-duplicate chip — this item was merged into a
								    survivor and moved to the closed stage. */}
								{columns?.flags !== false &&
									story.mergedIntoStoryId && (
										<DeclinedDuplicateBadge
											mergedIntoIdentifier={
												mergedIntoIdentifier
											}
										/>
									)}

								{/* PM terminal-status checkmark (card #1360). Shown whenever the
							    linked ticket is terminal — independent of draftingStage, so
							    it appears on hidden items under "Show Closed" too. */}
								{story.pmTicketTerminal && (
									<Tooltip>
										<TooltipTrigger asChild>
											<span
												className="flex shrink-0 items-center text-secondary"
												role="img"
												aria-label={pmTerminalTooltip}
											>
												<CircleCheckBigIcon className="size-3.5" />
											</span>
										</TooltipTrigger>
										<TooltipContent>
											{pmTerminalTooltip}
										</TooltipContent>
									</Tooltip>
								)}

								{/* Story points */}
								{story.storyPoints != null && (
									<span className="text-[10px] font-mono text-muted-foreground/60 shrink-0">
										{story.storyPoints}pt
									</span>
								)}

								{/* Task count toggle */}
								{totalTasks > 0 && (
									<button
										type="button"
										onClick={(e) => {
											e.stopPropagation();
											setTasksExpanded(!tasksExpanded);
										}}
										className="flex shrink-0 items-center gap-0.5 rounded-md px-1 py-0.5 text-[10px] text-muted-foreground/70 transition-colors hover:bg-background/70 hover:text-foreground"
									>
										{tasksExpanded ? (
											<ChevronDownIcon className="size-3" />
										) : (
											<ChevronRightIcon className="size-3" />
										)}
										{completedTasks}/{totalTasks}
									</button>
								)}

								{/* Aggregated agent status across tasks */}
								{(() => {
									const workingCount = story.tasks.filter(
										(t) =>
											ACTIVE_AGENT_STATUSES.has(
												t.agentStatus ?? "",
											),
									).length;
									const awaitingCount = story.tasks.filter(
										(t) =>
											AWAITING_AGENT_STATUSES.has(
												t.agentStatus ?? "",
											),
									).length;
									if (workingCount > 0) {
										return (
											<Tooltip>
												<TooltipTrigger asChild>
													<button
														type="button"
														onClick={(e) => {
															e.stopPropagation();
															setTasksExpanded(
																true,
															);
														}}
														className="flex shrink-0 items-center gap-1 rounded-full border border-primary/20 bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary transition-colors hover:bg-primary/15"
													>
														<Loader2Icon className="size-3 animate-spin" />
														{workingCount} agent
														{workingCount > 1
															? "s"
															: ""}{" "}
														working
													</button>
												</TooltipTrigger>
												<TooltipContent>
													{workingCount} task
													{workingCount > 1
														? "s"
														: ""}{" "}
													being worked on by agents
												</TooltipContent>
											</Tooltip>
										);
									}
									if (awaitingCount > 0) {
										return (
											<Tooltip>
												<TooltipTrigger asChild>
													<button
														type="button"
														onClick={(e) => {
															e.stopPropagation();
															setTasksExpanded(
																true,
															);
														}}
														className="flex shrink-0 items-center gap-1 rounded-full border border-highlight/20 bg-highlight/10 px-1.5 py-0.5 text-[10px] font-medium text-highlight transition-colors hover:bg-highlight/15"
													>
														<PauseIcon className="size-3" />
														{awaitingCount} awaiting
													</button>
												</TooltipTrigger>
												<TooltipContent>
													{awaitingCount} task
													{awaitingCount > 1
														? "s"
														: ""}{" "}
													waiting for approval
												</TooltipContent>
											</Tooltip>
										);
									}
									return null;
								})()}

								{taskSessionSummary.activeCount > 0 && (
									<button
										type="button"
										onClick={(e) => {
											e.stopPropagation();
											setTasksExpanded(true);
										}}
										className="shrink-0 rounded-full border border-primary/20 bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary transition-colors hover:bg-primary/15"
									>
										{taskSessionSummary.activeCount} task
										session
										{taskSessionSummary.activeCount === 1
											? ""
											: "s"}
									</button>
								)}

								{taskSessionSummary.reviewCount > 0 && (
									<button
										type="button"
										onClick={(e) => {
											e.stopPropagation();
											setTasksExpanded(true);
										}}
										className="shrink-0 rounded-full border border-highlight/20 bg-highlight/10 px-1.5 py-0.5 text-[10px] font-medium text-highlight transition-colors hover:bg-highlight/15"
									>
										{taskSessionSummary.reviewCount} need
										review
									</button>
								)}

								{/* Coding run status — clicking opens the timeline dialog;
				    session/PR links are available inside that dialog,
				    so the badge here is kept as a pure status indicator
				    to avoid nesting <a> inside <button>. */}
								{primaryTaskLabel && (
									<button
										type="button"
										onClick={(e) => {
											e.stopPropagation();
											onCodingRunClick?.(
												story.latestCodingRun?.id ?? "",
											);
										}}
										className="shrink-0 rounded-full border border-highlight/20 bg-highlight/10 px-1.5 py-0.5 text-[10px] font-medium text-highlight transition-colors hover:bg-highlight/15"
									>
										Primary task:{" "}
										{
											story.latestCodingRun?.storyTask
												?.identifier
										}
									</button>
								)}

								{shouldShowCodingRun(story.latestCodingRun) &&
									story.latestCodingRun && (
										<div className="flex items-center gap-1 shrink-0">
											<Tooltip>
												<TooltipTrigger asChild>
													<button
														type="button"
														onClick={(e) => {
															e.stopPropagation();
															onCodingRunClick?.(
																story
																	.latestCodingRun
																	?.id ?? "",
															);
														}}
														className="shrink-0"
													>
														<CodingRunStatusBadge
															status={
																story
																	.latestCodingRun
																	.status as Parameters<
																	typeof CodingRunStatusBadge
																>[0]["status"]
															}
															provider={
																story
																	.latestCodingRun
																	.provider
															}
															externalStatus={
																story
																	.latestCodingRun
																	.externalStatus
															}
															providerMetadata={
																story
																	.latestCodingRun
																	.providerMetadata
															}
														/>
													</button>
												</TooltipTrigger>
												<TooltipContent>
													View coding run details
												</TooltipContent>
											</Tooltip>

											{storyRunLinks?.projectUrl && (
												<Tooltip>
													<TooltipTrigger asChild>
														<a
															href={
																storyRunLinks.projectUrl
															}
															target="_blank"
															rel="noopener noreferrer"
															aria-label="Open linked Vibe project"
															onClick={(e) =>
																e.stopPropagation()
															}
															className="text-muted-foreground/60 hover:text-foreground"
														>
															<FolderKanbanIcon className="size-3" />
														</a>
													</TooltipTrigger>
													<TooltipContent>
														Open linked Vibe project
													</TooltipContent>
												</Tooltip>
											)}
											{storyRunLinks?.issueUrl && (
												<Tooltip>
													<TooltipTrigger asChild>
														<a
															href={
																storyRunLinks.issueUrl
															}
															target="_blank"
															rel="noopener noreferrer"
															aria-label="Open linked Vibe issue"
															onClick={(e) =>
																e.stopPropagation()
															}
															className="text-muted-foreground/60 hover:text-foreground"
														>
															<GitPullRequestArrowIcon className="size-3" />
														</a>
													</TooltipTrigger>
													<TooltipContent>
														Open linked Vibe issue
													</TooltipContent>
												</Tooltip>
											)}
										</div>
									)}
							</div>
							{effectiveColumnOrder.map((key) =>
								renderColumnCell(key),
							)}
						</div>
						{/* PM sync cloud toggle — ALWAYS shown (not a configurable
							    column), in a permanent slot just before the kebab, the
							    same way the kebab is always present. */}
						<div className="hidden shrink-0 items-center md:order-[35] md:flex xl:order-[998]">
							<PmSyncCloudToggle
								storyId={story.id}
								projectId={projectId}
								organizationId={organizationId ?? null}
								pmAutoSyncEnabled={story.pmAutoSyncEnabled}
								externalId={story.externalId ?? null}
								externalUrl={story.externalUrl ?? null}
								hasPmIntegration={hasPMIntegration}
								pmToolName={linkedPmToolName}
								lastPmSyncStatus={
									story.lastPmSyncStatus ?? null
								}
								lastPmSyncError={story.lastPmSyncError ?? null}
								lastSyncedAt={story.lastSyncedAt ?? null}
								source="card"
								size="sm"
								interactive={false}
							/>
						</div>

						<div className="shrink-0 order-[40] xl:order-[999]">
							{/* Kebab menu */}
							<DropdownMenu>
								<Tooltip>
									<TooltipTrigger asChild>
										<DropdownMenuTrigger asChild>
											<Button
												variant="ghost"
												size="icon"
												className="size-6 shrink-0 rounded-md opacity-60 transition-opacity group-hover:opacity-100 xl:opacity-0 xl:group-hover:opacity-60 hover:!opacity-100 hover:bg-background/70"
												onClick={(e) =>
													e.stopPropagation()
												}
												onMouseDown={(e) => {
													if (e.button === 1) {
														e.stopPropagation();
													}
												}}
												aria-label="Story actions"
											>
												<MoreHorizontalIcon className="size-3.5" />
											</Button>
										</DropdownMenuTrigger>
									</TooltipTrigger>
									<TooltipContent>
										{tStories("storyMoreActions")}
									</TooltipContent>
								</Tooltip>
								<DropdownMenuContent align="end">
									<DropdownMenuItem
										onClick={openStoryDetails}
									>
										<ExternalLink className="size-4 mr-2" />
										Open details
									</DropdownMenuItem>

									<DropdownMenuSub>
										<DropdownMenuSubTrigger
											onClick={(e) => e.stopPropagation()}
										>
											<DownloadIcon className="size-4 mr-2" />
											{tDownload("action")}
										</DropdownMenuSubTrigger>
										<DropdownMenuSubContent>
											<DropdownMenuItem
												onClick={(e) => {
													e.stopPropagation();
													void downloadActions.downloadMarkdown();
												}}
											>
												<FileCodeIcon className="size-4 mr-2" />
												{tDownload("format.markdown")}
											</DropdownMenuItem>
											<DropdownMenuItem
												onClick={(e) => {
													e.stopPropagation();
													void downloadActions.downloadPdf();
												}}
											>
												<FileTextIcon className="size-4 mr-2" />
												{tDownload("format.pdf")}
											</DropdownMenuItem>
											<DropdownMenuItem
												onClick={(e) => {
													e.stopPropagation();
													void downloadActions.downloadDocx();
												}}
											>
												<FileTextIcon className="size-4 mr-2" />
												{tDownload("format.docx")}
											</DropdownMenuItem>
										</DropdownMenuSubContent>
									</DropdownMenuSub>

									<Tooltip>
										<TooltipTrigger asChild>
											<DropdownMenuItem
												disabled={
													isQueuingForKanban ||
													!hasRepository
												}
												onClick={(e) => {
													e.stopPropagation();
													void handleOpenInKanban();
												}}
											>
												{isQueuingForKanban ? (
													<Loader2Icon className="size-4 mr-2 animate-spin" />
												) : (
													<FolderKanbanIcon className="size-4 mr-2" />
												)}
												Open Fabric Kanban
											</DropdownMenuItem>
										</TooltipTrigger>
										{!hasRepository && (
											<TooltipContent side="left">
												Configure a repository in
												project settings to enable
												Kanban
											</TooltipContent>
										)}
									</Tooltip>

									{(onStartImplementationSession ||
										onExecuteWithWeave) && (
										<>
											<DropdownMenuSeparator />
											{onStartImplementationSession && (
												<DropdownMenuItem
													onClick={() =>
														onStartImplementationSession(
															story.id,
														)
													}
													disabled={!hasRepository}
												>
													<CodeIcon className="size-4 mr-2" />
													Start Implementation Session
												</DropdownMenuItem>
											)}
											{onExecuteWithWeave && (
												<DropdownMenuItem
													onClick={() =>
														onExecuteWithWeave(
															story.id,
														)
													}
												>
													<CodeIcon className="size-4 mr-2" />
													Execute with Weave
												</DropdownMenuItem>
											)}
										</>
									)}

									{hasPMIntegration && onSync && (
										<>
											<DropdownMenuSeparator />
											<DropdownMenuItem
												onClick={(e) => {
													e.stopPropagation();
													if (story.externalId) {
														setSyncConfirm({
															direction: "push",
														});
													} else {
														onSync(
															story.id,
															"push",
														);
													}
												}}
											>
												<ArrowUpIcon className="size-4 mr-2" />
												Push to {pmToolName}
											</DropdownMenuItem>
											{story.externalId && (
												<>
													<DropdownMenuItem
														onClick={(e) => {
															e.stopPropagation();
															setSyncConfirm({
																direction:
																	"pull",
															});
														}}
													>
														<ArrowDownIcon className="size-4 mr-2" />
														Pull from {pmToolName}
													</DropdownMenuItem>
													{getValidExternalUrl(
														story.externalUrl,
													) && (
														<DropdownMenuItem
															onClick={(e) => {
																e.preventDefault();
																e.stopPropagation();
																const url =
																	getValidExternalUrl(
																		story.externalUrl,
																	);
																if (!url) {
																	return;
																}
																// Open `about:blank` first (same-origin,
																// not captured by cross-origin PWAs like
																// Fizzy.io) then navigate to the ticket
																// URL. Reset opener for security.
																const w =
																	window.open(
																		"about:blank",
																		"_blank",
																	);
																if (!w) {
																	return;
																}
																w.opener = null;
																w.location.href =
																	url;
															}}
														>
															<ExternalLinkIcon className="size-4 mr-2" />
															View in{" "}
															{linkedPmToolName}
														</DropdownMenuItem>
													)}
												</>
											)}
										</>
									)}

									<DropdownMenuSub>
										<DropdownMenuSubTrigger
											onClick={(e) => e.stopPropagation()}
										>
											<FlagIcon className="size-4 mr-2" />
											Change priority
										</DropdownMenuSubTrigger>
										<DropdownMenuSubContent>
											{PRIORITY_OPTIONS.map((opt) => {
												const isCurrent =
													story.priority ===
													opt.value;
												return (
													<DropdownMenuItem
														key={opt.value}
														disabled={
															isCurrent ||
															changePriorityMutation.isPending
														}
														onClick={(e) => {
															e.stopPropagation();
															changePriorityMutation.mutate(
																opt.value,
															);
														}}
													>
														<span
															className="size-2 rounded-full mr-2 shrink-0"
															style={{
																backgroundColor:
																	opt.color,
															}}
														/>
														<span>{opt.label}</span>
														{isCurrent ? (
															<CheckIcon
																data-testid="priority-check"
																className="size-4 ml-auto"
															/>
														) : null}
													</DropdownMenuItem>
												);
											})}
											{/* The per-item AI pass — this item only
											    (never weighed against the list;
											    that is the roadmap's Re-prioritize
											    button). Hidden, declined and
											    completed items can't be re-assessed
											    (the server refuses them), so no
											    dead entry. */}
											{aiReassessEligible && (
												<>
													<DropdownMenuSeparator />
													<DropdownMenuItem
														disabled={
															aiReprioritizeMutation.isPending
														}
														onClick={(e) => {
															e.stopPropagation();
															aiReprioritizeMutation.mutate(
																{
																	storyId:
																		story.id,
																	withListContext: false,
																},
															);
														}}
													>
														<SparklesIcon className="size-4 mr-2 text-secondary" />
														<span>
															Re-assess priority
															with AI
														</span>
													</DropdownMenuItem>
												</>
											)}
										</DropdownMenuSubContent>
									</DropdownMenuSub>

									<DropdownMenuSeparator />
									{/* F-171: convert-type — flip BUG ↔ FEATURE */}
									<DropdownMenuItem
										onClick={(e) => {
											e.stopPropagation();
											setConvertDialogOpen(true);
										}}
									>
										<ArrowLeftRightIcon className="size-4 mr-2" />
										{story.kind === "BUG"
											? "Change to feature"
											: "Change to bug"}
									</DropdownMenuItem>
									<DropdownMenuItem
										disabled={closeReopenMutation.isPending}
										onClick={(e) => {
											e.stopPropagation();
											closeReopenMutation.mutate(
												isClosed ? "DRAFT" : "CLOSED",
											);
										}}
									>
										{isClosed ? (
											<RotateCcwIcon className="size-4 mr-2" />
										) : (
											<CircleSlashIcon className="size-4 mr-2" />
										)}
										{isClosed
											? story.kind === "BUG"
												? "Unhide bug"
												: "Unhide feature"
											: story.kind === "BUG"
												? "Hide bug"
												: "Hide feature"}
									</DropdownMenuItem>
									<DropdownMenuItem
										onClick={(e) => {
											e.stopPropagation();
											onDelete(story.id);
										}}
										className="text-destructive"
									>
										<Trash2Icon className="size-4 mr-2" />
										Delete
									</DropdownMenuItem>
								</DropdownMenuContent>
							</DropdownMenu>
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

			{/* Expandable Tasks List */}
			{tasksExpanded && totalTasks > 0 && (
				<div className="space-y-1.5 rounded-b-xl border border-border/50 border-t-0 bg-background/25 py-2 pl-[120px] pr-4">
					{story.tasks.slice(0, 5).map((task) => (
						<TaskPreviewItem
							key={task.id}
							task={task}
							onToggle={() => onTaskToggle?.(story.id, task.id)}
						/>
					))}
					{story.tasks.length > 5 && (
						<button
							type="button"
							onClick={() => onSelect(story.id)}
							className="text-xs text-muted-foreground hover:text-primary"
						>
							+{story.tasks.length - 5} more tasks...
						</button>
					)}
				</div>
			)}

			{/* Sync Confirmation Dialog */}
			<AlertDialog
				open={!!syncConfirm}
				onOpenChange={(open) => !open && setSyncConfirm(null)}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							{syncConfirm?.direction === "push"
								? `Re-push to ${pmToolName}?`
								: `Pull latest from ${pmToolName}?`}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{syncConfirm?.direction === "push"
								? `This work item is already synced. Re-pushing will overwrite the current ticket content in ${pmToolName}.`
								: `This will overwrite the current Fabric work item content with the latest from ${pmToolName}.`}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Cancel</AlertDialogCancel>
						<AlertDialogAction
							onClick={() => {
								if (syncConfirm && onSync) {
									onSync(story.id, syncConfirm.direction);
								}
								setSyncConfirm(null);
							}}
						>
							{syncConfirm?.direction === "push"
								? "Re-push"
								: "Pull"}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>

			{/* Unified conflict-resolution dialog — Use Fabric / Use PM / AI
			    merge. Replaces the older PmSyncDiffModal "Push anyway / Skip"
			    push-time surface. `preview` is passed when StoryCard already
			    holds a fetched PM-side snapshot; otherwise the dialog fetches
			    its own single-item preview on open. */}
			<ConflictResolveDialog
				open={conflictDialogOpen}
				onOpenChange={(open) => {
					setConflictDialogOpen(open);
					if (!open) {
						setPmConflictPreview(null);
					}
				}}
				projectId={projectId}
				organizationId={organizationId ?? null}
				itemType={story.kind === "BUG" ? "bug" : "story"}
				entityId={story.id}
				fabricTitle={story.title}
				fabricDescription={story.description ?? ""}
				fabricUpdatedAt={story.lastEditedAt}
				fabricAuthor={story.lastEditedByName}
				fabricSource={story.lastEditedSource}
				identifier={story.identifier}
				preview={pmConflictPreview ?? undefined}
				settingsHref={buildProjectSettingsRoute(basePath, projectId)}
				onResolved={invalidatePmSyncState}
			/>

			{/* PM sync failure side panel — opened from FAILED badge */}
			<PmSyncFailureSidePanel
				open={pmFailurePanelOpen}
				onOpenChange={setPmFailurePanelOpen}
				pmToolName={pmToolName}
				error={story.lastPmSyncError}
				attemptedAt={story.lastPmSyncAttemptAt}
				onRetry={() => {
					retryPmSyncMutation.mutate(false);
					setPmFailurePanelOpen(false);
				}}
				isRetrying={retryPmSyncMutation.isPending}
				onUnlinkRecreate={() => {
					unlinkRecreateMutation.mutate();
					setPmFailurePanelOpen(false);
				}}
				isUnlinking={unlinkRecreateMutation.isPending}
				onRelink={() => {
					relinkMutation.mutate();
					setPmFailurePanelOpen(false);
				}}
				isRelinking={relinkMutation.isPending}
				settingsHref={buildProjectSettingsRoute(basePath, projectId)}
			/>

			<ConvertKindConfirmDialog
				open={convertDialogOpen}
				onOpenChange={setConvertDialogOpen}
				targetKind={targetKind}
				isPending={convertKindMutation.isPending}
				onConfirm={() => convertKindMutation.mutate()}
			/>
		</div>
	);
}

/**
 * Memoized so an unrelated parent re-render (the roadmap's 3s PM-sync poll,
 * expand/collapse, undo toasts, setting/filter changes) doesn't re-render every
 * card — only those whose props actually change. All callback props are
 * useCallback-stable and story/status/duplicateInfo are referentially stable.
 */
export const StoryCard = memo(StoryCardImpl);

/**
 * Get agent status display properties
 * Includes stuck detection based on running time
 */
function getAgentStatusDisplay(
	status: string | null | undefined,
	agentStartedAt?: Date | null,
) {
	if (!status || status === "idle") {
		return null;
	}

	// Check if agent is stuck (running for > 60 minutes)
	const isRunningStatus = ["running", "working", "executing"].includes(
		status,
	);
	let isStuck = false;
	if (isRunningStatus && agentStartedAt) {
		const runningMinutes =
			(Date.now() - new Date(agentStartedAt).getTime()) / (1000 * 60);
		isStuck = runningMinutes > 60;
	}

	// If stuck, show stuck status
	if (isStuck) {
		return {
			label: "STUCK",
			icon: <XIcon className="size-3" />,
			className: "bg-highlight/10 text-highlight border-highlight/20",
			dotClass: "bg-highlight",
		};
	}

	switch (status) {
		case "running":
		case "working":
		case "executing":
			return {
				label: "WORKING",
				icon: <Loader2Icon className="size-3 animate-spin" />,
				className: "bg-primary/10 text-primary border-primary/20",
				dotClass: "bg-primary motion-safe:animate-pulse",
			};
		case "paused":
		case "checkpoint":
		case "awaiting_approval":
			return {
				label: "AWAITING",
				icon: <PauseIcon className="size-3" />,
				className: "bg-highlight/10 text-highlight border-highlight/20",
				dotClass: "bg-highlight",
			};
		case "completed":
			return {
				label: "DONE",
				icon: <CheckIcon className="size-3" />,
				className: "bg-success/10 text-success border-success/20",
				dotClass: "bg-success",
			};
		case "failed":
		case "cancelled":
		case "stuck":
			return {
				label:
					status === "cancelled"
						? "STOPPED"
						: status === "stuck"
							? "STUCK"
							: "FAILED",
				icon: <XIcon className="size-3" />,
				className:
					"bg-destructive/10 text-destructive border-destructive/20",
				dotClass: "bg-destructive",
			};
		default:
			return null;
	}
}

/**
 * TaskPreviewItem - Compact task item for story card expansion.
 * Tasks are checkbox-only by design — see bug "Clicking AI-generated task
 * navigates to blank/error page". External `target="_blank"` Vibe links
 * (session/project/issue) are kept since they don't navigate the current page.
 */
function TaskPreviewItem({
	task,
	onToggle,
}: {
	task: StoryTask;
	onToggle: () => void;
}) {
	const agentDisplay = getAgentStatusDisplay(
		task.agentStatus,
		task.agentStartedAt,
	);
	const hasActiveAgent =
		agentDisplay &&
		task.agentStatus !== "completed" &&
		task.agentStatus !== "failed" &&
		task.agentStatus !== "cancelled";
	const taskRunLinks = task.latestCodingRun
		? getImplementationSessionLinks({
				provider: task.latestCodingRun.provider,
				externalUrl: task.latestCodingRun.externalUrl,
				providerMetadata: task.latestCodingRun.providerMetadata,
			})
		: null;

	return (
		<div
			className={cn(
				"flex items-center gap-2 group/task rounded-md transition-colors",
				hasActiveAgent && "bg-muted/50 px-1.5 py-1 -mx-1.5",
			)}
		>
			<Checkbox
				checked={task.isCompleted}
				onCheckedChange={onToggle}
				className="size-3.5"
				onClick={(e) => e.stopPropagation()}
			/>

			<span
				className={cn(
					"flex-1 text-left text-xs truncate",
					task.isCompleted && "line-through text-muted-foreground",
				)}
			>
				{task.title}
			</span>

			{agentDisplay && (
				<Badge
					variant="outline"
					className={cn(
						"text-[10px] px-1.5 py-0 h-5 gap-1 font-medium border",
						agentDisplay.className,
					)}
				>
					<span
						className={cn(
							"size-1.5 rounded-full",
							agentDisplay.dotClass,
						)}
					/>
					{agentDisplay.label}
				</Badge>
			)}

			{!agentDisplay &&
				shouldShowCodingRun(task.latestCodingRun) &&
				task.latestCodingRun && (
					<div className="flex items-center gap-1.5">
						<CodingRunStatusBadge
							status={
								task.latestCodingRun.status as Parameters<
									typeof CodingRunStatusBadge
								>[0]["status"]
							}
							provider={task.latestCodingRun.provider}
							externalStatus={task.latestCodingRun.externalStatus}
							providerMetadata={
								task.latestCodingRun.providerMetadata
							}
						/>

						{taskRunLinks?.sessionUrl && (
							<Tooltip>
								<TooltipTrigger asChild>
									<a
										href={taskRunLinks.sessionUrl}
										target="_blank"
										rel="noopener noreferrer"
										aria-label="Open workspace session"
										onClick={(e) => e.stopPropagation()}
										className="text-muted-foreground/60 hover:text-foreground"
									>
										<ExternalLinkIcon className="size-3" />
									</a>
								</TooltipTrigger>
								<TooltipContent>
									Open workspace session
								</TooltipContent>
							</Tooltip>
						)}
						{taskRunLinks?.projectUrl && (
							<Tooltip>
								<TooltipTrigger asChild>
									<a
										href={taskRunLinks.projectUrl}
										target="_blank"
										rel="noopener noreferrer"
										aria-label="Open linked Vibe project"
										onClick={(e) => e.stopPropagation()}
										className="text-muted-foreground/60 hover:text-foreground"
									>
										<FolderKanbanIcon className="size-3" />
									</a>
								</TooltipTrigger>
								<TooltipContent>
									Open linked Vibe project
								</TooltipContent>
							</Tooltip>
						)}
						{taskRunLinks?.issueUrl && (
							<Tooltip>
								<TooltipTrigger asChild>
									<a
										href={taskRunLinks.issueUrl}
										target="_blank"
										rel="noopener noreferrer"
										aria-label="Open linked Vibe issue"
										onClick={(e) => e.stopPropagation()}
										className="text-muted-foreground/60 hover:text-foreground"
									>
										<GitPullRequestArrowIcon className="size-3" />
									</a>
								</TooltipTrigger>
								<TooltipContent>
									Open linked Vibe issue
								</TooltipContent>
							</Tooltip>
						)}
					</div>
				)}
		</div>
	);
}
