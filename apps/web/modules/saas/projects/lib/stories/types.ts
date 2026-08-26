/**
 * User Stories & Kanban Board Type Definitions
 *
 * Types for the Kanban UI, CopilotKit agent state, and API interactions.
 * Based on the microsoft-kanban-demo pattern for AG-UI protocol support.
 */

import type {
	StoryTask as DbStoryTask,
	UserStory as DbUserStory,
	MaturationStatus,
	PmSyncStatus,
	ProjectStoryStatus,
	StoryKind,
	StoryPriority,
	StorySize,
} from "@repo/database";

// Re-export enums for convenience
export type {
	MaturationStatus,
	PmSyncStatus,
	StoryKind,
	StoryPriority,
	StorySize,
};

/**
 * Story origin — how the story was created. Stored on the FE as a lowercase
 * string (matches the URL-param format used by the roadmap Source filter).
 * Maps 1:1 with the Prisma `StorySource` enum on the backend; converted via
 * `dbSourceToFe()` in `transformStory`.
 */
export type StorySource =
	| "manual"
	| "jira"
	| "azure_devops"
	| "fizzy"
	| "gitlab"
	| "linear"
	| "github"
	| "ai_update"
	| "approved_proposal"
	| "custom_agent"
	| "slack";

export function dbSourceToFe(value: string | null | undefined): StorySource {
	switch (value) {
		case "JIRA":
			return "jira";
		case "AZURE_DEVOPS":
			return "azure_devops";
		case "FIZZY":
			return "fizzy";
		case "GITLAB":
			return "gitlab";
		case "LINEAR":
			return "linear";
		case "GITHUB":
			return "github";
		case "AI_UPDATE":
			return "ai_update";
		case "APPROVED_PROPOSAL":
			return "approved_proposal";
		case "CUSTOM_AGENT":
			return "custom_agent";
		case "SLACK":
			return "slack";
		default:
			return "manual";
	}
}

/**
 * Kanban column (status) for the board
 */
export interface StoryStatus {
	id: string;
	name: string;
	color: string;
	order: number;
	isDefault: boolean;
	isFinal: boolean;
}

/**
 * Task within a user story
 */
export interface StoryTask {
	id: string;
	identifier: string;
	title: string;
	description?: string | null;
	isCompleted: boolean;
	order: number;
	estimatedHours?: number | null;
	// Agent fields (Weft-style task automation)
	agentStatus?: string | null;
	agentTaskId?: string | null;
	agentStartedAt?: Date | null;
	// Repository context for code tasks
	repositoryUrl?: string | null;
	repositoryOwner?: string | null;
	repositoryName?: string | null;
	targetBranch?: string | null;
	latestCodingRun?: LatestCodingRun | null;
}

/**
 * Latest coding run summary (included from kanban query)
 */
export interface LatestCodingRun {
	id: string;
	executionChannel?: "BACKGROUND_AGENTS" | "LOCAL_AGENTS";
	provider?: "BACKGROUND_AGENTS" | "KANBAN_LOCAL";
	status: string;
	providerSessionId?: string | null;
	pullRequestUrl?: string | null;
	pullRequestNumber?: number | null;
	externalUrl?: string | null;
	externalStatus?: string | null;
	providerMetadata?: Record<string, unknown> | null;
	storyTask?: {
		id: string;
		identifier: string;
		title: string;
	} | null;
	createdAt: Date;
}

/**
 * User story with its tasks
 */
export interface UserStory {
	id: string;
	identifier: string;
	title: string;
	description?: string | null;
	acceptanceCriteria?: string | null;
	statusId: string;
	kind: StoryKind;
	priority: StoryPriority;
	size?: StorySize | null;
	storyPoints?: number | null;
	order: number;
	roadmapOrder: number;
	/** Shared manual rank for the roadmap's Priority layout. Null when the item
	 * has never been hand-placed, so it sits in its computed rank. */
	priorityOrder?: number | null;
	/** When the priority BAND last moved, denormalised from the newest
	 * StoryPriorityChange so the Priority view can stamp every row without a
	 * per-row history fetch. Null when the band has never been changed. */
	priorityChangedAt?: Date | string | null;
	/** Rationale of that newest change (AI reason or the author's comment),
	 * denormalised so the Priority row can show the "why" inline without a
	 * per-row history fetch. Null when the last change had no comment. */
	priorityChangeReason?: string | null;
	/** Fabric-internal custom tags (NEVER synced to any PM tool). Tag-level
	 * createdById is nullable (StoryTag.onDelete: SetNull). */
	tags: { id: string; value: string; createdById: string | null }[];
	tasks: StoryTask[];
	assigneeId?: string | null;
	createdById: string;
	createdAt: Date;
	updatedAt: Date;
	/** Semantic ticket-edit clock. Null on legacy rows until their next genuine edit. */
	lastEditedAt?: Date | null;
	// PM Tool sync fields
	externalId?: string | null;
	externalUrl?: string | null;
	externalMcpServerId?: string | null;
	// Per-feature auto-sync opt-in. False for Fabric-only features so they
	// stay local until the PM explicitly enables sync. Drives the
	// `<PmSyncCloudToggle />` icon state on every surface.
	pmAutoSyncEnabled: boolean;
	// PM sync state (F-1166)
	lastPmSyncStatus?: PmSyncStatus | null;
	lastPmSyncError?: string | null;
	lastPmSyncAttemptAt?: Date | null;
	lastSyncedAt?: Date | null;
	// Origin tracking — set when the story was created by an AI pipeline run.
	pipelineExecutionId?: string | null;
	/** Origin of the story (immutable after create). Drives the roadmap Source filter. */
	source: StorySource;
	/** The backlog proposal this item was created from, when it came from one.
	 * Null for manually-created items and for anything created before the link
	 * was recorded — historical rows cannot be backfilled. */
	createdFromProposalId?: string | null;
	/** True when the story's title was generated by AI (vs user-supplied or a fallback). */
	aiGeneratedTitle?: boolean;
	/** AI / fallback path that produced the current title. `null` for legacy rows. */
	titleSource?: "AI" | "DESCRIPTION_FALLBACK" | "UNTITLED_FALLBACK" | null;
	/**
	 * Last-edit provenance (conflict-dialog metadata). `lastEditedByName` is the
	 * human who last committed a genuine ticket edit (null for system/AI edits and
	 * pre-feature rows); `lastEditedSource` is where that edit came from.
	 */
	lastEditedByName?: string | null;
	lastEditedSource?:
		| "MANUAL"
		| "AI_BACKLOG_UPDATE"
		| "AI_MATURATION"
		| "CONFLICT_RESOLUTION"
		| "PM_PULL"
		| null;
	// Version tracking
	version: number;
	// Drafting stage fields
	draftingStage: FeatureDraftingStage;
	draftingStageUpdatedAt?: Date | null;
	/** Maturation V2 "dummy" status label (To Do / Discovery / Done). Null for
	 * non-V2 / legacy rows; the UI derives a label from `draftingStage` when null
	 * (see {@link deriveMaturationStatus}). Carries no logic. */
	maturationStatus?: MaturationStatus | null;
	/** When this story was discarded by a duplicate-merge: the id of the survivor
	 * it was merged into. Drives the roadmap "Declined duplicate" chip +
	 * "Merged into {identifier}" tooltip. Null for every other story. */
	mergedIntoStoryId?: string | null;
	// PM terminal-status snapshot (card #1360 Phase A). Drives the roadmap
	// checkmark. Set by the ADO poll; false/null when not terminal.
	pmTicketTerminal?: boolean;
	pmTicketTerminalStatus?: string | null;
	// F-171 bug triage: AI-determined; set at bug creation, cleared only by
	// the "Re-evaluate Bug" action. Always false for features.
	needsMoreInfo?: boolean;
	// Blocked flag (mirrors needsMoreInfo): a manual or scan-finding-driven
	// marker that this work item is blocked, with an optional reason shown on
	// hover. Drives the roadmap/card "Blocked" chip + the detail-page control.
	blocked?: boolean;
	blockedReason?: string | null;
	// F-171 reporter tracking: SLACK / TEAMS / MANUAL. Populated at creation for
	// Slack/Teams-origin items of any kind. Surfaced as "Originally proposed by
	// X via <source>" in the feature-editor Details tab for both bugs and
	// features, plus the bug detail pages.
	reporterName?: string | null;
	reporterSource?: "SLACK" | "TEAMS" | "MANUAL" | null;
	reporterSourceUrl?: string | null;
	/** Meeting this story was created from (Meeting Digest auto-proposal), if
	 * any. Prefers the linked meeting series' subject over the transcript's own
	 * snapshot subject. Null for manually-created / non-meeting-origin stories.
	 * Rendered read-only in ProvenanceSection — no deep link (YAGNI, Fizzy #1814). */
	sourceMeeting?: {
		subject: string | null;
		meetingDate: Date | string | null;
	} | null;
	// Client-side sync metadata (not persisted)
	/** Whether story is selected for bulk sync. UI state only. */
	isSelectedForSync?: boolean;
	/** Future: sync status with external PM tool (e.g. synced, pending, failed). */
	externalSyncStatus?: string | null;
	/** Latest coding run for this feature (populated from kanban query) */
	latestCodingRun?: LatestCodingRun | null;
	/** Latest kanban queue entry for this feature */
	latestKanbanQueue?: {
		id: string;
		status: "PENDING" | "PULLED" | "COMPLETED" | "CANCELLED";
		queuedAt: Date;
		pulledAt?: Date | null;
		completedAt?: Date | null;
		branchName?: string | null;
	} | null;
}

/**
 * Input for creating a new story
 */
export interface CreateStoryInput {
	projectId: string;
	/** Column (status) to create the story in; omit to use project default (e.g. Backlog) */
	statusId?: string;
	/**
	 * Optional title. When omitted the server generates a title from
	 * `description` via the AI title-generator helper.
	 */
	title?: string;
	description?: string;
	acceptanceCriteria?: string;
	/** Discriminator. Drives identifier prefix (F-NNN vs B-NNN) and which bound stage prompts the server selects. Server defaults to FEATURE when omitted. */
	kind?: StoryKind;
	priority?: StoryPriority;
	size?: StorySize;
	storyPoints?: number;
	assigneeId?: string;
	draftingStage?: FeatureDraftingStage;
	/** Optional explicit prompt id for AI-drafting the feature on creation. If omitted, falls back to the agent's bound prompt (or no AI). */
	promptId?: string;
	/** Optional pinned prompt version id (takes precedence over promptId). Ensures the version selected in the PromptSelector UI is exactly what runs. */
	promptVersionId?: string;
}

/**
 * Priority options for UI select
 */
export const PRIORITY_OPTIONS = [
	{ value: "P0_CRITICAL", label: "P0 - Critical", color: "#EF4444" },
	{ value: "P1_HIGH", label: "P1 - High", color: "#F97316" },
	{ value: "P2_MEDIUM", label: "P2 - Medium", color: "#EAB308" },
	{ value: "P3_LOW", label: "P3 - Low", color: "#22C55E" },
] as const;

/**
 * Size options for UI select
 */
export const SIZE_OPTIONS = [
	{ value: "XS", label: "XS", description: "Extra Small (< 1 day)" },
	{ value: "S", label: "S", description: "Small (1-2 days)" },
	{ value: "M", label: "M", description: "Medium (3-5 days)" },
	{ value: "L", label: "L", description: "Large (1-2 weeks)" },
	{ value: "XL", label: "XL", description: "Extra Large (2+ weeks)" },
] as const;

export type FeatureDraftingStage =
	| "PLACEHOLDER"
	| "ACTIVE_ANALYSIS"
	| "SANITY_CHECK"
	| "DRAFT"
	| "PUBLISHED"
	| "DECLINED"
	| "CLOSED";

export const DRAFTING_STAGE_META: Record<
	FeatureDraftingStage,
	{
		label: string;
		description: string;
		color: string;
		order: number;
	}
> = {
	PLACEHOLDER: {
		label: "Placeholder",
		description: "Title and basic info",
		color: "#6B7280",
		order: 0,
	},
	ACTIVE_ANALYSIS: {
		label: "Active Analysis",
		description: "AI Q&A: risks, assumptions, questions",
		color: "#F59E0B",
		order: 1,
	},
	SANITY_CHECK: {
		label: "Sanity Check",
		description: "Condensed summary for PO review",
		color: "#3B82F6",
		order: 2,
	},
	DRAFT: {
		label: "Draft",
		description: "Full detailed requirements document",
		color: "#10B981",
		order: 3,
	},
	PUBLISHED: {
		label: "Ready for Dev",
		description: "Ready for development",
		color: "#059669",
		order: 4,
	},
	DECLINED: {
		label: "Declined",
		description: "Removed or duplicate",
		color: "#EF4444",
		order: 5,
	},
	CLOSED: {
		label: "Hidden",
		description: "Hidden — completed or parked",
		color: "var(--muted-foreground)",
		order: 6,
	},
};

/**
 * Maturation V2 "dummy" status labels. These replace the five-stage maturation
 * pipeline in the V2 feature editor — three plain buckets that carry no logic
 * (no enhance, no PM push, no version snapshot). Eventually they'll guide the
 * kanban roadmap swim lanes.
 */
export const MATURATION_STATUS_META: Record<
	MaturationStatus,
	{ label: string; color: string; order: number }
> = {
	TO_DO: { label: "To Do", color: "#6B7280", order: 0 },
	DISCOVERY: { label: "Discovery", color: "#F59E0B", order: 1 },
	DONE: { label: "Requirements Complete", color: "#059669", order: 2 },
};

/** Order the three labels are offered in the V2 picker. */
export const MATURATION_STATUS_OPTIONS: MaturationStatus[] = [
	"TO_DO",
	"DISCOVERY",
	"DONE",
];

/**
 * Return selectable stage options filtered by a project's hidden stages.
 * If currentStage is hidden, it is retained so the active feature displays properly.
 */
export function getVisibleStageOptions(
	hiddenStages: string[] = [],
	currentStage?: string | null,
): MaturationStatus[] {
	return MATURATION_STATUS_OPTIONS.filter(
		(s) => !hiddenStages.includes(s) || s === currentStage,
	);
}

export type MaturationStatusPayloadParams =
	| {
			mode: "hide";
	  }
	| {
			mode: "set";
			targetMaturationStatus: MaturationStatus;
			isCurrentlyClosed?: boolean;
	  };

/**
 * Helper to build the mutation payload when changing status or hidden stage in Maturation V2.
 * Hiding a feature sends `draftingStage: "CLOSED"` without persisting/altering `maturationStatus`,
 * ensuring stateless hiding across all rows without triggering QA sign-off gates.
 */
export function buildMaturationStatusMutationPayload(
	params: MaturationStatusPayloadParams,
): {
	maturationStatus?: MaturationStatus;
	draftingStage?: FeatureDraftingStage;
} {
	if (params.mode === "hide") {
		return {
			draftingStage: "CLOSED",
		};
	}

	return {
		maturationStatus: params.targetMaturationStatus,
		...(params.isCurrentlyClosed
			? { draftingStage: "DRAFT" as const }
			: {}),
	};
}

/**
 * Derive a Maturation V2 label from a drafting stage, used as the display
 * fallback when `maturationStatus` is null (non-V2 / legacy rows).
 *
 * ⚠️ This mapping MUST stay in sync with the backfill in the migration
 * `20260625120000_add_maturation_status` — a backfilled row and a derived-null
 * row must never disagree.
 */
export function deriveMaturationStatus(
	stage: FeatureDraftingStage,
): MaturationStatus {
	switch (stage) {
		case "PUBLISHED":
		case "CLOSED":
			return "DONE";
		case "ACTIVE_ANALYSIS":
		case "SANITY_CHECK":
		case "DRAFT":
			return "DISCOVERY";
		default:
			// PLACEHOLDER, DECLINED, and any future stage fall back to TO_DO.
			// (PASSIVE_ANALYSIS is DB-only/soft-deprecated and absent from this
			// FE type; the migration backfills it to DISCOVERY directly, so this
			// helper never legitimately receives it.)
			return "TO_DO";
	}
}

/** The effective Maturation V2 label for a story: the explicit value if set,
 * otherwise derived from the drafting stage. */
export function getMaturationStatus(story: {
	maturationStatus?: MaturationStatus | null;
	draftingStage: FeatureDraftingStage;
}): MaturationStatus {
	return (
		story.maturationStatus ?? deriveMaturationStatus(story.draftingStage)
	);
}

/**
 * Returns actionable toast guidance when a roadmap move is blocked by the QA
 * coverage gate, directing the user to the feature editor to record an override.
 * Returns null for all other errors so callers can use standard error copy.
 */
export function coverageBlockedToastMessage(error: unknown): string | null {
	const data = (error as { data?: { errorCode?: string } } | null)?.data;
	if (data?.errorCode !== "COVERAGE_BELOW_TARGET") {
		return null;
	}
	return `Test coverage is below this project's target. Open the feature to record a reason and mark it ${MATURATION_STATUS_META.DONE.label}.`;
}

/**
 * Helper to get priority color
 */
export function getPriorityColor(priority: StoryPriority): string {
	const option = PRIORITY_OPTIONS.find((p) => p.value === priority);
	return option?.color ?? "#6B7280";
}

/**
 * Helper to get priority label
 */
export function getPriorityLabel(priority: StoryPriority): string {
	const option = PRIORITY_OPTIONS.find((p) => p.value === priority);
	return option?.label ?? priority;
}

/**
 * Helper to format size label
 */
export function getSizeLabel(size: StorySize | null | undefined): string {
	if (!size) {
		return "—";
	}
	const option = SIZE_OPTIONS.find((s) => s.value === size);
	return option?.label ?? size;
}

/**
 * Human-readable size estimate (e.g. "Medium (3-5 days)") for tooltips. Returns
 * null when no size is set.
 */
export function getSizeDescription(
	size: StorySize | null | undefined,
): string | null {
	if (!size) {
		return null;
	}
	return SIZE_OPTIONS.find((s) => s.value === size)?.description ?? null;
}

/**
 * Transform DB story status to UI type
 */
export function transformStatus(status: ProjectStoryStatus): StoryStatus {
	return {
		id: status.id,
		name: status.name,
		color: status.color,
		order: status.order,
		isDefault: status.isDefault,
		isFinal: status.isFinal,
	};
}

/**
 * Transform DB story to UI type
 */
export function transformStory(
	// `labels` is omitted: it is sync-owned state for the GitLab label↔status
	// pipeline, stripped by list-stories.ts / get-story.ts before it reaches the
	// client, and no longer a user-facing concept.
	story: Omit<DbUserStory, "labels"> & {
		tasks?: Array<
			DbStoryTask & {
				codingRuns?: Array<{
					id: string;
					executionChannel?:
						| "BACKGROUND_AGENTS"
						| "LOCAL_AGENTS"
						| "LOCAL_AGENTS";
					provider?: "BACKGROUND_AGENTS" | "KANBAN_LOCAL";
					status: string;
					providerSessionId: string | null;
					pullRequestUrl: string | null;
					pullRequestNumber: number | null;
					externalUrl?: string | null;
					externalStatus?: string | null;
					providerMetadata?: Record<string, unknown> | null;
					createdAt: Date;
				}>;
			}
		>;
		codingRuns?: Array<{
			id: string;
			executionChannel?: "BACKGROUND_AGENTS" | "LOCAL_AGENTS";
			provider?: "BACKGROUND_AGENTS" | "KANBAN_LOCAL";
			status: string;
			providerSessionId: string | null;
			pullRequestUrl: string | null;
			pullRequestNumber: number | null;
			externalUrl?: string | null;
			externalStatus?: string | null;
			providerMetadata?: Record<string, unknown> | null;
			storyTask?: {
				id: string;
				identifier: string;
				title: string;
			} | null;
			createdAt: Date;
		}>;
		kanbanQueue?: Array<{
			id: string;
			status: "PENDING" | "PULLED" | "COMPLETED" | "CANCELLED";
			queuedAt: Date;
			pulledAt: Date | null;
			completedAt: Date | null;
			branchName: string | null;
		}>;
		tags?: Array<{ id: string; value: string; createdById: string | null }>;
	},
): UserStory {
	return {
		id: story.id,
		identifier: story.identifier,
		title: story.title,
		description: story.description,
		acceptanceCriteria: story.acceptanceCriteria,
		statusId: story.statusId,
		kind: story.kind,
		priority: story.priority,
		size: story.size,
		storyPoints: story.storyPoints,
		order: story.order,
		roadmapOrder: story.roadmapOrder ?? 0,
		priorityOrder: story.priorityOrder ?? null,
		priorityChangedAt: story.priorityChangedAt ?? null,
		priorityChangeReason: story.priorityChangeReason ?? null,
		tags: (story.tags ?? []).map((t) => ({
			id: t.id,
			value: t.value,
			createdById: t.createdById,
		})),
		tasks: (story.tasks ?? []).map((task) => ({
			id: task.id,
			identifier: task.identifier,
			title: task.title,
			description: task.description,
			isCompleted: task.isCompleted,
			order: task.order,
			estimatedHours: task.estimatedHours,
			// Agent fields for task automation
			agentStatus: task.agentStatus,
			agentTaskId: task.agentTaskId,
			agentStartedAt: task.agentStartedAt,
			// Repository context for code tasks
			repositoryUrl: task.repositoryUrl,
			repositoryOwner: task.repositoryOwner,
			repositoryName: task.repositoryName,
			targetBranch: task.targetBranch,
			latestCodingRun: task.codingRuns?.[0] ?? null,
		})),
		assigneeId: story.assigneeId,
		createdById: story.createdById,
		createdAt: story.createdAt,
		updatedAt: story.updatedAt,
		lastEditedAt: story.lastEditedAt ?? null,
		externalId: story.externalId,
		externalUrl: story.externalUrl,
		externalMcpServerId: story.externalMcpServerId,
		// Migration backfilled true for every pre-existing PM-linked row, so
		// reading the column directly is always safe — no `?? false` fallback
		// needed and adding one would mask a missing-projection regression.
		pmAutoSyncEnabled: story.pmAutoSyncEnabled,
		lastPmSyncStatus: story.lastPmSyncStatus ?? null,
		lastPmSyncError: story.lastPmSyncError ?? null,
		lastPmSyncAttemptAt: story.lastPmSyncAttemptAt ?? null,
		lastSyncedAt: story.lastSyncedAt ?? null,
		pipelineExecutionId: story.pipelineExecutionId,
		source: dbSourceToFe(story.source),
		createdFromProposalId: story.createdFromProposalId ?? null,
		aiGeneratedTitle: story.aiGeneratedTitle,
		titleSource: story.titleSource,
		lastEditedByName: story.lastEditedByName ?? null,
		lastEditedSource: story.lastEditedSource ?? null,
		version: story.version ?? 1,
		draftingStage: story.draftingStage as FeatureDraftingStage,
		draftingStageUpdatedAt: story.draftingStageUpdatedAt,
		maturationStatus: story.maturationStatus ?? null,
		mergedIntoStoryId: story.mergedIntoStoryId ?? null,
		pmTicketTerminal: story.pmTicketTerminal ?? false,
		pmTicketTerminalStatus: story.pmTicketTerminalStatus ?? null,
		// F-171 bug triage + reporter tracking. The DB columns may be null
		// for stories created before F-171 — coerce to safe defaults so the
		// UI's `story.kind === "BUG" && story.needsMoreInfo` guards work.
		needsMoreInfo: story.needsMoreInfo ?? false,
		// Blocked flag — coerce to safe defaults so the UI's `story.blocked`
		// guards work for rows created before the column existed.
		blocked: story.blocked ?? false,
		blockedReason: story.blockedReason ?? null,
		reporterName: story.reporterName ?? null,
		reporterSource: story.reporterSource ?? null,
		reporterSourceUrl: story.reporterSourceUrl ?? null,
		latestCodingRun: story.codingRuns?.[0] ?? null,
		latestKanbanQueue: story.kanbanQueue?.[0] ?? null,
	};
}
