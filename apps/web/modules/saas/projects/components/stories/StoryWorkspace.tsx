"use client";

import {
	useCoAgent,
	useCopilotAction,
	useCopilotReadable,
} from "@copilotkit/react-core";
import { CopilotSidebar, useChatContext } from "@copilotkit/react-ui";
import { MessageRole, TextMessage } from "@copilotkit/runtime-client-gql";
import { AttachmentRegistryProvider } from "@saas/shared/components/copilot/AttachmentRegistry";
import { CopilotAssistantMessage } from "@saas/shared/components/copilot/CopilotAssistantMessage";
import { useCopilotChatSession } from "@saas/shared/components/copilot/CopilotChatSessionProvider";
import { AI_REQUEST_TOO_LARGE_EVENT } from "@saas/shared/components/copilot/CopilotFetchErrorInterceptor";
import { createCopilotSidebarInput } from "@saas/shared/components/copilot/CopilotSidebarInput";
import { CopilotUserMessage } from "@saas/shared/components/copilot/CopilotUserMessage";
import type { MessageAttachmentListItem } from "@saas/shared/components/copilot/MessageAttachmentList";
import {
	makeAssistantMessageWithRunMark,
	makeSuggestionsListWithRunMark,
} from "@saas/shared/components/copilot/run-mark-wrappers";
import { useUserRunSignal } from "@saas/shared/components/copilot/use-user-run-signal";
import {
	type ClarifyingQuestionFrequency,
	useClarifyingQuestions,
} from "@saas/shared/components/copilot/useClarifyingQuestions";
import { FocusModeToggle } from "@saas/shared/components/FocusModeToggle";
import { SubscribeToggle } from "@saas/subscriptions/components/SubscribeToggle";
import { formatDistanceToNow } from "date-fns";
import { CustomMessages } from "../copilot/CustomMessages";
import { DocumentAssistantOutcomesProvider } from "../copilot/DocumentAssistantOutcomesProvider";
import { HydratedMessagesProvider } from "../copilot/HydratedMessagesContext";
import type { AiReadinessData } from "./maturation/ReadinessBar";
import "@copilotkit/react-ui/styles.css";
import "../DocumentEditor.css"; // Import diff highlighting styles
import { isAiContextEligibleAttachmentMime } from "@repo/utils/story-attachment-ai-context";
import {
	useFabricAgentLauncher,
	useRegisterFabricAgentContext,
} from "@saas/agents/components/FabricAgentLauncher";
import { useConfirmChangesOperationResult } from "@saas/agents/copilot/useConfirmChangesOperationResult";
import { useCodeContextLauncher } from "@saas/agents/hooks/useCodeContextLauncher";
import { useDefaultMcpInlineRender } from "@saas/agents/hooks/useDefaultMcpInlineRender";
import { useFabricMention } from "@saas/agents/hooks/useFabricMention";
import { useSession } from "@saas/auth/hooks/use-session";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { useRegisterTiptapEditor } from "@saas/projects/components/excalidraw-auto-insert/TiptapEditorRegistry";
import { usePickerIntentConsumer } from "@saas/projects/components/excalidraw-auto-insert/usePickerIntentConsumer";
import { getOrpcCode } from "@saas/projects/components/field-mapping/orpc-error";
import { useIsOverflowing } from "@shared/hooks/use-is-overflowing";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { EditorContent, useEditor } from "@tiptap/react";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Checkbox } from "@ui/components/checkbox";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ui/components/popover";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { Tabs, TabsList, TabsTrigger } from "@ui/components/tabs";
import { Textarea } from "@ui/components/textarea";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import {
	ArrowLeftRightIcon,
	ArrowRightIcon,
	CheckCircle2Icon,
	CheckIcon,
	ChevronDownIcon,
	CircleSlashIcon,
	ClipboardListIcon,
	ClockIcon,
	CodeIcon,
	HistoryIcon,
	Loader2Icon,
	OctagonXIcon,
	PauseIcon,
	PlusIcon,
	RefreshCcwDotIcon,
	SaveIcon,
	SparklesIcon,
	TrashIcon,
	TriangleAlertIcon,
	XIcon,
} from "lucide-react";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import {
	startTransition,
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { createPortal, flushSync } from "react-dom";
import { toast } from "sonner";
import { orpcClient } from "../../../../shared/lib/orpc-client";
import { useDiffPreview } from "../../hooks/use-diff-view-mode";
import { useDocumentAssistantHistoryRealtimeSync } from "../../hooks/useDocumentAssistantHistory";
import { useDocumentAssistantHistoryEnabled } from "../../hooks/useDocumentAssistantHistoryEnabled";
import { contextEntryBytes } from "../../lib/ai-context-budget";
import { buildCleanSpecRefreshMessage } from "../../lib/clean-spec-refresh-message";
import {
	diffPartialText,
	focusOnAnchor,
	focusOnLastDiff,
	fromMarkdown,
	repairMarkdownDocument,
	resetScrollTracking,
} from "../../lib/diff-utils";
import {
	getEditorMarkdownForSave,
	getTurndownService,
} from "../../lib/editor-markdown-save";
import {
	extractStoryS3KeyFromImgSrc,
	extractStoryS3KeysFromContent,
	resolveStoryImageUrls,
	uploadStoryImage,
} from "../../lib/image-upload-utils";
import { shouldDeferStoryPropSync } from "../../lib/stories/diff-review-guard";
import { restorePendingDecisions } from "../../lib/stories/pending-decisions-preserve";
import { STORY_TAB_PARAM } from "../../lib/stories/routes";
import type {
	FeatureDraftingStage,
	MaturationStatus,
	StoryTask,
	UserStory,
} from "../../lib/stories/types";
import {
	buildMaturationStatusMutationPayload,
	DRAFTING_STAGE_META,
	getMaturationStatus,
	getPriorityColor,
	getVisibleStageOptions,
	MATURATION_STATUS_META,
	PRIORITY_OPTIONS,
	SIZE_OPTIONS,
} from "../../lib/stories/types";
import {
	isEditorDirty,
	shouldWarnBeforeUnload,
} from "../../lib/stories/unsaved-changes-guard";
import { storyAttachmentsQueryOptions } from "../../lib/story-attachments-query";
import {
	ACCEPTANCE_CRITERIA_PRESERVED_MESSAGE,
	formatStoryContent,
	parseStoryContent,
	resolveStoryContentForSave,
} from "../../lib/story-content";
import { advancedExtensions } from "../../lib/tiptap-extensions-advanced";
import { useClipboardImagePaste } from "../../lib/use-clipboard-image-paste";
import { CopilotHistoryDrawer } from "../copilot/CopilotHistoryDrawer";
import { CopilotPersistenceHook } from "../copilot/CopilotPersistenceHook";
import { createCopilotSidebarHeader } from "../copilot/CopilotSidebarHeader";
import { createCopilotSidebarLauncher } from "../copilot/CopilotSidebarLauncher";
import { DiffPreviewPanes } from "../DiffPreviewPanes";
import { DiffReviewBar } from "../DiffReviewBar";
import { DiffViewModeToggle } from "../DiffViewModeToggle";
import { DocumentTocRail } from "../DocumentTocRail";
import { EditorToolbar } from "../EditorToolbar";
import { ConvertKindConfirmDialog } from "./ConvertKindConfirmDialog";
import { CopyLinkButton } from "./CopyLinkButton";
import {
	type CoverageBlockDetail,
	CoverageOverrideDialog,
} from "./CoverageOverrideDialog";
import { FeatureTransitionDialog } from "./FeatureTransitionDialog";
import { FeatureVersionHistory } from "./FeatureVersionHistory";
import { ConfirmChangeSummaryCard } from "./maturation/ConfirmChangeSummaryCard";
import { DecisionLogPanel } from "./maturation/DecisionLogPanel";
import { QaPanel } from "./maturation/QaPanel";
import { RunChangeSummaryCard } from "./maturation/RunChangeSummaryCard";
import { SummaryQuestionsPanel } from "./maturation/SummaryQuestionsPanel";
import type { AnswerSource } from "./maturation/types";
import { NotifyButton } from "./NotifyButton";
import { AiReprioritizeControl } from "./priority/AiReprioritizeControl";
import { useAiReassessEligibility } from "./priority/useAiReassessEligibility";
import { StoryKindRegenerationNotice } from "./StoryKindRegenerationNotice";
import { StoryTagEditor } from "./StoryTagEditor";
import { useConsumeSearchParam } from "./use-consume-search-param";
import {
	useInvalidateStoryAfterRegeneration,
	useStoryKindRegeneration,
	watchStoryKindRegeneration,
} from "./useStoryKindRegeneration";
import { useUpdateWithContext } from "./useUpdateWithContext";

/** Tailwind `sm` — the width below which CopilotKit goes full-screen. */
const ASSISTANT_FULLSCREEN_BELOW = 640;

/**
 * Close the AI Feature Assistant on arrival at a phone-width viewport.
 *
 * Side-effect only; renders nothing. Below `sm` CopilotKit renders the sidebar
 * as a full-screen overlay, so opening it by default hid the entire feature
 * editor — measured on a real feature at 375px, the tab bar sat at x=499 in a
 * 360px window and neither the tabs, the specification nor the Testing panel
 * could be reached. Only the assistant was on screen.
 *
 * Done here rather than by computing `defaultOpen`: that prop is read once at
 * mount, and a viewport measured in an effect arrives too late, while gating the
 * sidebar's own mount would delay the editor with it — the sidebar wraps the
 * whole workspace, not just the chat. Closing once on mount leaves the launcher
 * to reopen it, and leaves every wider viewport untouched.
 */
function CloseAssistantOnNarrowViewport() {
	const { setOpen } = useChatContext();
	useEffect(() => {
		if (
			window.matchMedia(
				`(max-width: ${ASSISTANT_FULLSCREEN_BELOW - 1}px)`,
			).matches
		) {
			setOpen(false);
		}
		// Mount only: a later resize is the user's own doing, and yanking the
		// panel shut mid-conversation because they rotated the device would be
		// worse than leaving it where they put it.
	}, [setOpen]);
	return null;
}

// Agent state interface - matches other document editors
interface AgentState {
	document: string;
	focusAnchor?: string;
	hasTeamsIntegration?: boolean;
	hasSlackIntegration?: boolean;
	hasGitHubIntegration?: boolean;
	hasRepoIntegration?: boolean;
	projectId?: string;
	userId?: string;
	organizationId?: string;
	/**
	 * Connected project context (meeting transcripts, uploaded
	 * docs, team messages) pre-fetched for an "Update Clean Spec" refresh and
	 * pushed here via `flushSync` right before the refresh message is sent, so it
	 * reaches the model without being dumped into the visible chat. A dedicated
	 * field (not `ragContexts`) so it is immune to the `readable non-empty > state`
	 * short-circuit in the agent; the unified-server merges it into `ragContexts`
	 * (`project-document-generator/unified-server.ts`). MUST be present in
	 * `initialAgentState` or `useCoAgent` filters it out of the state snapshot.
	 */
	refreshSpecContexts?: string[];
	// Per-turn reasoning trace surfaced via ReasoningCollapsible (PR #1023).
	// Mirrors DocumentEditor.AgentState — declaring these keys here is
	// REQUIRED because `useCoAgent` filters out STATE_SNAPSHOT keys that
	// aren't present in `initialState`. Without them, the Stories Feature
	// Assistant (which uses the same `project_document_generator` coagent
	// as DocumentEditor) silently loses the reasoning/tool trace even
	// though the SSE wire carries it.
	reasoningByTurn?: Record<
		number,
		{
			text: string;
			durationMs: number;
			startedAt: number;
			completedAt: number;
		}
	>;
	// Per-turn tool-call trace surfaced via ReasoningCollapsible (PR #1024).
	toolCallsByTurn?: Record<
		number,
		Array<{
			id: string;
			name: string;
			status: "pending" | "success" | "error";
			startedAt: number;
			durationMs?: number;
			errorMessage?: string;
		}>
	>;
}

type Props = {
	story: UserStory;
	/**
	 * Whether the current user has STORY_UPDATE on this project. Drives the
	 * disabled state of write-only affordances — currently the AI Feature
	 * Assistant's image-attachment paperclip (AC-10). Defaults to `false`
	 * if omitted so we never accidentally show write controls to a viewer.
	 */
	canEdit?: boolean;
	canAddTags?: boolean;
	canManageAllTags?: boolean;
	projectId: string;
	projectName?: string;
	projectRepository?: {
		url?: string | null;
		owner?: string | null;
		name?: string | null;
		branch?: string | null;
	} | null;
	onClose: () => void;
	onStoryUpdated?: () => void;
	/**
	 * Feature Maturation V2. When `true`, the document-editor
	 * region is fronted by a three-tab control (Summary & Questions / Decision
	 * Log / Clean Specification). The Clean Specification tab IS this same
	 * TipTap editor; the other two tabs render presentational panels backed by
	 * the `getEditorState` query. When `false` (v1 classic), the editor renders
	 * exactly as before — the tab chrome is dead code. Always defaults to v1.
	 */
	maturationV2?: boolean;
	/**
	 * DOM mount point for the story title + AI regenerate button. The title
	 * input is editable and bound to local state, so it has to live inside
	 * StoryWorkspace, but the page-level layout owns the visual position
	 * (line 1 of the new title-top header). When the slot is not provided
	 * the title is rendered inline as a fallback (kept for tests / Storybook).
	 */
	titleSlot?: HTMLElement | null;
	/**
	 * DOM mount point for the state-coupled action items (Show raw toggle,
	 * Version history). Same reason as titleSlot — these read showRaw and
	 * mutation state that lives in this component.
	 */
	actionSlot?: HTMLElement | null;
	/**
	 * DOM mount point for the Save split-button. Separate from actionSlot so
	 * the page can position it after the StartWork button (the page owns
	 * StartWork; the workspace owns Save because it reads isSaving /
	 * hasUnsavedChanges / save mutation state).
	 */
	saveSlot?: HTMLElement | null;
	/**
	 * Group D — SSR-hydrated feature-assistant context. The RSC page
	 * (`app/(saas)/app/.../stories/[storyId]/page.tsx`) fetches the
	 * caller's most recent ACTIVE conversation and the client wrapper
	 * (`StoryWorkspacePage`) passes the payload through. Messages render
	 * via `<HydratedMessagesProvider>` + `<CustomMessages>` (see
	 * `HydratedMessagesContext.tsx`).
	 *
	 * The props below let this component:
	 * - Stamp `documentRefKind` on every persistence write (Group H).
	 * - Track the current `conversationId` in local state so subsequent
	 *   turns append to the right conversation row.
	 * - Seed the visibility chip (Group E) so the chip renders in its
	 *   correct pre-lock / post-lock state on first paint.
	 *
	 * Defaults keep this component backwards-compatible with any callers
	 * that haven't been migrated yet.
	 *
	 * Spec §3.5 FR-17 / FR-18, §6.2, §6.6.
	 */
	documentRefKind?: "PROJECT_DOCUMENT" | "USER_STORY";
	initialAssistantConversationId?: string | null;
	initialAssistantVisibility?: "SHARED" | "PRIVATE";
	initialAssistantVisibilityLockedAt?: string | null;
	/**
	 * Message ids from the SSR-hydrated conversation, threaded through
	 * to `CopilotPersistenceHook` so its walker doesn't re-fire
	 * `appendTurnForDocument` for already-persisted messages on every
	 * page reload. Mirrors `DocumentEditor.initialPersistedMessageIds`.
	 */
	initialPersistedMessageIds?: ReadonlyArray<string>;
	/**
	 * SSR-hydration seed for the live `<AttachmentRegistryProvider>`
	 * map — same role as `DocumentEditor.initialAttachmentsByMessageId`.
	 * Without this, hydrated user bubbles with attachments fall back to
	 * the legacy `[Attached: …]` filename caption on reload.
	 */
	initialAttachmentsByMessageId?: ReadonlyMap<
		string,
		MessageAttachmentListItem[]
	>;
	/**
	 * Raw persisted-conversation blob from the SSR loader. Mirrors
	 * `DocumentEditor.initialAssistantMessages`. Consumed by
	 * `<HydratedMessagesProvider>` to render historical turns directly
	 * from React state, bypassing CopilotKit's unreliable `agent.messages`
	 * lifecycle — see `HydratedMessagesContext` docblock.
	 */
	initialAssistantMessages?: ReadonlyArray<Record<string, unknown>>;
};

/**
 * StoryWorkspace - Full story grooming experience with CopilotKit AI assistance
 *
 * Features:
 * - Single TipTap rich text editor for story content (description + acceptance criteria)
 * - CopilotKit sidebar for AI-assisted grooming
 * - EditorToolbar for formatting
 * - AG-UI protocol for predictive state updates and diff highlighting
 * - Task management at the bottom
 * - Optimistic updates for seamless saving
 */

// Stable empty-array reference used as the fallback when the resolved
// story-media tuple is stale relative to the current story. Reusing one
// reference prevents `[...uploadedRagContexts, ...EMPTY_STRING_ARRAY]` from
// creating a new array identity on every render and avoids re-triggering the
// `useCopilotReadable` value-change handler downstream.
const EMPTY_STRING_ARRAY: readonly string[] = Object.freeze([]);

/**
 * A chat attachment's finished rag-context entry, kept alongside the facts
 * needed to police it: its size on the wire, and whether it is an image.
 *
 * The entry itself stays opaque — `useCopilotDocumentUpload` builds it and
 * neutralizes the filename, and nothing here reinterprets that.
 */
interface UploadedRagContext {
	id: string;
	entry: string;
	bytes: number;
	isImage: boolean;
}

// QA tab rides on the QA feature — same client flag as the
// project-level tab (`TEST_CASES_ENABLED` in ProjectDetails); the backend it
// composes over is independently gated server-side by `FABRIC_FEATURE_TEST_CASES`.
const QA_TAB_ENABLED =
	process.env.NEXT_PUBLIC_FABRIC_FEATURE_TEST_CASES === "true";

// Stored Feature/Bug descriptions are hand-authored. The
// orphan-bullet repair is for LLM output and merges real bullets here.
const USER_CONTENT_MD_OPTIONS = { repairLegacyBullets: false } as const;

// Cap on consecutive autosave failures before the `onError`
// re-arm stops scheduling another retry. Without a cap, a deterministic
// failure (offline, a permanent 4xx) re-arms forever — a PATCH and a
// "Failed to save story" toast every 10s, with no backoff. Reset to 0 on
// any successful save; see `saveFailureCountRef`.
const MAX_AUTO_SAVE_RETRIES = 3;

/**
 * DOM-id suffix of each maturation tab trigger, so a resolution that completes
 * while the trigger's own tab is on screen can put focus back on it instead of
 * dropping it to `<body>` when the banner it was clicked in unmounts.
 *
 * The ids themselves are assembled from `maturationTabBaseId` where the
 * triggers are rendered; this map is the other half of that literal and has to
 * move with it.
 */
const MATURATION_TAB_TRIGGER_SUFFIX = {
	summaryQuestions: "summary",
	decisionLog: "decisions",
	cleanSpec: "cleanspec",
	qa: "qa",
} as const;

/**
 * How long `handleAccept`'s deferred branch waits before re-arming the save it
 * stepped out of the way of. Named because the cross-tab review banner's
 * settle window has to outlast it — see `REVIEW_RESOLUTION_SETTLE_GRACE_MS`.
 */
const DEFERRED_ACCEPT_SAVE_DELAY_MS = 1000;

/**
 * How long the review banner keeps its pending label up after the last write
 * flag goes down, before it concludes the resolution has settled.
 *
 * It cannot conclude that from the click's own commit for two reasons, and the
 * window has to cover both. `handleAccept`'s ordinary branch raises `isSaving`
 * inside a `startTransition`, so the flag is still down in the commit the click
 * produced — reading it there would end the window one commit after it opened.
 * And the deferred branch re-arms its save `DEFERRED_ACCEPT_SAVE_DELAY_MS`
 * after the write it deferred behind completes, so between those two writes
 * every flag is momentarily down while the resolution is very much still in
 * flight.
 */
const REVIEW_RESOLUTION_SETTLE_GRACE_MS = DEFERRED_ACCEPT_SAVE_DELAY_MS + 250;

/**
 * The cross-tab review banner's own state machine (Fizzy #1929).
 *
 * `null` means the banner is a plain "a draft is waiting" notice. A non-null
 * value means the user has acted on it: `pending` while the resulting write is
 * in flight, `error` when the accept path threw and the decision still needs
 * one — the banner stays mounted in both, because dismissing it would strand a
 * draft the user can no longer reach from the tab they are on.
 */
type PendingReviewResolution = {
	action: "accept" | "reject";
	status: "pending" | "error";
	message?: string;
};

/**
 * oRPC error codes that mean the server made a decision, as opposed to the
 * request never landing. A decision must not be retried through a different,
 * weaker path — the prompt-resolution handlers fall back to a server-side
 * rewrite that skips diff review, and doing that after an explicit refusal
 * would apply exactly what the refusal was protecting against (Fizzy #2048).
 */
const SERVER_REFUSAL_CODES: ReadonlySet<string> = new Set([
	"BAD_REQUEST",
	"FORBIDDEN",
	"UNAUTHORIZED",
	"NOT_FOUND",
	"CONFLICT",
]);

/**
 * Reads the coverage refusal out of an oRPC error, or null for any other
 * failure. Keyed on the error code rather than the message so rewording the
 * refusal cannot quietly turn the dialog back into a dead-end toast.
 */
function coverageBlockFromError(error: unknown): CoverageBlockDetail | null {
	if (!error || typeof error !== "object" || !("data" in error)) {
		return null;
	}
	const data = (
		error as {
			data?: {
				errorCode?: string;
				percent?: number;
				target?: number;
				coveredCriteria?: number;
				totalCriteria?: number;
			};
		}
	).data;
	if (
		data?.errorCode !== "COVERAGE_BELOW_TARGET" ||
		typeof data.percent !== "number" ||
		typeof data.target !== "number" ||
		typeof data.coveredCriteria !== "number" ||
		typeof data.totalCriteria !== "number"
	) {
		return null;
	}
	return {
		percent: data.percent,
		target: data.target,
		coveredCriteria: data.coveredCriteria,
		totalCriteria: data.totalCriteria,
	};
}

export function StoryWorkspace({
	story,
	canEdit = false,
	canAddTags = false,
	canManageAllTags = false,
	projectId,
	projectName,
	projectRepository,
	onClose,
	onStoryUpdated,
	maturationV2 = false,
	titleSlot,
	actionSlot,
	saveSlot,
	documentRefKind = "USER_STORY",
	initialAssistantConversationId = null,
	initialAssistantVisibility = "SHARED",
	initialAssistantVisibilityLockedAt = null,
	initialPersistedMessageIds,
	initialAttachmentsByMessageId,
	initialAssistantMessages,
}: Props) {
	// Group D — Local state holding the active feature-assistant
	// `conversationId`. Seeded from the SSR payload, this is the id that
	// Group H's `appendTurnForDocument` mutation passes on each
	// stream-completion event. Held as state (not derived) because Group
	// E's "New conversation" affordance resets it to `null` so the next
	// persisted turn lazy-creates a fresh row. `documentRefKind` is
	// read-only — fully determined by which RSC route mounted this
	// component (USER_STORY when the feature editor mounts it directly).
	const [activeAssistantConversationId, setActiveAssistantConversationId] =
		useState<string | null>(initialAssistantConversationId);
	// Fork-aware hydration state — mirrors DocumentEditor. Seeded from
	// SSR-init props, replaced by the drawer's `onForked` callback when
	// the user forks a historical conversation. See the matching block in
	// `DocumentEditor.tsx` for the full rationale.
	const [effectiveAssistantMessages, setEffectiveAssistantMessages] =
		useState<ReadonlyArray<Record<string, unknown>> | undefined>(
			initialAssistantMessages,
		);
	const [effectiveSsrConversationId, setEffectiveSsrConversationId] =
		useState<string | null>(initialAssistantConversationId);
	const [effectivePersistedMessageIds, setEffectivePersistedMessageIds] =
		useState<ReadonlyArray<string> | undefined>(initialPersistedMessageIds);
	// Group E — visibility chip state (FR-17 / FR-18). SHARED is the default;
	// PRIVATE is set only when the author opted out pre-first-send via the
	// sidebar header. Locking happens on the server when the first turn is
	// persisted (`visibilityLockedAt` becomes non-null).
	const [activeAssistantVisibility, setActiveAssistantVisibility] = useState<
		"SHARED" | "PRIVATE"
	>(initialAssistantVisibility);
	const [
		activeAssistantVisibilityLockedAt,
		setActiveAssistantVisibilityLockedAt,
	] = useState<string | null>(initialAssistantVisibilityLockedAt);
	// Group F — history drawer open state. Flipped open by the sidebar
	// header's history-icon button and closed by `<Esc>` / overlay click
	// inside the drawer itself.
	const [historyDrawerOpen, setHistoryDrawerOpen] = useState(false);
	const queryClient = useQueryClient();
	const { user } = useSession();
	const sessionUser = user;
	const { organizationId } = useOrganizationContext();
	// Cross-tab BroadcastChannel listener: mirrors the wiring in
	// DocumentEditor.tsx so the StoryWorkspace surface (USER_STORY scope)
	// also picks up history mutations from sibling tabs.
	useDocumentAssistantHistoryRealtimeSync({
		documentRefKind: "USER_STORY",
		documentRefId: story.id,
		projectId,
		organizationId: organizationId ?? null,
	});
	const tWorkspace = useTranslations("projects.stories.workspace");
	const params = useParams();

	// ── Feature Maturation V2 ────────────────────────────────
	// When `maturationV2` is true, the document-editor region is fronted by a
	// three-tab control. The Clean Specification tab IS this TipTap editor; the
	// other two tabs render presentational panels from `getEditorState`. All of
	// the V2 hooks below are gated on `maturationV2` and are inert (no fetch, no
	// effect) in the v1 classic path, so v1 behaviour is unchanged.
	const tMaturation = useTranslations("projects.stories.maturation");
	const tMaturationToasts = useTranslations(
		"projects.stories.maturation.toasts",
	);
	const tTooltips = useTranslations("tooltips.stories");
	const tConvertKind = useTranslations("projects.stories.convertKind");
	const maturationTabBaseId = useId();
	const [maturationTab, setMaturationTab] = useState<
		"summaryQuestions" | "decisionLog" | "cleanSpec" | "qa"
	>("summaryQuestions");

	// QA tab: flag-gated and FEATURE-only — bugs keep the three-tab
	// editor unchanged. Server procedures enforce the same two gates.
	const qaTabEnabled = QA_TAB_ENABLED && story.kind !== "BUG";

	// `?storyTab=decisionLog` — how the roadmap's Priority layout sends a reader
	// from an open question on a row to the place it gets answered. Validated
	// against the tab set here rather than in the hook, so an unknown or stale
	// value lands the user on the feature instead of erroring.
	const requestedStoryTab = useConsumeSearchParam(STORY_TAB_PARAM);
	useEffect(() => {
		const tab = requestedStoryTab?.value;
		if (
			tab === "summaryQuestions" ||
			tab === "decisionLog" ||
			tab === "cleanSpec" ||
			(tab === "qa" && qaTabEnabled)
		) {
			setMaturationTab(tab);
		}
	}, [requestedStoryTab, qaTabEnabled]);

	// A feature can convert to a bug while its QA tab is open
	// (ConvertKindConfirmDialog) — the tab then no longer exists, so land the
	// reader on the default tab instead of an empty editor region.
	useEffect(() => {
		if (maturationTab === "qa" && !qaTabEnabled) {
			setMaturationTab("summaryQuestions");
		}
	}, [maturationTab, qaTabEnabled]);

	const maturationEditorInput = {
		projectId,
		storyId: story.id,
		organizationId: organizationId ?? null,
	};
	const maturationEditorKey =
		orpc.projects.stories.maturation.getEditorState.queryKey({
			input: maturationEditorInput,
		});
	const invalidateMaturationEditor = () =>
		queryClient.invalidateQueries({ queryKey: maturationEditorKey });

	const { data: maturationData } = useQuery({
		...orpc.projects.stories.maturation.getEditorState.queryOptions({
			input: maturationEditorInput,
		}),
		enabled: maturationV2,
	});

	const maturationAnswerMutation = useMutation(
		orpc.projects.stories.maturation.answerQuestion.mutationOptions({
			onSuccess: (result) => {
				requestGenRef.current++;
				setIsAiMode(false);
				setAiResult(null);
				invalidateMaturationEditor();
				const status = result.propagation?.status;
				if (status === "applied") {
					// The answer was written into the Clean Spec's "Resolved
					// Decisions (pending integration)" appendix. Refresh the story
					// so the editor + `agentState.document` (the chat copilot's
					// context, synced by Effect 5) pick up the new content — without
					// this the chat keeps reading a stale snapshot and reports it
					// "doesn't see" the answers (B2).
					queryClient.invalidateQueries({
						queryKey: orpc.projects.stories.get.queryKey({
							input: {
								projectId,
								storyId: story.id,
								organizationId,
							},
						}),
					});
					onStoryUpdated?.();
					toast.success(tMaturationToasts("specUpdated"));
				} else if (status === "error") {
					toast.warning(tMaturationToasts("couldntApply"));
				}
			},
			onError: (error) => {
				// The appendix write is version-guarded now: `recordAnswerInSpec`
				// re-reads the description under the story row's lock, so losing
				// that compare-and-set is a genuine anomaly and the procedure
				// raises CONFLICT for it instead of degrading it to a warning.
				//
				// That code means something very specific, and the generic toast
				// says the opposite of it: the decision IS committed to the
				// Decision Log, and only its integration into the Full
				// Specification failed. "Couldn't save your answer. Please try
				// again." sends the user back to a question that is no longer
				// open, and leaves both views stale — the questions list still
				// shows it open, the spec never gained the appendix entry.
				if (getOrpcCode(error) === "CONFLICT") {
					// Both reads changed underneath us: the question left the
					// open list (the decision committed) and the description
					// moved (whoever won the race wrote it).
					invalidateMaturationEditor();
					queryClient.invalidateQueries({
						queryKey: orpc.projects.stories.get.queryKey({
							input: {
								projectId,
								storyId: story.id,
								organizationId,
							},
						}),
					});
					onStoryUpdated?.();
					// `warning`, not `error`, and deliberately the same severity
					// as the `propagation.status === "error"` branch above: the
					// user-visible outcome is identical (decision recorded, spec
					// not updated), so the two must not read as different events.
					toast.warning(tMaturationToasts("answerConflictTitle"), {
						description: tMaturationToasts("answerConflictBody"),
					});
					return;
				}
				toast.error(tMaturationToasts("answerError"));
			},
		}),
	);

	// Amend a resolved answer (#1910). Appends a superseding turn — the Decision
	// Log is never edited in place — and upserts the question's bullet in the
	// Clean Spec appendix so the spec carries exactly one current answer.
	const maturationAmendMutation = useMutation(
		orpc.projects.stories.maturation.amendAnswer.mutationOptions({
			onSuccess: (result) => {
				invalidateMaturationEditor();
				// Same reason as the answer path: the spec's appendix changed, so
				// the story snapshot the editor and the chat copilot read is stale.
				queryClient.invalidateQueries({
					queryKey: orpc.projects.stories.get.queryKey({
						input: { projectId, storyId: story.id, organizationId },
					}),
				});
				onStoryUpdated?.();
				if (result.specUpdated) {
					toast.success(tMaturationToasts("specUpdated"));
				} else {
					// The amendment is committed to the log; only its integration
					// into the spec failed. Same severity as the answer path's
					// equivalent branch, since the user-visible outcome matches.
					toast.warning(tMaturationToasts("couldntApply"));
				}
			},
			onError: (error) => {
				// NOT_FOUND here means the turn was superseded by someone else
				// first, so this client's view of "the current answer" is stale.
				if (getOrpcCode(error) === "NOT_FOUND") {
					invalidateMaturationEditor();
					toast.warning(tMaturationToasts("amendStaleTitle"), {
						description: tMaturationToasts("amendStaleBody"),
					});
					return;
				}
				toast.error(tMaturationToasts("amendError"));
			},
		}),
	);

	// Notes is HUMAN-owned (the only writer is `setWorkingNotes`). Save-on-blur.
	// We deliberately do NOT invalidate `getEditorState` (that would trigger a
	// refetch that could clobber the textarea mid-edit). Instead we write the
	// saved value straight into the cache on success: the Summary panel is a
	// conditional sibling that UNMOUNTS when the user switches tabs, so on
	// return it re-seeds its local state from this cache — keeping the cache in
	// sync is what makes the just-saved notes survive a tab round-trip. The
	// panel's own `incoming !== lastServerNotes` guard keeps the still-mounted
	// case from being clobbered.
	const maturationSetNotesMutation = useMutation(
		orpc.projects.stories.maturation.setWorkingNotes.mutationOptions({
			onSuccess: (_result, variables) => {
				queryClient.setQueryData(
					maturationEditorKey,
					(old: typeof maturationData | undefined) =>
						old
							? { ...old, workingNotesContent: variables.content }
							: old,
				);
			},
			onError: () => toast.error(tMaturationToasts("notesError")),
		}),
	);

	// Auto-propose answers toggle (#7) — per-feature, default ON. Optimistically
	// write the new flag into the editor cache so the Switch reflects it without a
	// refetch (which would clobber the Notes textarea, per the comment above).
	const maturationAutoProposeMutation = useMutation(
		orpc.projects.stories.maturation.setAutoProposeAnswers.mutationOptions({
			onSuccess: (result) => {
				queryClient.setQueryData(
					maturationEditorKey,
					(old: typeof maturationData | undefined) =>
						old
							? {
									...old,
									feature: {
										...old.feature,
										autoProposeAnswers: result.enabled,
									},
								}
							: old,
				);
			},
			onError: () => toast.error(tMaturationToasts("autoProposeError")),
		}),
	);
	const onMaturationToggleAutoPropose = (enabled: boolean) =>
		maturationAutoProposeMutation.mutate({
			...maturationEditorInput,
			enabled,
		});

	// Auto-seed on open: when a feature has a Clean Spec but its Summary digest was
	// never populated, generate it once so the PO doesn't land on an empty tab. The
	// server no-ops cheaply otherwise; the ref keeps it to a single attempt/mount.
	// Questions are NO LONGER seeded on open — an empty question list is normal
	// until a maturation run mints them.
	const maturationSeedMutation = useMutation(
		orpc.projects.stories.maturation.ensureSeeded.mutationOptions({
			onSuccess: (result) => {
				if (result.summaryGenerated || result.questionsScanned) {
					invalidateMaturationEditor();
				}
			},
		}),
	);
	const maturationSeedAttempted = useRef(false);
	// Set true by the agent-accept (confirm_changes) handler so the NEXT save
	// success re-runs the (hash-gated) extraction — surfacing a run's new
	// questions immediately, without waiting for a reopen. Scoped to agent
	// applies only: a plain manual save leaves this false, so it never triggers
	// a per-keystroke extraction.
	const postAgentApplySeedRef = useRef(false);
	const triggerMaturationSeedAfterApply = () => {
		if (!postAgentApplySeedRef.current) {
			return;
		}
		postAgentApplySeedRef.current = false;
		if (maturationV2) {
			maturationSeedMutation.mutate(maturationEditorInput);
		}
	};
	useEffect(() => {
		if (
			!maturationV2 ||
			!maturationData ||
			maturationSeedAttempted.current
		) {
			return;
		}
		// Fire once per mount, unconditionally: the server seeds the summary only
		// when missing and extracts questions only when the spec hash changed, so
		// this is cheap (a no-op when nothing's stale) and — unlike gating on
		// `summaryDigest === null` — still surfaces questions on a feature that was
		// summarized before its spec last changed.
		maturationSeedAttempted.current = true;
		maturationSeedMutation.mutate(maturationEditorInput);
	}, [
		maturationV2,
		maturationData,
		maturationSeedMutation,
		maturationEditorInput,
	]);

	const onMaturationAnswer = (
		questionId: string,
		answer: string,
		opts?: {
			summary?: string;
			answerSource?: AnswerSource;
			mentionedUserIds?: string[];
		},
	) =>
		maturationAnswerMutation.mutate({
			...maturationEditorInput,
			questionId,
			answer,
			summary: opts?.summary?.trim() ? opts.summary.trim() : undefined,
			answerSource: opts?.answerSource,
			// Who the answer CITED (#1751, AC-10). Undefined rather than an empty
			// array so an answer that names nobody sends no field at all.
			mentionedUserIds: opts?.mentionedUserIds?.length
				? opts.mentionedUserIds
				: undefined,
		});

	const onMaturationSaveNotes = (content: string) =>
		maturationSetNotesMutation.mutate({
			...maturationEditorInput,
			content,
		});

	// "Revert this run" — restore to the version BEFORE the latest maturation run
	// (`latestRun.version - 1`). Mirrors FeatureVersionHistory's restore input
	// shape exactly. On success refresh both the story and the maturation editor
	// so the Clean Spec content and the run card re-hydrate.
	const maturationRevertMutation = useMutation(
		orpc.projects.stories.versions.restore.mutationOptions({
			onSuccess: () => {
				queryClient.invalidateQueries({
					queryKey: orpc.projects.stories.get.queryKey({
						input: {
							projectId,
							storyId: story.id,
							organizationId,
						},
					}),
				});
				invalidateMaturationEditor();
				onStoryUpdated?.();
				toast.success(tMaturationToasts("runReverted"));
			},
			onError: () => toast.error(tMaturationToasts("runRevertError")),
		}),
	);

	const onMaturationRevertRun = () => {
		const latestRun = maturationData?.latestRun;
		if (!latestRun) {
			return;
		}
		maturationRevertMutation.mutate({
			projectId,
			storyId: story.id,
			organizationId,
			versionNumber: latestRun.version - 1,
		});
	};

	// "Refresh Clean Spec" (#1/#4b/#6, #R1–R3) runs THROUGH the AI Feature Assistant
	// chat (same path as stage Enhance) — the button's onClick resolves the
	// kind-scoped Clean Spec prompt and appendMessage()s it so the agent applies via
	// write_document_local with the normal inline diff review. No standalone mutation.

	// Restore a soft-closed (POSSIBLY_RESOLVED) question to OPEN (#5).
	const maturationRestoreMutation = useMutation(
		orpc.projects.stories.maturation.restoreQuestion.mutationOptions({
			onSuccess: () => {
				requestGenRef.current++;
				setIsAiMode(false);
				setAiResult(null);
				invalidateMaturationEditor();
				toast.success(tMaturationToasts("questionRestored"));
			},
			onError: () =>
				toast.error(tMaturationToasts("questionRestoreError")),
		}),
	);
	const onMaturationRestoreQuestion = (questionRootId: string) =>
		maturationRestoreMutation.mutate({
			...maturationEditorInput,
			questionRootId,
		});

	// Question assignment (#1751). The search backs both the assignee picker and
	// the `@` popover — the same candidate set, so one query serves both.
	// No client-side flag read: the server resolves QUESTION_ASSIGNMENT in
	// getEditorState and omits `questionAssignees` when it is off, which is what
	// gates every control below. A NEXT_PUBLIC_ mirror would be inlined at build
	// time and put the kill switch back behind a redeploy.
	const isQuestionAssignmentEnabled =
		(maturationData?.questionAssignees ?? null) !== null;
	const [assigneeQuery, setAssigneeQuery] = useState("");
	const assignableMembersQuery = useQuery({
		...orpc.projects.stories.maturation.searchAssignableMembers.queryOptions(
			{ input: { ...maturationEditorInput, query: assigneeQuery } },
		),
		enabled: isQuestionAssignmentEnabled,
	});
	const maturationAssignMutation = useMutation(
		orpc.projects.stories.maturation.setQuestionAssignees.mutationOptions({
			onSuccess: () => {
				invalidateMaturationEditor();
			},
			onError: () => toast.error(tMaturationToasts("assignError")),
		}),
	);
	/**
	 * `note` carries the sentence the asker had typed. It is stored as context on
	 * the thread, never as an answer — this path must leave the question OPEN, or
	 * asking somebody would close the very question being asked.
	 */
	const onMaturationSetAssignees = (
		questionRootId: string,
		assigneeUserIds: string[],
		note?: string,
	) =>
		maturationAssignMutation.mutate({
			...maturationEditorInput,
			questionRootId,
			assigneeUserIds,
			note,
			link: typeof window === "undefined" ? "" : window.location.pathname,
		});

	// Staleness of the Clean Spec since its last AI/context update (#2/#3, #R4/R5/R7).
	// The inline "Updated {X} ago" date label carries the severity via `labelClass`
	// (proactive — visible without hover). `buttonClass` is a matching FILL tint used
	// only by the V1 "Update using context" button; in V2 that button is gone and the
	// label colour is the sole staleness signal. Bands: muted <1wk, yellow 1–2wk,
	// orange 2–4wk, red ≥1mo. `null` (never updated via context) = neutral, no label.
	const contextStaleness = useMemo(() => {
		const at = maturationData?.feature?.lastContextUpdateAt;
		if (!at) {
			return {
				level: "none" as const,
				buttonClass: "",
				labelClass: "",
				relative: null as string | null,
				attention: false,
			};
		}
		const date = new Date(at);
		const days = (Date.now() - date.getTime()) / 86_400_000;
		const relative = formatDistanceToNow(date, { addSuffix: true });
		if (days >= 30) {
			return {
				level: "month" as const,
				buttonClass:
					"border-destructive bg-destructive/10 text-destructive hover:bg-destructive/20",
				labelClass: "text-destructive",
				relative,
				attention: true,
			};
		}
		if (days >= 14) {
			return {
				level: "weeks" as const,
				buttonClass:
					"border-orange-500 bg-orange-500/10 text-orange-600 hover:bg-orange-500/20 dark:text-orange-400",
				labelClass: "text-orange-600 dark:text-orange-400",
				relative,
				attention: true,
			};
		}
		if (days >= 7) {
			return {
				level: "week" as const,
				buttonClass:
					"border-yellow-500 bg-yellow-500/10 text-yellow-700 hover:bg-yellow-500/20 dark:text-yellow-400",
				labelClass: "text-yellow-700 dark:text-yellow-400",
				relative,
				attention: false,
			};
		}
		return {
			level: "fresh" as const,
			buttonClass:
				"border-emerald-500/60 bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/20 dark:text-emerald-400",
			labelClass: "text-muted-foreground",
			relative,
			attention: false,
		};
	}, [maturationData?.feature?.lastContextUpdateAt]);
	const contextStalenessHint =
		contextStaleness.level === "month"
			? tTooltips("updateCleanSpecStaleMonth")
			: contextStaleness.level === "weeks"
				? tTooltips("updateCleanSpecStaleWeeks")
				: contextStaleness.level === "week"
					? tTooltips("updateCleanSpecStaleWeek")
					: null;
	const refreshCleanSpecNeeded = maturationData?.refreshNeeded ?? false;

	// Confirm-time change summary (v2 + agent-review only). When the agent's
	// inline diff-review opens (`isAwaitingConfirmation` → true) we ask the
	// backend to LLM-summarize before→after into a few section-tagged bullets so
	// the PO reads ~4 lines instead of scanning the whole diff. Purely advisory:
	// a slow/failed summarize NEVER blocks Accept/Reject (the buttons stay live),
	// and an empty result renders nothing.
	const [pendingChangeBullets, setPendingChangeBullets] = useState<
		string[] | null
	>(null);
	// Latest-value mirror of pendingChangeBullets. `handleAccept` is invoked
	// through CopilotKit's `renderRef.current`, whose closure lags React state by
	// a render, so reading the state var directly there can see a stale `null`
	// (the summarize result lands AFTER the confirm renderer's closure was built)
	// and the AI-update note would never be recorded. Read this ref instead —
	// same pattern as `agentStateRef`/`recordOutcomeRef`.
	const pendingChangeBulletsRef = useRef<string[] | null>(null);
	useEffect(() => {
		pendingChangeBulletsRef.current = pendingChangeBullets;
	}, [pendingChangeBullets]);
	const summarizeChangesMutation = useMutation(
		orpc.projects.stories.maturation.summarizeChanges.mutationOptions({
			onSuccess: (result) => {
				setPendingChangeBullets(result.changeSummary ?? []);
			},
			// Best-effort: on error leave bullets null so the card renders nothing
			// and the review proceeds with just the diff bar (as today).
			onError: () => setPendingChangeBullets(null),
		}),
	);

	// Tracks if the current pending diff review originated from a context refresh
	const isRefreshCleanSpecPendingRef = useRef<boolean>(false);

	// D3: persist an accepted run's change summary as a collapsed "AI update" note
	// in the Decision Log. Best-effort — a failed note must not affect the accept;
	// on success we refetch the editor state so the note appears.
	const recordChangeNoteMutation = useMutation(
		orpc.projects.stories.maturation.recordChangeNote.mutationOptions({
			onSuccess: () => {
				queryClient.invalidateQueries({
					queryKey: maturationEditorKey,
				});
			},
		}),
	);

	const fabricAgentContext = useMemo(
		() => ({
			projectId,
			projectName,
			storyId: story.id,
			storyIdentifier: story.identifier,
			storyTitle: story.title,
			repositoryUrl: projectRepository?.url ?? null,
			repositoryOwner: projectRepository?.owner ?? null,
			repositoryName: projectRepository?.name ?? null,
		}),
		[
			projectId,
			projectName,
			story.id,
			story.identifier,
			story.title,
			projectRepository?.url,
			projectRepository?.owner,
			projectRepository?.name,
		],
	);
	useRegisterFabricAgentContext(fabricAgentContext);

	// Detect if we're on an org route by checking for organizationSlug in params
	const paramOrgSlug = params?.organizationSlug as string | undefined;
	const isOrgRoute = !!paramOrgSlug;
	const orgContextReady = !isOrgRoute || organizationId !== undefined;

	// Form state
	const [title, setTitle] = useState(story.title);
	const [priority, setPriority] = useState<string>(story.priority);

	// Per-item AI sparkle beside the metadata Priority select — the second
	// live priority control on this page (the header chip carries the first).
	// Completed / hidden / declined items get no sparkle; the server refuses
	// them regardless.
	const aiReassessEligible = useAiReassessEligibility({
		projectId,
		organizationId: organizationId ?? null,
		draftingStage: story.draftingStage,
		statusId: story.statusId,
	});
	const [size, setSize] = useState<string>(story.size ?? "");
	const [storyPoints, setStoryPoints] = useState<string>(
		story.storyPoints?.toString() ?? "",
	);
	const [newTaskTitle, setNewTaskTitle] = useState("");
	const [isSaving, setIsSaving] = useState(false);
	const [tasks, setTasks] = useState<StoryTask[]>(story.tasks);
	const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
	const [showRaw, setShowRaw] = useState(false);
	// Drives Radix DropdownMenu open state so the stage tooltip can be
	// suppressed while the picker is open (otherwise both float on top of
	// each other when the menu opens off the trigger). The `recentlyClosed`
	// flag keeps the tooltip suppressed for a short window AFTER close —
	// without it the tooltip immediately re-opens because the trigger is
	// still focused/hovered when the user dismisses the menu.
	const [isStageMenuOpen, setIsStageMenuOpen] = useState(false);
	const [stageMenuRecentlyClosed, setStageMenuRecentlyClosed] =
		useState(false);
	const stageMenuCloseTimerRef = useRef<NodeJS.Timeout | null>(null);
	const handleStageMenuOpenChange = useCallback((open: boolean) => {
		setIsStageMenuOpen(open);
		if (!open) {
			setStageMenuRecentlyClosed(true);
			if (stageMenuCloseTimerRef.current) {
				clearTimeout(stageMenuCloseTimerRef.current);
			}
			stageMenuCloseTimerRef.current = setTimeout(() => {
				setStageMenuRecentlyClosed(false);
				stageMenuCloseTimerRef.current = null;
			}, 400);
		}
	}, []);
	useEffect(() => {
		return () => {
			if (stageMenuCloseTimerRef.current) {
				clearTimeout(stageMenuCloseTimerRef.current);
			}
		};
	}, []);
	const autoSaveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
	const isManualSaveRef = useRef(false);

	// The `onUpdate` closure is sealed at first render (see `useEditor`'s empty
	// dep array), so calling `triggerAutoSave` directly there pins render-1's
	// copy — whose `hasUnsavedChanges` is always false, so the autosave never
	// ran. Fizzy #1987.
	const triggerAutoSaveRef = useRef<(() => void) | null>(null);

	// `updateMutation`'s hook-level `onError` re-arms the autosave
	// timer to retry a failed save — but that callback "always run[s]
	// regardless, even from a dead component" (see the unmount-cleanup
	// comment below), so an unguarded re-arm would schedule a `setTimeout` on
	// an unmounted component that nothing ever cancels. `isMountedRef` lets
	// `onError` (and the timer it schedules) tell a live component from a
	// dead one. Set to `false` in the unmount cleanup; never resurrected.
	const isMountedRef = useRef(true);

	// Consecutive-failure counter for the same `onError` re-arm.
	// Incremented on every failed save, reset to 0 on any successful one.
	// Past `MAX_AUTO_SAVE_RETRIES` the re-arm is skipped so a deterministic
	// failure (offline, a permanent 4xx) stops retrying instead of toasting
	// "Failed to save story" every 10s forever. A manual Save (button or
	// Ctrl/Cmd+S) is not gated by this — the user can still retry by hand.
	const saveFailureCountRef = useRef(0);

	// `hasUnsavedChanges` is ALSO in Effect 5's dependency array
	// (see below) — that is deliberate and load-bearing: the dirty→clean
	// transition re-runs Effect 5 and drains any sync that was deferred while
	// the user was typing. Do not remove it as redundant.
	//
	// This ref mirrors the same state for consistency with the other guard
	// flags (`isContextUpdateActiveRef`, `isAwaitingConfirmationRef`) and so
	// the guard reads a live value rather than a stale closure if the effect
	// ordering ever changes.
	const hasUnsavedChangesRef = useRef(false);
	useEffect(() => {
		hasUnsavedChangesRef.current = hasUnsavedChanges;
	}, [hasUnsavedChanges]);

	// Mirrors `isSaving` for the `beforeunload` guard (see below),
	// using the same direct-render-assignment pattern as `setAgentStateRef` /
	// `handleSaveRef` rather than a bridging effect.
	const isSavingRef = useRef(false);
	isSavingRef.current = isSaving;

	// Effect 1 (below) runs above `handleSave`'s declaration, so it can't
	// reference it directly. Bridge via a ref, following the same
	// direct-render-assignment pattern used by `setAgentStateRef` /
	// `imageUploaderRef` elsewhere in this file.
	const handleSaveRef = useRef<
		((opts?: { includeStageTransition?: boolean }) => boolean) | null
	>(null);

	// The accept-path deferred save gets its OWN timer, deliberately not
	// `autoSaveTimeoutRef`. That ref is also written by `updateMutation.onError`,
	// which clears whatever is pending and re-arms a 10s `triggerAutoSave`. If
	// the accept-path save shared it, a save failing inside the deferral window
	// would cancel the accepted AI content's save and replace it with a
	// `triggerAutoSave` that bails while `isAiLoading` / `isAwaitingConfirmation`
	// are still set — and bails without re-arming, so the content would sit
	// unsaved until the user typed again. Separate refs mean neither can cancel
	// the other.
	const deferredAcceptSaveTimeoutRef = useRef<ReturnType<
		typeof setTimeout
	> | null>(null);

	// Effect 1 also needs `updateMutation.isPending` to avoid
	// double-submitting a flush while a save is already in flight (see below).
	// `updateMutation` is declared well after Effect 1, so it can't be read
	// directly there without adding it to Effect 1's dependency array — which
	// would make the effect re-fire on every mutation state change. Mirror it
	// into a ref instead, using the same direct-render-assignment pattern as
	// `handleSaveRef`.
	const updateMutationPendingRef = useRef(false);

	// The markdown the server last confirmed. `hasUnsavedChanges`
	// is derived by comparing the live editor against this.
	//
	// This used to be paired with a `pendingSaveContentRef` — one shared slot
	// holding "the markdown handed to the in-flight mutation" — that every
	// `updateMutation.mutate` call site wrote before calling `mutate`, read
	// unconditionally by the mutation's shared `onSuccess`. That was a race:
	// save #1 sends A, the user types B, a second save sends A+B and
	// overwrites the shared ref, then save #1's `onSuccess` fires and confirms
	// A+B as if it were what #1 actually sent — `lastSavedMarkdownRef` goes
	// clean while B never reached the server if #2 then failed. Each
	// `updateMutation.mutate(updates, { onSuccess })` call site now confirms
	// its own snapshot from its own per-call `onSuccess` closure instead (see
	// `handleSave` and the AI-accept flow below) — that closure captures the
	// exact markdown *this* call sent, so it can never be attributed to a
	// different, concurrently in-flight request.
	const lastSavedMarkdownRef = useRef<string | null>(null);

	// Smart title tooltip — only show when the title is actually truncated.
	// The input is portaled into a slot whose target DOM ref is set by the
	// parent on commit, so a one-shot mount effect would bail before the
	// element exists. `useIsOverflowing` attaches its ResizeObserver inside a
	// callback ref so detection is independent of when the input mounts, and
	// also re-measures after web fonts load (fallback metrics often differ
	// enough to flip the truncated/fits decision after the initial paint).
	const [isTitleFocused, setIsTitleFocused] = useState(false);
	const [titleInputRef, isTitleTruncated] =
		useIsOverflowing<HTMLInputElement>(title);
	const showTitleTooltip = !!title && isTitleTruncated && !isTitleFocused;

	// Image paste/drop wiring.
	// `imageUploaderRef` lets us declare the editor's `editorProps.handlePaste`
	// before the actual upload callback exists (the callback closes over the
	// editor we're about to create). Mirrors the `imageUploadRef` pattern in
	// `DocumentEditor.tsx` (lines 767-770 / 1839).
	const imageUploaderRef = useRef<
		((file: File, signal: AbortSignal) => Promise<void>) | null
	>(null);

	/**
	 * Stable wrapper passed to the shared clipboard hook. The hook keeps a
	 * referentially stable handler set across renders, so we must
	 * indirect through the ref to pick up the always-fresh `editor` /
	 * `projectId` / `story.id` closure variables without re-mounting the editor
	 * (PR #688 lesson — `<CopilotKit>` mount stability depends on this).
	 */
	const stableImageUploader = useCallback(
		async (file: File, signal: AbortSignal): Promise<void> => {
			const uploader = imageUploaderRef.current;
			if (!uploader) {
				return;
			}
			await uploader(file, signal);
		},
		[],
	);

	// MIME allowlist mirrors `image-upload-utils.ts` (png/jpeg/gif/webp for
	// the rich-editor surfaces). Frozen so React never thinks it changed
	// between renders (the hook reads it via `optionsRef`, but stability still
	// helps consumers reading the same value).
	const storyAllowedMimeTypes = useMemo(
		() =>
			new Set<string>([
				"image/png",
				"image/jpeg",
				"image/gif",
				"image/webp",
			]),
		[],
	);

	const { handlePaste: handleImagePaste, handleDrop: handleImageDrop } =
		useClipboardImagePaste({
			surface: "story",
			maxSizeBytes: 5 * 1024 * 1024,
			allowedMimeTypes: storyAllowedMimeTypes,
			maxFilesPerPaste: 5,
			uploader: stableImageUploader,
		});

	// Task generation state
	const [isGeneratingTasks, setIsGeneratingTasks] = useState(false);

	// Drafting stage state
	const [targetStage, setTargetStage] = useState<FeatureDraftingStage | "">(
		"",
	);
	const [showTransitionDialog, setShowTransitionDialog] = useState(false);

	// Set when the coverage gate refused the move to Done; carries the numbers
	// the refusal reported so the dialog can restate them.
	const [coverageBlock, setCoverageBlock] =
		useState<CoverageBlockDetail | null>(null);
	// Stashes the last attempted maturation mutation payload in `onError` so that
	// `CoverageOverrideDialog` retries with the full original variables (including draftingStage).
	const lastMaturationVariablesRef = useRef<{
		maturationStatus?: MaturationStatus;
		draftingStage?: FeatureDraftingStage;
	}>({});

	// Pending stage for CopilotKit streaming enhance flow
	const [pendingTargetStage, setPendingTargetStage] =
		useState<FeatureDraftingStage | null>(null);

	// True while the confirm_changes dialog is visible (keeps diff highlighting active)
	const [isAwaitingConfirmation, setIsAwaitingConfirmation] = useState(false);
	// Callbacks for the DiffReviewBar to trigger accept/reject
	const confirmCallbacksRef = useRef<{
		accept: () => void;
		reject: () => void;
	} | null>(null);

	/**
	 * `resolvePendingReview`, reachable from the `confirm_changes` renderer.
	 *
	 * The renderer is declared ABOVE that callback (it has to be — `useCopilotAction`
	 * sits with the other agent wiring, and the resolution path is defined with the
	 * banner it was written for), so the chat card cannot close over it directly.
	 * This ref is the forward reference, assigned in the render body immediately
	 * after the callback exists.
	 *
	 * Assigned during render rather than in an effect, which makes the ordering a
	 * property of React's render model rather than of effect scheduling: the
	 * renderer closure is only ever INVOKED by `<CopilotSidebar>`, a child of this
	 * component's own JSX, and a parent's render body always completes before any
	 * child renders. So the assignment below has run before the closure captured
	 * on the same pass can be called — on the first pass and every later one.
	 */
	const resolvePendingReviewRef = useRef<
		((action: "accept" | "reject") => Promise<boolean>) | null
	>(null);

	// ── Cross-tab review banner (Fizzy #1929, R7–R9) ─────────────────────
	// The review bar above lives inside the Clean Specification tab's sticky
	// header, so with any other maturation tab active it is not merely hidden —
	// it is unrendered, and its accept / reject controls are absent from the
	// accessibility tree (asserted in `story-workspace-tab-mount.test.tsx`). A
	// product owner who steps over to Summary & Questions to answer an open
	// question therefore cannot resolve the draft from where they are, and
	// nothing on that tab says one is waiting at all.
	//
	// These three pieces of state back a SECOND surface for that one decision,
	// rendered once above the tab bar. The review bar itself is deliberately
	// not moved: it owns per-change navigation and the diff view-mode toggle,
	// which are meaningless above the tabs, and its sticky placement was built
	// on purpose.
	const [reviewResolution, setReviewResolution] =
		useState<PendingReviewResolution | null>(null);
	/** Text of the always-mounted polite live region. */
	const [reviewAnnouncement, setReviewAnnouncement] = useState("");
	/** The spec tab's review region, focused by the banner's "Review changes". */
	const reviewBarRegionRef = useRef<HTMLElement>(null);
	/**
	 * The banner itself. Read only by the settle timer, to tell "focus is still
	 * where the resolution left it" from "the user has moved on" — the
	 * difference between restoring focus and stealing it.
	 */
	const reviewBannerRef = useRef<HTMLElement>(null);
	/** Set while a tab switch to Clean Spec is waiting to hand focus over. */
	const wantsReviewBarFocusRef = useRef(false);

	// Version history state
	const [showVersionHistory, setShowVersionHistory] = useState(false);

	// @fabric mention support for raw markdown editor
	const { handleInputChange: handleRawEditorFabricMention } =
		useFabricMention({
			projectId,
			projectName,
			storyId: story.id,
			storyIdentifier: story.identifier,
			storyTitle: story.title,
			onMentionTrigger: () => {
				toast.info("Opening Fabric Agent...");
			},
		});

	// Code context launcher for "Ask About This" functionality
	const { openWithSelectedCode, getSelectedText, isLikelyCode } =
		useCodeContextLauncher({
			projectId,
			projectName,
			storyId: story.id,
			storyIdentifier: story.identifier,
			storyTitle: story.title,
			repositoryUrl: projectRepository?.url ?? null,
			repositoryOwner: projectRepository?.owner ?? null,
			repositoryName: projectRepository?.name ?? null,
			defaultBranch: projectRepository?.branch ?? null,
		});

	// Handle "Ask About This" from text selection
	const handleAskAboutSelection = () => {
		const selected = getSelectedText();
		if (!selected) {
			toast.info("Select some text first to ask about it");
			return;
		}
		if (!isLikelyCode(selected)) {
			// Still allow but maybe warn
			openWithSelectedCode(selected, undefined, "Explain this:");
		} else {
			openWithSelectedCode(selected, undefined, "Explain this code:");
		}
	};

	// Build initial content combining description and acceptance criteria.
	// Description is rendered as-is — it may already contain its own heading
	// structure (e.g. a `# Passive Analysis: ...` preamble from a stage-enhance
	// LLM). AC, if present, is appended under a `## Acceptance Criteria`
	// heading so parseStoryContent() can recover the split on save.
	const buildInitialContent = useCallback(() => {
		const desc = story.description
			? story.description.startsWith("<")
				? getTurndownService().turndown(story.description)
				: story.description
			: "";
		const ac = story.acceptanceCriteria
			? story.acceptanceCriteria.startsWith("<")
				? getTurndownService().turndown(story.acceptanceCriteria)
				: story.acceptanceCriteria
			: "";
		return formatStoryContent({
			description: desc,
			acceptanceCriteria: ac,
		});
	}, [story.description, story.acceptanceCriteria]);

	// Current document content (baseline for diffs) - ag-ui-demo pattern
	const [currentDocument, setCurrentDocument] = useState(() =>
		buildInitialContent(),
	);

	// === STREAMING BASELINE REFS (fixes race condition with async state) ===
	// React state updates are async, but we need the baseline IMMEDIATELY when streaming starts.
	// Using refs ensures synchronous access to the baseline in Effect 3.
	const baselineRef = useRef<string>(buildInitialContent());
	const wasLoadingRef = useRef(false);

	/**
	 * The document as it stood when the CURRENT run started — the text the model
	 * was actually given.
	 *
	 * Written in exactly one place: Effect 1's run-start capture. That is the
	 * whole point of it existing next to `baselineRef`, which four other writers
	 * also assign (Effect 4's editor sync, Effect 5's prop adoption,
	 * `handleAccept`, `handleReject`) — any of which can land between the run
	 * starting and the user resolving it, at which point `baselineRef` no longer
	 * describes the pre-run state.
	 *
	 * `restorePendingDecisions` compares the server's appendix against this to
	 * decide which entries the model never saw, so handing it the wrong snapshot
	 * either duplicates an integrated decision or drops a mid-run one. The
	 * editor-restore semantics `handleReject` relies on stay on `baselineRef`.
	 *
	 * `null` until a run starts in this mount: with no run there is no pre-run
	 * baseline, and the splice's "credit what the content already holds" rule is
	 * the correct comparison on its own.
	 */
	const runStartBaselineRef = useRef<string | null>(null);

	// Seed `lastSavedMarkdownRef` from the loaded story — same
	// buildInitialContent() shape as `baselineRef` above — so a freshly
	// opened, untouched document compares equal (both sides come from the
	// same call) instead of reading dirty before the user has typed anything.
	// Guarded so a later re-render doesn't stomp a value a real save has
	// since confirmed.
	//
	// Note: this is the stored-markdown shape (`buildInitialContent()`),
	// not the Turndown shape every other writer of this ref uses
	// (`getEditorMarkdownForSave` output — e.g. `-   item`, trailing
	// spaces). The two are never byte-equal for a bulleted document. This
	// only matters for `handleReject`, the one reader that compares against
	// this ref without another writer having overwritten it first; it fails
	// safe (reports dirty, not clean) on a never-saved document, so no data
	// loss — just a possible false "unsaved changes" right after a reject.
	if (lastSavedMarkdownRef.current === null) {
		lastSavedMarkdownRef.current = buildInitialContent();
	}

	// Track last-known story prop content to detect external changes (e.g. enhance mutation refetch)
	const lastStoryDescriptionRef = useRef(story.description);
	const lastStoryAcceptanceCriteriaRef = useRef(story.acceptanceCriteria);
	// Latest-value mirror of the SERVER's spec body, assigned on every render —
	// the same pattern as `agentStateRef` / `isSavingRef` below.
	//
	// Answering an open question writes a bullet into the pending-decisions
	// appendix at the end of `description` server-side, immediately. The
	// confirm_changes renderer's closure cannot see that write: its dependency
	// array (`[agentState?.document, currentDocument]`) does not list the story,
	// so the closure is not rebuilt when the answer's query invalidation lands,
	// and Effect 5 — which would otherwise refresh the editor from the prop — is
	// deliberately frozen for the whole review by `shouldDeferStoryPropSync`.
	// Reading this ref at click time is what lets accept/reject splice a mid-run
	// decision back into the content they save instead of erasing it.
	//
	// Deliberately NOT `lastStoryDescriptionRef` above: that one records the
	// last value Effect 5 ADOPTED, which during a review is by definition the
	// pre-answer text.
	//
	// The render-time assignment is a FLOOR, not the value the splice trusts.
	// `story.description` is React Query cache data and the answer mutation's
	// `stories.get` invalidation is fire-and-forget, so between the answer
	// landing on the server and its refetch arriving this mirror still holds
	// pre-answer text — and resolving inside that window would reproduce #1929
	// through the very code path that exists to prevent it. Every resolution
	// therefore goes through `resolvePendingReview`, which awaits a fresh read
	// and overwrites this ref before it lets either callback run.
	const serverDescriptionRef = useRef(story.description);
	serverDescriptionRef.current = story.description;
	// Guard to suppress onUpdate/auto-save when programmatically syncing editor content
	const isSyncingFromPropRef = useRef(false);
	// TipTap fires onUpdate once during its initial mount as it parses /
	// normalises the seed content. Without this guard that synthetic update
	// flips hasUnsavedChanges → true the moment the editor loads, making
	// Save look active even though the user hasn't typed anything.
	const editorInitialMountRef = useRef(true);
	// useEditor's onUpdate callback is created once and closes over the
	// initial state. Without these refs the AI-loading and
	// awaiting-confirmation guards inside onUpdate would read the stale
	// (initial-render) values — so an AI-driven setContent firing onUpdate
	// after generation slips past the guard and marks the doc dirty.
	const isAiLoadingRef = useRef(false);
	const isAwaitingConfirmationRef = useRef(false);
	// Shared re-entrancy latch for the two run-triggering handlers below
	// (`handleRefreshCleanSpec` and the `FeatureTransitionDialog` `onEnhance`).
	// Both post to the SAME CopilotKit thread, so a single shared latch is
	// required — separate per-handler latches would let Refresh fire during
	// Enhance's prefetch window (and vice versa), still causing a second
	// concurrent run. Each handler awaits network calls (bound-prompt fetch,
	// context retrieval) before `appendMessage` actually starts the agent
	// run, so a double-click (or a click while a prior run is still
	// streaming) fires a second concurrent run on the same thread — the
	// server-side InMemoryAgentRunner then throws "Thread already running"
	// (GH issue #2526).
	const isProgrammaticAgentRunInFlightRef = useRef(false);
	// Guard to suppress editor-to-state sync during context update diff review
	const isContextUpdateActiveRef = useRef(false);

	// Fetch project context for AI - wait for org context on org routes
	// IMPORTANT: Pass null explicitly for personal context to prevent
	// session fallback which could leak org data to personal pages
	const {
		data: projectData,
		isPending: isProjectLoading,
		isError: isProjectError,
	} = useQuery({
		...orpc.projects.get.queryOptions({
			input: { id: projectId, organizationId },
		}),
		enabled: orgContextReady,
	});

	// Fetch project documents for context
	const { data: documentsData } = useQuery(
		orpc.projects.documents.list.queryOptions({
			input: { projectId, organizationId },
		}),
	);

	// Fetch recent Teams messages (for context + integration detection)
	const { data: teamsMessagesData } = useQuery({
		...orpc.integrations.teams.getRecentMessages.queryOptions({
			input: {
				projectId,
				limit: 10,
				organizationId: organizationId ?? null,
			},
		}),
		enabled: !!projectId && orgContextReady,
	});

	// Fetch recent Slack messages (for context + integration detection)
	const { data: slackMessagesData } = useQuery({
		...orpc.integrations.slack.getRecentMessages.queryOptions({
			input: {
				projectId,
				limit: 10,
				organizationId: organizationId ?? null,
			},
		}),
		enabled: !!projectId && orgContextReady,
	});

	// Fetch meeting transcript context for AI
	const { data: transcriptContextData } = useQuery({
		...orpc.projects.meetingTranscriptSync.getContext.queryOptions({
			input: {
				projectId,
				limit: 10,
				organizationId: organizationId ?? null,
			},
		}),
		enabled: !!projectId && orgContextReady,
		staleTime: 300000,
	});

	// Check if code search is enabled for this project (controls hasRepoIntegration)
	// Mirrors DocumentEditor.tsx so the agent binds code-search tools when chatting
	// from a feature/story, not just from the project document editor.
	const { data: ragSettingsData } = useQuery({
		...orpc.projects.ragSettings.get.queryOptions({
			input: { projectId, organizationId: organizationId ?? null },
		}),
		enabled: !!projectId && orgContextReady,
		staleTime: 60000,
	});
	const codeSearchEnabled =
		ragSettingsData?.settings?.codeSearchEnabled ?? false;

	const project = projectData?.project;
	const documents = documentsData?.documents ?? [];

	// CopilotChat hook for isLoading state and programmatic message sending.
	// `isAiLoading` flips true during CopilotKit AG-UI handshakes (info /
	// agent/connect) on mount and re-mount, even when no user-initiated
	// generation is happening. We keep `isAiLoading` for editor-state gating
	// (which must be defensive — e.g. don't fire onUpdate-side-effects when
	// the agent is streaming) AND for the disable-type consumers below
	// ("Update Full Spec", the "X New Decisions" CTA, the Enhance dialog's
	// submit button) — a brief disable during a handshake is harmless.
	//
	// The "AI is generating…" pill below IS a user-facing indicator, so it
	// cannot tolerate a handshake-triggered flash: it gates on the explicit
	// user-send signal from `useUserRunSignal`, marked by the chat input's
	// `onUserSend` and the two programmatic `appendMessage` triggers below
	// (`handleRefreshCleanSpec`, the FeatureTransitionDialog enhance flow).
	// See the hook's doc-comment for the transition-clear and
	// reload-mid-run semantics.
	//
	// Both reads come from the surface-wide `<CopilotChatSessionProvider>`
	// rather than a local `useCopilotChat()` / `useCopilotChatInternal()`
	// pair: on 1.70 each of those call sites opens its own `agent/connect`
	// (Fizzy #2389). Same fields, same values, one connect.
	const {
		isLoading: isAiLoading,
		appendMessage,
		agent,
	} = useCopilotChatSession();
	const { isUserGenerationActive, markUserRunInitiated, clearUserRunMark } =
		useUserRunSignal(isAiLoading);

	// Mirrors the `agent` instance into a ref so `isAgentRunActive` below can
	// read `isRunning` live at call time instead of through a stale
	// closure. The instance itself only changes on provider remount, so
	// effect-lag on THIS ref is not a concern — what's live is the
	// `isRunning` property read off `.current` at call time.
	const copilotAgentRef = useRef(agent);
	useEffect(() => {
		copilotAgentRef.current = agent;
	}, [agent]);
	// Ground-truth run check for the two run-triggering handlers below.
	// `agent.isRunning` is set SYNCHRONOUSLY by the AG-UI client at
	// `runAgent` entry, whereas `isAiLoadingRef` mirrors `isLoading` via a
	// passive `useEffect` and can lag ground truth within the same tick
	// (GH #2526) — e.g. `flushSync` triggering a render that flips
	// `isRunning` before the `isAiLoadingRef` effect has a chance to run.
	const isAgentRunActive = useCallback(
		() =>
			Boolean(copilotAgentRef.current?.isRunning) ||
			isAiLoadingRef.current,
		[],
	);

	// Query keys for optimistic updates. Declared here rather than beside the
	// mutations below because the two AI-run handlers that follow immediately
	// (`handleRefreshCleanSpec`, the transition dialog's `onEnhance`) invalidate
	// on kind drift and their dependency arrays are evaluated at this point in
	// the render.
	const storyGetQueryKey = orpc.projects.stories.get.queryKey({
		input: { projectId, storyId: story.id, organizationId },
	});
	/**
	 * DERIVED, NEVER HAND-BUILT.
	 *
	 * This was `["projects", "stories", "list", projectId]` — a literal that
	 * matched none of the three key shapes this repository registers, so every
	 * `invalidateQueries` below it was a silent no-op. See
	 * `docs/solutions/conventions/derive-query-invalidation-keys-never-hand-build-them.md`.
	 *
	 * The filter carries only `projectId` on purpose: TanStack compares the
	 * input object as a recursive subset, so this matches the roadmap list
	 * however the surface that registered it scoped its organization argument.
	 */
	const storiesListQueryKey = useMemo(
		() => orpc.projects.stories.list.key({ input: { projectId } }),
		[projectId],
	);

	// Fizzy #2048: the server owns the work item's kind at generation time, so a
	// resolved kind that disagrees with this component's cached row means the
	// cache is stale — the item was converted from another surface (the roadmap
	// card kebab, the actions menu) that does not share this cache. Refresh it
	// before the run posts, so the chrome around the editor (kind icon, stage
	// list, kind-gated actions) stops describing the other kind while a spec for
	// the resolved one is being generated. Same pair of keys the convert and
	// enhance mutations already invalidate.
	const invalidateStoryAfterKindDrift = useCallback(() => {
		queryClient.invalidateQueries({ queryKey: storyGetQueryKey });
		queryClient.invalidateQueries({ queryKey: storiesListQueryKey });
	}, [queryClient, storyGetQueryKey, storiesListQueryKey]);

	// "Refresh Clean Spec" / "Update" (#1/#4b/#B) — ask the SERVER for the Clean
	// Spec prompt this work item should run and post it into the AI Feature
	// Assistant chat (same path as stage Enhance) so the agent rebuilds the spec
	// via write_document_local with the normal diff review, batching all pending
	// decisions in one run. Shared by the toolbar button and the "X New
	// Decisions" bar.
	const handleRefreshCleanSpec = useCallback(async () => {
		// Bail out if a prior invocation is still in flight (network prefetch
		// still resolving, or the agent run it started is still streaming) —
		// otherwise this fires a second concurrent run on the same thread.
		// Shared with `onEnhance` below since both post to the same thread.
		if (isProgrammaticAgentRunInFlightRef.current || isAgentRunActive()) {
			return;
		}
		isProgrammaticAgentRunInFlightRef.current = true;
		isRefreshCleanSpecPendingRef.current = true;
		try {
			// The work item id is all the server needs; no agent name and no kind
			// leave this component. See `clean-spec-agent-for-kind.ts` for why.
			const resolvedPrompt =
				await orpcClient.projects.stories.resolvePrompt({
					projectId,
					storyId: story.id,
					organizationId: organizationId ?? null,
				});
			const promptContent = resolvedPrompt.resolved
				? resolvedPrompt.content
				: null;
			if (!promptContent) {
				// Nothing bound for this item's kind. The server never substitutes
				// the other kind's prompt, so this stays the existing "no prompt
				// configured" error and writes nothing.
				isRefreshCleanSpecPendingRef.current = false;
				toast.error(tMaturationToasts("cleanSpecRefreshError"));
				return;
			}
			// The message and the template must agree, so the word comes from the
			// same response as the prompt — never from `story.kind`.
			const kindWord = resolvedPrompt.kindWord;
			if (resolvedPrompt.kind !== story.kind) {
				invalidateStoryAfterKindDrift();
			}
			// Deterministically pre-fetch connected project context (meeting
			// transcripts, uploaded docs, team messages). This preserves the
			// context-folding the removed "Update using context" button provided:
			// the agent's own search_project_knowledge tool is single-query and only
			// fires if the model chooses to call it, whereas this pre-fetch uses the
			// same multi-query RRF retrieval as the old button and is always present.
			// Best-effort — a retrieval failure must not block the rebuild.
			let contexts: string[] = [];
			try {
				const result = await orpcClient.projects.specContext({
					projectId,
					specMarkdown: currentDocument,
					organizationId: organizationId ?? null,
				});
				contexts = result.contexts;
			} catch {
				// Retrieval failed — proceed without the pre-fetched block; the agent
				// can still fall back to its search_project_knowledge tool.
			}
			// Late recheck (pre-flush): reads synchronous ground truth via
			// `isAgentRunActive()` — abort before writing `refreshSpecContexts`
			// into agent state — it persists across turns until replaced or the
			// story changes, so writing it for a run we then abort would feed
			// stale context to a later, unrelated run (GH #2526).
			if (isAgentRunActive()) {
				isRefreshCleanSpecPendingRef.current = false;
				return;
			}
			// Route the connected context to the model out-of-band on the dedicated
			// `refreshSpecContexts` agent-state field — NOT the visible chat message,
			// which previously showed the PO a wall of raw transcript and read as "the
			// clean spec is using the wrong prompt". The unified-server
			// merges this field into the agent's `ragContexts`. `flushSync` commits it
			// synchronously so CopilotKit's outgoing state snapshot carries it on this
			// exact turn (same mechanism as `syncDocumentBeforeSend`) — no readable
			// timing, no race. Partial-update form (never spread a stale `agentState`).
			flushSync(() => {
				setAgentStateRef.current({
					refreshSpecContexts: contexts,
				} as AgentState);
			});
			// Late recheck (post-flush, belt-and-braces): a run may have started
			// from the chat input itself during the awaits above (the input only
			// consults `agent.isRunning`, not our latch), so `isAgentRunActive()`
			// can have flipped true after we set the latch above and after the
			// pre-flush check ran. Re-checking right before `appendMessage`
			// catches that race (GH #2526).
			if (isAgentRunActive()) {
				isRefreshCleanSpecPendingRef.current = false;
				// Roll back: the contexts were committed for a refresh we are now
				// aborting and would otherwise ride along on a later, unrelated run.
				flushSync(() => {
					setAgentStateRef.current({
						refreshSpecContexts: [] as string[],
					} as AgentState);
				});
				return;
			}
			// `appendMessage` awaits the full agent run, so the latch stays held
			// (via the outer `finally`) until the run actually completes.
			markUserRunInitiated();
			try {
				await appendMessage(
					new TextMessage({
						role: MessageRole.User,
						content: buildCleanSpecRefreshMessage(
							kindWord,
							promptContent,
						),
					}),
				);
			} catch (error) {
				// The user-run signal is shared across every send surface on
				// this thread, so this handler may only clear a mark it set
				// itself — a broad clear (e.g. in the outer `catch` below)
				// could wipe an unrelated, concurrently-active chat send's
				// mark. Scoping the clear to this narrow try/catch, right
				// after the `markUserRunInitiated()` above, keeps it tied to
				// the run THIS handler started.
				clearUserRunMark();
				throw error;
			}
		} catch {
			isRefreshCleanSpecPendingRef.current = false;
			toast.error(tMaturationToasts("cleanSpecRefreshError"));
		} finally {
			isProgrammaticAgentRunInFlightRef.current = false;
		}
	}, [
		story.id,
		// Read ONLY to detect drift against the server's answer — never to pick
		// a template (Fizzy #2048 R2).
		story.kind,
		organizationId,
		projectId,
		currentDocument,
		appendMessage,
		markUserRunInitiated,
		clearUserRunMark,
		tMaturationToasts,
		invalidateStoryAfterKindDrift,
	]);

	const hasRepoUrl = !!project?.repositoryUrl;

	// useCoAgent for streaming updates from LangGraph (AG-UI protocol).
	// Pass Teams integration state so the agent can autonomously fetch context via tools.
	//
	// `initialState` MUST be memoized: a fresh object literal on every render
	// causes CopilotKit / AG-UI to re-emit `agent/connect` handshakes, which on
	// top of integration-query re-renders sends dozens of redundant
	// /api/copilotkit POSTs per feature load and burns the per-user 500/min
	// rate-limit budget. It also forces <CopilotKit> to re-render its children,
	// flashing the title/action/save portals in the page header on cold load
	// and on nav-back — the bug the user reports as "4–5 flashes on first load".
	// Mirrors the fix applied to the document editor in PR #688.
	const initialAgentState = useMemo<AgentState>(
		() => ({
			document: "",
			hasTeamsIntegration: !!teamsMessagesData?.hasTeamsIntegration,
			hasSlackIntegration: !!slackMessagesData?.hasSlackIntegration,
			hasGitHubIntegration: hasRepoUrl,
			hasRepoIntegration: codeSearchEnabled && hasRepoUrl,
			projectId,
			userId: user?.id,
			organizationId: organizationId ?? undefined,
			// Declare so the outgoing state snapshot always carries
			// the key; the "Update Clean Spec" refresh flushSyncs it just before send.
			refreshSpecContexts: [],
			// Declare reasoningByTurn / toolCallsByTurn in initialState so
			// CopilotKit's useCoAgent doesn't filter them out of React state
			// updates. Mirrors DocumentEditor — without these keys, the
			// STATE_SNAPSHOT events that carry per-turn reasoning/tool-call
			// traces (PR #976/#1023/#1024) reach the SSE wire but are dropped
			// before CopilotAssistantMessage's useCoAgent subscription sees
			// them on the Stories Feature Assistant surface.
			reasoningByTurn: {},
			toolCallsByTurn: {},
		}),
		[
			teamsMessagesData?.hasTeamsIntegration,
			slackMessagesData?.hasSlackIntegration,
			hasRepoUrl,
			codeSearchEnabled,
			projectId,
			user?.id,
			organizationId,
		],
	);

	const {
		state: agentState,
		setState: setAgentState,
		nodeName,
	} = useCoAgent<AgentState>({
		name: "project_document_generator",
		initialState: initialAgentState,
	});

	// `useCoAgent` returns a new `setState` function every render, so listing it
	// in a useEffect dep array causes an infinite render loop. Stash the latest
	// reference in a ref and read through it from effects that only need to fire
	// when their *data* dependencies change. (Existing code below at the Fabric
	// Agent launcher also uses this pattern.)
	const setAgentStateRef = useRef(setAgentState);
	setAgentStateRef.current = setAgentState;

	// Mirror agentState into a ref so callbacks captured by the CopilotKit
	// renderer can read the latest value at *call time* rather than the value
	// the closure captured at render time. CopilotKit invokes the renderer
	// through `renderRef.current` which is updated in a useEffect (one render
	// behind), so reading agentState directly from the closure inside
	// handleAccept could otherwise see a streaming partial after a newer
	// snapshot has already committed to React state.
	const agentStateRef = useRef(agentState);
	agentStateRef.current = agentState;

	// Sync integration flags into agent state when their source queries resolve.
	// useCoAgent captures initialState at mount, but `ragSettings` / Teams / Slack
	// queries are async — without this effect the flags are stuck at the mount-time
	// defaults (typically all false), so code-search tools never bind even when the
	// "Enable code search for AI agents" toggle is on.
	// Partial update form (matches the pattern already used elsewhere in this file,
	// e.g. `setAgentState({ document: ... })`); the functional form requires a full
	// AgentState which we can't construct without the other ref-managed fields.
	useEffect(() => {
		setAgentStateRef.current({
			hasTeamsIntegration: !!teamsMessagesData?.hasTeamsIntegration,
			hasSlackIntegration: !!slackMessagesData?.hasSlackIntegration,
			hasGitHubIntegration: hasRepoUrl,
			hasRepoIntegration: codeSearchEnabled && hasRepoUrl,
		} as AgentState);
	}, [
		teamsMessagesData?.hasTeamsIntegration,
		slackMessagesData?.hasSlackIntegration,
		hasRepoUrl,
		codeSearchEnabled,
	]);

	// Initialize TipTap editor with advanced extensions
	const editor = useEditor(
		{
			extensions: advancedExtensions,
			immediatelyRender: false,
			editorProps: {
				attributes: {
					class: "p-6 tiptap min-h-[400px] focus:outline-none",
				},
				// Route image paste/drop through the shared S3 upload hook so the
				// description JSON stores `data-s3-key` references instead of
				// base64. The hook owns MIME/size validation, the 5-image cap,
				// friendly toasts, and telemetry — see `use-clipboard-image-paste.ts`.
				handlePaste: (_view, event) => handleImagePaste(event),
				handleDrop: (_view, event) => handleImageDrop(event),
			},
			content: fromMarkdown(currentDocument, USER_CONTENT_MD_OPTIONS),
			onUpdate: ({ editor: ed, transaction }) => {
				// Skip the synthetic onUpdate fired during TipTap's initial
				// mount as it parses + normalises the seed content.
				if (editorInitialMountRef.current) {
					editorInitialMountRef.current = false;
					return;
				}
				// Skip onUpdate fires that don't actually mutate the doc.
				// `editor.setEditable()` (called from Effect 1 when AI loading
				// flips) triggers an onUpdate event in TipTap even though the
				// content is unchanged — without this guard those synthetic
				// fires slip past the editable+loading checks and mark the
				// doc dirty as soon as CopilotKit's mount handshake settles.
				if (!transaction.docChanged) {
					return;
				}
				// Only track changes when editor is editable and not during AI updates,
				// prop syncs, or while the confirmation dialog is showing diff marks.
				// Read AI loading + awaiting-confirmation through refs so this guard
				// sees current values (the closure was sealed at first render).
				if (
					ed.isEditable &&
					!isAiLoadingRef.current &&
					!isSyncingFromPropRef.current &&
					!isAwaitingConfirmationRef.current
				) {
					setHasUnsavedChanges(true);
					// Clear existing auto-save timer
					if (autoSaveTimeoutRef.current) {
						clearTimeout(autoSaveTimeoutRef.current);
					}
					// Set new auto-save timer (10 seconds)
					autoSaveTimeoutRef.current = setTimeout(() => {
						triggerAutoSaveRef.current?.();
					}, 10000);
				}
			},
		},
		[],
	);

	/**
	 * Per-image upload pipeline for the StoryWorkspace TipTap editor.
	 * Mirrors `DocumentEditor.tsx`'s `handleImageUpload` (line 1762) but routes
	 * through `stories.createMediaUploadUrl` so the resulting S3 key sits under
	 * `story-media/{projectId}/{storyId}/...`.
	 *
	 * Flow per file:
	 *   1. Insert an `imageUpload` placeholder at the current selection so the
	 *      user sees an in-place spinner.
	 *   2. Run `uploadStoryImage` (validate → compress → presigned URL → S3 PUT).
	 *   3. Resolve the new key to a signed download URL.
	 *   4. Swap the placeholder for an `image` node with `data-s3-key` so the
	 *      editor JSON stores the key (no base64), and the reload-time
	 *      resolver effect can refresh the signed URL on every page load.
	 *   5. On failure, remove the placeholder and surface a `toast.error` (the
	 *      hook's friendly-toast layer also fires its own neutral fallback —
	 *      this one names the file).
	 *
	 * Honors the `AbortSignal` from the hook: when the StoryWorkspace unmounts
	 * mid-upload, the controller fires and the listener removes the placeholder
	 * + skips the placeholder→image swap.
	 */
	const handleStoryImageUpload = useCallback(
		async (file: File, signal: AbortSignal): Promise<void> => {
			if (!editor) {
				return;
			}
			if (signal.aborted) {
				return;
			}

			const uploadId = `upload_${Date.now()}_${Math.random()
				.toString(36)
				.slice(2, 8)}`;

			editor.commands.insertImageUpload({
				uploadId,
				filename: file.name,
				progress: 0,
				error: null,
			});

			const onAbort = (): void => {
				editor.commands.removeImageUpload(uploadId);
			};
			signal.addEventListener("abort", onAbort, { once: true });

			try {
				const s3Key = await uploadStoryImage({
					file,
					projectId,
					userStoryId: story.id,
					organizationId: organizationId ?? null,
					onProgress: (percent) => {
						if (signal.aborted) {
							return;
						}
						editor.commands.updateImageUpload(uploadId, {
							progress: percent,
						});
					},
				});

				if (signal.aborted) {
					return;
				}

				const urls = await resolveStoryImageUrls({
					projectId,
					userStoryId: story.id,
					organizationId: organizationId ?? null,
					s3Keys: [s3Key],
				});
				const signedUrl = urls[s3Key];

				if (signal.aborted) {
					return;
				}

				// Remove placeholder and insert the persisted image node in one
				// transaction. We call `insertContent` (not `setImage`) because
				// `setImage` advances the cursor past the new node, so a follow-up
				// `updateAttributes` would target the wrong node.
				editor.commands.removeImageUpload(uploadId);
				if (signedUrl) {
					editor
						.chain()
						.focus()
						.insertContent({
							type: "image",
							attrs: {
								src: signedUrl,
								alt: file.name,
								width: "50%",
								"data-s3-key": s3Key,
							},
						})
						.run();
				}
			} catch (error) {
				const message =
					error instanceof Error ? error.message : "Upload failed";
				editor.commands.updateImageUpload(uploadId, {
					error: message,
					progress: 0,
				});
				// Surface a toast that names the file so the user can correlate
				// failures across multiple parallel uploads. The hook's own
				// network toast still fires for the generic case.
				toast.error(`Failed to upload ${file.name}: ${message}`);
				// Re-throw so the hook classifies + emits its `[PasteImage] …
				// status=error errorCode=upload_failed` telemetry line.
				throw error;
			} finally {
				signal.removeEventListener("abort", onAbort);
			}
		},
		[editor, projectId, story.id, organizationId],
	);

	// Keep the ref in sync so the stable wrapper passed to `useClipboardImagePaste`
	// always sees the latest closure (with the up-to-date `editor` instance).
	imageUploaderRef.current = handleStoryImageUpload;

	// Re-resolve expired story-media S3 signed URLs on mount and whenever the
	// editor instance changes. Signed URLs expire after 1 hour, so loading a
	// story with previously-uploaded images requires a fresh resolve. Mirrors
	// `DocumentEditor.tsx:1713` for the story-media keyspace.
	useEffect(() => {
		if (!editor) {
			return;
		}
		let cancelled = false;
		const resolveUrls = async (): Promise<void> => {
			const editorDom = editor.view.dom;
			const images = editorDom.querySelectorAll("img[src]");
			const keyMap = new Map<string, HTMLImageElement[]>();
			// Anchors carrying `data-s3-key` are file attachments pulled from a
			// PM tool — refresh their `href` the same way images refresh `src`.
			const anchorMap = new Map<string, HTMLAnchorElement[]>();
			for (const img of images) {
				const src = img.getAttribute("src") || "";
				// Handles bare markdown (`story-media/...`), root-relative
				// (`/story-media/...`), and signed-URL (`https://.../story-media/...?Sig`)
				// shapes. See `extractStoryS3KeyFromImgSrc` for the contract +
				// tests.
				const key = extractStoryS3KeyFromImgSrc(src);
				if (key) {
					if (!keyMap.has(key)) {
						keyMap.set(key, []);
					}
					keyMap.get(key)?.push(img as HTMLImageElement);
				}
			}
			for (const a of editorDom.querySelectorAll("a[data-s3-key]")) {
				const key = a.getAttribute("data-s3-key") || "";
				if (!key.startsWith("story-media/")) {
					continue;
				}
				if (!keyMap.has(key)) {
					keyMap.set(key, []);
				}
				if (!anchorMap.has(key)) {
					anchorMap.set(key, []);
				}
				anchorMap.get(key)?.push(a as HTMLAnchorElement);
			}
			// Also check editor JSON for keys referenced as `data-s3-key`
			// (extracted via the shared helper) so newly-loaded content with
			// only the data attribute and no resolved src still gets refreshed.
			const html = editor.getHTML();
			for (const key of extractStoryS3KeysFromContent(html)) {
				if (!keyMap.has(key)) {
					keyMap.set(key, []);
				}
			}
			if (keyMap.size === 0) {
				return;
			}
			try {
				const urls = await resolveStoryImageUrls({
					projectId,
					userStoryId: story.id,
					organizationId: organizationId ?? null,
					s3Keys: [...keyMap.keys()],
				});
				if (cancelled) {
					return;
				}
				for (const [key, imgEls] of keyMap) {
					const freshUrl = urls[key];
					if (!freshUrl) {
						continue;
					}
					for (const img of imgEls) {
						img.setAttribute("src", freshUrl);
					}
					for (const a of anchorMap.get(key) ?? []) {
						a.setAttribute("href", freshUrl);
					}
				}
			} catch (e) {
				console.error(
					"[StoryWorkspace] Failed to resolve story-media URLs:",
					e,
				);
			}
		};
		// Delay slightly to ensure editor content is rendered.
		const timer = setTimeout(resolveUrls, 500);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [editor, projectId, story.id, organizationId]);

	// Download-on-click for pulled file attachments (`<a data-s3-key download>`).
	// The Link extension uses `openOnClick:false` (links stay editable), so file
	// attachments wouldn't open on click — intercept clicks on data-s3-key
	// anchors and open the (signed) href so the file downloads. Images are
	// `<img>`, so this only targets file links.
	useEffect(() => {
		if (!editor) {
			return;
		}
		const dom = editor.view.dom;
		const onClick = (event: MouseEvent) => {
			const anchor = (event.target as HTMLElement | null)?.closest?.(
				"a[data-s3-key]",
			) as HTMLAnchorElement | null;
			const href = anchor?.getAttribute("href");
			if (!anchor || !href) {
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			window.open(href, "_blank", "noopener,noreferrer");
		};
		dom.addEventListener("click", onClick);
		return () => dom.removeEventListener("click", onClick);
	}, [editor]);

	// Broken images render a readable message instead of the browser's native
	// broken-image icon (Fizzy #2027). The pull ingester keeps unreachable PM
	// attachment URLs out of stored descriptions; the ImageLoadFallback
	// extension covers what it cannot — an expired signed URL, a storage blip,
	// a legacy stored description. Like the ingester's own "could not be
	// imported" placeholders (MediaImportPlaceholder), it is a decoration, so
	// the message never reaches the saved description.

	// === STREAMING PATTERN - REF-BASED TO FIX RACE CONDITIONS ===
	// The key insight: React state updates are async, but we need the baseline
	// IMMEDIATELY when streaming starts. Using refs ensures synchronous access.
	// See AGENTS.md for full documentation of this pattern.

	// Sync the AI-loading + awaiting-confirmation refs that the editor's
	// onUpdate guard reads (its closure is stale and doesn't see live state).
	useEffect(() => {
		isAiLoadingRef.current = isAiLoading;
	}, [isAiLoading]);
	useEffect(() => {
		isAwaitingConfirmationRef.current = isAwaitingConfirmation;
	}, [isAwaitingConfirmation]);

	// Confirm-time change summary trigger (v2 + agent-review only). Fire the
	// summarize mutation exactly ONCE per awaiting-confirmation cycle — guarded by
	// a ref so the frequently-re-running CopilotKit renderer can't re-trigger it.
	// `before` is the pre-stream baseline; `after` is the current editor markdown
	// with diff tags stripped. On the false transition (accept or reject) we clear
	// the bullets and reset the guard so the next review starts fresh.
	const summarizeTriggeredRef = useRef(false);
	useEffect(() => {
		if (!maturationV2) {
			return;
		}
		if (isAwaitingConfirmation) {
			if (summarizeTriggeredRef.current || !editor) {
				return;
			}
			summarizeTriggeredRef.current = true;
			const before = baselineRef.current || currentDocument;
			// Null means the serializer failed. Coercing to ""
			// would make `before === after` miss (since `before` is normally
			// non-empty), sending a "total deletion" summary to the AI whose
			// resulting bullets can later be persisted via
			// `recordChangeNoteMutation`. Bail instead of guessing.
			const after = getEditorMarkdownForSave(editor);
			if (after === null) {
				setPendingChangeBullets([]);
				return;
			}
			// Skip the round-trip when nothing actually changed.
			if (before === after) {
				setPendingChangeBullets([]);
				return;
			}
			summarizeChangesMutation.mutate({
				...maturationEditorInput,
				before,
				after,
			});
		} else {
			summarizeTriggeredRef.current = false;
			setPendingChangeBullets(null);
		}
	}, [
		isAwaitingConfirmation,
		maturationV2,
		editor,
		currentDocument,
		getEditorMarkdownForSave,
		summarizeChangesMutation,
		maturationEditorInput,
	]);

	// Effect 1: Capture baseline when loading STARTS (transition from false to true)
	useEffect(() => {
		// Only capture baseline on transition: wasLoading=false → isAiLoading=true
		if (isAiLoading && !wasLoadingRef.current && editor) {
			// The pending auto-save must not fire *during* AI review
			// (it would persist unconfirmed diff content) — but discarding it
			// threw away real user edits. Flush it first, then cancel.
			if (autoSaveTimeoutRef.current) {
				clearTimeout(autoSaveTimeoutRef.current);
				autoSaveTimeoutRef.current = null;
			}
			// Flush a pending edit rather than discarding it.
			//
			// Skip the flush while a save is already in flight (`handleSave`'s
			// own re-entrancy guard would no-op it anyway; checking here just
			// avoids the pointless call) — a manual Save immediately followed by
			// an AI request would otherwise double-submit: duplicate PATCH,
			// duplicate toast, and for Save & Close a spurious onClose() mid-review.
			//
			// Crucially, we must NOT clear `hasUnsavedChanges` here — in either
			// branch. In the skip-flush branch, the in-flight request carries an
			// older snapshot; anything typed after it was issued isn't in it. In
			// the flush branch, `handleSave` returning `true` only means the PATCH
			// was *kicked off* (or there was nothing to send), not that it landed;
			// clearing eagerly here raced the mutation — a failed save would leave
			// the flag false, and Effect 5 (already gated on `isAiLoading` for the
			// whole review) would then adopt the server version over the user's
			// text the moment the review ended. Every other clear site waits for
			// `onSuccess` (or restores on `onError`); this one now does too.
			const saveInFlight = updateMutationPendingRef.current;
			if (!saveInFlight && hasUnsavedChangesRef.current) {
				// Same reasoning as `triggerAutoSave` and the unmount
				// flush — this is a machine-triggered flush (the AI just started
				// loading), not an explicit user Save, so it must not silently
				// commit a pending `targetStage` dropdown selection.
				handleSaveRef.current?.({ includeStageTransition: false });
			}

			// Reset scroll tracking for new streaming session
			// This clears the "user scrolled away" flag so auto-scroll works
			resetScrollTracking();

			const baseline = getEditorMarkdownForSave(editor);
			// Null means serialization failed. Do NOT overwrite the
			// baseline/currentDocument with "" — Effect 3 treats an empty
			// baseline as "no prior content" and replaces the editor with the
			// AI's raw output unfiltered, and a later Reject would then restore
			// that empty string, wiping real content. Keep the last-known-good
			// baseline instead.
			if (baseline !== null) {
				baselineRef.current = baseline;
				// The ONLY write of the run-start ref — see its declaration for
				// why the pending-decisions splice cannot read `baselineRef`
				// here instead.
				runStartBaselineRef.current = baseline;
				setCurrentDocument(baseline); // Keep state in sync
			} else {
				toast.error(
					"Couldn't read the editor content to start this AI review — please retry.",
				);
			}
		}
		wasLoadingRef.current = isAiLoading;
		editor?.setEditable(!isAiLoading);
	}, [isAiLoading, editor]);

	// Effect 2: Final diff when nodeName becomes "end"
	// Uses baselineRef instead of currentDocument state
	useEffect(() => {
		const baseline = baselineRef.current;
		const newDocument = agentState?.document || "";
		if (nodeName === "end") {
			if (
				baseline.trim().length > 0 &&
				newDocument.trim().length > 0 &&
				baseline !== newDocument
			) {
				const diff = diffPartialText(baseline, newDocument, true);
				const markdown = fromMarkdown(diff);
				// Guard so the diff injection doesn't trigger onUpdate → auto-save
				isSyncingFromPropRef.current = true;
				editor?.commands.setContent(markdown);
				isSyncingFromPropRef.current = false;

				// Focus on the changed section
				focusOnAnchor(editor, agentState?.focusAnchor || "");
			}
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [nodeName, agentState?.document]);

	// Effect 3: Streaming diff during loading
	// CRITICAL: Uses baselineRef.current instead of currentDocument state
	useEffect(() => {
		if (isAiLoading) {
			const baseline = baselineRef.current;
			const newDocument = agentState?.document || "";

			if (baseline.trim().length === 0) {
				// No baseline - just show the new content without diff
				if (newDocument.trim().length > 0) {
					const markdown = fromMarkdown(newDocument);
					editor?.commands.setContent(markdown);
				}
				return;
			}

			if (newDocument.trim().length === 0 || newDocument === baseline) {
				return;
			}

			const diff = diffPartialText(baseline, newDocument);
			const markdown = fromMarkdown(diff);
			editor?.commands.setContent(markdown);

			// Follow the last diff element during streaming
			focusOnLastDiff(editor);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [agentState?.document, isAiLoading]);

	// Effect 4: Sync editor to state when not loading
	// Also updates baselineRef for the next streaming session
	// Skip when:
	// - context update is showing a diff (stripping diff tags would destroy the review)
	// - the editor still carries AI diff marks (a confirm_changes review is pending —
	//   stripping diff tags here would set baselineRef.current to the AI-applied
	//   content, so a subsequent Reject would restore the AI version instead of the
	//   user's pre-enhance original)
	useEffect(() => {
		if (
			!isAiLoading &&
			!isContextUpdateActiveRef.current &&
			editor &&
			!editorHasDiffMarks(editor)
		) {
			const markdownContent = getEditorMarkdownForSave(editor);
			// Null means serialization failed on this edit — skip
			// the sync rather than overwriting currentDocument/baselineRef with
			// "". Those values feed straight into raw-mode saves and AI diffing,
			// so silently corrupting them to empty would just relocate the
			// original data-loss bug one hop over.
			if (markdownContent !== null) {
				setCurrentDocument(markdownContent);
				baselineRef.current = markdownContent; // Keep ref in sync
				setAgentState({ document: markdownContent });
			}
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [editor?.state?.doc, isAiLoading]);

	// D2: clicking a confirm-time change-summary bullet scrolls the diff to the
	// referenced section and flashes it. Bullets are formatted "Section — change",
	// so the section is the prefix before the em-dash; we match it against the
	// editor's heading text (best-effort — a non-matching bullet is a no-op).
	const scrollDiffToSection = (bullet: string) => {
		if (!editor) {
			return;
		}
		const section = bullet.split(" — ")[0]?.trim().toLowerCase();
		if (!section) {
			return;
		}
		const dom = editor.view.dom as HTMLElement;
		const headings = Array.from(
			dom.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6"),
		);
		const target = headings.find((h) =>
			(h.textContent ?? "").trim().toLowerCase().startsWith(section),
		);
		if (!target) {
			return;
		}
		target.scrollIntoView({ behavior: "smooth", block: "center" });
		target.classList.add("maturation-section-flash");
		window.setTimeout(
			() => target.classList.remove("maturation-section-flash"),
			1600,
		);
	};

	// Effect 5: Sync editor when story prop changes externally (e.g. after enhance mutation refetch)
	useEffect(() => {
		const descChanged =
			story.description !== lastStoryDescriptionRef.current;
		const acChanged =
			story.acceptanceCriteria !== lastStoryAcceptanceCriteriaRef.current;
		// Never rebuild the editor from the story prop while an AI
		// edit/diff review is in flight — doing so wipes the derived inline diff
		// mid-review and turns Accept into a no-op (leaving the pending-decisions
		// appendix, so the "X decisions not added" banner never clears). See
		// `shouldDeferStoryPropSync` for the full rationale. After Accept,
		// `updateMutation` re-invalidates `stories.get` and this effect re-fires
		// to sync the accepted content.
		if (
			shouldDeferStoryPropSync({
				isAiLoading,
				isContextUpdateActive: isContextUpdateActiveRef.current,
				isAwaitingConfirmation: isAwaitingConfirmationRef.current,
				hasPendingDiffMarks: !!editor && editorHasDiffMarks(editor),
				hasUnsavedChanges: hasUnsavedChangesRef.current,
			})
		) {
			// Do NOT advance the last-seen refs here. Leaving them
			// stale is what lets this effect re-detect the change and adopt the
			// server version once `hasUnsavedChanges` flips false (that flag is in
			// the dependency array, so the transition re-runs this effect). If we
			// advanced them, `descChanged` would be false forever after and this
			// server version would never be adopted at all.
			return; // Don't sync during AI streaming, context update, pending diff review, or unsaved manual edits
		}

		if (descChanged || acChanged) {
			lastStoryDescriptionRef.current = story.description;
			lastStoryAcceptanceCriteriaRef.current = story.acceptanceCriteria;

			const newContent = buildInitialContent();
			setCurrentDocument(newContent);
			baselineRef.current = newContent;
			// The adopted content is what the server holds, so
			// treat it as the last-saved snapshot too — otherwise a later
			// handleReject could compare against a stale ref and report
			// dirty for content that matches the server exactly.
			//
			// Note: `newContent` is `buildInitialContent()` shape, not the
			// Turndown shape (`getEditorMarkdownForSave` output) every other
			// writer of this ref uses — see the seeding comment near
			// `lastSavedMarkdownRef`'s declaration above for why that's safe
			// (fails toward false-dirty, only affects `handleReject`).
			lastSavedMarkdownRef.current = newContent;
			setAgentState({ document: newContent });

			if (editor) {
				// Guard: suppress onUpdate from triggering auto-save for this programmatic update
				isSyncingFromPropRef.current = true;
				editor.commands.setContent(
					fromMarkdown(newContent, USER_CONTENT_MD_OPTIONS),
				);
				isSyncingFromPropRef.current = false;
			}

			// Content matches what's in the DB — no unsaved changes
			setHasUnsavedChanges(false);
			if (autoSaveTimeoutRef.current) {
				clearTimeout(autoSaveTimeoutRef.current);
				autoSaveTimeoutRef.current = null;
			}
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [
		story.description,
		story.acceptanceCriteria,
		isAiLoading,
		editor,
		hasUnsavedChanges,
	]);

	// Register this editor as the active document surface so the Fabric Agent
	// launcher can push content into it via "Apply to document".
	// `setAgentStateRef` is hoisted earlier so both this effect and the integration
	// flag sync effect share a single ref.
	const { registerDocumentEditor } = useFabricAgentLauncher();
	useEffect(() => {
		if (!editor) {
			return;
		}
		return registerDocumentEditor((content: string) => {
			editor.commands.setContent(fromMarkdown(content));
			setAgentStateRef.current({ document: content });
			setHasUnsavedChanges(true);
		});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [editor, registerDocumentEditor]);

	// Register this editor with the Excalidraw auto-insert resolver
	// registry so the chat button can target it when it produces an
	// `<excalidraw-embed>` insert request. See spec §9 (active-editor
	// resolution algorithm). `useRegisterTiptapEditor` is a no-op while
	// `editor` is null (still booting). Lives alongside the
	// `registerDocumentEditor` block above intentionally — both register
	// the same editor for different downstream consumers.
	useRegisterTiptapEditor({
		projectId,
		kind: "story",
		storyId: story.id,
		editor,
	});

	// Consume any pending picker intent the chat may have stashed in
	// sessionStorage before navigating to this feature. Runs AFTER the
	// registration above (next animation frame) so the registry has the
	// live editor by the time the insertion fires. `kind: "story"` is
	// HARDCODED here -- making it configurable would let an intent leak
	// across page navigations.
	usePickerIntentConsumer({
		editor,
		projectId,
		kind: "story",
		storyId: story.id,
		documentLabel: `${story.identifier} ${story.title}`,
	});

	// Parse content back to description and acceptance criteria.
	// Splits only on `## Acceptance Criteria` — anything before stays in
	// description verbatim, preserving rich content like a stage-enhance
	// `# Passive Analysis: ...` preamble. See lib/story-content.ts.
	const parseContent = useCallback(
		(markdown: string) => parseStoryContent(markdown),
		[],
	);

	// Update with context — in-editor diff flow (same UX as AI Feature Assistant)
	const contextUpdate = useUpdateWithContext({
		projectId,
		storyId: story.id,
		organizationId: organizationId ?? null,
		editor,
		parseContent,
		getEditorMarkdownForSave,
		fromMarkdown,
		diffPartialText,
		onSaved: () => {
			queryClient.invalidateQueries({ queryKey: storyGetQueryKey });
			queryClient.invalidateQueries({ queryKey: storiesListQueryKey });
			onStoryUpdated?.();
		},
	});
	// Keep ref in sync so Effects 4 & 5 (declared above) can read it
	isContextUpdateActiveRef.current = contextUpdate.isActive;

	// Diff review-mode toggle (inline / side-by-side / full preview). Pure view
	// state — switching never mutates the editor doc or the pending diff.
	const isDiffReviewActive =
		isAwaitingConfirmation || contextUpdate.showingDiff;
	const {
		diffViewMode,
		setDiffViewMode,
		diffViews,
		effectiveDiffViewMode,
		showDiffPreviewPanes,
	} = useDiffPreview(editor, isDiffReviewActive);

	// F-171: Re-evaluate Bug mutation (REQ-13, REQ-7, AC6, AC14). Replaces
	// the generic "Update using context" button on bug detail pages. Runs
	// the bug_reanalysis prompt server-side, persists the updated markdown
	// + re-evaluated needsMoreInfo, and refreshes the story view. No diff
	// preview (one-click action — user already added context to the
	// description before clicking).
	const reevaluateBugMutation = useMutation({
		mutationFn: async () => {
			return await orpcClient.projects.stories.reevaluateBug({
				projectId,
				storyId: story.id,
				organizationId: organizationId ?? null,
			});
		},
		onSuccess: (data) => {
			toast.success(
				data.needsMoreInfo
					? "Re-evaluated — still needs more info"
					: "Re-evaluated — ready to act on",
			);
			queryClient.setQueryData(maturationEditorKey, (old: any) => {
				if (!old?.feature) {
					return old;
				}
				return {
					...old,
					feature: {
						...old.feature,
						lastContextUpdateAt: new Date().toISOString(),
					},
				};
			});
			queryClient.invalidateQueries({ queryKey: storyGetQueryKey });
			queryClient.invalidateQueries({ queryKey: storiesListQueryKey });
			onStoryUpdated?.();
		},
		onError: (error) => {
			toast.error(
				error instanceof Error ? error.message : "Re-evaluation failed",
			);
		},
	});

	// Block / Unblock control. Mirrors `needsMoreInfo`: a manual marker that the
	// work item is blocked, with an optional reason shown on the chip's hover.
	// The backend records the change in the work item's version history.
	const [blockPopoverOpen, setBlockPopoverOpen] = useState(false);
	const [blockReason, setBlockReason] = useState("");
	const setBlockedMutation = useMutation({
		mutationFn: async (vars: { blocked: boolean; reason?: string }) => {
			return await orpcClient.projects.stories.setBlocked({
				projectId,
				storyId: story.id,
				organizationId: organizationId ?? null,
				blocked: vars.blocked,
				reason: vars.reason,
			});
		},
		onSuccess: (data) => {
			toast.success(
				data.blocked ? "Blocked status saved" : "Work item unblocked",
			);
			setBlockPopoverOpen(false);
			setBlockReason("");
			queryClient.invalidateQueries({ queryKey: storyGetQueryKey });
			queryClient.invalidateQueries({ queryKey: storiesListQueryKey });
			// Keep the Security & Accessibility findings view in sync — its
			// "Block F-XXX" / "Blocked → F-XXX" chip reads the story's blocked
			// state, so it would otherwise go stale after a detail-page change.
			queryClient.invalidateQueries({
				queryKey: orpc.projects.scan.findings.list.key(),
			});
			onStoryUpdated?.();
		},
		onError: (error) => {
			toast.error(
				error instanceof Error
					? error.message
					: "Failed to update blocked status",
			);
		},
	});

	// F-171: convert-type mutation (REQ-11, AC10). Same shape as the
	// StoryCard kebab handler — flips kind and snaps stage to DRAFT.
	//
	// Fizzy #2048: it now also starts an asynchronous redraft of the body
	// through the new type's template. The mutation resolving means the TYPE
	// changed, nothing more; the rewrite is followed below.
	const [convertDialogOpen, setConvertDialogOpen] = useState(false);
	const targetConvertKind: "BUG" | "FEATURE" =
		story.kind === "BUG" ? "FEATURE" : "BUG";

	/**
	 * Detail-view progress for that redraft.
	 *
	 * `alwaysWatch` — this view renders exactly one work item, so following it
	 * unconditionally costs one request, and it is the surface a user comes
	 * BACK to while the rewrite is still running. Reading the persisted job row
	 * rather than a `useState` set at confirmation time is the only reason that
	 * return shows anything at all.
	 *
	 * On completion the story read is invalidated; Effect 5 then adopts the new
	 * description / acceptance criteria into the editor, so the regenerated
	 * body appears without a manual reload.
	 */
	const invalidateAfterRegeneration = useInvalidateStoryAfterRegeneration(
		projectId,
		story.id,
		organizationId ?? null,
	);
	const regeneration = useStoryKindRegeneration({
		projectId,
		storyId: story.id,
		organizationId: organizationId ?? null,
		alwaysWatch: true,
		onCompleted: () => {
			void invalidateAfterRegeneration();
			onStoryUpdated?.();
		},
		onFailed: () => {
			// The body is unchanged, but the kind and stage on the row are not
			// — refresh so the chrome stops describing the previous type.
			void invalidateAfterRegeneration();
			onStoryUpdated?.();
		},
	});

	/**
	 * The body is read-only from the moment a redraft is in flight until it
	 * reaches a terminal state.
	 *
	 * Without this the user can keep typing into a description that is about to
	 * be replaced under them. (U5's activity writes under an optimistic version
	 * guard, so the manual edit would actually win and the redraft would be
	 * discarded — the outcome is not data loss, but an editable field that may
	 * be swapped out mid-sentence is still the wrong thing to offer.)
	 *
	 * A separate effect rather than a change to Effect 1's `setEditable` call:
	 * this one is declared after the regeneration hook, so it runs last and its
	 * answer wins whenever both fire.
	 */
	useEffect(() => {
		editor?.setEditable(!isAiLoading && !regeneration.isBodyLocked);
	}, [editor, isAiLoading, regeneration.isBodyLocked]);

	const convertKindMutation = useMutation({
		mutationFn: async () => {
			return await orpcClient.projects.stories.convertKind({
				projectId,
				storyId: story.id,
				organizationId: organizationId ?? null,
				targetKind: targetConvertKind,
			});
		},
		onSuccess: (result) => {
			// Previously "Converted to bug" — an assertion that the conversion
			// was done, fired at the moment the rewrite had not yet begun.
			toast.success(
				targetConvertKind === "BUG"
					? tConvertKind("startedBug")
					: tConvertKind("startedFeature"),
				{ description: tConvertKind("startedDescription") },
			);
			setConvertDialogOpen(false);
			if (result?.regeneration?.workflowId) {
				watchStoryKindRegeneration(story.id);
			}
			queryClient.invalidateQueries({ queryKey: storyGetQueryKey });
			queryClient.invalidateQueries({ queryKey: storiesListQueryKey });
			onStoryUpdated?.();
		},
		onError: (error) => {
			toast.error(
				error instanceof Error ? error.message : "Failed to convert",
			);
		},
	});

	// Update story mutation with optimistic updates
	const updateMutation = useMutation({
		mutationFn: async (data: {
			title?: string;
			description?: string | null;
			acceptanceCriteria?: string | null;
			priority?: "P0_CRITICAL" | "P1_HIGH" | "P2_MEDIUM" | "P3_LOW";
			size?: "XS" | "S" | "M" | "L" | "XL" | null;
			storyPoints?: number | null;
			draftingStage?: FeatureDraftingStage;
			maturationStatus?: MaturationStatus | null;
			isContextUpdate?: boolean;
		}) => {
			return await orpcClient.projects.stories.update({
				projectId,
				storyId: story.id,
				organizationId: organizationId ?? null,
				...data,
			});
		},
		onMutate: async (variables) => {
			await queryClient.cancelQueries({ queryKey: storyGetQueryKey });
			await queryClient.cancelQueries({ queryKey: storiesListQueryKey });

			const previousStory = queryClient.getQueryData(storyGetQueryKey);
			const previousList = queryClient.getQueryData(storiesListQueryKey);
			const previousMaturation =
				queryClient.getQueryData(maturationEditorKey);

			if (variables.isContextUpdate) {
				queryClient.setQueryData(maturationEditorKey, (old: any) => {
					if (!old?.feature) {
						return old;
					}
					return {
						...old,
						feature: {
							...old.feature,
							lastContextUpdateAt: new Date().toISOString(),
						},
					};
				});
			}

			queryClient.setQueryData(storyGetQueryKey, (old: any) => {
				if (!old?.story) {
					return old;
				}
				return {
					...old,
					story: {
						...old.story,
						...variables,
					},
				};
			});

			return { previousStory, previousList, previousMaturation };
		},
		onError: (error, _variables, context) => {
			if (context?.previousStory) {
				queryClient.setQueryData(
					storyGetQueryKey,
					context.previousStory,
				);
			}
			if (context?.previousList) {
				queryClient.setQueryData(
					storiesListQueryKey,
					context.previousList,
				);
			}
			if (context?.previousMaturation !== undefined) {
				queryClient.setQueryData(
					maturationEditorKey,
					context.previousMaturation,
				);
			}
			isManualSaveRef.current = false;
			// Count the failure BEFORE deciding whether to toast, so the
			// conflict suppression below and the re-arm cap read the same number.
			saveFailureCountRef.current += 1;
			// A lost optimistic-concurrency race (oRPC CONFLICT) is not a failure
			// worth alarming the user about: the row moved under this save —
			// typically the AI assistant writing the same feature while autosave
			// was in flight — nothing was written, and the re-arm below retries
			// against the fresh version and succeeds. Surfaced every time, a normal
			// editing session with the assistant open produced a stream of red
			// "Failed to save story" toasts for saves that then went through.
			// Still surfaced once the retry budget is spent, because a conflict
			// that will not clear is a real problem the user has to know about.
			const isVersionConflict = getOrpcCode(error) === "CONFLICT";
			if (
				!isVersionConflict ||
				saveFailureCountRef.current > MAX_AUTO_SAVE_RETRIES
			) {
				toast.error("Failed to save story", {
					description: error.message,
				});
			}
			// A failed save must not leave the editor reading
			// clean — whatever this call sent never reached the server, and
			// anything typed since is definitely not there either. This fires
			// for ANY failed `updateMutation` — e.g. a title-only save with a
			// clean description also sets this — over-reporting dirty in that
			// case. That's deliberate: failing safe (re-showing dirty and
			// re-arming autosave) is preferable to risking a silent wedge.
			setHasUnsavedChanges(true);
			// Without re-arming, a failed save leaves no pending
			// autosave — the timer that led here already fired and won't fire
			// again — so the doc would sit dirty until the user types again.
			// Same wedge as the `isSavingRef` guard above; see that comment.
			//
			// Bounded on two axes (see `isMountedRef` / `saveFailureCountRef`
			// declarations above for the full rationale): skip the re-arm
			// entirely once the component has unmounted (nothing left to save
			// for), and once `MAX_AUTO_SAVE_RETRIES` consecutive failures have
			// piled up (a live but permanently-failing save shouldn't retry —
			// and therefore toast — forever either).
			if (
				isMountedRef.current &&
				saveFailureCountRef.current <= MAX_AUTO_SAVE_RETRIES
			) {
				if (autoSaveTimeoutRef.current) {
					clearTimeout(autoSaveTimeoutRef.current);
				}
				autoSaveTimeoutRef.current = setTimeout(() => {
					// Re-check on fire, not just at arm time — the
					// component can unmount during the 10s window between
					// scheduling this timer and it firing.
					if (!isMountedRef.current) {
						return;
					}
					triggerAutoSaveRef.current?.();
				}, 10000);
			}
			setIsSaving(false);
		},
		onSuccess: () => {
			// A successful save clears the consecutive-failure
			// streak `onError` counts against `MAX_AUTO_SAVE_RETRIES` — the
			// cap bounds a run of failures, not the cumulative total.
			saveFailureCountRef.current = 0;
			toast.success("Story saved");
			// Confirming `lastSavedMarkdownRef` / re-deriving
			// `hasUnsavedChanges` used to happen here, reading a shared
			// `pendingSaveContentRef` written by whichever `mutate()` call
			// happened to run last — a race when two saves overlapped (see
			// `lastSavedMarkdownRef`'s declaration comment above). Each
			// `mutate()` call site now does this itself, from a per-call
			// `onSuccess` closure that captures its own snapshot.
			setTargetStage("");
			queryClient.invalidateQueries({
				queryKey: orpc.projects.stories.versions.list.queryKey({
					input: {
						projectId,
						storyId: story.id,
						organizationId,
					},
				}),
			});
			if (isManualSaveRef.current) {
				isManualSaveRef.current = false;
				onClose();
			}
			triggerMaturationSeedAfterApply();
			onStoryUpdated?.();
		},
		onSettled: () => {
			setIsSaving(false);
			queryClient.invalidateQueries({ queryKey: storiesListQueryKey });
		},
	});
	// Keep the ref in sync so Effect 1 (declared above, before this mutation
	// exists) can read the latest pending state without being listed in its
	// own dependency array.
	updateMutationPendingRef.current = updateMutation.isPending;

	const [isAiMode, setIsAiMode] = useState(false);
	const [aiResult, setAiResult] = useState<AiReadinessData | null>(null);

	const isAiModeRef = useRef(isAiMode);
	isAiModeRef.current = isAiMode;
	const requestGenRef = useRef(0);

	const evaluateAiReadinessMutation = useMutation(
		orpc.projects.stories.maturation.evaluateAiReadiness.mutationOptions(
			{},
		),
	);

	const handleToggleAiMode = (enabled: boolean) => {
		setIsAiMode(enabled);
		if (enabled && !aiResult) {
			const currentGen = ++requestGenRef.current;
			evaluateAiReadinessMutation.mutate(
				{
					projectId,
					storyId: story.id,
					organizationId: organizationId ?? null,
				},
				{
					onSuccess: (data) => {
						if (
							isAiModeRef.current &&
							currentGen === requestGenRef.current
						) {
							setAiResult(data.aiReadiness);
						}
					},
					onError: (error) => {
						if (currentGen === requestGenRef.current) {
							setIsAiMode(false);
							setAiResult(null);
							toast.error("AI Readiness unavailable", {
								description:
									error.message ||
									"Falling back to Spec Readiness mode.",
							});
						}
					},
				},
			);
		}
	};

	const lastEditedAtTimestamp = story.lastEditedAt
		? new Date(story.lastEditedAt).getTime()
		: 0;

	// The readiness recency signal asks whether the SPEC is fresh, and an
	// AI/context rebuild stamps `lastContextUpdateAt` without touching the
	// ticket's edit event. Fall back to that edit event, then to creation, so a
	// feature that was never rebuilt still scores on its own activity.
	const specRecencyAt =
		maturationData?.feature?.lastContextUpdateAt ??
		story.lastEditedAt ??
		story.createdAt;

	// Clear the assessment whenever scoreable content or the selected rubric
	// changes. A kind conversion can preserve the text and edit timestamp, so it
	// must invalidate independently to avoid showing a FEATURE score on a BUG (or
	// vice versa) until another edit happens.
	useEffect(() => {
		requestGenRef.current++;
		setAiResult(null);
		setIsAiMode(false);
	}, [
		story.kind,
		story.description,
		story.acceptanceCriteria,
		lastEditedAtTimestamp,
	]);

	// Maturation V2 status picker. A dedicated mutation — deliberately NOT the
	// full `updateMutation` — because that one's onSuccess clears
	// `hasUnsavedChanges`/`targetStage` and toasts "Story saved", which would
	// corrupt the editor's dirty-state (and silently shadow a pending
	// description edit) when the user picks a status mid-edit. This writes only
	// the dummy label: optimistic cache update for snappy UI + list invalidate,
	// nothing else.
	const maturationStatusMutation = useMutation({
		mutationFn: async ({
			maturationStatus,
			draftingStage,
			coverageOverrideReason,
		}: {
			maturationStatus?: MaturationStatus;
			draftingStage?: FeatureDraftingStage;
			coverageOverrideReason?: string;
		}) => {
			return await orpcClient.projects.stories.update({
				projectId,
				storyId: story.id,
				organizationId: organizationId ?? null,
				maturationStatus,
				draftingStage,
				coverageOverrideReason,
			});
		},
		onMutate: async ({ maturationStatus, draftingStage }) => {
			await queryClient.cancelQueries({ queryKey: storyGetQueryKey });
			const previousStory = queryClient.getQueryData(storyGetQueryKey);
			queryClient.setQueryData(storyGetQueryKey, (old: any) => {
				if (!old?.story) {
					return old;
				}
				return {
					...old,
					story: {
						...old.story,
						...(maturationStatus ? { maturationStatus } : {}),
						...(draftingStage ? { draftingStage } : {}),
					},
				};
			});
			return { previousStory };
		},
		onError: (error, variables, context) => {
			if (context?.previousStory) {
				queryClient.setQueryData(
					storyGetQueryKey,
					context.previousStory,
				);
			}
			// The coverage refusal is answerable — it asks for a reason — so it
			// opens the dialog that collects one instead of a dead-end toast.
			const blocked = coverageBlockFromError(error);
			if (blocked) {
				lastMaturationVariablesRef.current = {
					maturationStatus: variables.maturationStatus,
					draftingStage: variables.draftingStage,
				};
				setCoverageBlock(blocked);
				return;
			}
			toast.error("Failed to update status", {
				description: error.message,
			});
		},
		onSuccess: () => {
			// Closes the override dialog on the retry that carried the reason.
			setCoverageBlock(null);
		},
		onSettled: () => {
			queryClient.invalidateQueries({ queryKey: storiesListQueryKey });
			queryClient.invalidateQueries({ queryKey: storyGetQueryKey });
			onStoryUpdated?.();
		},
	});

	// Toggle task mutation with optimistic update
	const toggleTaskMutation = useMutation({
		mutationFn: async (taskId: string) => {
			return await orpcClient.projects.stories.tasks.toggle({
				projectId,
				storyId: story.id,
				taskId,
			});
		},
		onMutate: async (taskId) => {
			setTasks((prev) =>
				prev.map((t) =>
					t.id === taskId ? { ...t, isCompleted: !t.isCompleted } : t,
				),
			);
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: storiesListQueryKey });
			onStoryUpdated?.();
		},
		onError: (error, taskId) => {
			setTasks((prev) =>
				prev.map((t) =>
					t.id === taskId ? { ...t, isCompleted: !t.isCompleted } : t,
				),
			);
			toast.error("Failed to toggle task", {
				description: error.message,
			});
		},
	});

	// Create task mutation with optimistic update
	const createTaskMutation = useMutation({
		mutationFn: async (taskTitle: string) => {
			return await orpcClient.projects.stories.tasks.create({
				projectId,
				storyId: story.id,
				title: taskTitle,
			});
		},
		onMutate: async (taskTitle) => {
			const tempTask: StoryTask = {
				id: `temp-${Date.now()}`,
				identifier: "TASK-???",
				title: taskTitle,
				description: null,
				isCompleted: false,
				order: tasks.length,
				estimatedHours: null,
			};
			setTasks((prev) => [...prev, tempTask]);
			return { tempTask };
		},
		onSuccess: (data, _taskTitle, context) => {
			if (data?.task) {
				setTasks((prev) =>
					prev.map((t) =>
						t.id === context?.tempTask.id
							? {
									id: data.task.id,
									identifier: data.task.identifier,
									title: data.task.title,
									description: data.task.description,
									isCompleted: data.task.isCompleted,
									order: data.task.order,
									estimatedHours: data.task.estimatedHours,
								}
							: t,
					),
				);
			}
			queryClient.invalidateQueries({ queryKey: storiesListQueryKey });
			toast.success("Task added");
			onStoryUpdated?.();
		},
		onError: (error, _taskTitle, context) => {
			if (context?.tempTask) {
				setTasks((prev) =>
					prev.filter((t) => t.id !== context.tempTask.id),
				);
			}
			toast.error("Failed to add task", {
				description: error.message,
			});
		},
	});

	// Generate tasks with AI mutation
	const generateTasksMutation = useMutation({
		mutationFn: async () => {
			return await orpcClient.projects.stories.generateTasks({
				projectId,
				storyId: story.id,
				organizationId: organizationId ?? null,
			});
		},
		onSuccess: (data) => {
			queryClient.invalidateQueries({ queryKey: storiesListQueryKey });
			toast.success(`Generated ${data?.tasksCreated ?? 0} tasks with AI`);
			onStoryUpdated?.();
			setIsGeneratingTasks(false);
		},
		onError: (error) => {
			toast.error("Failed to generate tasks", {
				description: error.message,
			});
			setIsGeneratingTasks(false);
		},
	});

	// Enhance drafting stage mutation
	const enhanceMutation = useMutation({
		mutationFn: async ({
			stage,
			promptId,
		}: {
			stage: FeatureDraftingStage;
			promptId?: string;
		}) => {
			return await orpcClient.projects.stories.enhance({
				projectId,
				storyId: story.id,
				organizationId: organizationId ?? null,
				targetStage: stage,
				promptId,
			});
		},
		onSuccess: (data) => {
			queryClient.invalidateQueries({
				queryKey: orpc.projects.stories.get.queryKey({
					input: { projectId, storyId: story.id, organizationId },
				}),
			});
			// Refresh the maturation editor so the "Changes from this run" card,
			// summary digest, and questions re-hydrate after a stage advance /
			// Enhance. No-op for v1 (the query isn't mounted there).
			invalidateMaturationEditor();
			toast.success(
				data?.aiEnhanced
					? `${story.kind === "BUG" ? "Bug" : "Feature"} enhanced with AI`
					: "Drafting stage updated",
			);
			setShowTransitionDialog(false);
			onStoryUpdated?.();
		},
		onError: (error) => {
			toast.error("Failed to update drafting stage", {
				description: error.message,
			});
		},
	});

	// Update stage with version mutation (used by CopilotKit confirm flow)
	const updateStageWithVersionMutation = useMutation({
		mutationFn: async (data: {
			targetStage: FeatureDraftingStage;
			description: string | null;
			acceptanceCriteria: string | null;
		}) => {
			return await orpcClient.projects.stories.updateStageWithVersion({
				projectId,
				storyId: story.id,
				organizationId: organizationId ?? null,
				targetStage: data.targetStage,
				description: data.description,
				acceptanceCriteria: data.acceptanceCriteria,
			});
		},
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: orpc.projects.stories.get.queryKey({
					input: { projectId, storyId: story.id, organizationId },
				}),
			});
			queryClient.invalidateQueries({ queryKey: storiesListQueryKey });
			toast.success(
				`${story.kind === "BUG" ? "Bug" : "Feature"} enhanced and stage updated`,
			);
			triggerMaturationSeedAfterApply();
			onStoryUpdated?.();
		},
		onError: (error) => {
			// The stage write is version-guarded now, so it can come back as a
			// CONFLICT when an autosave landed on the same row while the AI work
			// was running. That used to be a silent overwrite, and the message
			// has to say what actually happened rather than read as a failure of
			// the enhancement itself — the user's content is intact on both
			// sides, and reloading shows them the newer copy.
			if (getOrpcCode(error) === "CONFLICT") {
				toast.error("This feature changed while the AI was working", {
					description:
						"Your stage change was not applied, and nothing was overwritten. Reload to pick up the newer version and try again.",
				});
				return;
			}
			toast.error("Failed to update stage", {
				description: error.message,
			});
		},
	});

	const storyDetailQueryKey = orpc.projects.stories.get.queryKey({
		input: { projectId, storyId: story.id, organizationId },
	});

	// Regenerate AI title mutation. The server already absorbs the fallback
	// chain so failures are vanishingly rare — handle them with the same calm
	// toast as the success case.
	const regenerateTitleMutation = useMutation({
		mutationFn: async () => {
			return await orpcClient.projects.stories.regenerateTitle({
				projectId,
				storyId: story.id,
				organizationId: organizationId ?? null,
			});
		},
		onSuccess: (data) => {
			setTitle(data.title);
			toast.success(tWorkspace("regenerateTitleSuccess"));
			queryClient.invalidateQueries({ queryKey: storyDetailQueryKey });
			queryClient.invalidateQueries({ queryKey: storiesListQueryKey });
			onStoryUpdated?.();
		},
		onError: (error) => {
			toast.error("Failed to regenerate title", {
				description: error.message,
			});
		},
	});

	// Delete task mutation
	const deleteTaskMutation = useMutation({
		mutationFn: async (taskId: string) => {
			return await orpcClient.projects.stories.tasks.delete({
				projectId,
				storyId: story.id,
				taskId,
			});
		},
		onMutate: async (taskId) => {
			const previousTasks = [...tasks];
			setTasks((prev) => prev.filter((t) => t.id !== taskId));
			return { previousTasks };
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: storiesListQueryKey });
			toast.success("Task deleted");
			onStoryUpdated?.();
		},
		onError: (error, _taskId, context) => {
			if (context?.previousTasks) {
				setTasks(context.previousTasks);
			}
			toast.error("Failed to delete task", {
				description: error.message,
			});
		},
	});

	// Auto-save function — bail if AI is loading or confirmation dialog is open
	const triggerAutoSave = useCallback(() => {
		if (!hasUnsavedChanges || isAiLoading || isAwaitingConfirmation) {
			return;
		}
		// `targetStage` is a *pending* selection from the drafting
		// stage dropdown — its only confirmed job today is arming the Enhance
		// button. Autosave firing 10s after the user merely opens that dropdown
		// must not silently commit a workflow stage transition (create a story
		// version, fire the maturation seed, toast "Story saved" — possibly on
		// a page the user has since navigated away from). Only an explicit
		// Save commits the stage.
		handleSave({ includeStageTransition: false });
	}, [hasUnsavedChanges, isAiLoading, isAwaitingConfirmation]);

	// Expose the latest `triggerAutoSave` to the sealed `onUpdate`
	// closure via `triggerAutoSaveRef` (declared above, before this function
	// exists) — see that declaration's comment for why the direct call was a
	// no-op.
	triggerAutoSaveRef.current = triggerAutoSave;

	// Handle save
	// Returns `false` only when the flush bailed (serializer
	// failure — nothing was saved and nothing was sent). Returns `true` when
	// there was nothing to save, a save was successfully kicked off, *or* the
	// re-entrancy guard below bailed because a save was already in flight —
	// that last case is NOT distinguishable from "saved fine" by the return
	// value alone. Nothing currently branches on the distinction: Effect 1
	// stopped reading this return value (see its own call site) and the other
	// callers (Ctrl/Cmd+S, the Save buttons, the unmount flush) are
	// fire-and-forget. If a future caller needs to know "did this actually
	// persist", don't infer it from this boolean.
	const handleSave = useCallback(
		({
			includeStageTransition = true,
		}: {
			includeStageTransition?: boolean;
		} = {}): boolean => {
			// Re-entrancy guard. Without it, the 10s autosave firing
			// while a manual Ctrl+S (or vice versa) is still in flight kicks off a
			// second overlapping `updateMutation.mutate` — the root cause of the
			// concurrent-save race (two in-flight PATCHes, each confirming its own
			// snapshot out of order). The Save buttons already disable on
			// `isSaving`; this closes the same gap for the autosave timer and the
			// Ctrl/Cmd+S shortcut, which don't go through a disabled button.
			if (isSavingRef.current) {
				// The one-shot debounce timer has already fired — that's
				// why we're here — and won't fire again on its own. Bailing without
				// re-arming would leave `hasUnsavedChanges` true with no pending
				// autosave: Effect 5 stays permanently deferred and `beforeunload`
				// warns on every close, until the user happens to type again. Re-arm
				// so a save still in flight (or one that just failed) gets retried.
				if (autoSaveTimeoutRef.current) {
					clearTimeout(autoSaveTimeoutRef.current);
				}
				autoSaveTimeoutRef.current = setTimeout(() => {
					triggerAutoSaveRef.current?.();
				}, 10000);
				return true;
			}
			setIsSaving(true);

			if (autoSaveTimeoutRef.current) {
				clearTimeout(autoSaveTimeoutRef.current);
				autoSaveTimeoutRef.current = null;
			}

			// In raw mode, use currentDocument directly; otherwise read from editor.
			// The raw-mode branch no longer runs `repairMarkdownDocument`
			// — in raw mode the user is editing markdown by hand, so repairing it is
			// the same silent rewrite of user intent the read path was fixed for.
			const markdown = showRaw
				? currentDocument
				: getEditorMarkdownForSave(editor);

			// Null means the serializer failed. Saving here would
			// persist `description: null` and destroy the document.
			if (markdown === null) {
				setIsSaving(false);
				toast.error(
					"Couldn't save your changes — the editor content could not be read. Your text is still here; please copy it somewhere safe and reload the page.",
				);
				return false;
			}

			if (!showRaw) {
				setCurrentDocument(markdown);
			}

			const {
				description,
				acceptanceCriteria,
				acceptanceCriteriaPreserved,
			} = resolveStoryContentForSave(markdown, story.acceptanceCriteria);
			if (acceptanceCriteriaPreserved) {
				toast.warning(ACCEPTANCE_CRITERIA_PRESERVED_MESSAGE);
			}

			const updates: Parameters<typeof updateMutation.mutate>[0] = {};

			if (title !== story.title) {
				updates.title = title;
			}
			if (description !== (story.description ?? "")) {
				updates.description = description || null;
			}
			if (acceptanceCriteria !== (story.acceptanceCriteria ?? "")) {
				updates.acceptanceCriteria = acceptanceCriteria || null;
			}
			if (priority !== story.priority) {
				updates.priority = priority as
					| "P0_CRITICAL"
					| "P1_HIGH"
					| "P2_MEDIUM"
					| "P3_LOW";
			}
			if (size !== (story.size ?? "")) {
				updates.size = (size as "XS" | "S" | "M" | "L" | "XL") || null;
			}
			if (storyPoints !== (story.storyPoints?.toString() ?? "")) {
				updates.storyPoints = storyPoints
					? Number.parseInt(storyPoints, 10)
					: null;
			}
			// `targetStage` is a pending dropdown selection, not a
			// confirmed decision — only commit it when this save is an explicit
			// user action (Save, Save & Close, Ctrl/Cmd+S, the AI-accept path).
			// Autosave and the unmount flush pass `includeStageTransition: false`
			// so merely opening the dropdown and waiting (or navigating away)
			// can't silently advance the feature's drafting stage.
			if (
				includeStageTransition &&
				targetStage &&
				targetStage !== story.draftingStage
			) {
				updates.draftingStage = targetStage as FeatureDraftingStage;
			}

			if (Object.keys(updates).length > 0) {
				updates.isContextUpdate = true;
				// Capture the AI-title edit signal *before* the mutation runs so
				// the optimistic cache update (which can rewrite `story.title`)
				// doesn't eat the diff.
				const aiTitleWasEdited =
					updates.title !== undefined &&
					story.aiGeneratedTitle === true &&
					updates.title !== story.title;
				const editedTitleBefore = story.title;
				const editedTitleAfter = updates.title;
				const editedTitleSource = story.titleSource ?? null;

				updateMutation.mutate(updates, {
					// Confirm THIS call's snapshot, not whatever a
					// concurrently in-flight save might have last written to a
					// shared ref. `markdown` is captured by this closure, so it's
					// unambiguously the content *this* mutate() call sent — see
					// `lastSavedMarkdownRef`'s declaration comment for the race this
					// replaced. Any new `updateMutation.mutate` call site should
					// follow the same pattern: confirm from its own `onSuccess`.
					onSuccess: () => {
						lastSavedMarkdownRef.current = markdown;
						// In raw mode the TipTap editor still holds the
						// pre-raw-edit rich content — raw edits never reach it until
						// the toggle back — so comparing against
						// `getEditorMarkdownForSave(editor)` here would report dirty
						// on every successful raw save. Compare against
						// `currentDocument` (the textarea text actually saved)
						// instead when in raw mode.
						const live = showRaw
							? currentDocument
							: getEditorMarkdownForSave(editor);
						setHasUnsavedChanges(
							isEditorDirty(live, lastSavedMarkdownRef.current),
						);
						if (aiTitleWasEdited) {
							// Structured log line — same pipeline pattern as
							// `[PasteImage] status=ok` in use-clipboard-image-paste.ts.
							// Downstream log shippers can pick this up by event name.
							console.log("[ai_title_edited]", {
								storyId: story.id,
								projectId,
								organizationId: organizationId ?? null,
								userId: story.createdById,
								oldTitle: editedTitleBefore,
								newTitle: editedTitleAfter,
								titleSource: editedTitleSource,
							});
						}
					},
				});
				return true;
			}
			if (isManualSaveRef.current) {
				isManualSaveRef.current = false;
				onClose();
			}
			setIsSaving(false);
			setHasUnsavedChanges(false);
			return true;
		},
		[
			title,
			priority,
			size,
			storyPoints,
			targetStage,
			story,
			updateMutation,
			editor,
			parseContent,
			showRaw,
			currentDocument,
		],
	);

	// Keep the ref in sync so Effect 1 (declared above, before this
	// useCallback) can flush a pending auto-save through the latest
	// `handleSave` closure without being listed in its own dependency array.
	handleSaveRef.current = handleSave;

	// Handle adding a task
	const handleAddTask = useCallback(() => {
		if (!newTaskTitle.trim()) {
			return;
		}
		createTaskMutation.mutate(newTaskTitle.trim());
		setNewTaskTitle("");
	}, [newTaskTitle, createTaskMutation]);

	// Handle AI task generation
	const handleGenerateTasks = useCallback(() => {
		setIsGeneratingTasks(true);
		generateTasksMutation.mutate();
	}, [generateTasksMutation]);

	// Expose story context to CopilotKit — this is what the AI sees.
	// `description` mirrors the live editor content (`currentDocument`), NOT
	// `story.description`, which lags the editor state.
	//
	// Story-media attachment IMAGES are NOT delivered through this readable.
	// They are resolved separately by the web-tier oRPC procedure
	// `projects.stories.resolveMediaForAgent` (see the
	// `storyMediaRagContexts` state and the `rag context` readable below),
	// then base64-data-URL markdown strings are merged into the same
	// `rag context` value the agent already consumes.
	useCopilotReadable(
		{
			description:
				"The current feature being edited. The AI can modify this content by generating new document content.",
			value: {
				storyId: story.id,
				projectId,
				identifier: story.identifier,
				title,
				description: currentDocument,
				currentContent: currentDocument,
				version: story.version ?? 1,
				draftingStage: story.draftingStage,
				priority,
				size,
				storyPoints,
				tasks: tasks.map((t) => ({
					title: t.title,
					isCompleted: t.isCompleted,
					estimatedHours: t.estimatedHours,
				})),
			},
		},
		[
			story.id,
			projectId,
			story.identifier,
			title,
			currentDocument,
			story.version,
			story.draftingStage,
			priority,
			size,
			storyPoints,
			tasks,
		],
	);

	// Expose project context (also carries integration flags for the agent)
	// hasRepoIntegration is the load-bearing flag that binds code-search tools in
	// chat-node.ts / tool-node.ts; without it the agent can't search the repo even
	// when "Enable code search for AI agents" is toggled on for the project.
	useCopilotReadable({
		description: "Project context for the feature",
		value: {
			projectId,
			projectName: project?.name,
			projectDescription: project?.description,
			techStack: project?.techStack,
			features: project?.features,
			documentTitles: documents.map((d) => d.title),
			hasTeamsIntegration: !!teamsMessagesData?.hasTeamsIntegration,
			hasSlackIntegration: !!slackMessagesData?.hasSlackIntegration,
			hasGitHubIntegration: hasRepoUrl,
			hasRepoIntegration: codeSearchEnabled && hasRepoUrl,
		},
	});

	// Expose available context sources (metadata only — agent searches on-demand via tools)
	useCopilotReadable({
		description:
			"Available project context sources. The agent can search these using the search_project_knowledge tool (for meeting transcripts, documents, codebase) and search_teams_messages / search_slack_messages tools (for live chat messages).",
		value: {
			meetingTranscriptCount: transcriptContextData?.transcriptCount ?? 0,
			meetingSubjects: (transcriptContextData?.transcripts ?? []).map(
				(t) => ({
					subject: t.meetingSubject,
					date: t.meetingDate,
				}),
			),
			teamsMessageCount: teamsMessagesData?.messages?.length ?? 0,
			slackMessageCount: slackMessagesData?.messages?.length ?? 0,
		},
	});

	// Render default-MCP tool results (e.g. Excalidraw `create_view`)
	// inline in the AI Feature Assistant sidebar. The hook hooks the
	// CopilotKit wildcard action; for tool calls without our render
	// envelope it returns `null` (default rendering). Without this the
	// model's Excalidraw result shows up as raw JSON in the chat.
	useDefaultMcpInlineRender({ organizationId });

	// Clarifying-question card + frequency policy. Lets the agent ask the user a
	// question with up to 3 clickable options (instead of a free-text inline
	// question) and continue with the answer; the project's frequency tier
	// controls how often it asks.
	useClarifyingQuestions({
		frequency:
			(project?.clarifyingQuestionFrequency as
				| ClarifyingQuestionFrequency
				| undefined) ?? "BALANCED",
		organizationId: organizationId ?? null,
	});

	// Fizzy #1412 PR3 §7.4 follow-up: persist a `role: "system"`
	// operation-result message into the underlying AgentConversation
	// when the user accepts or rejects the confirm_changes dialog
	// below. Best-effort — never blocks the accept/reject UI flow.
	// See `useConfirmChangesOperationResult.ts` for the full design
	// notes (defensive null-conversationId guard, fresh operationKey
	// per click, error-swallow policy).
	const recordConfirmChangesOutcome = useConfirmChangesOperationResult({
		conversationId: activeAssistantConversationId,
		projectId,
		organizationId: organizationId ?? null,
		operationLabel: "Confirm AI document changes",
	});

	// "Latest ref" pattern — Copilot round-3 finding on PR #1240.
	//
	// `useCopilotAction` below caches its `renderAndWaitForResponse`
	// callback keyed off its `dependencies` array. Adding the
	// `recordConfirmChangesOutcome` callback to that array would
	// re-register the action on every conversation-id flip, which
	// CopilotKit's internal action map handles but produces extra
	// render churn. The idiomatic React workaround is the
	// "latest ref" pattern: hold the latest callback in a ref,
	// refresh it via useEffect when the callback identity changes,
	// and have handlers read `recordOutcomeRef.current` so they
	// always invoke the freshest closure regardless of when
	// CopilotKit captured the parent callback.
	//
	// Without this ref, the captured `recordConfirmChangesOutcome`
	// would freeze at first render — i.e. when
	// `activeAssistantConversationId` is still `null` and
	// `<CopilotPersistenceHook>` hasn't lazy-created yet. Every
	// subsequent click would hit the null-info-log branch in the
	// helper and NEVER persist, defeating the whole purpose of the
	// PR. This is exactly the regression Copilot caught on the
	// initial commit — the helper's null-guard was correct, but
	// the captured-stale-closure problem rendered the fix
	// inoperative in the most common path (fresh session).
	const recordOutcomeRef = useRef(recordConfirmChangesOutcome);
	useEffect(() => {
		recordOutcomeRef.current = recordConfirmChangesOutcome;
	}, [recordConfirmChangesOutcome]);

	// Confirmation action for agent changes
	// CRITICAL FIX: Use editor content with diff tags stripped, NOT agentState.document
	// The AI may return only partial content, but the editor has the full merged view
	// with diff highlighting. getEditorMarkdownForSave() strips diff tags and gives us
	// the final content (original - deletions + additions).
	useCopilotAction(
		{
			name: "confirm_changes",
			renderAndWaitForResponse: ({ args, respond, status }) => {
				const handleReject = () => {
					isRefreshCleanSpecPendingRef.current = false;
					setIsAwaitingConfirmation(false);
					confirmCallbacksRef.current = null;
					// Reject: Restore the baseline content.
					//
					// The baseline predates the run, so it predates any question
					// answered while the run was in flight — restoring it puts
					// the pre-answer spec back in the editor and marks it dirty,
					// and the next autosave then writes that over the server,
					// erasing the appendix exactly the way accept did (#1929).
					// Splice those entries back before the content ever reaches
					// the editor, reading the server text at click time.
					//
					// `content` is the text being restored (`baselineRef`, the
					// editor-restore semantics); `baseline` is the pre-run
					// snapshot the model was given (`runStartBaselineRef`).
					// They are usually the same string — but only
					// `runStartBaselineRef` is guaranteed not to have been
					// reassigned by another effect since the run started, and it
					// is the comparison that decides what gets re-added.
					const rejectBase = baselineRef.current || currentDocument;
					const restoredContent = restorePendingDecisions({
						baseline: runStartBaselineRef.current,
						serverDescription: serverDescriptionRef.current,
						content: rejectBase,
					});
					// Guard the setContent call so it doesn't trigger
					// onUpdate → auto-save → unwanted version creation.
					isSyncingFromPropRef.current = true;
					editor?.commands.setContent(
						// `baselineRef.current`/`currentDocument` are
						// serializer output of *user* content — the same provenance
						// opted out of the LLM bullet-repair everywhere else. Without
						// the opt-out, a hand-written list gets silently collapsed
						// here and then persisted by the next save.
						fromMarkdown(restoredContent, USER_CONTENT_MD_OPTIONS),
					);
					isSyncingFromPropRef.current = false;
					setAgentState({ document: restoredContent });
					// Keep the baseline pointing at what the editor now holds, the
					// invariant `handleAccept` maintains and Effect 4 re-
					// establishes on the next editor update. Without it the ref
					// would describe a document that is no longer on screen for
					// as long as the editor sits untouched.
					baselineRef.current = restoredContent;
					// Cancel any pending auto-save and re-derive the dirty flag.
					// Rejecting restores `baselineRef`, which was
					// never necessarily persisted. Derive from content — from the
					// RESTORED content, so a splice that added an entry is seen
					// as dirty and the autosave that follows persists it.
					setHasUnsavedChanges(
						isEditorDirty(
							restoredContent,
							lastSavedMarkdownRef.current,
						),
					);
					if (autoSaveTimeoutRef.current) {
						clearTimeout(autoSaveTimeoutRef.current);
						autoSaveTimeoutRef.current = null;
					}
					// Clear pending stage — do NOT advance
					setPendingTargetStage(null);
					// When the splice actually put something back, flagging the
					// editor dirty is not enough — it is actively harmful. A
					// dirty editor is one of `shouldDeferStoryPropSync`'s hold
					// conditions, so Effect 5 stops adopting server
					// descriptions for as long as the flag stays up, and
					// nothing lowers it but a successful save. Rejecting into
					// that state leaves the restored answer unsaved AND the
					// editor frozen against later server content, so the next
					// ordinary save can erase the answer a second time.
					//
					// Flush instead of waiting for a keystroke to arm the
					// autosave. Same machine-triggered flush shape as Effect
					// 1's (`includeStageTransition: false` — a rejection must
					// not commit a pending stage-dropdown selection), and
					// through `handleSaveRef` for the same stale-closure reason
					// the deferred accept save documents below.
					if (restoredContent !== rejectBase) {
						handleSaveRef.current?.({
							includeStageTransition: false,
						});
					}
					// Fire-and-forget operation-result persistence.
					// `void` makes the lint-rule explicit: we intentionally
					// don't await so the agent flow continues immediately.
					// Helper is internally best-effort and swallows errors.
					// Read via `recordOutcomeRef.current` (NOT the
					// `recordConfirmChangesOutcome` variable directly) so
					// the call always uses the freshest closure with the
					// latest resolved conversationId — see the
					// "Latest ref" pattern doc-comment above.
					void recordOutcomeRef.current({ accepted: false });
					respond?.({ accepted: false });
				};

				const handleAccept = () => {
					setIsAwaitingConfirmation(false);
					confirmCallbacksRef.current = null;

					// #737 race defense: if Effect 2 hasn't landed the AI diff yet,
					// the editor still shows the pre-enhance baseline and stripping
					// diff tags would silently save the original content. Detect that
					// state (editor === baseline while the agent's final document
					// differs) and apply the diff synchronously so the read below
					// sees the merged view.
					//
					// Read agentState through agentStateRef so we always see the
					// latest committed value at click time. The closure that built
					// this handleAccept may be one render stale (the renderer is
					// invoked via CopilotKit's renderRef.current, which trails the
					// React state by one render), so reading agentState directly
					// from the closure could pick up a streaming partial that has
					// already been superseded.
					const baselineAtAccept = baselineRef.current;
					const agentFinalDoc = agentStateRef.current?.document || "";
					if (
						editor &&
						agentFinalDoc &&
						agentFinalDoc !== baselineAtAccept &&
						getEditorMarkdownForSave(editor) === baselineAtAccept
					) {
						const diff = diffPartialText(
							baselineAtAccept,
							agentFinalDoc,
							true,
						);
						isSyncingFromPropRef.current = true;
						editor.commands.setContent(fromMarkdown(diff));
						isSyncingFromPropRef.current = false;
					}

					// Confirm: Get the merged content from editor (strips diff tags)
					// This gives us: original content - deletions + additions
					const mergedContent = getEditorMarkdownForSave(editor);

					// Null means serialization failed — persisting it
					// would wipe the document. Treat like a reject: leave the
					// editor/document untouched and resolve the CopilotKit action
					// as declined rather than hanging or saving null. Mirror
					// `handleReject`'s cleanup of `pendingTargetStage` and the
					// pending auto-save timeout — otherwise a stale
					// `pendingTargetStage` survives into a later accept and
					// takes the stage-transition branch unexpectedly.
					if (mergedContent === null) {
						toast.error(
							"Couldn't apply the AI changes — the editor content could not be read. Your text is still here; please copy it somewhere safe and reload the page.",
						);
						setPendingTargetStage(null);
						isRefreshCleanSpecPendingRef.current = false;
						if (autoSaveTimeoutRef.current) {
							clearTimeout(autoSaveTimeoutRef.current);
							autoSaveTimeoutRef.current = null;
						}
						void recordOutcomeRef.current({ accepted: false });
						respond?.({ accepted: false });
						return;
					}

					// #1929: the editor was built from a snapshot taken when the
					// run started, so it carries no trace of a question answered
					// while the run was in flight — and saving it over the spec
					// body erases that answer's appendix entry for good (the
					// appendix is the only channel a later run learns the
					// decision through). Re-add the entries the server holds but
					// the pre-run baseline never had, reading the server text at
					// click time rather than from the renderer's frozen closure.
					//
					// Spliced HERE, where the saved content is produced, so all
					// three exits below — the stage-transition write, the
					// deferred write, and the ordinary write — carry it: each of
					// them derives from `finalContent`, whether directly or by
					// re-reading the editor this sets.
					//
					// `runStartBaselineRef` and NOT `baselineAtAccept`: the
					// latter is `baselineRef`, which the #737 race defense above
					// depends on being the editor's current state and which
					// three other writers also assign. Only the run-start ref is
					// guaranteed to be the snapshot the model was handed, which
					// is the comparison "did the model ever see this decision?"
					// actually asks.
					const finalContent = restorePendingDecisions({
						baseline: runStartBaselineRef.current,
						serverDescription: serverDescriptionRef.current,
						content: mergedContent,
					});

					// Set editor to clean content (no diff highlighting)
					// `finalContent` is Turndown output of an editor
					// doc, so list structure is already resolved in the ProseMirror
					// tree — the column-0-continuation shape the legacy bullet
					// repair targets cannot be present. Running it here is pure
					// downside: it would collapse the user's own hand-authored
					// bullets. Opt out. (Anything the splice above re-added is a
					// two-line `- **Q:** …` / `  **Decided:** …` bullet whose
					// continuation is indented, so it is not that shape either.)
					//
					// The repair never ran on this content earlier either:
					// `getEditorMarkdownForSave` is plain Turndown (no repair on the
					// write path, see `repairMarkdownDocument`'s doc comment), and
					// `mergeOrphanBulletContinuations` skips any text carrying diff
					// markers, which is what the diff parse above produced.
					editor?.commands.setContent(
						fromMarkdown(finalContent, USER_CONTENT_MD_OPTIONS),
					);
					setCurrentDocument(finalContent);
					baselineRef.current = finalContent; // Update baseline for next edit
					setAgentState({ document: finalContent });

					// Guard the split against a rewrite that dropped the
					// `Acceptance Criteria` heading: preserve the existing
					// criteria rather than silently nulling the column.
					const parsed = resolveStoryContentForSave(
						finalContent,
						story.acceptanceCriteria,
					);
					if (parsed.acceptanceCriteriaPreserved) {
						toast.warning(ACCEPTANCE_CRITERIA_PRESERVED_MESSAGE);
					}

					// The agent just rewrote the spec — have the next save success
					// re-run the (hash-gated, deduped) question extraction so a run's
					// new open questions surface immediately, no reopen needed.
					postAgentApplySeedRef.current = true;

					if (pendingTargetStage) {
						// CopilotKit enhance flow: save content + update stage + create version
						isRefreshCleanSpecPendingRef.current = false;
						updateStageWithVersionMutation.mutate({
							targetStage: pendingTargetStage,
							description: parsed.description || null,
							acceptanceCriteria:
								parsed.acceptanceCriteria || null,
						});
						setPendingTargetStage(null);
					} else if (isSavingRef.current) {
						// Same re-entrancy guard `handleSave` applies above, for
						// the same reason: a save already in flight plus this one
						// means two overlapping writes to the same row, and the
						// loser is rejected as a version conflict.
						//
						// This closes the gap on THIS branch only. The sibling
						// `pendingTargetStage` branch above still races, and more
						// dangerously: it writes through
						// `update-drafting-stage-with-version`, whose
						// `db.userStory.update` names no `version` in its WHERE
						// clause and sets `version: newVersion` outright — so a
						// concurrent autosave there is silently overwritten
						// rather than rejected. Fixing that means giving that
						// procedure an optimistic-concurrency write of its own,
						// which is a larger change than this one; it is
						// deliberately left alone here rather than half-done.
						//
						// Nothing is dropped. The confirmed content is already in
						// the editor, and the autosave re-armed here reads it back
						// through the same `resolveStoryContentForSave` split this
						// branch would have used — so it persists exactly the same
						// thing, just after the in-flight write lands instead of
						// racing it.
						isRefreshCleanSpecPendingRef.current = false;
						setHasUnsavedChanges(true);
						if (deferredAcceptSaveTimeoutRef.current) {
							clearTimeout(deferredAcceptSaveTimeoutRef.current);
						}
						deferredAcceptSaveTimeoutRef.current = setTimeout(
							() => {
								if (!isMountedRef.current) {
									return;
								}
								// Through `handleSaveRef`, not the `handleSave` in scope:
								// `useCopilotAction` freezes this render on its own
								// dependency array, so the closure captured here can
								// outlive the state it closed over. Toggling raw mode
								// while the confirm bar is up changes neither dependency,
								// so a direct call could persist through a stale `showRaw`
								// and write content that no longer matches the screen. The
								// ref is what the rest of this file already uses for that.
								//
								// `handleSave` and NOT `triggerAutoSave`:
								// that one bails when `isAiLoading` or
								// `isAwaitingConfirmation` is still set, and both are
								// mid-transition at exactly this moment. A bail there
								// re-arms nothing, so the user's confirmed changes
								// would sit unsaved until they happened to type
								// again. `handleSave` carries its own re-entrancy
								// re-arm, so if the earlier write is somehow still in
								// flight this retries instead of vanishing.
								//
								// `includeStageTransition: false` because this branch
								// only runs when there is no `pendingTargetStage` —
								// the stage flow is the sibling branch above.
								handleSaveRef.current?.({
									includeStageTransition: false,
								});
							},
							DEFERRED_ACCEPT_SAVE_DELAY_MS,
						);
					} else {
						// Normal AI edit: just save the confirmed changes
						startTransition(() => {
							setIsSaving(true);
							const isContextUpdate = true;
							isRefreshCleanSpecPendingRef.current = false; // Reset for future edits

							updateMutation.mutate(
								{
									description: parsed.description || null,
									acceptanceCriteria:
										parsed.acceptanceCriteria || null,
									isContextUpdate,
								},
								{
									// Mirror handleSave's per-call
									// confirmation pattern — confirm THIS call's
									// snapshot (`finalContent`, the full document
									// markdown, same shape as
									// `getEditorMarkdownForSave`/`buildInitialContent`
									// output, not just the `description` field
									// above) from its own `onSuccess` rather than a
									// shared ref. See `lastSavedMarkdownRef`'s
									// declaration comment for the race this
									// replaced. Any new `updateMutation.mutate`
									// call site should follow the same pattern.
									onSuccess: () => {
										lastSavedMarkdownRef.current =
											finalContent;
										const live = showRaw
											? currentDocument
											: getEditorMarkdownForSave(editor);
										setHasUnsavedChanges(
											isEditorDirty(
												live,
												lastSavedMarkdownRef.current,
											),
										);
									},
								},
							);
						});
					}
					// D3: persist this run's confirm-time change summary as a
					// collapsed "AI update" note in the Decision Log (best-effort;
					// never blocks the accept). Read the ref, not the state var —
					// this closure lags React state (see pendingChangeBulletsRef).
					const bulletsToRecord = pendingChangeBulletsRef.current;
					if (
						maturationV2 &&
						bulletsToRecord &&
						bulletsToRecord.length > 0
					) {
						recordChangeNoteMutation.mutate({
							...maturationEditorInput,
							bullets: bulletsToRecord,
						});
					}
					pendingChangeBulletsRef.current = null;
					setPendingChangeBullets(null);

					// Fire-and-forget operation-result persistence.
					// Summary names the story being edited so the persisted
					// system message gives the chat history meaningful
					// context. Both flows (stage transition + normal AI
					// edit) land here at the same point; the persisted
					// message describes the user-visible action regardless
					// of which downstream mutation runs. See
					// `useConfirmChangesOperationResult.ts` for the full
					// integration design. Read via `recordOutcomeRef.current`
					// (Copilot round-3 latest-ref fix) so the helper sees
					// the freshest `conversationId` even when the captured
					// closure dates back to a pre-lazy-create render.
					void recordOutcomeRef.current({
						accepted: true,
						summary: pendingTargetStage
							? `Changes applied — advanced to stage ${pendingTargetStage}.`
							: "Changes applied.",
					});
					respond?.({ accepted: true });
				};

				// Keep diff highlighting visible and expose callbacks for DiffReviewBar.
				// Use queueMicrotask to avoid setState during render of a different component.
				//
				// Don't gate on `!isAiLoading` here: this renderer is invoked
				// through CopilotKit's `renderRef.current`, which is updated in a
				// useEffect that runs AFTER commit. The closure CopilotKit invokes
				// therefore lags one render behind the React state, so reading
				// `isAiLoading` here would see the stale value and the gate could
				// stay closed forever (the bar/fallback never appear). The race
				// the previous gate was trying to protect (saving a streaming
				// partial before the run finishes) is a non-issue: the agent
				// emits confirm_changes only inside the same Command that sets
				// state.document to its final value (chat-node.ts:615-630), so by
				// the time this renderer ever sees status === "executing",
				// agentState.document is already final. handleAccept additionally
				// applies the diff synchronously if Effect 2 hasn't run yet.
				if (status === "executing" && !isAwaitingConfirmation) {
					confirmCallbacksRef.current = {
						accept: handleAccept,
						reject: handleReject,
					};
					queueMicrotask(() => setIsAwaitingConfirmation(true));
				}

				// The confirm dialog is now minimal — DiffReviewBar above the
				// editor provides the primary accept/reject UX. This component
				// stays as a fallback inside the CopilotKit chat sidebar.
				//
				// `canEdit` (Fizzy #1929, R9): a third write control for the
				// same draft, in the chat sidebar. The spec tab's review region
				// and the cross-tab banner are both gated now, so leaving this
				// one ungated would make the rule true of two surfaces out of
				// three — and this is the one that stays reachable no matter
				// which tab is open. The card itself still renders (the run
				// happened, and a viewer may watch it); only the buttons go.
				//
				// Routed through `resolvePendingReview` — NOT straight at
				// `handleAccept` / `handleReject` (Fizzy #1929). Called direct,
				// this surface resolves against `serverDescriptionRef` as the
				// cache last left it, so approving from the chat a beat after
				// answering a question splices nothing back and saves the answer
				// away: the original bug, on the one surface that is reachable
				// from every tab. It also skips the failure handling — a throw
				// in a click handler with `isAwaitingConfirmation` already
				// cleared behind it leaves the draft unresolved with no control
				// anywhere to try again.
				//
				// The wrapper is async and reports whether the resolution
				// actually landed, which is what lets the card hold its
				// in-flight state and decline to latch on a failure.
				const resolveFromChatCard = async (
					action: "accept" | "reject",
				) => {
					return (
						(await resolvePendingReviewRef.current?.(action)) ??
						false
					);
				};
				return (
					<ConfirmChanges
						args={args}
						respond={respond}
						status={status}
						canEdit={canEdit}
						onReject={() => resolveFromChatCard("reject")}
						onConfirm={() => resolveFromChatCard("accept")}
					/>
				);
			},
		},
		[agentState?.document, currentDocument],
	);

	// ── Cross-tab review banner behaviour (Fizzy #1929) ──────────────────
	//
	// Everything below reads `confirmCallbacksRef` — the SAME pair the spec
	// tab's `<DiffReviewBar>` calls — so the two surfaces resolve one draft
	// rather than two. Only one banner is ever mounted (it renders above the
	// tab bar, not inside a tab), because two copies would race to resolve it.

	/** A review the user still owes a decision on, in any of its three states. */
	const isPendingReviewOpen =
		isAwaitingConfirmation || reviewResolution !== null;
	const isResolvingReview = reviewResolution?.status === "pending";

	const focusActiveMaturationTabTrigger = useCallback(() => {
		document
			.getElementById(
				`${maturationTabBaseId}-tab-${MATURATION_TAB_TRIGGER_SUFFIX[maturationTab]}`,
			)
			?.focus();
	}, [maturationTab, maturationTabBaseId]);

	/**
	 * Approve or reject the pending draft. THE resolution path — the banner's
	 * two buttons, the Clean Specification tab's own `<DiffReviewBar>` and the
	 * chat sidebar's `<ConfirmChanges>` card all come through here, so the fresh
	 * read below and the failure handling cover all three surfaces rather than
	 * whichever one happened to be wired up.
	 *
	 * Both callbacks are synchronous and both clear `isAwaitingConfirmation` as
	 * their first act, so a throw anywhere after that point (the
	 * pending-decisions splice, the markdown round trip, the save split) leaves
	 * the review resolved on paper and unresolved in fact, with no control left
	 * on screen to try again. Put the callbacks and the awaiting flag back and
	 * report the failure on the banner instead of dismissing it.
	 *
	 * Returns whether the resolution landed. The banner and the review bar read
	 * their state off `reviewResolution` and ignore it; the chat card keeps its
	 * own accepted/rejected state machine and needs to know not to latch
	 * "✓ Accepted" over a resolution that threw.
	 */
	const resolvePendingReview = useCallback(
		async (action: "accept" | "reject"): Promise<boolean> => {
			const callbacks = confirmCallbacksRef.current;
			if (!callbacks) {
				return false;
			}
			setReviewResolution({ action, status: "pending" });
			try {
				// #1929, the crux. Both callbacks splice the server's
				// pending-decisions appendix into the content they write, and
				// they read it from `serverDescriptionRef` — a mirror of
				// `story.description`, which is React Query CACHE data. The
				// answer mutation only invalidates `stories.get`; it does not
				// await the refetch. Answer a question, approve the waiting
				// draft a beat later, and the splice compares the server text
				// as it stood BEFORE the answer: nothing is baseline-absent,
				// nothing is restored, and the accept saves the answer away —
				// the original bug, reached through its own fix.
				//
				// So resolve against a fresh read, not against the cache, and
				// do it before either callback is allowed to run. Nothing can
				// interleave between the assignment and the call: the render
				// that would re-mirror the stale prop cannot happen inside a
				// synchronous block.
				const fresh = await queryClient.fetchQuery(
					orpc.projects.stories.get.queryOptions({
						input: {
							projectId,
							storyId: story.id,
							organizationId,
						},
					}),
				);
				const freshStory = fresh?.story;
				if (!freshStory) {
					// A read that came back without a story is not a read.
					// Falling through would resolve against the cache, which is
					// exactly what this is here to stop.
					throw new Error(
						"The latest version of this feature could not be read.",
					);
				}
				serverDescriptionRef.current = freshStory.description ?? null;

				if (action === "accept") {
					callbacks.accept();
				} else {
					callbacks.reject();
				}
				return true;
			} catch (error) {
				// Covers the fresh read as well as the callbacks: a failed read
				// must surface here rather than silently resolve against stale
				// text. Nothing has been written in either case — the draft is
				// still pending and still needs a decision.
				confirmCallbacksRef.current = callbacks;
				setIsAwaitingConfirmation(true);
				setReviewResolution({
					action,
					status: "error",
					message:
						error instanceof Error && error.message
							? error.message
							: undefined,
				});
				return false;
			}
		},
		[queryClient, projectId, story.id, organizationId],
	);
	// See `resolvePendingReviewRef`'s declaration for why this is a render-body
	// assignment and why the renderer above can rely on it.
	resolvePendingReviewRef.current = resolvePendingReview;

	/**
	 * Route to the diff. Approving a whole-spec rewrite from a tab that shows
	 * no diff is a blind confirm, which is the failure this surface exists to
	 * prevent — so the banner always offers the way to look first.
	 *
	 * Focus lands on the review region rather than the tab panel: the region is
	 * what the user asked to see, and the diff itself is below it.
	 */
	const handleReviewPendingChanges = useCallback(() => {
		if (maturationTab === "cleanSpec") {
			reviewBarRegionRef.current?.focus();
			return;
		}
		wantsReviewBarFocusRef.current = true;
		setMaturationTab("cleanSpec");
	}, [maturationTab]);

	// Hand focus over once the Clean Specification tab has actually rendered
	// its review region — the tab switch above is a state change, so the region
	// does not exist yet when the click handler returns.
	useEffect(() => {
		if (!wantsReviewBarFocusRef.current || maturationTab !== "cleanSpec") {
			return;
		}
		const region = reviewBarRegionRef.current;
		if (!region) {
			return;
		}
		wantsReviewBarFocusRef.current = false;
		region.focus();
	}, [maturationTab]);

	// Announce arrival and departure of a draft. The region itself is mounted
	// at all times (see the render below); only this text changes, because a
	// live region that appears already carrying its text is unreliably
	// announced — the same reason `StoryKindRegenerationNotice` is kept outside
	// the tab gate.
	const wasAwaitingConfirmationRef = useRef(isAwaitingConfirmation);
	useEffect(() => {
		if (wasAwaitingConfirmationRef.current === isAwaitingConfirmation) {
			return;
		}
		wasAwaitingConfirmationRef.current = isAwaitingConfirmation;
		setReviewAnnouncement(
			isAwaitingConfirmation
				? tMaturation("pendingReview.announcePending")
				: tMaturation("pendingReview.announceResolved"),
		);
	}, [isAwaitingConfirmation, tMaturation]);

	// A resolution is in flight until the write it started settles. Until then
	// both controls stay disabled under a pending label, so a second click
	// cannot start a second write against the same draft.
	//
	// Every write flag being down is NOT on its own proof that the resolution
	// finished — see `REVIEW_RESOLUTION_SETTLE_GRACE_MS` for the two ways it is
	// momentarily down mid-flight. A flag coming back up cancels the timer
	// through this effect's cleanup, so the window simply re-opens.
	useEffect(() => {
		if (
			reviewResolution?.status !== "pending" ||
			isAwaitingConfirmation ||
			isSaving ||
			updateMutation.isPending ||
			updateStageWithVersionMutation.isPending
		) {
			return;
		}
		const settleTimeout = setTimeout(() => {
			// The banner is about to unmount. If focus is inside it (or has
			// already been dropped to `<body>` by an earlier unmount inside
			// it), landing it on the tab the user is looking at beats leaving
			// it at the top of the document.
			//
			// But this fires up to a second and a half after the click, and the
			// user does not owe us that second and a half: they may well be
			// typing in the editor or filling in an answer on another tab by
			// now. Stealing focus out of a field mid-sentence is worse than the
			// dropped focus this repairs, so read where focus actually is
			// FIRST, and only move it when it is somewhere we put it.
			const active = document.activeElement;
			const shouldRestoreFocus =
				!active ||
				active === document.body ||
				reviewBannerRef.current?.contains(active) === true;
			setReviewResolution(null);
			if (shouldRestoreFocus) {
				focusActiveMaturationTabTrigger();
			}
		}, REVIEW_RESOLUTION_SETTLE_GRACE_MS);
		return () => clearTimeout(settleTimeout);
	}, [
		reviewResolution?.status,
		isAwaitingConfirmation,
		isSaving,
		updateMutation.isPending,
		updateStageWithVersionMutation.isPending,
		focusActiveMaturationTabTrigger,
	]);

	// Keyboard shortcut for save (Ctrl/Cmd + S)
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if ((e.ctrlKey || e.metaKey) && e.key === "s") {
				e.preventDefault();
				// Mirror the Save buttons' `disabled={isSaving}` —
				// they're the only thing that was gated before. `handleSave`
				// itself now also no-ops while saving (belt and suspenders), but
				// checking here skips the call (and the log line's worth of work
				// building `updates`) entirely.
				if (isSavingRef.current) {
					return;
				}
				handleSave();
			}
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [handleSave]);

	// The 10s auto-save debounce means a tab close right after
	// typing loses the edit. Warn while dirty.
	useEffect(() => {
		const onBeforeUnload = (event: BeforeUnloadEvent) => {
			if (
				!shouldWarnBeforeUnload({
					hasUnsavedChanges: hasUnsavedChangesRef.current,
					isSaving: isSavingRef.current,
				})
			) {
				return;
			}
			// Browsers ignore custom text and show their own copy; both the
			// assignment and preventDefault are required for cross-browser support.
			event.preventDefault();
			event.returnValue = "";
		};
		window.addEventListener("beforeunload", onBeforeUnload);
		return () => window.removeEventListener("beforeunload", onBeforeUnload);
	}, []);

	// Cleanup auto-save timeout on unmount, and flush a pending edit rather
	// than silently dropping it.
	//
	// `beforeunload` (above) does not fire on Next.js App
	// Router client-side navigation — the workspace is a full page and
	// `StoryWorkspacePage`'s Close is a `router.push`, so back-to-roadmap,
	// the breadcrumb, and the Close button all unmount this component with
	// no warning. Rather than adding a `confirm()` prompt to each of those
	// (they live in `StoryWorkspacePage.tsx`, outside this file, and a
	// prompt on every nav-away would be a worse experience than the
	// existing `beforeunload` browser dialog already provides for the
	// tab-close case), flush silently here: this cleanup runs on ANY
	// unmount, so it covers every navigation path uniformly with no new UI.
	// `hasUnsavedChangesRef` / `isSavingRef` / `handleSaveRef` are refs
	// precisely so this — an empty-deps effect whose cleanup only runs once,
	// at unmount — reads their current values instead of first render's.
	//
	// Also flips `isMountedRef` false and nulls `triggerAutoSaveRef` here.
	// `updateMutation`'s hook-level `onError` re-arms the autosave timer on
	// failure (see its declaration) and that callback fires regardless of
	// mount state — so if the flush below fails after this component is
	// gone, `isMountedRef` is what stops `onError` from scheduling a
	// `setTimeout` nothing will ever cancel. Nulling `triggerAutoSaveRef`
	// is belt-and-suspenders on top of that same guard: even if a timer
	// were already in flight, it can't call into a stale closure.
	//
	// Best-effort: `handleSave` fires the PATCH, but this component is
	// unmounting, so its confirmation callbacks split in two. The hook-level
	// `updateMutation` callbacks (`onSuccess`/`onError`/`onSettled` passed to
	// `useMutation` itself — the toast, `onClose()`, `setTargetStage("")`,
	// the maturation seed, `onStoryUpdated()`) always run regardless, even
	// from a dead component — React Query owns the mutation, not the
	// component. The *per-call* `onSuccess` passed to this specific
	// `mutate(updates, { onSuccess })` (the one that confirms
	// `lastSavedMarkdownRef`) never runs, because React Query v5 gates
	// `mutateOptions` callbacks on `MutationObserver.hasListeners()`, and an
	// unmounted component's observer has none. Net effect: the PATCH lands
	// and the server gets the data either way, but `lastSavedMarkdownRef`
	// won't be confirmed by this flush — harmless here since nothing reads it
	// again after unmount. Skipped while a save is already in flight to avoid
	// double-submitting; a save that was kicked off but hasn't resolved will
	// still land on its own.
	useEffect(() => {
		// Re-arm on every setup. React StrictMode runs setup → cleanup → setup
		// on the SAME fiber (same refs) in dev, so without this the cleanup's
		// `false` below would stick for as long as the component lives in dev and
		// permanently disable the `onError` autosave re-arm — reintroducing the
		// dirty-with-no-pending-save wedge in dev only. Fizzy #1987.
		isMountedRef.current = true;
		return () => {
			isMountedRef.current = false;
			triggerAutoSaveRef.current = null;
			if (autoSaveTimeoutRef.current) {
				clearTimeout(autoSaveTimeoutRef.current);
			}
			if (deferredAcceptSaveTimeoutRef.current) {
				clearTimeout(deferredAcceptSaveTimeoutRef.current);
			}
			if (hasUnsavedChangesRef.current && !isSavingRef.current) {
				// Same reasoning as `triggerAutoSave` — this is not
				// an explicit user Save, so it must not silently commit a
				// pending `targetStage` dropdown selection.
				handleSaveRef.current?.({ includeStageTransition: false });
			}
		};
	}, []);

	// Sync tasks from story prop when it changes (e.g., after task generation)
	// Use JSON comparison to avoid infinite loops from reference changes
	const storyTasksJson = JSON.stringify(story.tasks);
	useEffect(() => {
		const newTasks = JSON.parse(storyTasksJson);
		setTasks(newTasks);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [storyTasksJson]);

	const _priorityColor = getPriorityColor(story.priority);
	const completedTasks = tasks.filter((t) => t.isCompleted).length;
	const totalTasks = tasks.length;

	// Track uploaded attachment content as RAG-context entries the agent
	// actually reads. The agent's unified-server.ts looks up readable values
	// by description matching "rag context" (case-insensitive) and expects a
	// `{ragContexts: string[]}` shape — see
	// `agents/langchain/project-document-generator/unified-server.ts:478`.
	// Other description / value shapes are silently dropped.
	//
	// `useCopilotDocumentUpload` builds the entry (text inlined raw; images as
	// a markdown image with the data URL, so vision-capable models render the
	// picture from prompt context) and neutralizes the filename against the
	// envelope's delimiters. We only push it — see `buildAttachmentContextEntry`.
	//
	// `flushSync` forces the state commit synchronously inside
	// `onContentExtracted` so the readable's value reflects the newly-uploaded
	// file BEFORE CopilotKit collects context for the in-flight agent run.
	// Without it React's batched render leaves the first turn after upload
	// shipping a stale (empty) context.
	//
	// Kept as records rather than bare strings so the entries can be measured
	// and counted without re-deriving anything: the upload hook needs both to
	// judge a new attachment against the request it will ride in, and a 413
	// recovery needs something to drop. `mergedRagContexts` maps back to plain
	// strings, so the wire format is unchanged (Fizzy #2167).
	const [uploadedRagContexts, setUploadedRagContexts] = useState<
		UploadedRagContext[]
	>([]);

	const handleAttachmentExtracted = useCallback((entry: string) => {
		flushSync(() => {
			setUploadedRagContexts((prev) => [
				...prev,
				{
					id: `rag-${prev.length}-${entry.length}`,
					entry,
					bytes: contextEntryBytes(entry),
					// The envelope inlines an image as a data URL; a document is
					// inlined as text. That is the only distinction the image cap
					// cares about.
					isImage: entry.includes("](data:image/"),
				},
			]);
		});
	}, []);

	// Drop every uploaded attachment from context. The entries outlive the chat
	// input's own chips — those are cleared on each send — so without this there
	// is no way back from a request that the body cap refused: the offending
	// entry rides every later turn and each one is refused in turn.
	const clearUploadedRagContexts = useCallback(() => {
		setUploadedRagContexts((prev) => (prev.length === 0 ? prev : []));
	}, []);

	// Story-attached images for the AI Feature Assistant multimodal pipeline.
	// The server-side procedure `projects.stories.resolveMediaForAgent` reads
	// the story's description, extracts `story-media/...` keys, fetches each
	// from S3 with a per-fetch timeout + 5 MB byte cap, and returns base64
	// data-URL markdown strings in the same shape as `uploadedRagContexts`
	// items. Merging both arrays into the single `rag context` readable means
	// the agent's existing `splitRagContextImages` extracts them uniformly —
	// no changes needed in the agent code.
	//
	// We trigger the fetch on the SET of `story-media/...` keys present in
	// the persisted `story.description` PROP (not in `currentDocument` editor
	// state). This matters for two reasons:
	//
	//   1. Sig source must match resolver source. The procedure reads the
	//      description from the DB; the prop carries that same DB value (via
	//      the parent's query). Sigging from `currentDocument` would lag
	//      `story.description` by one effect cycle (see lines ~1166–1178 where
	//      external `story.description` changes are synced into
	//      `currentDocument`), creating a window where a story switch updates
	//      the prop but `currentDocument` still holds the previous story's
	//      content. During that window the derived sig would still match
	//      `resolvedStoryMedia.sig`, exposing the previous story's base64
	//      payloads to the new story's chat. Sigging from the prop closes
	//      that window — the prop changes synchronously with the new story.
	//
	//   2. Unsaved edits don't trigger spurious empty fetches. Pasting a new
	//      image into the editor inserts the markdown locally but does not
	//      update DB; sigging from the editor would request a resolve that
	//      returns [] (DB doesn't have the new key yet), then re-request on
	//      save. Sigging from the prop only fires when the save actually
	//      lands and the parent refetches.
	//
	// Store the resolved media as a tuple keyed by the sig that produced it.
	// `storyMediaRagContexts` is derived from `resolvedStoryMedia` only when
	// its `sig` still matches the CURRENT sig — so the moment the user
	// switches stories (`story.description` prop flips), the readable below
	// sees `[]` in the SAME render, without waiting for an effect to clear
	// state. A clear-in-effect (the previous revision) leaked the old story's
	// payloads through the first render of the new story.
	const [resolvedStoryMedia, setResolvedStoryMedia] = useState<{
		sig: string;
		items: string[];
	}>({ sig: "", items: [] });
	const storyMediaKeysSig = useMemo(() => {
		// `story.description` may be markdown or HTML — the extractor handles
		// both via the shared helper.
		const keys = extractStoryS3KeysFromContent(story.description ?? "");
		// Sort for stability so reordering the description does not refetch.
		return keys.slice().sort().join("\n");
	}, [story.description]);
	const storyMediaRagContexts =
		resolvedStoryMedia.sig === storyMediaKeysSig
			? resolvedStoryMedia.items
			: EMPTY_STRING_ARRAY;

	useEffect(() => {
		if (!storyMediaKeysSig) {
			// Empty content — make sure any stale resolved tuple is dropped.
			setResolvedStoryMedia({ sig: "", items: [] });
			return;
		}
		let cancelled = false;
		const load = async (): Promise<void> => {
			try {
				const result =
					await orpcClient.projects.stories.resolveMediaForAgent({
						projectId,
						userStoryId: story.id,
						organizationId: organizationId ?? null,
					});
				if (cancelled) {
					return;
				}
				setResolvedStoryMedia({
					sig: storyMediaKeysSig,
					items: result.items.map(
						(it: { ragContextMarkdown: string }) =>
							it.ragContextMarkdown,
					),
				});
			} catch (e) {
				if (!cancelled) {
					console.warn(
						"[StoryWorkspace] resolveMediaForAgent failed; chat will run without story-media multimodal context",
						e,
					);
					// On failure, store an empty tuple under the current sig
					// so the derived `storyMediaRagContexts` resolves to []
					// (rather than falling back to a stale resolved tuple
					// from a previous story whose sig happens to differ).
					setResolvedStoryMedia({
						sig: storyMediaKeysSig,
						items: [],
					});
				}
			}
		};
		void load();
		return () => {
			cancelled = true;
		};
	}, [projectId, story.id, organizationId, storyMediaKeysSig]);

	// Context-only (UNLOCKED) attachment TEXT for the Feature Assistant.
	//
	// Sibling of the story-media block above and structured the same way: a
	// server procedure does the reading (the agent is stateless and cannot
	// touch the database or storage), and its returned strings merge into the
	// same `ragContexts` the agent already consumes.
	//
	// The trigger is the shared attachments query rather than a content
	// signature, because unlike story-media there is nothing in the description
	// to derive one from. Sharing AttachmentsTab's cache key is also what makes
	// a designation toggle take effect here: the tab invalidates that key, this
	// query refetches, the sig below changes, and the text is re-resolved. A
	// fetch keyed only on `story.id` would keep serving the pre-toggle answer
	// until the workspace remounted.
	const { data: attachmentsForContext } = useQuery({
		...storyAttachmentsQueryOptions({
			projectId,
			storyId: story.id,
			organizationId: organizationId ?? null,
		}),
		// The panel owns freshness; this is a passive reader.
		staleTime: 30_000,
	});

	// Only rows the resolver would actually deliver contribute to the sig, so
	// uploading an image or toggling a protected asset does not churn a refetch
	// that would return the same strings.
	const attachmentContextSig = useMemo(() => {
		const rows = attachmentsForContext?.attachments ?? [];
		return rows
			.filter(
				(a: { designation: string; mimeType: string }) =>
					a.designation === "UNLOCKED" &&
					isAiContextEligibleAttachmentMime(a.mimeType),
			)
			.map((a: { id: string }) => a.id)
			.sort()
			.join("\n");
	}, [attachmentsForContext]);

	const [resolvedAttachmentContexts, setResolvedAttachmentContexts] =
		useState<{
			sig: string;
			items: string[];
		}>({ sig: "", items: [] });
	const attachmentRagContexts =
		resolvedAttachmentContexts.sig === attachmentContextSig
			? resolvedAttachmentContexts.items
			: EMPTY_STRING_ARRAY;

	useEffect(() => {
		if (!attachmentContextSig) {
			setResolvedAttachmentContexts({ sig: "", items: [] });
			return;
		}
		let cancelled = false;
		const load = async (): Promise<void> => {
			try {
				const result =
					await orpcClient.projects.stories.resolveAttachmentContextForAgent(
						{
							projectId,
							userStoryId: story.id,
							organizationId: organizationId ?? null,
						},
					);
				if (cancelled) {
					return;
				}
				setResolvedAttachmentContexts({
					sig: attachmentContextSig,
					items: result.contexts,
				});
			} catch (e) {
				if (!cancelled) {
					console.warn(
						"[StoryWorkspace] resolveAttachmentContextForAgent failed; chat will run without context-only attachment text",
						e,
					);
					// Store an empty tuple under the CURRENT sig so the derived
					// value resolves to [] rather than falling back to a stale
					// tuple from a previous story.
					setResolvedAttachmentContexts({
						sig: attachmentContextSig,
						items: [],
					});
				}
			}
		};
		void load();
		return () => {
			cancelled = true;
		};
	}, [projectId, story.id, organizationId, attachmentContextSig]);

	// Single memoized merge of every rag-context source. Computing this once
	// per tuple — rather than spreading inline at every readable/mirror site —
	// keeps the array reference stable across unrelated re-renders. Downstream
	// consumers of `useCopilotReadable` and the `useCoAgent` mirror compare by
	// reference for re-registration / re-send decisions; inline spreads created
	// a fresh array every render and made the `EMPTY_STRING_ARRAY` stability
	// promise (kept above for the stale-tuple fallback) ineffective here.
	const mergedRagContexts = useMemo(
		() => [
			// Records back to plain strings here, so everything downstream —
			// the readable, the agent, the wire format — is unchanged.
			...uploadedRagContexts.map((c) => c.entry),
			...storyMediaRagContexts,
			...attachmentRagContexts,
		],
		[uploadedRagContexts, storyMediaRagContexts, attachmentRagContexts],
	);

	// What this surface is already carrying, for the upload hook's budget and
	// image-count checks. Story media and resolved attachment contexts count
	// toward the bytes because they ride the same request body; only chat
	// uploads count toward the image cap, since those are the ones the cap's
	// copy tells the user they can remove.
	const residentContextRef = useRef<{ bytes: number; imageCount: number }>({
		bytes: 0,
		imageCount: 0,
	});
	residentContextRef.current = useMemo(
		() => ({
			bytes:
				uploadedRagContexts.reduce((sum, c) => sum + c.bytes, 0) +
				storyMediaRagContexts.reduce(
					(sum, e) => sum + contextEntryBytes(e),
					0,
				) +
				attachmentRagContexts.reduce(
					(sum, e) => sum + contextEntryBytes(e),
					0,
				),
			imageCount: uploadedRagContexts.filter((c) => c.isImage).length,
		}),
		[uploadedRagContexts, storyMediaRagContexts, attachmentRagContexts],
	);
	const getResidentContext = useCallback(
		() => residentContextRef.current,
		[],
	);
	// Only the chat uploads are ours to drop — story media and resolved
	// attachment contexts are derived from the feature itself and come back on
	// the next render regardless.
	const uploadedCountRef = useRef(0);
	uploadedCountRef.current = uploadedRagContexts.length;

	useCopilotReadable({
		description:
			"RAG context — content extracted from files the user has attached in this chat session AND images attached to the active UserStory itself. Each entry is prefixed with the filename and contains either the raw text (documents) or a markdown image link with a base64 data URL (images, for vision-capable models).",
		value: {
			ragContexts: mergedRagContexts,
			ragContextsCount: mergedRagContexts.length,
		},
	});

	// The readable above is the ONLY channel carrying this payload, deliberately.
	//
	// It used to be mirrored onto `useCoAgent` state as well, so the AG-UI wire
	// payload carried the file content on BOTH `input.context` and
	// `input.state.ragContexts`. That was described as safe belt-and-suspenders
	// against a readable arriving stale on a turn racing the upload commit. It
	// is neither safe nor protective, and it is what broke the assistant on any
	// message carrying an image:
	//
	//   - The agent uses exactly ONE of the two. Its precedence is
	//     `readable (if non-empty) > state > input`
	//     (`project-document-generator/unified-server.ts:479-485`), so whenever
	//     the readable is populated — which is whenever the mirror had anything
	//     to mirror — the state copy is read by nothing and discarded.
	//   - An image entry is a base64 data URL. Sending it twice doubles the
	//     request body, and two ~2.3 MB images put a single ~4.8 MB screenshot's
	//     turn over the hosting platform's serverless request-body cap. The POST
	//     is rejected with 413 before it ever reaches the model, and because the
	//     entry stays in the thread's contexts, EVERY later turn — including
	//     plain text with no attachment — is rejected too. The thread is dead
	//     for good (Fizzy #2167).
	//   - The race it named was already fixed, properly, somewhere else.
	//     `handleAttachmentExtracted` commits the upload with `flushSync`
	//     precisely so the readable is fresh before CopilotKit collects context
	//     for the in-flight run. The mirror sat on top of that as redundancy,
	//     and could not have been fresher regardless: both channels read the
	//     same `mergedRagContexts` memo, the readable is registered during
	//     render, and the mirror ran in a post-commit effect — strictly
	//     not-earlier.
	//
	// A context that genuinely must survive the `readable non-empty > state`
	// short-circuit gets its own state field instead — see `refreshSpecContexts`
	// below, which is state-only by design for exactly that reason.

	// Drop stale refresh context on story switch so a previous
	// story's transcript never bleeds into a different story's chat. The field
	// otherwise persists on agent state across turns (invisible, replaced by the
	// next refresh); clearing it here bounds it to the story it was fetched for.
	useEffect(() => {
		setAgentStateRef.current({
			refreshSpecContexts: [] as string[],
		} as AgentState);
	}, [story.id]);

	// Same reasoning, applied to chat uploads: this component is mounted without
	// a `key` (see `StoryWorkspacePage`), so it survives a story switch and the
	// uploads would otherwise follow the user to an unrelated feature — carrying
	// their bytes into its request budget as well as their content into its
	// prompt.
	useEffect(() => {
		clearUploadedRagContexts();
	}, [story.id, clearUploadedRagContexts]);

	// Recover the thread when a request comes back 413.
	//
	// Dropping the uploads is the whole point rather than a side effect: the
	// request never reached the model, so nothing is lost by discarding them,
	// while KEEPING them guarantees every later turn is refused too — including
	// plain text with no attachment. That is the state users described as the
	// chat being dead, with no way out but a new conversation (Fizzy #2167).
	//
	// The 413's own toast, raised by the interceptor, already explains the
	// cause; this one only reports what was done about it, and only when there
	// was in fact something to drop.
	useEffect(() => {
		const onTooLarge = () => {
			if (uploadedCountRef.current === 0) {
				return;
			}
			clearUploadedRagContexts();
			toast.info(
				"Attachments cleared so you can keep chatting. Re-attach a smaller image to try again.",
			);
		};
		window.addEventListener(AI_REQUEST_TOO_LARGE_EVENT, onTooLarge);
		return () => {
			window.removeEventListener(AI_REQUEST_TOO_LARGE_EVENT, onTooLarge);
		};
	}, [clearUploadedRagContexts]);

	// FIFO queue of per-message attachment batches — mirrors the wiring in
	// DocumentEditor. See `CopilotPersistenceHook.tsx` for the queue
	// ordering rationale.
	const pendingAttachmentsRef = useRef<
		Array<
			Array<{
				id: string;
				s3Path: string;
				name: string;
				mimeType: string;
				sizeBytes?: number;
				kind: "image" | "file";
			}>
		>
	>([]);
	const handleAttachmentsForNextMessage = useCallback(
		(
			attachments: Array<{
				id: string;
				s3Path: string;
				name: string;
				mimeType: string;
				sizeBytes?: number;
				kind: "image" | "file";
			}>,
		) => {
			pendingAttachmentsRef.current.push(attachments);
		},
		[],
	);

	// Force the live editor content into the agent's `document` state field
	// immediately before every chat send. `useCoAgent` is bidirectional, so an
	// agent reply that omits `document` syncs an empty value back onto the
	// frontend state (see unified-server.ts:888-891) — without re-asserting it
	// here, the next turn ships an empty `state.document` and the agent answers
	// as if it cannot see the open feature's sections. The `flushSync` commits
	// the update synchronously so CopilotKit's outgoing state snapshot carries
	// it. A stable callback (delegating through a per-render-refreshed ref)
	// keeps the input factory memo from re-registering. Partial-update form
	// only — never spread a stale `agentState` (see note at setAgentStateRef).
	const syncDocumentBeforeSendRef = useRef<() => void>(() => {});
	syncDocumentBeforeSendRef.current = () => {
		if (!editor) {
			return;
		}
		// This only mirrors editor content into the agent's
		// context state (not a save) — `?? ""` is fine here; a failed read
		// just means the agent temporarily sees an empty document.
		const markdown = getEditorMarkdownForSave(editor) ?? "";
		flushSync(() => {
			setAgentStateRef.current({ document: markdown } as AgentState);
		});
	};
	const handleBeforeSend = useCallback(() => {
		syncDocumentBeforeSendRef.current();
	}, []);

	// Custom CopilotSidebar Input with paste/drop + paperclip attachment support.
	const CustomSidebarInput = useMemo(
		() =>
			createCopilotSidebarInput({
				organizationId: organizationId ?? null,
				surface: "feature-assistant",
				onContentExtracted: handleAttachmentExtracted,
				getResidentContext,
				allowedImageTypes: ["image/jpeg", "image/png"],
				maxImageCount: 5,
				attachmentDisabled: !canEdit,
				attachmentDisabledReason:
					"You need edit access to attach images.",
				// PM-locked compression for the AI Feature Assistant only.
				// Document editor surfaces omit these so they inherit the
				// existing 2000 px / 0.85 defaults.
				compressionMaxDimension: 1024,
				compressionQuality: 0.8,
				onAttachmentsForNextMessage: handleAttachmentsForNextMessage,
				onBeforeSend: handleBeforeSend,
				onUserSend: markUserRunInitiated,
				onUserSendFailed: clearUserRunMark,
			}),
		[
			organizationId,
			handleAttachmentExtracted,
			getResidentContext,
			canEdit,
			handleAttachmentsForNextMessage,
			handleBeforeSend,
			markUserRunInitiated,
			clearUserRunMark,
		],
	);

	// Suggestion chips and the assistant bubble's "Regenerate" button both
	// start a run through CopilotKit internals, bypassing the custom
	// `Input`'s `onUserSend` — see `run-mark-wrappers.tsx`. Memoized on
	// `markUserRunInitiated` (a stable identity from `useUserRunSignal`) so
	// `<CopilotSidebar>`'s `AssistantMessage` / `RenderSuggestionsList`
	// props keep a stable component identity across renders.
	const AssistantMessageWithMark = useMemo(
		() =>
			makeAssistantMessageWithRunMark(
				CopilotAssistantMessage,
				markUserRunInitiated,
			),
		[markUserRunInitiated],
	);
	const SuggestionsListWithMark = useMemo(
		() => makeSuggestionsListWithRunMark(markUserRunInitiated),
		[markUserRunInitiated],
	);

	// Group E — feature flag (FR-27) for the chat-history header. Returns
	// true for personal context and for orgs with the flag ON. When false,
	// the `Header` prop on `<CopilotSidebar>` is left at its CopilotKit
	// default (no plus/history/visibility chip), the
	// `<CopilotHistoryDrawer>` is not mounted, and the persistence hook is
	// not mounted — mirrors `DocumentEditor.tsx`'s wiring.
	const documentAssistantHistoryEnabled =
		useDocumentAssistantHistoryEnabled();
	// Group E — CopilotKit's live message-store setter (FR-10). The
	// plus-icon affordance calls `setCopilotMessages([])` to clear the
	// transcript so the next user input lazy-creates a fresh row.
	// `useCopilotChatInternal` (not `useCopilotMessagesContext` —
	// CopilotKit 1.52 routes the live store through the internal hook)
	// is the writer that surfaces in the sidebar's LIVE half. The
	// historical half (`<HydratedMessagesProvider>`) is cleared
	// implicitly when `activeAssistantConversationId` flips. Read via the
	// shared session so this call site doesn't open its own connect.
	const { setMessages: setCopilotMessages } = useCopilotChatSession();

	// Group E — "New conversation" affordance handler (FR-10).
	// Mirrors `DocumentEditor.handleNewConversation` so both surfaces behave
	// identically:
	//   1. Archive the live thread server-side (if one exists).
	//   2. Null out the local conversationId AND reset visibility to the
	//      SHARED + unlocked defaults so the next user input lazy-creates a
	//      brand-new row.
	//   3. Clear CopilotKit's in-memory transcript so the user sees a fresh
	//      greeting (same path the empty-thread first-load takes).
	//   4. Toast a polite confirmation so the user knows their click took
	//      effect.
	//
	// Failure handling: if the archive call fails (network blip, FORBIDDEN,
	// feature-flag), local state still resets so the UI isn't stuck — the
	// worst case is "the old thread reappears on next reload", which is
	// safer than silently leaving the user staring at the previous
	// transcript.
	const handleNewConversation = useCallback(async () => {
		const archivingId = activeAssistantConversationId;
		try {
			if (archivingId) {
				await orpcClient.agents.conversations.archiveForDocument({
					conversationId: archivingId,
					organizationId: organizationId ?? null,
				});
			}
			setActiveAssistantConversationId(null);
			setActiveAssistantVisibility("SHARED");
			setActiveAssistantVisibilityLockedAt(null);
			setCopilotMessages([]);
			// Uploads belong to the conversation that was archived. Leaving them
			// resident is how a "new chat" started already carrying the previous
			// one's images — and, when those were what breached the body cap, how
			// the fresh conversation inherited the failure (Fizzy #2167).
			clearUploadedRagContexts();
			toast.success("Started a new conversation");
		} catch (err) {
			setActiveAssistantConversationId(null);
			setActiveAssistantVisibility("SHARED");
			setActiveAssistantVisibilityLockedAt(null);
			setCopilotMessages([]);
			// Uploads belong to the conversation that was archived. Leaving them
			// resident is how a "new chat" started already carrying the previous
			// one's images — and, when those were what breached the body cap, how
			// the fresh conversation inherited the failure (Fizzy #2167).
			clearUploadedRagContexts();
			const message =
				err instanceof Error
					? err.message
					: "Could not archive the previous conversation.";
			toast.error(message);
		}
	}, [
		activeAssistantConversationId,
		organizationId,
		setCopilotMessages,
		clearUploadedRagContexts,
	]);

	const handleOpenHistory = useCallback(() => {
		setHistoryDrawerOpen(true);
	}, []);

	// Custom CopilotSidebar Header — only assembled when the org has the
	// chat-history feature flag ON. When OFF, the `Header` prop on
	// `<CopilotSidebar>` is left at its CopilotKit default so existing
	// behaviour is unchanged for orgs that have disabled the feature
	// (FR-27).
	const CustomSidebarHeader = useMemo(() => {
		if (!documentAssistantHistoryEnabled) {
			return undefined;
		}
		return createCopilotSidebarHeader({
			title: "AI Feature Assistant",
			documentRefKind,
			documentRefId: story.id,
			projectId,
			organizationId: organizationId ?? null,
			conversationId: activeAssistantConversationId,
			visibility: activeAssistantVisibility,
			visibilityLockedAt: activeAssistantVisibilityLockedAt,
			onNewConversation: handleNewConversation,
			onOpenHistory: handleOpenHistory,
			// Mirror DocumentEditor: lifts pre-first-send chip toggle into
			// parent state so the persistence hook's `requestedVisibility`
			// matches the user's choice on lazy-create.
			onVisibilityChange: setActiveAssistantVisibility,
		});
	}, [
		documentAssistantHistoryEnabled,
		documentRefKind,
		story.id,
		projectId,
		organizationId,
		activeAssistantConversationId,
		activeAssistantVisibility,
		activeAssistantVisibilityLockedAt,
		handleNewConversation,
		handleOpenHistory,
	]);

	// Branded reopen launcher for the AI Feature Assistant. Gated on the same
	// chat-history flag as the header: when OFF, leaving `Button` undefined
	// keeps CopilotKit's default round launcher; when ON, the header owns
	// closing (its X button) and this pill owns reopening (it renders only
	// while the panel is closed).
	const CustomSidebarLauncher = useMemo(() => {
		if (!documentAssistantHistoryEnabled) {
			return undefined;
		}
		return createCopilotSidebarLauncher();
	}, [documentAssistantHistoryEnabled]);

	return (
		<AttachmentRegistryProvider
			pendingAttachmentsRef={pendingAttachmentsRef}
			initialAttachmentsByMessageId={initialAttachmentsByMessageId}
		>
			<DocumentAssistantOutcomesProvider
				documentRefKind={documentRefKind}
				documentRefId={story.id}
				projectId={projectId}
				organizationId={organizationId ?? null}
			>
				<HydratedMessagesProvider
					initialMessages={effectiveAssistantMessages ?? []}
					ssrConversationId={effectiveSsrConversationId}
					activeConversationId={activeAssistantConversationId}
					documentRefKind={documentRefKind}
					documentRefId={story.id}
					projectId={projectId}
					organizationId={organizationId ?? null}
				>
					<CopilotSidebar
						AssistantMessage={AssistantMessageWithMark}
						UserMessage={CopilotUserMessage}
						Messages={CustomMessages}
						defaultOpen={true}
						clickOutsideToClose={false}
						Input={CustomSidebarInput}
						RenderSuggestionsList={SuggestionsListWithMark}
						// Group E. `CustomSidebarHeader` is `undefined` when the
						// org has the chat-history feature flag OFF — CopilotKit's
						// default header renders instead.
						Header={CustomSidebarHeader}
						// Group E (cont). When the chat-history flag is OFF,
						// `CustomSidebarLauncher` is undefined and CopilotKit's default
						// round launcher renders. When ON, the header owns closing and
						// this branded pill owns reopening.
						Button={CustomSidebarLauncher}
						labels={{
							title: "AI Feature Assistant",
							initial:
								"Hi! I can help you refine this feature. Ask me to:\n\n" +
								"- Improve the feature description\n" +
								"- Generate acceptance criteria in Given-When-Then format\n" +
								"- Suggest feature sizing\n" +
								"- Draw an Excalidraw diagram (architecture, flow, etc.)\n\n" +
								"Just type your request or use the suggestions below.",
						}}
						suggestions={[
							{
								title: "Improve description",
								message: `Please improve the description section of this feature. Make it more detailed, user-focused, and follow the "As a [persona], I want [action], so that [benefit]" format. Keep the existing acceptance criteria.`,
							},
							{
								title: "Generate acceptance criteria",
								message:
									"Generate comprehensive acceptance criteria for this feature using the Given-When-Then format. Include edge cases and error scenarios. Keep the existing description.",
							},
							{
								title: "Suggest size",
								message:
									"Analyze this feature's complexity and suggest an appropriate T-shirt size (XS, S, M, L, XL) with your reasoning. Consider the scope of work, technical complexity, and acceptance criteria.",
							},
						]}
					>
						{/* Below `sm`, CopilotKit renders this sidebar
						    FULL-SCREEN, so `defaultOpen` buries the whole
						    feature editor behind the chat. Measured on a phone
						    viewport: the tab bar sat at x=499 in a 360px
						    window and nothing but the assistant was reachable —
						    no tabs, no specification, no Testing. Closed on
						    arrival there instead; the launcher still opens it.
						    Done from inside the sidebar because `defaultOpen`
						    is read once at mount, and this component wraps the
						    entire editor, so gating its mount on a measured
						    viewport would delay the page rather than the chat. */}
						<CloseAssistantOnNarrowViewport />

						{/* Group H — persists each terminal-state CopilotKit
			    message via `appendTurnForDocument` (FR-2,
			    AC-5/AC-6/AC-7). Side-effect-only component (renders
			    `null`). Mounted inside <CopilotSidebar> so the
			    `useCopilotChatSession()` read resolves against the same
			    provider the sidebar consumes. Gated on the feature flag
			    to mirror the sidebar header + history drawer mounts.
			    `agentId` matches the `useCoAgent` config above
			    (`project_document_generator`). */}
						{documentAssistantHistoryEnabled ? (
							<CopilotPersistenceHook
								documentRefKind={documentRefKind}
								documentRefId={story.id}
								projectId={projectId}
								organizationId={organizationId ?? null}
								conversationId={activeAssistantConversationId}
								onConversationIdResolved={
									setActiveAssistantConversationId
								}
								onSpilled={setActiveAssistantConversationId}
								requestedVisibility={activeAssistantVisibility}
								agentId="project_document_generator"
								pendingAttachmentsRef={pendingAttachmentsRef}
								initialPersistedMessageIds={
									effectivePersistedMessageIds
								}
							/>
						) : null}
						<div className="flex flex-col h-full bg-background">
							{/* Title slot — portaled into the page-level title row (line 1
				  of the new title-top header). The state stays here because the
				  input is bound to local title/setTitle + the AI regenerate
				  mutation also lives in this component. */}
							{titleSlot &&
								createPortal(
									<>
										{/* Title field — Sparkles regen lives INSIDE the input as a
							  leading affordance (Notion / search-icon pattern). The
							  unified relative wrapper means hover/focus highlights the
							  whole frame including the icon, so the action reads as
							  "AI on the title field" regardless of how short the title
							  is. The icon is absolutely positioned + a left padding on
							  the Input clears space for it. */}
										<div className="relative flex-1 min-w-0">
											{/* Regenerate-title button disable rules (AC-11):
								  - description empty → disabled; tooltip says "Add a description first."
								  - mutation in-flight → disabled; tooltip says regen is running.
								  Otherwise → enabled; tooltip describes the action. */}
											{(() => {
												const isDescriptionEmpty =
													(
														story.description ?? ""
													).trim().length === 0;
												return (
													<TooltipProvider>
														<Tooltip>
															<TooltipTrigger
																asChild
															>
																<Button
																	type="button"
																	variant="ghost"
																	size="icon"
																	data-testid="regenerate-title-button"
																	disabled={
																		isDescriptionEmpty ||
																		regenerateTitleMutation.isPending
																	}
																	onClick={() =>
																		regenerateTitleMutation.mutate()
																	}
																	aria-label={tWorkspace(
																		"regenerateTitleAction",
																	)}
																	className="absolute left-1.5 top-1/2 -translate-y-1/2 size-7 z-10 text-muted-foreground hover:text-foreground"
																>
																	{regenerateTitleMutation.isPending ? (
																		<Loader2Icon
																			className="size-4 motion-safe:animate-spin"
																			aria-hidden="true"
																		/>
																	) : (
																		<SparklesIcon
																			className="size-4"
																			aria-hidden="true"
																		/>
																	)}
																</Button>
															</TooltipTrigger>
															<TooltipContent side="bottom">
																<p>
																	{tWorkspace(
																		isDescriptionEmpty
																			? "regenerateTitleEmptyDescription"
																			: regenerateTitleMutation.isPending
																				? "regenerateTitleInFlight"
																				: "regenerateTitleTooltip",
																	)}
																</p>
															</TooltipContent>
														</Tooltip>
													</TooltipProvider>
												);
											})()}
											<TooltipProvider>
												<Tooltip
													open={
														showTitleTooltip
															? undefined
															: false
													}
												>
													<TooltipTrigger asChild>
														<Input
															ref={titleInputRef}
															value={title}
															onChange={(e) => {
																setTitle(
																	e.target
																		.value,
																);
																setHasUnsavedChanges(
																	true,
																);
															}}
															onFocus={() =>
																setIsTitleFocused(
																	true,
																)
															}
															onBlur={() =>
																setIsTitleFocused(
																	false,
																)
															}
															placeholder="Story title..."
															className="h-auto py-1.5 pl-10 pr-3 text-xl md:text-2xl font-semibold tracking-tight border border-transparent shadow-none w-full transition-colors hover:bg-muted/40 hover:border-border focus-visible:bg-background focus-visible:border-input focus-visible:ring-1 focus-visible:ring-ring cursor-text truncate"
														/>
													</TooltipTrigger>
													<TooltipContent
														side="bottom"
														className="max-w-[min(90vw,640px)] break-words text-wrap"
													>
														<p>{title}</p>
													</TooltipContent>
												</Tooltip>
											</TooltipProvider>
										</div>
										<CopyLinkButton
											identifier={story.identifier}
											title={title}
											storyId={story.id}
											projectId={projectId}
											organizationSlug={paramOrgSlug}
										/>
										<NotifyButton
											storyId={story.id}
											projectId={projectId}
											organizationId={
												organizationId ?? null
											}
										/>
									</>,
									titleSlot,
								)}

							{/* Action slot — Show raw + Version history. These read showRaw +
				  the regenerate-mutation state that lives here. */}
							{actionSlot &&
								createPortal(
									<>
										<TooltipProvider>
											<Tooltip>
												<TooltipTrigger asChild>
													<Button
														variant={
															showRaw
																? "secondary"
																: "ghost"
														}
														size="sm"
														onClick={() => {
															if (
																!showRaw &&
																editor
															) {
																const markdown =
																	getEditorMarkdownForSave(
																		editor,
																	);
																// Null means serialization
																// failed — don't switch to raw view with
																// lost content, and don't let a later raw-mode
																// save persist it.
																if (
																	markdown ===
																	null
																) {
																	toast.error(
																		"Couldn't read the editor content — please try again or reload the page.",
																	);
																	return;
																}
																setCurrentDocument(
																	markdown,
																);
															} else if (
																showRaw &&
																editor
															) {
																const repaired =
																	repairMarkdownDocument(
																		currentDocument,
																	);
																setCurrentDocument(
																	repaired,
																);
																editor.commands.setContent(
																	fromMarkdown(
																		repaired,
																		USER_CONTENT_MD_OPTIONS,
																	),
																);
															}
															setShowRaw(
																!showRaw,
															);
														}}
														disabled={isAiLoading}
														aria-label={
															showRaw
																? "Switch to rich editor"
																: "View raw markdown"
														}
													>
														<CodeIcon className="size-4" />
													</Button>
												</TooltipTrigger>
												<TooltipContent>
													<p>
														{showRaw
															? "Switch to rich editor"
															: "View raw markdown"}
													</p>
												</TooltipContent>
											</Tooltip>
										</TooltipProvider>
										<SubscribeToggle
											subjectType="FEATURE"
											subjectId={story.id}
											projectId={projectId}
										/>
										<TooltipProvider>
											<Tooltip>
												<TooltipTrigger asChild>
													<Button
														variant="ghost"
														size="sm"
														onClick={() =>
															setShowVersionHistory(
																true,
															)
														}
														aria-label={`Version history, current v${
															story.version ?? 1
														}`}
													>
														<HistoryIcon className="size-4 mr-1" />
														<span className="text-xs text-muted-foreground">
															v
															{story.version ?? 1}
														</span>
													</Button>
												</TooltipTrigger>
												<TooltipContent>
													<p>Version history</p>
												</TooltipContent>
											</Tooltip>
										</TooltipProvider>
										{/* Block / Unblock control. When blocked, a single
								  Unblock button clears the flag; when not blocked, a
								  popover collects an optional reason before blocking. */}
										{story.blocked ? (
											<Popover
												open={blockPopoverOpen}
												onOpenChange={(open) => {
													setBlockPopoverOpen(open);
													// Pre-fill the editor
													// with the current reason
													// when opening.
													setBlockReason(
														open
															? (story.blockedReason ??
																	"")
															: "",
													);
												}}
											>
												<PopoverTrigger asChild>
													<button
														type="button"
														aria-label="Blocked — click to edit the reason or unblock"
														className="inline-flex items-center gap-1 rounded-full border border-destructive/40 bg-destructive/10 px-2.5 py-1 font-medium text-[11px] text-destructive transition-colors hover:bg-destructive/20"
													>
														<OctagonXIcon
															aria-hidden="true"
															className="size-3.5"
														/>
														Blocked
													</button>
												</PopoverTrigger>
												<PopoverContent
													align="end"
													className="w-80 space-y-3"
												>
													<div className="space-y-1">
														<Label
															htmlFor="block-reason"
															className="font-medium text-sm"
														>
															This work item is
															blocked
														</Label>
														<p className="text-muted-foreground text-xs">
															Edit the reason or
															unblock. Changes are
															recorded in the
															version history.
														</p>
													</div>
													<Textarea
														id="block-reason"
														value={blockReason}
														onChange={(e) =>
															setBlockReason(
																e.target.value,
															)
														}
														placeholder="Reason (optional)"
														rows={3}
														maxLength={2000}
													/>
													<div className="flex items-center justify-between gap-2">
														<Button
															variant="ghost"
															size="sm"
															className="text-destructive hover:text-destructive"
															onClick={() =>
																setBlockedMutation.mutate(
																	{
																		blocked: false,
																	},
																)
															}
															disabled={
																setBlockedMutation.isPending
															}
														>
															{setBlockedMutation.isPending ? (
																<Loader2Icon className="mr-1 size-4 animate-spin" />
															) : (
																<OctagonXIcon className="mr-1 size-4" />
															)}
															Unblock
														</Button>
														<Button
															size="sm"
															onClick={() =>
																setBlockedMutation.mutate(
																	{
																		blocked: true,
																		reason:
																			blockReason.trim() ||
																			undefined,
																	},
																)
															}
															disabled={
																setBlockedMutation.isPending
															}
														>
															Save reason
														</Button>
													</div>
												</PopoverContent>
											</Popover>
										) : (
											<Popover
												open={blockPopoverOpen}
												onOpenChange={(open) => {
													setBlockPopoverOpen(open);
													if (!open) {
														setBlockReason("");
													}
												}}
											>
												<PopoverTrigger asChild>
													<Button
														variant="ghost"
														size="sm"
													>
														<OctagonXIcon className="size-4 mr-1" />
														Block
													</Button>
												</PopoverTrigger>
												<PopoverContent
													align="end"
													className="w-80 space-y-3"
												>
													<div className="space-y-1">
														<Label
															htmlFor="block-reason"
															className="text-sm font-medium"
														>
															Block this work item
														</Label>
														<p className="text-xs text-muted-foreground">
															Add an optional
															reason. It shows on
															the Blocked chip's
															hover and is
															recorded in the
															version history.
														</p>
													</div>
													<Textarea
														id="block-reason"
														value={blockReason}
														onChange={(e) =>
															setBlockReason(
																e.target.value,
															)
														}
														placeholder="Reason (optional)"
														rows={3}
														maxLength={2000}
													/>
													<div className="flex justify-end gap-2">
														<Button
															variant="ghost"
															size="sm"
															onClick={() =>
																setBlockPopoverOpen(
																	false,
																)
															}
															disabled={
																setBlockedMutation.isPending
															}
														>
															Cancel
														</Button>
														<Button
															variant="destructive"
															size="sm"
															onClick={() =>
																setBlockedMutation.mutate(
																	{
																		blocked: true,
																		reason:
																			blockReason.trim() ||
																			undefined,
																	},
																)
															}
															disabled={
																setBlockedMutation.isPending
															}
														>
															{setBlockedMutation.isPending && (
																<Loader2Icon className="size-4 mr-1 animate-spin" />
															)}
															Block
														</Button>
													</div>
												</PopoverContent>
											</Popover>
										)}
									</>,
									actionSlot,
								)}

							{/* Save slot — Save split-button. Separate from actionSlot so the
				  page can position it after StartWork on the action bar.
				  Save is just Save — when the PM-sync cloud toggle is on, the
				  push is handled by the toggle itself (immediate for unlinked
				  features) and by the server-side gate at update-story.ts on
				  every subsequent save. We deliberately do NOT change the
				  button label to "Save & Push" because that promises an
				  action the click can't deliver: the Save PATCH does NOT
				  carry `pmAutoSyncEnabled`, so for an unlinked story the
				  server gate would fall through to the `no-external-id`
				  short-circuit and silently no-op. The cloud-icon tooltip
				  is now the single source of truth for "what happens on
				  save". */}
							{saveSlot &&
								createPortal(
									(() => {
										const isSaved =
											!isSaving && !hasUnsavedChanges;
										const isPrimaryDisabled =
											isSaving || isSaved;
										const primaryLabel = isSaving
											? "Saving…"
											: isSaved
												? "Saved"
												: "Save";
										const primaryAriaLabel = isSaving
											? "Saving"
											: isSaved
												? "Story saved, no changes to save"
												: "Save story";
										const PrimaryIcon = isSaving
											? Loader2Icon
											: isSaved
												? CheckIcon
												: SaveIcon;
										return (
											<div className="flex">
												<Button
													size="sm"
													className="rounded-r-none"
													onClick={() => {
														isManualSaveRef.current = false;
														handleSave();
													}}
													disabled={isPrimaryDisabled}
													aria-label={
														primaryAriaLabel
													}
												>
													<PrimaryIcon
														className={`size-4 mr-2 ${
															isSaving
																? "motion-safe:animate-spin"
																: ""
														}`}
													/>
													{primaryLabel}
												</Button>
												<DropdownMenu modal={false}>
													<DropdownMenuTrigger
														asChild
													>
														<Button
															size="sm"
															className="rounded-l-none border-l border-primary-foreground/20 px-2"
															disabled={
																isPrimaryDisabled
															}
															aria-label="More save options"
														>
															<ChevronDownIcon className="size-4" />
														</Button>
													</DropdownMenuTrigger>
													<DropdownMenuContent align="end">
														<DropdownMenuItem
															onSelect={() => {
																isManualSaveRef.current = true;
																handleSave();
															}}
															className="cursor-pointer rounded-md bg-primary text-primary-foreground focus:bg-primary/90 focus:text-primary-foreground data-[highlighted]:bg-primary/90 data-[highlighted]:text-primary-foreground"
														>
															<SaveIcon className="size-4 mr-2" />
															Save & Close
														</DropdownMenuItem>
													</DropdownMenuContent>
												</DropdownMenu>
											</div>
										);
									})(),
									saveSlot,
								)}

							{/* Drafting Stage Section.
				  The progress bar + current-stage label is itself the dropdown
				  trigger — clicking opens the picker. Selecting a stage sets a
				  pending target (applied on Save), so transitions go through
				  the same save flow as anything else. "Close feature" sits
				  under a divider as a target option of its own; if the feature
				  is currently CLOSED, picking any non-CLOSED stage is the
				  re-open path. */}
							{isUserGenerationActive && (
								<div className="flex items-center justify-between px-6 py-3 border-b">
									<div className="flex-1" />
									<div className="relative flex items-center gap-3 px-5 py-2 rounded-full bg-gradient-to-r from-violet-500/20 via-purple-500/20 to-fuchsia-500/20 border border-purple-500/40 shadow-lg shadow-purple-500/20">
										<div className="absolute inset-0 rounded-full bg-gradient-to-r from-violet-500/30 via-purple-500/30 to-fuchsia-500/30 animate-pulse" />
										<div
											className="absolute inset-0 rounded-full bg-purple-500/20 animate-ping opacity-50"
											style={{
												animationDuration: "1.5s",
											}}
										/>
										<Loader2Icon className="relative size-5 animate-spin text-purple-500" />
										<span className="relative text-base font-semibold bg-gradient-to-r from-violet-500 via-purple-500 to-fuchsia-500 bg-clip-text text-transparent">
											AI is generating...
										</span>
									</div>
									<div className="flex-1 flex justify-end">
										<FocusModeToggle />
									</div>
								</div>
							)}
							{!isUserGenerationActive &&
								(() => {
									const isBug = story.kind === "BUG";
									// F-171: bugs have a single-stage workflow (PLACEHOLDER →
									// DRAFT → CLOSED/DECLINED). No maturation pipeline; the
									// analysis stages are feature-only. Features keep the full
									// PLACEHOLDER → analysis → DRAFT → PUBLISHED progression.
									const activeStages: FeatureDraftingStage[] =
										isBug
											? [
													"PLACEHOLDER",
													"DRAFT",
													"PUBLISHED",
												]
											: [
													"PLACEHOLDER",
													"ACTIVE_ANALYSIS",
													"SANITY_CHECK",
													"DRAFT",
													"PUBLISHED",
												];
									// Effective stage = pending target if user picked one,
									// otherwise the actual stored stage. The indicator + the
									// dropdown checkmark both reference this so what the user
									// sees in the row matches what's "selected" in the menu.
									const effectiveStage =
										(targetStage as FeatureDraftingStage) ||
										story.draftingStage;
									// Historical PASSIVE_ANALYSIS rows that have not been migrated yet
									// fall back to PLACEHOLDER per OQ-2 — the stage is soft-deprecated
									// and excluded from DRAFTING_STAGE_META, so the lookup would otherwise
									// return undefined and crash the workspace render.
									const effectiveMeta =
										DRAFTING_STAGE_META[effectiveStage] ??
										DRAFTING_STAGE_META.PLACEHOLDER;
									const isClosing =
										effectiveStage === "CLOSED";
									const pickStage = (
										s: FeatureDraftingStage,
									) => {
										if (s === story.draftingStage) {
											// Picking the actual current stage is a no-op: clear
											// any pending target if one was set, otherwise leave
											// hasUnsavedChanges alone (the user may still have
											// other dirty fields on the form).
											if (targetStage) {
												setTargetStage("");
											}
											return;
										}
										if (s === targetStage) {
											return;
										}
										setTargetStage(s);
										setHasUnsavedChanges(true);
									};
									const totalStages = activeStages.length;
									const enhanceDisabled =
										!targetStage ||
										targetStage === "CLOSED";
									const updateContextDisabled =
										isAiLoading ||
										!orgContextReady ||
										contextUpdate.isActive;
									const isStagePickerLoading =
										isProjectLoading && !isProjectError;
									const currentStage =
										getMaturationStatus(story);
									const isClosed =
										story.draftingStage === "CLOSED";
									const currentMeta =
										MATURATION_STATUS_META[currentStage];

									return (
										<div className="flex items-center gap-2 px-6 py-2 border-b min-w-0 overflow-x-auto">
											{maturationV2 ? (
												<DropdownMenu>
													<DropdownMenuTrigger
														asChild
														disabled={
															isStagePickerLoading
														}
													>
														<button
															type="button"
															disabled={
																isStagePickerLoading
															}
															aria-label="Change maturation status"
															className="flex items-center gap-2 px-2 h-8 -ml-2 rounded-md hover:bg-muted/40 transition-colors group focus:outline-none focus-visible:outline-none focus-visible:bg-muted/40 disabled:opacity-50 disabled:cursor-not-allowed"
														>
															<span
																className="size-2 rounded-full shrink-0"
																style={{
																	backgroundColor:
																		isClosed
																			? "var(--muted-foreground)"
																			: currentMeta.color,
																}}
															/>
															<span
																className="text-xs font-medium"
																style={{
																	color: isClosed
																		? "var(--muted-foreground)"
																		: currentMeta.color,
																}}
															>
																{isClosed
																	? "Hidden"
																	: currentMeta.label}
															</span>
															{isStagePickerLoading ? (
																<Loader2Icon className="size-3 text-muted-foreground animate-spin" />
															) : (
																<ChevronDownIcon className="size-3 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
															)}
														</button>
													</DropdownMenuTrigger>
													<DropdownMenuContent
														align="start"
														className="w-48"
													>
														{getVisibleStageOptions(
															project?.hiddenMaturationStatuses ??
																[],
															currentStage,
														).map((ms) => {
															const meta =
																MATURATION_STATUS_META[
																	ms
																];
															const isCurrent =
																!isClosed &&
																ms ===
																	currentStage;
															return (
																<DropdownMenuItem
																	key={ms}
																	onSelect={() => {
																		if (
																			isCurrent
																		) {
																			return;
																		}
																		maturationStatusMutation.mutate(
																			buildMaturationStatusMutationPayload(
																				{
																					mode: "set",
																					targetMaturationStatus:
																						ms,
																					isCurrentlyClosed:
																						isClosed,
																				},
																			),
																		);
																	}}
																	className="cursor-pointer"
																>
																	<span
																		className="size-2 rounded-full mr-2 shrink-0"
																		style={{
																			backgroundColor:
																				meta.color,
																		}}
																	/>
																	<span className="flex-1">
																		{
																			meta.label
																		}
																	</span>
																	{isCurrent && (
																		<CheckIcon className="size-4 ml-2 text-muted-foreground" />
																	)}
																</DropdownMenuItem>
															);
														})}
														<DropdownMenuSeparator />
														<DropdownMenuItem
															onSelect={() => {
																if (isClosed) {
																	return;
																}
																maturationStatusMutation.mutate(
																	buildMaturationStatusMutationPayload(
																		{
																			mode: "hide",
																		},
																	),
																);
															}}
															className="cursor-pointer text-muted-foreground focus:text-foreground"
														>
															<CircleSlashIcon className="size-4 mr-2 shrink-0" />
															<span className="flex-1">
																Hidden
															</span>
															{isClosed && (
																<CheckIcon className="size-4 ml-2 text-muted-foreground" />
															)}
														</DropdownMenuItem>
													</DropdownMenuContent>
												</DropdownMenu>
											) : (
												<DropdownMenu
													open={isStageMenuOpen}
													onOpenChange={
														handleStageMenuOpenChange
													}
												>
													<TooltipProvider>
														<Tooltip
															open={
																isStageMenuOpen ||
																stageMenuRecentlyClosed
																	? false
																	: undefined
															}
														>
															<TooltipTrigger
																asChild
															>
																<DropdownMenuTrigger
																	asChild
																>
																	<button
																		type="button"
																		aria-label="Change drafting stage"
																		className="flex items-center gap-2 px-2 h-8 -ml-2 rounded-md hover:bg-muted/40 transition-colors group focus:outline-none focus-visible:outline-none focus-visible:bg-muted/40"
																	>
																		{/* Progress steps. When the feature is CLOSED the
													  steps render but all dots are blank/muted — the
													  drafting progress is no longer meaningful, but
													  keeping the row shape avoids the layout shifting
													  when the user picks Close vs another stage. */}
																		<div className="flex gap-0.5">
																			{activeStages.map(
																				(
																					s,
																				) => {
																					const sMeta =
																						DRAFTING_STAGE_META[
																							s
																						];
																					const isActive =
																						!isClosing &&
																						sMeta.order <=
																							effectiveMeta.order;
																					return (
																						<div
																							key={
																								s
																							}
																							className="h-1.5 w-4 rounded-full transition-colors"
																							style={{
																								backgroundColor:
																									isClosing
																										? "color-mix(in srgb, var(--muted-foreground) 20%, transparent)"
																										: isActive
																											? effectiveMeta.color
																											: `${effectiveMeta.color}20`,
																							}}
																						/>
																					);
																				},
																			)}
																		</div>
																		<span
																			className="text-xs font-medium"
																			style={{
																				color: isClosing
																					? "var(--muted-foreground)"
																					: effectiveMeta.color,
																			}}
																		>
																			{
																				effectiveMeta.label
																			}
																		</span>
																		<ChevronDownIcon className="size-3 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
																	</button>
																</DropdownMenuTrigger>
															</TooltipTrigger>
															<TooltipContent
																side="bottom"
																surface="popover"
															>
																<p className="font-medium">
																	Drafting
																	Stage:{" "}
																	{
																		effectiveMeta.label
																	}
																</p>
																<p className="text-xs text-muted-foreground">
																	{
																		effectiveMeta.description
																	}
																</p>
																{!isClosing && (
																	<p className="mt-1 text-xs text-muted-foreground">
																		Stage{" "}
																		{effectiveMeta.order +
																			1}{" "}
																		of{" "}
																		{
																			totalStages
																		}
																	</p>
																)}
															</TooltipContent>
														</Tooltip>
													</TooltipProvider>
													<DropdownMenuContent
														align="start"
														className="w-56"
													>
														{activeStages.map(
															(s) => {
																const sMeta =
																	DRAFTING_STAGE_META[
																		s
																	];
																const isCurrent =
																	s ===
																	effectiveStage;
																return (
																	<DropdownMenuItem
																		key={s}
																		onSelect={() =>
																			pickStage(
																				s,
																			)
																		}
																		className="cursor-pointer"
																	>
																		<span
																			className="size-2 rounded-full mr-2 shrink-0"
																			style={{
																				backgroundColor:
																					sMeta.color,
																			}}
																		/>
																		<span className="flex-1">
																			{
																				sMeta.label
																			}
																		</span>
																		{isCurrent && (
																			<CheckIcon className="size-4 ml-2 text-muted-foreground" />
																		)}
																	</DropdownMenuItem>
																);
															},
														)}
														<DropdownMenuSeparator />
														<DropdownMenuItem
															onSelect={() =>
																pickStage(
																	"CLOSED",
																)
															}
															className="cursor-pointer text-muted-foreground focus:text-foreground"
														>
															<CircleSlashIcon className="size-4 mr-2 shrink-0" />
															<span className="flex-1">
																Hidden
															</span>
															{effectiveStage ===
																"CLOSED" && (
																<CheckIcon className="size-4 ml-2 text-muted-foreground" />
															)}
														</DropdownMenuItem>
													</DropdownMenuContent>
												</DropdownMenu>
											)}
											<div className="flex-1" />
											{/* Enhance is hidden in Maturation V2 — the maturation
									  pipeline is driven by Refresh Clean Spec, and the stage
									  bar is replaced by the dummy status picker above. */}
											{!maturationV2 && (
												<TooltipProvider>
													<Tooltip>
														<TooltipTrigger asChild>
															<Button
																size="sm"
																variant="outline"
																disabled={
																	enhanceDisabled
																}
																onClick={() =>
																	setShowTransitionDialog(
																		true,
																	)
																}
																className="h-8 gap-1.5 text-xs"
															>
																<SparklesIcon className="size-3" />
																Enhance
															</Button>
														</TooltipTrigger>
														<TooltipContent surface="popover">
															<p>
																Enhance with AI
																for the new
																stage
															</p>
															<p className="text-xs text-muted-foreground">
																{enhanceDisabled
																	? targetStage ===
																		"CLOSED"
																		? "Hiding isn't an AI-enhanced transition"
																		: "Pick a target stage from the dropdown first"
																	: "Runs the stage-transition workflow to expand the feature for the selected stage"}
															</p>
														</TooltipContent>
													</Tooltip>
												</TooltipProvider>
											)}
											{/* Context-action button. For V2 features the
									  "Update using context" flow is folded into
									  "Update Clean Spec" (the maturation prompt already
									  pulls latest context), so this renders only for bugs
									  (Re-evaluate Bug) or the V1 classic path. */}
											{(story.kind === "BUG" ||
												!maturationV2) && (
												<TooltipProvider>
													<Tooltip>
														<TooltipTrigger asChild>
															{story.kind ===
															"BUG" ? (
																// F-171 REQ-13, AC14: bugs use the
																// dedicated bug_reanalysis prompt
																// via the Re-evaluate Bug action,
																// not the generic context-update
																// diff flow.
																<Button
																	size="sm"
																	variant="outline"
																	onClick={() =>
																		reevaluateBugMutation.mutate()
																	}
																	disabled={
																		reevaluateBugMutation.isPending
																	}
																	className="h-8 gap-1.5 text-xs"
																>
																	{reevaluateBugMutation.isPending ? (
																		<Loader2Icon className="size-3 motion-safe:animate-spin" />
																	) : (
																		<RefreshCcwDotIcon className="size-3" />
																	)}
																	Re-evaluate
																	Bug
																</Button>
															) : (
																<Button
																	size="sm"
																	variant="outline"
																	onClick={() =>
																		contextUpdate.start()
																	}
																	disabled={
																		updateContextDisabled
																	}
																	className={cn(
																		"h-8 gap-1.5 text-xs",
																		contextStaleness.buttonClass,
																	)}
																>
																	{contextUpdate.isLoading ? (
																		<Loader2Icon className="size-3 motion-safe:animate-spin" />
																	) : (
																		<RefreshCcwDotIcon className="size-3" />
																	)}
																	Update using
																	context
																</Button>
															)}
														</TooltipTrigger>
														<TooltipContent surface="popover">
															{story.kind ===
															"BUG" ? (
																<>
																	<p>
																		Re-run
																		the bug
																		analysis
																	</p>
																	<p className="text-xs text-muted-foreground">
																		Updates
																		the bug
																		card and
																		re-evaluates
																		the
																		"Needs
																		More
																		Info"
																		flag.
																		The
																		original
																		user
																		description
																		is
																		preserved.
																	</p>
																</>
															) : (
																<>
																	<p>
																		Refresh
																		from
																		latest
																		context
																	</p>
																	<p className="text-xs text-muted-foreground">
																		Reviews
																		recent
																		meeting
																		transcripts
																		and team
																		messages,
																		then
																		proposes
																		updates
																		you can
																		accept
																		or
																		reject.
																	</p>
																	{contextStaleness.relative && (
																		<p className="mt-1 text-xs text-muted-foreground">
																			Last
																			updated{" "}
																			{
																				contextStaleness.relative
																			}
																			.
																		</p>
																	)}
																	{contextStalenessHint && (
																		<p className="mt-1 text-xs font-medium text-foreground">
																			{
																				contextStalenessHint
																			}
																		</p>
																	)}
																</>
															)}
														</TooltipContent>
													</Tooltip>
												</TooltipProvider>
											)}
											{/* Staleness date label (#R4/R7) — a plain inline
								  timestamp (clock icon + text tinted by severity via
								  labelClass). For V2 the neighbouring "Update Clean Spec"
								  button keeps its own answered-questions emphasis
								  (decision 1b), so this label's colour is what carries
								  staleness severity; the tooltip hint moved onto that
								  button. Feature-only (bugs use "Re-evaluate Bug"). */}
											{/* Not focusable, so the tooltip is a pointer
								  affordance; the `sr-only` child carries the same
								  copy for assistive tech and leaves the visible
								  "Updated …" in the accessible name. */}
											{story.kind !== "BUG" &&
												contextStaleness.relative && (
													<Tooltip>
														<TooltipTrigger asChild>
															<span
																className={cn(
																	"inline-flex items-center gap-1 whitespace-nowrap text-xs",
																	contextStaleness.labelClass,
																)}
															>
																<ClockIcon className="size-3 opacity-70" />
																Updated{" "}
																{
																	contextStaleness.relative
																}
																<span className="sr-only">
																	{tTooltips(
																		"contextStaleness",
																	)}
																</span>
															</span>
														</TooltipTrigger>
														<TooltipContent>
															{tTooltips(
																"contextStaleness",
															)}
														</TooltipContent>
													</Tooltip>
												)}
											{/* Refresh Clean Spec (#1/#4b/#6, #R1–R3) — the single
								  configurable Clean Spec prompt, run THROUGH the AI
								  Feature Assistant chat (same path as stage Enhance):
								  ask the server which kind-scoped prompt this item
								  runs, then appendMessage so the agent applies via
								  write_document_local with the normal inline diff
								  review. Shown for features AND bugs; highlighted when
								  questions were answered since the last rebuild. */}
											{maturationV2 && (
												<TooltipProvider>
													<Tooltip>
														<TooltipTrigger asChild>
															<Button
																size="sm"
																variant={
																	refreshCleanSpecNeeded
																		? "default"
																		: "outline"
																}
																disabled={
																	isAiLoading
																}
																onClick={
																	handleRefreshCleanSpec
																}
																className="h-8 gap-1.5 text-xs"
															>
																<RefreshCcwDotIcon className="size-3" />
																Update Full Spec
															</Button>
														</TooltipTrigger>
														<TooltipContent surface="popover">
															<p className="text-xs text-muted-foreground">
																{tTooltips(
																	"updateCleanSpec",
																)}
															</p>
															{refreshCleanSpecNeeded && (
																<p className="mt-1 text-xs font-medium text-foreground">
																	{tTooltips(
																		"updateCleanSpecAnsweredHint",
																	)}
																</p>
															)}
															{contextStaleness.relative && (
																<p className="mt-1 text-xs text-muted-foreground">
																	{tTooltips(
																		"lastUpdatedRelative",
																		{
																			relative:
																				contextStaleness.relative,
																		},
																	)}
																</p>
															)}
															{contextStalenessHint && (
																<p className="mt-1 text-xs font-medium text-foreground">
																	{
																		contextStalenessHint
																	}
																</p>
															)}
														</TooltipContent>
													</Tooltip>
												</TooltipProvider>
											)}
											{/* F-171 convert-type (REQ-11, AC10). Discrete button
							  next to the context-action so users can flip
							  BUG ↔ FEATURE from the detail page without going
							  back to the roadmap. Confirmation dialog handled
							  below; mutation handles the API call. */}
											<TooltipProvider>
												<Tooltip>
													<TooltipTrigger asChild>
														<Button
															size="sm"
															variant="outline"
															onClick={() =>
																setConvertDialogOpen(
																	true,
																)
															}
															disabled={
																convertKindMutation.isPending
															}
															className="h-8 gap-1.5 text-xs"
														>
															<ArrowLeftRightIcon className="size-3" />
															{story.kind ===
															"BUG"
																? "Change to feature"
																: "Change to bug"}
														</Button>
													</TooltipTrigger>
													<TooltipContent surface="popover">
														<p>
															Flip the work item
															type
														</p>
														{/* Fizzy #2048 — this
														    said "Card content
														    stays as-is", which
														    is no longer true. */}
														<p className="text-xs text-muted-foreground">
															{tConvertKind(
																"tooltipHint",
															)}
														</p>
													</TooltipContent>
												</Tooltip>
											</TooltipProvider>
											<FocusModeToggle />
										</div>
									);
								})()}

							{/* Feature Maturation V2 — three-tab control fronting the
								  document-editor region (spec §9, TG5). The Clean
								  Specification tab IS the TipTap editor below; the
								  other two tabs swap the editor region for a
								  presentational panel. Rendered only in v2 so the v1
								  classic path keeps the single editor exactly as
								  before. The feature title is owned by the page chrome,
								  so only the TabsList renders here. */}
							{maturationV2 && (
								<Tabs
									value={maturationTab}
									onValueChange={(v) =>
										setMaturationTab(
											v as typeof maturationTab,
										)
									}
									className="shrink-0 border-b px-6 pt-3 overflow-x-auto"
								>
									<TabsList
										aria-label={tMaturation(
											"tabsAriaLabel",
										)}
									>
										<TabsTrigger
											value="summaryQuestions"
											id={`${maturationTabBaseId}-tab-summary`}
											className="gap-2"
										>
											{tMaturation(
												"tabs.summaryQuestions",
											)}
											{(maturationData?.openQuestions
												.length ?? 0) > 0 && (
												<Badge
													variant="warning"
													className="h-5 min-w-5 justify-center px-1.5 text-[11px]"
													aria-hidden="true"
												>
													{
														maturationData
															?.openQuestions
															.length
													}
												</Badge>
											)}
										</TabsTrigger>
										<TabsTrigger
											value="decisionLog"
											id={`${maturationTabBaseId}-tab-decisions`}
										>
											{tMaturation("tabs.decisionLog")}
										</TabsTrigger>
										<TabsTrigger
											value="cleanSpec"
											id={`${maturationTabBaseId}-tab-cleanspec`}
										>
											{tMaturation("tabs.cleanSpec")}
										</TabsTrigger>
										{qaTabEnabled && (
											<TabsTrigger
												value="qa"
												id={`${maturationTabBaseId}-tab-qa`}
												className="gap-2"
											>
												{tMaturation("tabs.qa")}
												{/* Test-first, and this feature has nothing
												    to test against yet. On the tab so it is
												    visible without opening the panel —
												    somebody should learn this before they
												    try to start work and get refused, not
												    after. Amber, not destructive: nothing is
												    broken, the feature simply is not ready to
												    implement. */}
												{maturationData?.applyTddApproach &&
													maturationData?.linkedTestCaseCount ===
														0 && (
														<TriangleAlertIcon
															className="size-4 text-highlight"
															aria-label={tMaturation(
																"tabs.qaTddNoCases",
															)}
														/>
													)}
												{(maturationData?.qaAnalysis
													?.warnings.length ?? 0) >
													0 && (
													<Badge
														variant="warning"
														className="h-5 min-w-5 justify-center px-1.5 text-[11px]"
														aria-hidden="true"
													>
														{
															maturationData
																?.qaAnalysis
																?.warnings
																.length
														}
													</Badge>
												)}
											</TabsTrigger>
										)}
									</TabsList>
								</Tabs>
							)}

							{/* Cross-tab pending-review banner (Fizzy #1929, R7–R9).
								  ABOVE the tab bar's content region and outside every
								  tab gate, so a draft awaiting approval is announced,
								  visible and actionable from whichever maturation tab
								  the user happens to be on — the Clean Specification
								  tab's own review bar stays exactly where it is and
								  keeps per-change navigation and the view-mode
								  toggle. Rendered once, never per tab: two mounted
								  copies would race to resolve the same draft. */}
							{maturationV2 && (
								<>
									{/* Always mounted, so the announcement is a CHANGE
										  inside an existing polite region rather than a
										  region that appears already full — the shape
										  `StoryKindRegenerationNotice` uses, and for the
										  same reason it sits outside the tab gate. */}
									<output
										className="sr-only"
										aria-live="polite"
										data-testid="pending-review-announcement"
									>
										{reviewAnnouncement}
									</output>

									{canEdit && isPendingReviewOpen && (
										<section
											ref={reviewBannerRef}
											aria-labelledby={`${maturationTabBaseId}-pending-review-title`}
											data-testid="cross-tab-review-banner"
											className="mx-6 mt-3 flex shrink-0 flex-wrap items-center gap-3 rounded-lg border border-highlight/40 bg-highlight/10 px-4 py-2.5"
										>
											<SparklesIcon
												className="size-4 shrink-0 text-highlight"
												aria-hidden="true"
											/>
											<div className="min-w-0 flex-1">
												<p
													id={`${maturationTabBaseId}-pending-review-title`}
													className="text-sm font-medium text-foreground"
												>
													{tMaturation(
														"pendingReview.title",
													)}
												</p>
												{reviewResolution?.status ===
												"error" ? (
													<p
														role="alert"
														data-testid="cross-tab-review-error"
														className="mt-0.5 text-xs leading-relaxed text-destructive"
													>
														{reviewResolution.message
															? tMaturation(
																	"pendingReview.resolveFailed",
																	{
																		reason: reviewResolution.message,
																	},
																)
															: tMaturation(
																	"pendingReview.resolveFailedUnknown",
																)}
													</p>
												) : (
													<p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
														{isResolvingReview
															? tMaturation(
																	"pendingReview.resolving",
																)
															: tMaturation(
																	"pendingReview.body",
																)}
													</p>
												)}
											</div>
											{/* Wraps rather than overflows: the banner shares the
												  narrow strip above the tabs with the
												  pending-decision bar, and the assistant
												  sidebar has already taken 28rem of the work
												  area before either is laid out. */}
											<div className="flex flex-wrap items-center justify-end gap-2">
												<Button
													size="sm"
													variant="outline"
													onClick={
														handleReviewPendingChanges
													}
													aria-label={tMaturation(
														"pendingReview.reviewAria",
													)}
													className="h-8 gap-1.5 text-xs"
												>
													<ArrowRightIcon
														className="size-3"
														aria-hidden="true"
													/>
													{tMaturation(
														"pendingReview.review",
													)}
												</Button>
												<Button
													size="sm"
													onClick={() => {
														void resolvePendingReview(
															"accept",
														);
													}}
													disabled={isResolvingReview}
													aria-label={tMaturation(
														"pendingReview.approveAria",
													)}
													className="h-8 gap-1.5 text-xs"
												>
													{isResolvingReview &&
													reviewResolution?.action ===
														"accept" ? (
														<Loader2Icon
															className="size-3 motion-safe:animate-spin"
															aria-hidden="true"
														/>
													) : (
														<CheckIcon
															className="size-3"
															aria-hidden="true"
														/>
													)}
													{tMaturation(
														"pendingReview.approve",
													)}
												</Button>
												<Button
													size="sm"
													variant="outline"
													onClick={() => {
														void resolvePendingReview(
															"reject",
														);
													}}
													disabled={isResolvingReview}
													aria-label={tMaturation(
														"pendingReview.rejectAria",
													)}
													className="h-8 gap-1.5 text-xs"
												>
													{isResolvingReview &&
													reviewResolution?.action ===
														"reject" ? (
														<Loader2Icon
															className="size-3 motion-safe:animate-spin"
															aria-hidden="true"
														/>
													) : (
														<XIcon
															className="size-3"
															aria-hidden="true"
														/>
													)}
													{tMaturation(
														"pendingReview.reject",
													)}
												</Button>
											</div>
										</section>
									)}
								</>
							)}

							{/* "X New Decisions" bar (#B) — salient, visible across all
								  tabs. Answers are recorded into the Clean Spec's pending
								  appendix without an LLM call; this counts them and lets the
								  PM merge them all into the spec in one run via the same
								  refresh path as the toolbar button. Clears to 0 once the
								  refresh dissolves the appendix. */}
							{maturationV2 &&
								(maturationData?.pendingDecisionCount ?? 0) >
									0 && (
									<div className="mx-6 mt-3 flex shrink-0 items-center justify-between gap-3 rounded-lg border border-primary/40 bg-primary/10 px-4 py-2.5">
										<div className="min-w-0">
											<p className="text-sm font-medium text-foreground">
												{tMaturation(
													"newDecisions.title",
													{
														count:
															maturationData?.pendingDecisionCount ??
															0,
													},
												)}
											</p>
											{/* A refresh started now would open a SECOND
												  draft over the one still awaiting a
												  decision. Say so where the disabled
												  button is — a disabled control takes no
												  focus, so a tooltip could not carry
												  this. */}
											{isPendingReviewOpen && (
												<p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
													{tMaturation(
														"pendingReview.refreshBlocked",
													)}
												</p>
											)}
										</div>
										<Button
											size="sm"
											onClick={handleRefreshCleanSpec}
											disabled={
												isAiLoading ||
												isPendingReviewOpen
											}
											className="h-8 shrink-0 gap-1.5 text-xs"
										>
											<RefreshCcwDotIcon className="size-3" />
											{tMaturation("newDecisions.cta")}
										</Button>
									</div>
								)}

							{/* Fizzy #2048 — the body redraft a type change started,
								  sitting directly above the description /
								  acceptance-criteria region it is about to replace.
								  OUTSIDE the tab gate below on purpose: the convert
								  control lives in the header and is reachable from every
								  tab, and the component carries the polite live region
								  that announces start, completion and refusal. That
								  region has to stay mounted for its text change to be
								  announced at all, so it must not come and go with the
								  active tab. */}
							<StoryKindRegenerationNotice state={regeneration} />

							{/* Clean Specification tab (v2) === the v1 editor. In v1
								  this fragment always renders (no DOM wrapper, so the
								  height chain is byte-for-byte unchanged); in v2 it
								  renders only when the Clean Specification tab is
								  active. */}
							{(!maturationV2 ||
								maturationTab === "cleanSpec") && (
								<>
									{/* "Changes from this run" review card (v2 only).
										  Renders above the editor toolbar when the most
										  recent maturation run produced section-tagged
										  change bullets. */}
									{maturationV2 &&
										!!maturationData?.latestRun
											?.changeSummary?.length && (
											<RunChangeSummaryCard
												storyId={story.id}
												latestRun={
													maturationData.latestRun
												}
												onRevert={onMaturationRevertRun}
												isReverting={
													maturationRevertMutation.isPending
												}
											/>
										)}

									{/* Toolbar - hide when showing raw */}
									{!showRaw && (
										<EditorToolbar editor={editor} />
									)}

									{/* Content - scrollable area, with the table of
									    contents docked on its left. Hidden in raw mode
									    (the Textarea has no heading DOM) and while diff
									    preview panes replace the live editor. */}
									<div className="relative flex min-h-0 flex-1 overflow-hidden">
										{!showRaw && !showDiffPreviewPanes && (
											<DocumentTocRail
												editor={editor}
												// This surface opens with the AI
												// assistant expanded, so 28rem of
												// the work area is already gone
												// before the rail takes its 256px.
												breakpoint="xl"
											/>
										)}
										<div className="flex-1 min-h-0 overflow-y-auto">
											{/* Raw markdown view */}
											{showRaw ? (
												<div className="p-6">
													<div className="mb-2 flex items-center justify-between">
														<span className="text-xs text-muted-foreground font-mono">
															Raw Markdown
														</span>
														<Button
															type="button"
															variant="outline"
															size="sm"
															onClick={
																handleAskAboutSelection
															}
															disabled={
																isAiLoading
															}
															className="gap-1.5"
														>
															<SparklesIcon className="size-3.5" />
															Ask About Selection
														</Button>
													</div>
													<Textarea
														value={currentDocument}
														onChange={(e) => {
															const result =
																handleRawEditorFabricMention(
																	e.target
																		.value,
																);
															if (
																!result.consumed
															) {
																setCurrentDocument(
																	result.value,
																);
																setHasUnsavedChanges(
																	true,
																);
															}
														}}
														className="min-h-[400px] font-mono text-sm resize-none"
														placeholder="Enter markdown content... Type @fabric followed by your question to ask the AI agent."
														// Fizzy #2048: read-only while a
														// type-change redraft is rewriting
														// this exact text.
														disabled={
															isAiLoading ||
															regeneration.isBodyLocked
														}
													/>
												</div>
											) : (
												/* Editor with diff highlighting support */
												<div
													className={`border-b ${isAiLoading || isAwaitingConfirmation || contextUpdate.showingDiff ? "streaming-diff-active" : ""}`}
												>
													{/* Sticky diff-review header — keeps the mode toggle +
								    accept/reject controls pinned while scrolling a long feature. */}
													<div className="sticky top-0 z-20 bg-background">
														{isDiffReviewActive && (
															<div className="flex items-center justify-end border-b border-border bg-muted/30 px-4 py-2">
																<DiffViewModeToggle
																	value={
																		diffViewMode
																	}
																	onChange={
																		setDiffViewMode
																	}
																/>
															</div>
														)}
														{/* Gated on `canEdit` (Fizzy #1929, R9): these are
															  write controls and carried no permission check
															  before. Server-side the update procedure's
															  permission middleware is what actually refuses a
															  viewer's write — this is the presentational
															  mirror of that check, and it has to hold on THIS
															  surface too, or the rule would be true only of
															  the cross-tab banner above.
															  `tabIndex={-1}` + the ref: the banner's "Review
															  changes" hands focus here, so a user who came to
															  look at the diff lands on the controls for it
															  rather than at the top of the document. */}
														{isAwaitingConfirmation &&
															canEdit && (
																<section
																	ref={
																		reviewBarRegionRef
																	}
																	tabIndex={
																		-1
																	}
																	aria-label={tMaturation(
																		"pendingReview.regionLabel",
																	)}
																	data-testid="spec-tab-review-region"
																	className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
																>
																	{/* Confirm-time change summary (v2 only) —
																	  advisory, sits above the diff bar; renders
																	  nothing when empty/errored. */}
																	{maturationV2 && (
																		<ConfirmChangeSummaryCard
																			bullets={
																				pendingChangeBullets
																			}
																			isLoading={
																				summarizeChangesMutation.isPending
																			}
																			onBulletClick={
																				scrollDiffToSection
																			}
																		/>
																	)}
																	<DiffReviewBar
																		editor={
																			editor
																		}
																		mode={
																			effectiveDiffViewMode
																		}
																		// Through `resolvePendingReview`, NOT
																		// straight at the callbacks (Fizzy
																		// #1929). One resolution path for both
																		// surfaces: this is where the fresh
																		// read of the server description
																		// happens, and where a throw out of
																		// the splice is caught and reported
																		// instead of escaping unhandled from a
																		// click handler with the review
																		// already cleared behind it.
																		onAcceptAll={() => {
																			void resolvePendingReview(
																				"accept",
																			);
																		}}
																		onRejectAll={() => {
																			void resolvePendingReview(
																				"reject",
																			);
																		}}
																		onBeforeChange={() => {
																			isSyncingFromPropRef.current = true;
																		}}
																		onAfterChange={() => {
																			isSyncingFromPropRef.current = false;
																		}}
																	/>
																</section>
															)}
													</div>
													<div
														className={
															showDiffPreviewPanes
																? "hidden"
																: undefined
														}
													>
														<EditorContent
															editor={editor}
															className="prose prose-sm max-w-none dark:prose-invert"
														/>
													</div>
													{showDiffPreviewPanes &&
														diffViews && (
															<DiffPreviewPanes
																mode={
																	effectiveDiffViewMode ===
																	"fullPreview"
																		? "fullPreview"
																		: "sideBySide"
																}
																derived={
																	diffViews
																}
															/>
														)}
												</div>
											)}

											{/* Context update confirm/reject banner */}
											{contextUpdate.showingDiff && (
												<div className="bg-card text-card-foreground p-4 border-b border-border">
													<div className="max-w-4xl mx-auto flex items-center justify-between gap-4">
														<div className="space-y-1 min-w-0">
															<p className="text-sm font-medium">
																Context update
																ready for review
															</p>
															{contextUpdate
																.preview
																?.summary && (
																<p className="text-xs text-muted-foreground truncate">
																	{
																		contextUpdate
																			.preview
																			.summary
																	}
																</p>
															)}
														</div>
														<div className="flex items-center gap-2 shrink-0">
															<Button
																variant="outline"
																size="sm"
																onClick={() =>
																	contextUpdate.reject()
																}
															>
																Reject
															</Button>
															<Button
																size="sm"
																onClick={() =>
																	contextUpdate.confirm()
																}
																disabled={
																	contextUpdate.isApplying
																}
															>
																{contextUpdate.isApplying ? (
																	<>
																		<Loader2Icon className="mr-1.5 size-3.5 motion-safe:animate-spin" />
																		Applying...
																	</>
																) : (
																	"Confirm"
																)}
															</Button>
														</div>
													</div>
												</div>
											)}

											{/* Metadata and Tasks Section */}
											<div className="max-w-4xl mx-auto p-6 space-y-6">
												{/* Metadata Row */}
												<div className="grid grid-cols-2 md:grid-cols-3 gap-4">
													<div className="space-y-2">
														<div className="flex items-center gap-1.5">
															<Label htmlFor="priority">
																Priority
															</Label>
															{aiReassessEligible && (
																<AiReprioritizeControl
																	className="-my-1"
																	projectId={
																		projectId
																	}
																	organizationId={
																		organizationId ??
																		null
																	}
																	storyId={
																		story.id
																	}
																	identifier={
																		story.identifier
																	}
																	onApplied={(
																		result,
																	) => {
																		// Sync the DRAFT to the applied band so a
																		// later form save cannot overwrite the move.
																		if (
																			result.changed &&
																			result.toPriority
																		) {
																			setPriority(
																				result.toPriority,
																			);
																		}
																		queryClient.invalidateQueries(
																			{
																				queryKey:
																					orpc.projects.stories.get.key(),
																			},
																		);
																		queryClient.invalidateQueries(
																			{
																				queryKey:
																					orpc.projects.stories.list.key(),
																			},
																		);
																	}}
																/>
															)}
														</div>
														<Select
															value={priority}
															onValueChange={(
																v,
															) => {
																setPriority(v);
																setHasUnsavedChanges(
																	true,
																);
															}}
															disabled={
																isAiLoading
															}
														>
															<SelectTrigger id="priority">
																<SelectValue />
															</SelectTrigger>
															<SelectContent>
																{PRIORITY_OPTIONS.map(
																	(opt) => (
																		<SelectItem
																			key={
																				opt.value
																			}
																			value={
																				opt.value
																			}
																		>
																			<div className="flex items-center gap-2">
																				<div
																					className="size-2 rounded-full"
																					style={{
																						backgroundColor:
																							opt.color,
																					}}
																				/>
																				{
																					opt.label
																				}
																			</div>
																		</SelectItem>
																	),
																)}
															</SelectContent>
														</Select>
													</div>

													<div className="space-y-2">
														<Label htmlFor="size">
															Size
														</Label>
														<Select
															value={size}
															onValueChange={(
																v,
															) => {
																setSize(v);
																setHasUnsavedChanges(
																	true,
																);
															}}
															disabled={
																isAiLoading
															}
														>
															<SelectTrigger id="size">
																<SelectValue placeholder="Select size" />
															</SelectTrigger>
															<SelectContent>
																{SIZE_OPTIONS.map(
																	(opt) => (
																		<SelectItem
																			key={
																				opt.value
																			}
																			value={
																				opt.value
																			}
																		>
																			{
																				opt.label
																			}{" "}
																			-{" "}
																			{
																				opt.description
																			}
																		</SelectItem>
																	),
																)}
															</SelectContent>
														</Select>
													</div>

													<div className="space-y-2">
														<Label htmlFor="storyPoints">
															Story Points
														</Label>
														<Input
															id="storyPoints"
															type="number"
															min="0"
															max="100"
															value={storyPoints}
															onChange={(e) => {
																setStoryPoints(
																	e.target
																		.value,
																);
																setHasUnsavedChanges(
																	true,
																);
															}}
															placeholder="e.g., 3, 5, 8"
															disabled={
																isAiLoading
															}
														/>
													</div>
												</div>

												<StoryTagEditor
													projectId={projectId}
													storyId={story.id}
													organizationId={
														organizationId ?? null
													}
													tags={story.tags ?? []}
													currentUserId={
														sessionUser?.id
													}
													canAddTags={canAddTags}
													canManageAllTags={
														canManageAllTags
													}
												/>

												{/* Tasks Section */}
												<div className="space-y-4 border-t pt-6">
													<div className="flex items-center justify-between">
														<Label className="flex items-center gap-2 text-base font-semibold">
															<ClipboardListIcon className="size-4" />
															Tasks
															{totalTasks > 0 && (
																<span className="text-sm font-normal text-muted-foreground">
																	(
																	{
																		completedTasks
																	}
																	/
																	{totalTasks}{" "}
																	completed)
																</span>
															)}
														</Label>
														<Button
															type="button"
															variant="outline"
															size="sm"
															onClick={
																handleGenerateTasks
															}
															disabled={
																isGeneratingTasks ||
																generateTasksMutation.isPending ||
																isAiLoading
															}
															className="gap-1.5"
														>
															{isGeneratingTasks ||
															generateTasksMutation.isPending ? (
																<>
																	<Loader2Icon className="size-4 animate-spin" />
																	Generating...
																</>
															) : (
																<>
																	<SparklesIcon className="size-4" />
																	Generate
																	with AI
																</>
															)}
														</Button>
													</div>

													{/* AI Generation hint when no tasks */}
													{totalTasks === 0 &&
														!isGeneratingTasks && (
															<div className="rounded-lg border border-dashed border-primary/30 bg-primary/5 p-6 text-center">
																<SparklesIcon className="size-8 mx-auto mb-3 text-primary/60" />
																<p className="text-sm text-muted-foreground mb-2">
																	No tasks
																	yet. Click{" "}
																	<strong>
																		"Generate
																		with AI"
																	</strong>{" "}
																	to
																	automatically
																	create
																	implementation
																	tasks based
																	on this
																	story.
																</p>
																<p className="text-xs text-muted-foreground">
																	Or add tasks
																	manually
																	below.
																</p>
															</div>
														)}

													{/* Task list */}
													<div className="space-y-2">
														{tasks.map((task) => (
															<TaskItem
																key={task.id}
																task={task}
																onToggle={() =>
																	toggleTaskMutation.mutate(
																		task.id,
																	)
																}
																onDelete={() =>
																	deleteTaskMutation.mutate(
																		task.id,
																	)
																}
																disabled={
																	isAiLoading
																}
															/>
														))}
													</div>

													{/* Manual add task */}
													<div className="flex gap-2">
														<Input
															value={newTaskTitle}
															onChange={(e) =>
																setNewTaskTitle(
																	e.target
																		.value,
																)
															}
															placeholder="Add task manually..."
															className="flex-1"
															onKeyDown={(e) => {
																if (
																	e.key ===
																	"Enter"
																) {
																	e.preventDefault();
																	handleAddTask();
																}
															}}
															disabled={
																isAiLoading
															}
														/>
														<Button
															type="button"
															variant="outline"
															size="icon"
															onClick={
																handleAddTask
															}
															disabled={
																!newTaskTitle.trim() ||
																createTaskMutation.isPending ||
																isAiLoading
															}
														>
															<PlusIcon className="size-4" />
														</Button>
													</div>
												</div>
											</div>
										</div>
									</div>
								</>
							)}

							{/* Summary & Questions tab (v2 only). Summary → Questions
								  → Notes, in that fixed order. Notes is the human's
								  notebook — the AI never writes it. */}
							{maturationV2 &&
								maturationTab === "summaryQuestions" && (
									<div className="flex-1 min-h-0 overflow-y-auto px-6 py-6">
										<SummaryQuestionsPanel
											summaryDigest={
												maturationData?.summaryDigest ??
												null
											}
											openQuestions={
												maturationData?.openQuestions ??
												[]
											}
											possiblyResolvedQuestions={
												maturationData?.possiblyResolvedQuestions ??
												[]
											}
											workingNotesContent={
												maturationData?.workingNotesContent ??
												null
											}
											isGenerating={
												maturationData === undefined ||
												!maturationSeedAttempted.current ||
												maturationSeedMutation.isPending
											}
											onAnswer={onMaturationAnswer}
											autoProposeAnswers={
												maturationData?.feature
													?.autoProposeAnswers ?? true
											}
											onToggleAutoPropose={
												onMaturationToggleAutoPropose
											}
											togglingAutoPropose={
												maturationAutoProposeMutation.isPending
											}
											onSaveNotes={onMaturationSaveNotes}
											onRestoreQuestion={
												onMaturationRestoreQuestion
											}
											// Undefined while the flag is off,
											// which is what hides every
											// assignment control without a
											// second check per control.
											questionAssignees={
												maturationData?.questionAssignees ??
												undefined
											}
											assignableMembers={
												assignableMembersQuery.data
													?.members ?? []
											}
											onAssigneeQueryChange={
												setAssigneeQuery
											}
											onSetAssignees={
												isQuestionAssignmentEnabled
													? onMaturationSetAssignees
													: undefined
											}
											settingAssigneesId={
												maturationAssignMutation.isPending
													? (maturationAssignMutation
															.variables
															?.questionRootId ??
														null)
													: null
											}
											answeringId={
												maturationAnswerMutation.isPending
													? (maturationAnswerMutation
															.variables
															?.questionId ??
														null)
													: null
											}
											restoringId={
												maturationRestoreMutation.isPending
													? (maturationRestoreMutation
															.variables
															?.questionRootId ??
														null)
													: null
											}
											hasAcceptanceCriteria={Boolean(
												story.acceptanceCriteria?.trim() ||
													/acceptance\s+criteria|\bgiven\b.*\bwhen\b.*\bthen\b/i.test(
														[
															maturationData?.summaryDigest,
															story.description,
															maturationData
																?.cleanSpec
																?.description,
														]
															.filter(Boolean)
															.join("\n"),
													),
											)}
											hasFunctionalRequirements={Boolean(
												/functional\s+requirements|FR-\d+|FR\d+|\bFRs?\b/i.test(
													[
														maturationData?.summaryDigest,
														story.description,
														maturationData
															?.cleanSpec
															?.description,
													]
														.filter(Boolean)
														.join("\n"),
												),
											)}
											storyKind={
												story.kind as "FEATURE" | "BUG"
											}
											hasExpectedResult={Boolean(
												/\bexpected\s+(result|behavior|outcome|output)|\bexpected\s*:/i.test(
													[
														maturationData?.summaryDigest,
														story.description,
														maturationData
															?.cleanSpec
															?.description,
													]
														.filter(Boolean)
														.join("\n"),
												),
											)}
											hasActualResult={Boolean(
												/\bactual\s+(result|behavior|outcome|output)|\bactual\s*:/i.test(
													[
														maturationData?.summaryDigest,
														story.description,
														maturationData
															?.cleanSpec
															?.description,
													]
														.filter(Boolean)
														.join("\n"),
												),
											)}
											needsMoreInfo={Boolean(
												story.needsMoreInfo,
											)}
											isSpecRecentlyUpdated={Boolean(
												specRecencyAt &&
													Date.now() -
														new Date(
															specRecencyAt,
														).getTime() <=
														15 *
															24 *
															60 *
															60 *
															1000,
											)}
											resolvedQuestionsCount={
												(
													maturationData?.decisionLog ??
													[]
												).filter(
													(e) =>
														e.root
															?.impactedSection !==
															"AI Updates" &&
														e.root?.questionId !=
															null &&
														(e.root?.status ===
															"RESOLVED" ||
															e.root?.status ===
																"POSSIBLY_RESOLVED"),
												).length
											}
											isAiMode={isAiMode}
											isAiEvaluating={
												evaluateAiReadinessMutation.isPending
											}
											aiResult={aiResult}
											onToggleAiMode={handleToggleAiMode}
										/>
									</div>
								)}

							{/* Decision Log tab (v2 only). Resolved decisions grouped
								  by topic (impactedSection). */}
							{maturationV2 &&
								maturationTab === "decisionLog" && (
									<div className="flex-1 min-h-0 overflow-y-auto px-6 py-6">
										<DecisionLogPanel
											threads={
												maturationData?.decisionLog ??
												[]
											}
											onAmend={(input) =>
												maturationAmendMutation.mutate({
													projectId,
													storyId: story.id,
													questionId:
														input.questionId,
													supersedesId:
														input.supersedesId,
													answer: input.answer,
													// A hand-amended answer is no
													// longer a straight AI
													// acceptance (#1910).
													answerSource: "AI_EDITED",
												})
											}
											amendingId={
												maturationAmendMutation.isPending
													? (maturationAmendMutation
															.variables
															?.questionId ??
														null)
													: null
											}
										/>
									</div>
								)}

							{/* QA tab (v2 + Test Cases flag, features only).
								  Real TestCase rows + traceability matrix + persisted
								  AI analysis; drafting runs through the same durable
								  pipeline as the project QA tab. */}
							{maturationV2 &&
								qaTabEnabled &&
								maturationTab === "qa" && (
									<div className="flex-1 min-h-0 overflow-y-auto px-6 py-6">
										<QaPanel
											currentUserId={
												sessionUser?.id ?? null
											}
											projectId={projectId}
											storyId={story.id}
											organizationId={
												organizationId ?? null
											}
											loading={
												maturationData === undefined
											}
											acceptanceCriteria={
												maturationData?.cleanSpec
													.acceptanceCriteria ?? null
											}
											qaAnalysis={
												maturationData?.qaAnalysis ??
												null
											}
											qaAnalysisStale={
												maturationData?.qaAnalysisStale ??
												false
											}
											qaStrategyLevel={
												maturationData?.qaStrategyLevel ??
												"STANDARD"
											}
											generateManualTestCases={
												maturationData?.generateManualTestCases ??
												true
											}
											applyTddApproach={
												maturationData?.applyTddApproach ??
												false
											}
										/>
									</div>
								)}

							{/* Feature Version History */}
							<FeatureVersionHistory
								open={showVersionHistory}
								onOpenChange={setShowVersionHistory}
								projectId={projectId}
								storyId={story.id}
								currentVersion={story.version ?? 1}
								currentDescription={story.description ?? ""}
								currentAcceptanceCriteria={
									story.acceptanceCriteria ?? ""
								}
								organizationId={organizationId}
								onRestore={() => {
									queryClient.invalidateQueries({
										queryKey:
											orpc.projects.stories.get.queryKey({
												input: {
													projectId,
													storyId: story.id,
													organizationId,
												},
											}),
									});
									queryClient.invalidateQueries({
										queryKey: storiesListQueryKey,
									});
									onStoryUpdated?.();
								}}
							/>

							{/* Opens only when the coverage gate refused the move
							    to Done; self-gated on its own `detail`. */}
							<CoverageOverrideDialog
								detail={coverageBlock}
								isPending={maturationStatusMutation.isPending}
								onOpenChange={(open) => {
									if (!open) {
										setCoverageBlock(null);
									}
								}}
								onConfirm={(reason) => {
									maturationStatusMutation.mutate({
										...lastMaturationVariablesRef.current,
										coverageOverrideReason: reason,
									});
								}}
							/>

							{/* Drafting Stage Transition Dialog */}
							{showTransitionDialog && targetStage && (
								<FeatureTransitionDialog
									open={showTransitionDialog}
									onOpenChange={setShowTransitionDialog}
									currentStage={story.draftingStage}
									targetStage={
										targetStage as FeatureDraftingStage
									}
									storyKind={story.kind}
									featureIdentifier={story.identifier}
									featureTitle={story.title}
									tddNeedsTestCases={
										(maturationData?.applyTddApproach ??
											false) &&
										maturationData?.linkedTestCaseCount ===
											0
									}
									onEnhance={async (stage, promptId) => {
										// Bail out if a prior invocation (this handler or
										// `handleRefreshCleanSpec`, sharing the same thread) is
										// still in flight — otherwise this fires a second
										// concurrent run on the same thread (GH issue #2526).
										if (
											isProgrammaticAgentRunInFlightRef.current ||
											isAgentRunActive()
										) {
											return;
										}
										isProgrammaticAgentRunInFlightRef.current = true;
										try {
											// One server call covers both
											// branches: the stage's default prompt
											// and a prompt the reviewer picked by
											// hand. Sending the prompt id rather
											// than its text is what lets the server
											// refuse a choice bound to the other
											// kind — at shared stages like
											// PLACEHOLDER and DRAFT the two kinds
											// would otherwise reach each other's
											// prompts.
											let promptContent:
												| string
												| undefined;
											let resolvedKind:
												| UserStory["kind"]
												| undefined;

											try {
												const resolvedPrompt =
													await orpcClient.projects.stories.resolvePrompt(
														{
															projectId,
															storyId: story.id,
															organizationId:
																organizationId ??
																null,
															targetStage: stage,
															promptId,
														},
													);
												if (
													resolvedPrompt.resolved &&
													resolvedPrompt.content
												) {
													promptContent =
														resolvedPrompt.content;
													resolvedKind =
														resolvedPrompt.kind;
												}
											} catch (error) {
												// A refusal is not a reason to fall
												// through. The sync flow rewrites the
												// body server-side with no diff review,
												// so treating "the server said no" the
												// same as "the network blipped" turns a
												// deliberate stop into an unreviewed
												// rewrite. A cross-kind refusal would
												// also just be refused again one round
												// trip later, under a vaguer message.
												// The outer `finally` releases the
												// in-flight latch on this return.
												const code = (
													error as {
														code?: unknown;
													} | null
												)?.code;
												if (
													typeof code === "string" &&
													SERVER_REFUSAL_CODES.has(
														code,
													)
												) {
													// A cross-kind refusal means this component's
													// cached kind is almost certainly a conversion
													// behind — the prompt list was built from it, so
													// without a refresh the reviewer picks from the
													// wrong kind's prompts and is refused again.
													invalidateStoryAfterKindDrift();
													toast.error(
														error instanceof
															Error &&
															error.message
															? error.message
															: tMaturationToasts(
																	"cleanSpecRefreshError",
																),
													);
													return;
												}
												// Anything else (transport, timeout) keeps
												// the previous fall-through.
											}

											if (promptContent) {
												// Cache is a conversion behind the
												// stored row — refresh the chrome
												// before the run posts.
												if (
													resolvedKind &&
													resolvedKind !== story.kind
												) {
													invalidateStoryAfterKindDrift();
												}
												// Late recheck: a run may have started from the
												// chat input itself during the awaits above (the
												// input only consults `agent.isRunning`, not our
												// latch). Reads synchronous ground truth via
												// `isAgentRunActive()`. Placed before any dialog
												// state mutation so an abort leaves the dialog
												// open and un-mutated (GH #2526).
												if (isAgentRunActive()) {
													return;
												}
												// CopilotKit streaming flow: wrap prompt with tool instructions
												setPendingTargetStage(stage);
												setShowTransitionDialog(false);
												setTargetStage("");
												const stageLabel = stage
													.toLowerCase()
													.replace(/_/g, " ");
												// Display word only — the template was already
												// chosen server-side. It still has to agree with
												// that choice: this message travels to the model
												// beside the prompt, and calling a bug a "feature"
												// there contradicts the instructions being sent.
												const kindNoun =
													(resolvedKind ??
														story.kind) === "BUG"
														? "bug"
														: "feature";
												markUserRunInitiated();
												try {
													await appendMessage(
														new TextMessage({
															role: MessageRole.User,
															content: `Enhance this ${kindNoun} to the "${stageLabel}" stage. Apply all changes using the write_document_local tool.\n\nFollow these instructions:\n\n${promptContent}`,
														}),
													);
												} catch (error) {
													// A rejection before the run ever starts
													// streaming would otherwise leave the mark
													// stuck "on" for a later unmarked handshake
													// to surface as a false pill. Rethrow
													// preserves this handler's existing (lack of)
													// error handling — the outer `finally` below
													// still resets the in-flight latch.
													clearUserRunMark();
													throw error;
												}
											} else {
												// Sync flow: no prompt configured → just update stage
												enhanceMutation.mutate({
													stage,
													promptId,
												});
											}
										} finally {
											isProgrammaticAgentRunInFlightRef.current = false;
										}
									}}
									isEnhancing={
										enhanceMutation.isPending || isAiLoading
									}
								/>
							)}

							{/* Context update loading overlay */}
							{contextUpdate.isLoading && (
								<div className="absolute inset-0 bg-background/60 flex items-center justify-center z-10">
									<div className="flex flex-col items-center gap-3 text-muted-foreground max-w-sm text-center">
										<Loader2Icon className="size-7 motion-safe:animate-spin text-primary" />
										<p className="text-sm font-medium text-foreground">
											{contextUpdate.loadingStage}
										</p>
										<p className="text-xs tabular-nums">
											{contextUpdate.elapsedSeconds}s
											elapsed · this usually takes 30–120
											s
										</p>
									</div>
								</div>
							)}

							<ConvertKindConfirmDialog
								open={convertDialogOpen}
								onOpenChange={setConvertDialogOpen}
								targetKind={targetConvertKind}
								isPending={convertKindMutation.isPending}
								onConfirm={() => convertKindMutation.mutate()}
							/>
						</div>
					</CopilotSidebar>

					{/* Group F — persistent chat-history drawer. The drawer is the
		    secondary surface for browsing prior conversations; only
		    mounted when the org has the feature flag ON, mirroring
		    `CustomSidebarHeader`. */}
					{documentAssistantHistoryEnabled && user ? (
						<CopilotHistoryDrawer
							open={historyDrawerOpen}
							onOpenChange={setHistoryDrawerOpen}
							documentRefKind={documentRefKind}
							documentRefId={story.id}
							projectId={projectId}
							organizationId={organizationId ?? null}
							currentUserId={user.id}
							activeConversationId={activeAssistantConversationId}
							onForked={({
								forkedConversationId,
								copiedMessages,
							}) => {
								// Mirror DocumentEditor's fork handler. We deliberately
								// do NOT push the copied messages into CopilotKit's
								// runtime via a second setMessages call — that
								// triggers a "<CopilotKit> not wrapped" crash mid-
								// render (see DocumentEditor.tsx's matching docblock
								// for the staging trace). Agent context for the next
								// user send comes from the LangGraph backend reading
								// the persisted blob, not from the client runtime.
								setCopilotMessages([]);
								setEffectiveAssistantMessages(
									copiedMessages as unknown as ReadonlyArray<
										Record<string, unknown>
									>,
								);
								setEffectiveSsrConversationId(
									forkedConversationId,
								);
								setEffectivePersistedMessageIds(
									copiedMessages
										.map((m) => m.id)
										.filter(
											(id): id is string =>
												typeof id === "string",
										),
								);
								setActiveAssistantConversationId(
									forkedConversationId,
								);
							}}
						/>
					) : null}
				</HydratedMessagesProvider>
			</DocumentAssistantOutcomesProvider>
		</AttachmentRegistryProvider>
	);
}

// Tasks are checkbox-only by design. The previous click-to-open detail modal
// was disabled while the long-term purpose of tasks is decided (see bug
// "Clicking AI-generated task navigates to blank/error page").
function TaskItem({
	task,
	onToggle,
	onDelete,
	disabled,
}: {
	task: StoryTask;
	onToggle: () => void;
	onDelete: () => void;
	disabled?: boolean;
}) {
	const [isDeleting, setIsDeleting] = useState(false);

	const handleDelete = async () => {
		setIsDeleting(true);
		try {
			onDelete();
		} finally {
			setIsDeleting(false);
		}
	};

	return (
		<div className="group flex items-center gap-3 p-3 rounded-lg border bg-card hover:bg-muted/50 transition-colors">
			<Checkbox
				checked={task.isCompleted}
				onCheckedChange={onToggle}
				className="size-5"
				disabled={disabled}
			/>
			<div className="flex-1 min-w-0">
				<span
					className={cn(
						"text-sm",
						task.isCompleted &&
							"line-through text-muted-foreground",
					)}
				>
					{task.title}
				</span>
				{task.description && (
					<p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">
						{task.description}
					</p>
				)}
			</div>
			{task.estimatedHours && (
				<Badge variant="outline" className="shrink-0">
					{task.estimatedHours}h
				</Badge>
			)}
			{task.isCompleted && (
				<CheckCircle2Icon className="size-4 text-success shrink-0" />
			)}

			{/* Agent status badge */}
			{task.agentStatus &&
				task.agentStatus !== "idle" &&
				(() => {
					const statusConfig = {
						running: {
							label: "WORKING",
							icon: (
								<Loader2Icon className="size-3 animate-spin" />
							),
							className:
								"bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300",
						},
						working: {
							label: "WORKING",
							icon: (
								<Loader2Icon className="size-3 animate-spin" />
							),
							className:
								"bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300",
						},
						executing: {
							label: "WORKING",
							icon: (
								<Loader2Icon className="size-3 animate-spin" />
							),
							className:
								"bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300",
						},
						paused: {
							label: "AWAITING",
							icon: <PauseIcon className="size-3" />,
							className:
								"bg-yellow-100 text-yellow-700 dark:bg-yellow-900/50 dark:text-yellow-300",
						},
						checkpoint: {
							label: "AWAITING",
							icon: <PauseIcon className="size-3" />,
							className:
								"bg-yellow-100 text-yellow-700 dark:bg-yellow-900/50 dark:text-yellow-300",
						},
						awaiting_approval: {
							label: "AWAITING",
							icon: <PauseIcon className="size-3" />,
							className:
								"bg-yellow-100 text-yellow-700 dark:bg-yellow-900/50 dark:text-yellow-300",
						},
						completed: {
							label: "DONE",
							icon: <CheckCircle2Icon className="size-3" />,
							className:
								"bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-300",
						},
						failed: {
							label: "FAILED",
							icon: <XIcon className="size-3" />,
							className:
								"bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300",
						},
						cancelled: {
							label: "FAILED",
							icon: <XIcon className="size-3" />,
							className:
								"bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300",
						},
					}[task.agentStatus];

					return statusConfig ? (
						<Badge
							variant="outline"
							className={cn(
								"text-[10px] px-1.5 py-0 h-5 font-medium gap-1 shrink-0",
								statusConfig.className,
							)}
						>
							{statusConfig.icon}
							{statusConfig.label}
						</Badge>
					) : null;
				})()}

			{/* Delete button - shown on hover */}
			<Button
				variant="ghost"
				size="sm"
				onClick={() => void handleDelete()}
				disabled={disabled || isDeleting}
				className="h-6 w-6 p-0 text-destructive hover:text-destructive hover:bg-red-50 dark:hover:bg-red-950/30 opacity-0 group-hover:opacity-100 transition-opacity"
				title="Delete task"
			>
				{isDeleting ? (
					<Loader2Icon className="w-3 h-3 animate-spin" />
				) : (
					<TrashIcon className="w-3 h-3" />
				)}
			</Button>
		</div>
	);
}

// True iff the editor's document carries any diffInsert/diffDelete marks —
// i.e. it's currently showing a pending AI review. Used to suppress the
// editor → state sync (Effect 4) so baselineRef.current isn't overwritten
// with the AI-applied content while the user is still deciding accept/reject.
function editorHasDiffMarks(
	editor: ReturnType<typeof useEditor> | null,
): boolean {
	if (!editor) {
		return false;
	}
	let found = false;
	editor.state.doc.descendants((node) => {
		if (found) {
			return false;
		}
		if (!node.isText) {
			return;
		}
		for (const mark of node.marks) {
			if (
				mark.type.name === "diffInsert" ||
				mark.type.name === "diffDelete"
			) {
				found = true;
				return false;
			}
		}
	});
	return found;
}

// Confirmation dialog component - EXACT COPY of ag-ui-demo pattern
interface ConfirmChangesProps {
	args: any;
	respond: any;
	status: any;
	/**
	 * Resolve the pending draft through `resolvePendingReview` — the one path
	 * all three surfaces share (fresh server read, failure recovery, callback
	 * restore). Async by consequence, and resolves to whether the resolution
	 * actually landed: `false` means nothing was written and the draft is still
	 * waiting, so this card must not latch into a resolved state.
	 */
	onConfirm: () => Promise<boolean>;
	onReject: () => Promise<boolean>;
	/**
	 * Whether the viewer may write to this feature. False hides Confirm /
	 * Reject: they resolve the same draft the (gated) review bar and cross-tab
	 * banner do, and the update procedure's permission middleware would refuse
	 * the write anyway — this is the presentational mirror of that refusal.
	 */
	canEdit: boolean;
}

function ConfirmChanges({
	respond: _respond,
	status,
	onConfirm,
	onReject,
	canEdit,
}: ConfirmChangesProps) {
	const [accepted, setAccepted] = useState<boolean | null>(null);
	/** Which decision is currently being written, `null` when none is. */
	const [resolving, setResolving] = useState<boolean | null>(null);
	const [hidden, setHidden] = useState(false);
	const isResolving = resolving !== null;

	// Auto-dismiss after user makes a choice
	useEffect(() => {
		if (accepted !== null) {
			const timer = setTimeout(() => setHidden(true), 2000);
			return () => clearTimeout(timer);
		}
	}, [accepted]);

	/**
	 * The card's state machine, made async-aware.
	 *
	 * It used to latch `accepted` in the click handler and call the resolver
	 * next, which was honest while the resolver was synchronous and total. It
	 * is neither now: the fresh read is a round trip, and the resolution can
	 * fail with nothing written. Latching up front would show "✓ Accepted" over
	 * a draft that is still pending and then dismiss the card two seconds
	 * later, taking the last retry control in the chat with it — while the
	 * banner sits on another tab saying the resolution failed.
	 *
	 * So: hold an in-flight state for the duration, and latch only on a
	 * resolution that reports it landed. A failure returns the card to its
	 * offered state, retryable in place, with the banner's inline error as the
	 * explanation.
	 */
	const resolve = useCallback(
		async (accept: boolean) => {
			// Re-entrancy: two clicks would start two writes against one draft.
			if (accepted !== null || resolving !== null) {
				return;
			}
			setResolving(accept);
			let landed = false;
			try {
				landed = accept ? await onConfirm() : await onReject();
			} finally {
				setResolving(null);
			}
			if (landed) {
				setAccepted(accept);
			}
		},
		[accepted, resolving, onConfirm, onReject],
	);

	// If status is not "executing" and user hasn't made a choice,
	// this is a stale/re-registered component - hide it.
	//
	// `isResolving` holds the card open across that window deliberately:
	// resolving answers CopilotKit's HITL callback, which flips `status` off
	// "executing" — and unmounting the card mid-write would make an in-flight
	// resolution look like a completed one.
	if (status !== "executing" && accepted === null && !isResolving) {
		return null;
	}

	if (hidden) {
		return null;
	}

	return (
		<div
			data-testid="confirm-changes-modal"
			className="bg-card text-card-foreground p-6 rounded-lg shadow-lg border border-border mt-5 mb-5"
		>
			<h2 className="text-lg font-bold mb-4 text-foreground">
				Confirm Changes
			</h2>
			<p className="mb-6 text-foreground">
				Do you want to accept the changes?
			</p>
			{accepted === null && !canEdit && (
				<p
					data-testid="confirm-changes-readonly"
					className="text-sm text-muted-foreground"
				>
					You don't have permission to apply changes to this feature.
				</p>
			)}
			{accepted === null && canEdit && (
				<div className="flex items-center justify-end space-x-4">
					{isResolving && (
						<span
							data-testid="confirm-changes-pending"
							className="text-sm text-muted-foreground"
							aria-live="polite"
						>
							Applying your decision…
						</span>
					)}
					<button
						type="button"
						data-testid="reject-button"
						disabled={isResolving}
						className="bg-muted text-muted-foreground py-2 px-4 rounded cursor-pointer hover:bg-muted/80 disabled:cursor-not-allowed disabled:opacity-60"
						onClick={() => {
							void resolve(false);
						}}
					>
						Reject
					</button>
					<button
						type="button"
						data-testid="confirm-button"
						disabled={isResolving}
						className="bg-primary text-primary-foreground py-2 px-4 rounded cursor-pointer hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
						onClick={() => {
							void resolve(true);
						}}
					>
						Confirm
					</button>
				</div>
			)}
			{accepted !== null && (
				<div className="flex justify-end">
					<div
						data-testid="status-display"
						className="mt-4 bg-muted text-muted-foreground py-2 px-4 rounded inline-block"
					>
						{accepted ? "✓ Accepted" : "✗ Rejected"}
					</div>
				</div>
			)}
		</div>
	);
}
