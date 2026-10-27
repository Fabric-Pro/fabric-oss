"use client";

import {
	useCoAgent,
	useCopilotAction,
	useCopilotChat,
	useCopilotChatInternal,
	useCopilotReadable,
} from "@copilotkit/react-core";
import { normalizeDocumentType, type ProjectContext } from "@repo/agent-types";
import { featureKeyForAgentId } from "@repo/ai/lib/feature-keys";
import { countDocumentWords } from "@repo/utils/document-word-count";
import {
	DOCUMENT_GENERATION_IN_PROGRESS,
	isGenerationRunStillWriting,
	isRunGuardedDocumentType,
	REJECT_REVIEW_STALE,
} from "@repo/utils/generation-run-guard";
import {
	hasVisualSlots,
	preserveVisualSlots,
} from "@repo/utils/glossy/visual-slots";
import { normalizeForComparison } from "@repo/utils/normalize-for-comparison";
import { preserveVisualMarkers } from "@repo/utils/proposal-artifact/visual-identity";
import {
	type DraftVerdictRecorder,
	useConfirmChangesVerdict,
	useConfirmChangesVerdictCard,
} from "@saas/agents/copilot/useConfirmChangesVerdict";
import { AttachmentRegistryProvider } from "@saas/shared/components/copilot/AttachmentRegistry";
import { CopilotAssistantMessage } from "@saas/shared/components/copilot/CopilotAssistantMessage";
import { CopilotReplyRatingSidebar } from "@saas/shared/components/copilot/CopilotReplyRatingSidebar";
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
import { CustomMessages } from "./copilot/CustomMessages";
import { DocumentAssistantOutcomesProvider } from "./copilot/DocumentAssistantOutcomesProvider";
import { HydratedMessagesProvider } from "./copilot/HydratedMessagesContext";
import "@copilotkit/react-ui/styles.css";
import "./DocumentEditor.css";
import { useRegisterFabricAgentContext } from "@saas/agents/components/FabricAgentLauncher";
import { ACCEPT_OUTCOME_SUMMARIES } from "@saas/agents/copilot/accept-outcome-summaries";
import {
	type RecordOnResolveOptions,
	useConfirmChangesOperationResult,
} from "@saas/agents/copilot/useConfirmChangesOperationResult";
import { useCodeContextLauncher } from "@saas/agents/hooks/useCodeContextLauncher";
import { useDefaultMcpInlineRender } from "@saas/agents/hooks/useDefaultMcpInlineRender";
import { useFabricMention } from "@saas/agents/hooks/useFabricMention";
import { useSession } from "@saas/auth/hooks/use-session";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { useRegisterTiptapEditor } from "@saas/projects/components/excalidraw-auto-insert/TiptapEditorRegistry";
import { usePickerIntentConsumer } from "@saas/projects/components/excalidraw-auto-insert/usePickerIntentConsumer";
import { FabricLogo } from "@saas/shared/components/FabricLogo";
import { useFeatureFlag } from "@saas/shared/components/FeatureFlagProvider";
import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import {
	useIsMutating,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { Editor as DetachedEditor } from "@tiptap/core";
import { isChangeOrigin } from "@tiptap/extension-collaboration";
import { EditorContent, useEditor } from "@tiptap/react";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import { Button } from "@ui/components/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import { Textarea } from "@ui/components/textarea";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import {
	AlertTriangle,
	CheckIcon,
	ChevronDown,
	ClockIcon,
	Code2Icon,
	EyeIcon,
	HistoryIcon,
	ImageIcon,
	Loader2,
	MoreHorizontal as MoreHorizontalIcon,
	RefreshCcwDotIcon,
	RefreshCw,
	SaveIcon,
	SparklesIcon,
	X as XIcon,
} from "lucide-react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import {
	type ReactNode,
	type RefObject,
	startTransition,
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { createPortal, flushSync } from "react-dom";
import { toast } from "sonner";
import * as Y from "yjs";
import { PromptSelector } from "../../prompts/components/PromptSelector";
import {
	type DiffOutcomeAudit,
	useDiffOutcomeStamp,
} from "../hooks/use-diff-outcome-stamp";
import { useDiffPreview } from "../hooks/use-diff-view-mode";
import { useCollaborativeEditor } from "../hooks/useCollaborativeEditor";
import { useDocumentAssistantHistoryRealtimeSync } from "../hooks/useDocumentAssistantHistory";
import { useDocumentAssistantHistoryEnabled } from "../hooks/useDocumentAssistantHistoryEnabled";
import {
	isEmptyExtractionAgainstBaseline,
	isNoOpProposedContent,
} from "../lib/confirm-noop-guards";
import {
	focusOnAnchor,
	focusOnLastDiff,
	fromMarkdown,
	repairMarkdownDocument,
	resetScrollTracking,
	toAgentDocument,
} from "../lib/diff-utils";
import {
	isDocumentGenerationStale,
	resolveGenerationClock,
} from "../lib/document-generation-timestamp";
import {
	getDocumentPollInterval,
	isDocumentGenerationRunning,
} from "../lib/document-pipeline";
import {
	buildDocumentSaveInput,
	DOCUMENT_AUTOSAVE_TIMINGS,
	type DocumentSaveBase,
	isSaveBaseRequiredRefusal,
} from "../lib/document-save-input";
import { describeDocumentWriteRefusal } from "../lib/document-write-refusal";
import { getEditorMarkdownForSave } from "../lib/editor-markdown-save";
import { extractMentionIdsFromHtml } from "../lib/extract-mention-ids";
import {
	extractDocumentS3KeyFromImgSrc,
	keyWithinPrefix,
	uploadImage,
} from "../lib/image-upload-utils";
import {
	type MentionActiveIds,
	MentionStatusContext,
} from "../lib/mention-status-context";
import {
	MermaidVisualProvider,
	type ProposalVisualsOptions,
} from "../lib/mermaid-visual-context";
import {
	createSignedMediaUrlRefresher,
	type SignedMediaUrlRefresher,
} from "../lib/signed-media-url-refresher";
import { createCollaborativeExtensions } from "../lib/tiptap-extensions";
import { createAdvancedExtensions } from "../lib/tiptap-extensions-advanced";
import {
	diffKeepingVisualSlotsWhole,
	preserveEditorVisualSlots,
	VisualSlotControlsGate,
} from "../lib/tiptap-visual-slot-extension";
import { CollaborationStatus } from "./CollaborationStatus";
import { CopilotHistoryDrawer } from "./copilot/CopilotHistoryDrawer";
import { CopilotPersistenceHook } from "./copilot/CopilotPersistenceHook";
import { createCopilotSidebarHeader } from "./copilot/CopilotSidebarHeader";
import { createCopilotSidebarLauncher } from "./copilot/CopilotSidebarLauncher";
import { DiffPreviewPanes } from "./DiffPreviewPanes";
import { DiffReviewBar } from "./DiffReviewBar";
import { DiffViewModeToggle } from "./DiffViewModeToggle";
import { DocumentAssetsPanel } from "./DocumentAssetFrame";
import { DocumentDecisionPrecheckBanner } from "./DocumentDecisionPrecheckBanner";
import { DocumentGenerationFailedNotice } from "./DocumentGenerationFailedNotice";
import { DocumentGenerationProgress } from "./DocumentGenerationProgress";
import { DocumentTocRail } from "./DocumentTocRail";
import { DocumentVersionHistory } from "./DocumentVersionHistory";
import { useUpdateDocumentWithContext } from "./documents/useUpdateDocumentWithContext";
import { EditorToolbar } from "./EditorToolbar";
import { getOrpcCode } from "./field-mapping/orpc-error";
import { ImageLightbox } from "./ImageLightbox";
import { ImageSelectionToolbar } from "./ImageSelectionToolbar";
import {
	describeGenerationRefusal,
	resolveRegenerateToastKey,
} from "./proposal-artifact/generation-feedback";
import {
	appliesAttachedRunBody,
	isRoomBodyEmpty,
	publishGenerationRunRole,
	publishRoomPeer,
	publishRoomSaveInFlight,
	type RoomStamp,
	readRoomStamp,
	sameRoomStamp,
	writeRoomStamp,
} from "./proposal-artifact/generation-run-awareness";
import { RoomSavedBody } from "./proposal-artifact/RoomSavedBody";
import { RoomUpdatingStatus } from "./proposal-artifact/RoomUpdatingStatus";
import {
	type GenerationRunState,
	useGenerationRunState,
} from "./proposal-artifact/use-generation-run-state";
import { getOrpcErrorData } from "./proposal-artifact/use-proposal-analysis";
import type { ProposalThemeRootProps } from "./proposal-artifact/use-proposal-theme";
import {
	type RoomStatus,
	useRoomConvergence,
} from "./proposal-artifact/use-room-convergence";
import {
	SlashCommandsExtension,
	setSlashCommandImageUploadHandler,
} from "./SlashCommands";
import { genuineUserMessage } from "./stories/backlog-flow-controller";
import {
	isMeetingNotesTranscriptResult,
	MEETING_NOTES_SKIPPED_NONE_RESULT,
	MEETING_NOTES_SKIPPED_TOO_MANY_RESULT,
	MEETING_NOTES_TRANSCRIPT_MARKER,
	MeetingNotesFlow,
	MeetingNotesFlowCard,
} from "./stories/MeetingNotesFlow";

export {
	MEETING_NOTES_SKIPPED_NONE_RESULT,
	MEETING_NOTES_SKIPPED_TOO_MANY_RESULT,
} from "./stories/MeetingNotesFlow";

// Non-collaborative extensions (matches document-generator pattern)
// Uses advanced extensions for proper diff highlighting support (<em> and <s> tags).
// The @-mention suggestion popover needs the active project + document ids,
// so this is built per-instance via
// `buildNonCollaborativeExtensions(projectId, documentId)` rather than as a
// module-level constant.
function buildNonCollaborativeExtensions(
	projectId: string | null,
	documentId: string | null,
	statTiles: boolean,
) {
	return [
		...createAdvancedExtensions({ projectId, documentId, statTiles }),
		SlashCommandsExtension,
	];
}

type DocumentTiptapEditor = NonNullable<ReturnType<typeof useEditor>>;
type EditorContentArg = Parameters<
	DocumentTiptapEditor["commands"]["setContent"]
>[0];

/**
 * Where a programmatic content application comes from (Fizzy #2589).
 * Required at every call site, so the type checker makes each new one
 * choose:
 *
 * - `server` — a body the person or the server already stands behind: the
 *   initial load, a polled refresh, a repair of what was loaded, a restore,
 *   a rejected proposal's baseline, the person's own raw-markdown edit.
 *   Applied as is: a visual slot it lacks was deleted on purpose — by another
 *   editor, in raw mode, or by a server write path that already preserved
 *   slots — and must stay deleted.
 * - `assistant` — model output from the in-editor assistant. The document's
 *   visual slots are spliced in before it is rendered, so the model can
 *   neither drop a slot nor introduce one.
 */
type ProgrammaticContentSource = "server" | "assistant";

interface AssistantApplicationOptions {
	/**
	 * Turns the markdown, once the slots are spliced in, into editor content
	 * — a diff against the baseline, for instance. By default the markdown is
	 * rendered as is.
	 */
	render?: (markdown: string) => EditorContentArg;
	/**
	 * The markdown whose visual slots are spliced in. By default the editor's
	 * current content, which is right only while it holds a complete
	 * document. A streamed run passes its baseline instead: mid-run the
	 * editor holds the previous partial frame, where a slot whose section has
	 * not streamed yet sits orphaned at the partial's end.
	 */
	slotSource?: string;
}

interface ApplyProgrammaticContent {
	(
		ed: DocumentTiptapEditor | null | undefined,
		content: EditorContentArg,
		source: "server",
	): void;
	/**
	 * `markdown` is the assistant's body; see `AssistantApplicationOptions`
	 * for how it is rendered and whose slots it keeps. Returns the markdown
	 * applied, or `null` when there is no editor.
	 */
	(
		ed: DocumentTiptapEditor | null | undefined,
		markdown: string,
		source: "assistant",
		options?: AssistantApplicationOptions,
	): string | null;
}

/**
 * Shown when an accepted assistant proposal was not saved because the
 * document changed after the editor last synced (a guarded save's CONFLICT).
 */
const ACCEPT_VERSION_CONFLICT_MESSAGE =
	"Your accepted changes were not saved: the document changed in the meantime. They are still in the editor — copy anything you want to keep, then reload to review the latest version and apply them again.";

/**
 * How a save sent past `handleSave` was refused (Fizzy #2946): the editor
 * still holds what it would have saved, or no longer does — the page was
 * left, or the room was brought back to the saved document — and the text
 * was offered to copy instead; or the single-user editor that held it was
 * closed, and nothing holds it any more.
 */
type DirectSaveFailure = "keptInEditor" | "offeredToCopy" | "editorClosed";

/**
 * How long the run that answers a proposal must keep the editor locked
 * before the editor says so (Fizzy #2946): a shorter lock is neither shown
 * nor announced.
 */
const ASSISTANT_FINISHING_SHOW_DELAY_MS = 300;

/**
 * How long an answer to a proposal waits for the run it starts before it no
 * longer counts for the status above (Fizzy #2946).
 */
const ASSISTANT_FINISHING_ARM_MS = 10_000;

/**
 * How often, at most, the raw markdown view reads the editor's body again
 * while changes keep reaching the editor — a colleague typing (Fizzy #2946):
 * each read runs Turndown over the whole document.
 */
const RAW_VIEW_FOLLOW_MS = 150;

/** Why the switch between the rich and the raw view waits (Fizzy #2946). */
const VIEW_SWITCH_HELD_TEXT =
	"Switching views waits until the assistant, a generation run or a review is done with the document.";

/**
 * An accepted proposal whose save waits behind the one in flight, or is
 * the one in flight, with what it says of that save (Fizzy #2946).
 */
interface AcceptAwaitingSave {
	/** The text the accept saves. */
	accepted: string;
	/** The body the proposal's review started from. */
	acceptedFrom: string;
	/** The saved body when it was accepted. */
	savedBody: string;
	onSaved?: (saved: RoomStamp | null) => boolean | undefined;
	onFailed?: (failure: DirectSaveFailure) => void;
	onSettled?: () => void;
	onUndone: () => void;
}

const DOCUMENT_TYPE_LABELS: Record<string, string> = {
	GENERAL: "General",
	PRD: "PRD",
	PROPOSAL: "Proposal",
	BUSINESS_CASE: "Business Case",
	DESIGN_SYSTEM: "Design System",
	ARCHITECTURE: "Architecture",
	TECHNICAL_SPEC: "Technical Spec",
	USER_STORY: "Feature",
	API_SPEC: "API Spec",
	INTEGRATION_CONTRACT: "Integration Contract",
};

export function getDocumentTypeLabel(type: string): string {
	return DOCUMENT_TYPE_LABELS[type] ?? type.replace(/_/g, " ");
}

type Props = {
	projectId: string;
	documentId: string;
	/**
	 * When true, the action bar collapses its inline buttons into the
	 * overflow menu regardless of viewport width. The page-level wrapper
	 * (DocumentEditorPage) sets this when the AI sidebar is expanded — at
	 * that point the page is shifted but the lg: media query (viewport-based)
	 * doesn't know that the *available* width has shrunk, so without this
	 * flag the wide-tier inline buttons would overlap each other.
	 */
	isAiSidebarExpanded?: boolean;
	/**
	 * DOM mount points for the page-chrome action bar (Line 3). DocumentEditor
	 * portals its state-coupled chrome controls (Raw toggle + Version history
	 * into actionSlot, Save split-button into saveSlot) so the masthead stays
	 * consistent with the feature editor's layout while the state for those
	 * controls (viewMode, isSaving, hasUnsavedChanges) keeps living here where
	 * it belongs.
	 */
	actionSlot?: HTMLElement | null;
	saveSlot?: HTMLElement | null;
	/** Mount for the Yjs sync-status pill — lives on the breadcrumb row. */
	syncSlot?: HTMLElement | null;
	/**
	 * Group D — SSR-hydrated document-assistant context. The RSC page
	 * (`app/(saas)/app/.../documents/[documentId]/page.tsx`) fetches the
	 * caller's most recent ACTIVE document-assistant conversation and
	 * the client wrapper (`DocumentEditorPage`) passes the payload
	 * through. Messages themselves render via `<HydratedMessagesProvider>` +
	 * `<CustomMessages>` (see `HydratedMessagesContext.tsx`). The two
	 * props below let this component:
	 *
	 * - Stamp `documentRefKind` on every persistence write (Group H wires
	 *   `appendTurnForDocument`).
	 * - Track the current `conversationId` in local state so subsequent
	 *   turns append to the right conversation row (and so the "New
	 *   conversation" affordance in Group E can null it out).
	 *
	 * Defaults keep this component backwards-compatible with any callers
	 * that haven't been migrated yet (e.g. tests, storybook).
	 *
	 * Spec §6.2.
	 */
	documentRefKind?: "PROJECT_DOCUMENT" | "USER_STORY";
	initialAssistantConversationId?: string | null;
	/**
	 * Group E — visibility metadata from the same SSR fetch that produced
	 * `initialAssistantConversationId`. Drives the visibility chip in the
	 * `<CopilotSidebarHeader>` (FR-17 / FR-18, AC-8). Both default to a
	 * brand-new SHARED + unlocked thread so callers that haven't been
	 * migrated (e.g. tests) keep working.
	 */
	initialAssistantVisibility?: "SHARED" | "PRIVATE";
	initialAssistantVisibilityLockedAt?: string | null;
	/**
	 * Message ids from the SSR-hydrated conversation, threaded through to
	 * `CopilotPersistenceHook` so its walker doesn't re-fire
	 * `appendTurnForDocument` for already-persisted messages on every
	 * page reload. Derived in `DocumentEditorPage` from the same SSR
	 * payload that feeds `<HydratedMessagesProvider>`.
	 */
	initialPersistedMessageIds?: ReadonlyArray<string>;
	/**
	 * SSR-hydration seed for the live `<AttachmentRegistryProvider>`
	 * map. Derived at the page level from the same `initialAssistantMessages`
	 * payload. Pre-populating the registry on first render is what lets
	 * hydrated user bubbles render
	 * the rich `<MessageAttachmentList>` (inline image previews + file
	 * chips) on page reload instead of falling back to the legacy
	 * `[Attached: …]` filename caption.
	 */
	initialAttachmentsByMessageId?: ReadonlyMap<
		string,
		MessageAttachmentListItem[]
	>;
	/**
	 * Raw persisted-conversation blob from the SSR loader. Consumed by
	 * `<HydratedMessagesProvider>` (mounted around `<CopilotSidebar>`)
	 * so `<CustomMessages>` can render historical turns directly from
	 * React state instead of pushing them through `agent.messages`. This
	 * is the fix for the hydration flake — see HydratedMessagesContext
	 * docblock for the full Part-2 rationale.
	 */
	initialAssistantMessages?: ReadonlyArray<Record<string, unknown>>;
	/**
	 * The page shows generation progress itself (a Proposal in artifact mode,
	 * Fizzy #2801), so the full-screen progress overlay stays off. The failed
	 * notice and the regeneration review are unaffected.
	 */
	suppressGenerationOverlay?: boolean;
	/**
	 * Attach the editor to a generation the server reports as queued or running
	 * that the editor did not start (Fizzy #2801): a Proposal in artifact mode
	 * regenerated from the documents list, the chat, or before a reload. The
	 * editor then takes the regenerated body through its own regeneration
	 * review, exactly as if it had started the run, instead of keeping the body
	 * it loaded.
	 */
	attachToServerRun?: boolean;
	/**
	 * Shown in place of the prompt selector when the run ignores the prompt
	 * chosen here: a Proposal under the `PROPOSAL_ARTIFACT` gate is always
	 * written from the library's client proposal prompt (Fizzy #2801).
	 */
	promptSelectorReplacement?: ReactNode;
	/**
	 * Makes the box around the editor's content a theme root: a client-document
	 * Proposal's Main wears the shared Proposal theme there (Fizzy #2946). The
	 * box holds the content only, so the diff preview panes and the chat stay
	 * unthemed. The caller renders the theme's stylesheet.
	 */
	contentThemeProps?: ProposalThemeRootProps;
	/**
	 * Draws `stat-tiles` fences as tiles (Fizzy #2946). Only a client-document
	 * Proposal opts in; every other document keeps them as code blocks. Read
	 * once when the editor is built, so pass a value known at mount.
	 */
	statTiles?: boolean;
	/**
	 * What a client-document Proposal's diagrams need beside `statTiles`
	 * (Fizzy #2946): the theme's paint for their role colours, and whether
	 * the viewer is a member of the owning organization (Build with AI is
	 * offered to members only). Read only where `statTiles` is on.
	 */
	proposalVisuals?: ProposalVisualsOptions;
};

interface AgentState {
	document: string;
	streamingContent?: string;
	documentType?: string;
	error?: string;
	retryCount?: number;
	focusAnchor?: string;
	// RAG contexts from uploaded documents, Notion pages, etc.
	ragContexts?: string[];
	// Project context (name, techStack, features, etc.)
	projectContext?: ProjectContext;
	// Integration status flags
	hasTeamsIntegration?: boolean;
	hasSlackIntegration?: boolean;
	hasGitHubIntegration?: boolean;
	hasRepoIntegration?: boolean;
	// Tenant context for tool execution
	projectId?: string;
	userId?: string;
	organizationId?: string;
	// Per-turn reasoning trace surfaced via ReasoningCollapsible (PR #1023).
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

/** See `saveBlockReason` in `DocumentEditorInner`. */
type SaveBlockReason =
	| "regenerating"
	| "review"
	| "proposal"
	| "runLive"
	| "reconnecting"
	| "updatingToLatest"
	| "staleBase";

export function DocumentEditor({
	projectId,
	documentId,
	isAiSidebarExpanded = false,
	actionSlot,
	saveSlot,
	syncSlot,
	documentRefKind = "PROJECT_DOCUMENT",
	initialAssistantConversationId = null,
	initialAssistantVisibility = "SHARED",
	initialAssistantVisibilityLockedAt = null,
	initialPersistedMessageIds,
	initialAttachmentsByMessageId,
	initialAssistantMessages,
	suppressGenerationOverlay = false,
	attachToServerRun = false,
	promptSelectorReplacement,
	contentThemeProps,
	statTiles = false,
	proposalVisuals,
}: Props) {
	const [isRegenerating, setIsRegenerating] = useState(false);
	// Beside `isRegenerating`, above the collaboration branch that remounts
	// the editor on every sync loss (Fizzy #2946).
	const runState = useGenerationRunState();
	// The room stamp, the convergence of a room behind the saved document
	// and guarded saves (Fizzy #2946). Off, the editor saves and seeds its
	// room as it did before them.
	const roomConvergence = useFeatureFlag("DOCUMENT_ROOM_CONVERGENCE");
	const { organizationId } = useOrganizationContext();
	// Group D — Local state holding the active document-assistant
	// `conversationId`. Seeded from the SSR payload, this is the id that
	// Group H's `appendTurnForDocument` mutation will pass on each
	// stream-completion event. It is held as state (not a derived value)
	// because Group E's "New conversation" affordance resets it to `null`
	// and the next persisted turn will lazy-create a fresh row.
	//
	// `documentRefKind` is read-only — it is fully determined by which RSC
	// route mounted this component (PROJECT_DOCUMENT for the document editor,
	// USER_STORY for the feature editor's reuse of this component) and never
	// changes mid-session.
	const [activeAssistantConversationId, setActiveAssistantConversationId] =
		useState<string | null>(initialAssistantConversationId);
	// Group E — local visibility state seeded from the SSR snapshot. Bumped
	// to the outer component so a child re-render of `DocumentEditorInner`
	// does NOT throw away the user's pending "Private to me" toggle (the
	// inner component re-mounts on prompt changes / yjs sync events). The
	// header (rendered inside the inner component) reads + mutates this.
	const [activeAssistantVisibility, setActiveAssistantVisibility] = useState<
		"SHARED" | "PRIVATE"
	>(initialAssistantVisibility);
	const [
		activeAssistantVisibilityLockedAt,
		setActiveAssistantVisibilityLockedAt,
	] = useState<string | null>(initialAssistantVisibilityLockedAt);
	// Surface the seeded id once so Group H wiring has an obvious console
	// breadcrumb during development. Removed when Group H lands the
	// persistence mutation (which will replace this with real telemetry).
	useEffect(() => {
		if (process.env.NODE_ENV !== "production") {
			console.warn("[DocumentEditor] document-assistant hydrated", {
				documentRefKind,
				documentRefId: documentId,
				activeAssistantConversationId,
				activeAssistantVisibility,
				activeAssistantVisibilityLockedAt,
			});
		}
		// Run once per mount; subsequent updates to
		// `activeAssistantConversationId` are intentionally not logged
		// (Group H will replace this with telemetry anyway).
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);
	const params = useParams();
	const searchParams = useSearchParams();

	// Check if we should auto-generate on mount (from Create Document with AI)
	const shouldGenerateOnMount = searchParams.get("generate") === "true";

	// Detect if we're on an org route by checking for organizationSlug in params
	const paramOrgSlug = params?.organizationSlug as string | undefined;
	const isOrgRoute = !!paramOrgSlug;
	const orgContextReady = !isOrgRoute || organizationId !== undefined;

	// Check if collaboration is enabled via environment variable
	const enableCollaboration =
		process.env.NEXT_PUBLIC_ENABLE_COLLABORATION === "true";

	// Fetch document with polling when regenerating.
	// refetchOnWindowFocus is gated on isRegenerating: it lets users who
	// switch tabs during a long generation see the completed document
	// when they return. While simply reading, refetching on focus would
	// re-seed the editor and reset the scroll position.
	const {
		data: documentData,
		isLoading,
		// Passed down to DocumentEditorInner so its FAILED watcher can tell a
		// freshly-polled snapshot apart from one already in flight when a
		// regenerate mutation resolved (see regenerationAckAtRef).
		dataUpdatedAt: documentDataUpdatedAt,
	} = useQuery({
		...orpc.projects.documents.get.queryOptions({
			// `organizationId` is part of the query key. Omitting it here
			// while DocumentEditorPage passes it cached the same document
			// under two keys, so opening one document cost two identical
			// round-trips. It is also required for correctness: without it
			// the fetch falls back to the viewer's session active-org, which
			// 404s for a mentioned user whose active org differs from the
			// route (Fizzy #1187, fixed in DocumentEditorPage but not here).
			input: { id: documentId, projectId, organizationId },
		}),
		enabled: orgContextReady,
		// Poll when actively regenerating OR when the run is under way — QUEUED
		// as well as GENERATING, since a document waiting on the project's
		// context work never polled at all and so never noticed it started.
		//
		// The cadence is `getDocumentPollInterval`'s, shared with the Documents
		// tab and the pipeline: GENERATING keeps the flat 3s and its ten-minute
		// floor cap (which exists to give up on a run that died mid-flight),
		// while QUEUED is exempt from that cap and widens toward 30s instead.
		// The wait belongs to the server, which backs off from it on its own;
		// this poll only has to notice when it ends.
		refetchInterval: (query) => {
			const doc = query.state.data?.document;
			// A regenerate whose mutation is still in flight has no server
			// status to read yet, so it polls on the GENERATING schedule until
			// the row catches up.
			const pollStatus =
				doc?.status === "QUEUED"
					? "QUEUED"
					: isRegenerating
						? "GENERATING"
						: (doc?.status ?? "");
			return getDocumentPollInterval(
				pollStatus,
				resolveGenerationClock(
					pollStatus,
					doc?.generationStartedAt,
					doc?.updatedAt,
				),
			);
		},
		// "always" bypasses the 60s default staleTime so a user who tabs
		// away mid-generation always sees the completed document on return.
		refetchOnWindowFocus: (query) => {
			const doc = query.state.data?.document;
			if (doc?.status === "QUEUED") {
				return "always";
			}
			if (!isRegenerating && doc?.status !== "GENERATING") {
				return false;
			}
			// The same ten-minute silence ceiling the poll uses, measured the
			// same way: from the run's last server write, not from when its
			// request was accepted. A run that spent its first fifty minutes
			// waiting on the project's context work is not a dead one.
			const lastSignOfLife = resolveGenerationClock(
				"GENERATING",
				doc?.generationStartedAt,
				doc?.updatedAt,
			);
			if (Date.now() - lastSignOfLife > 10 * 60 * 1000) {
				return false;
			}
			return "always";
		},
	});

	const document = documentData?.document;

	// Fetch project for context - wait for org context on org routes
	// IMPORTANT: Pass null explicitly for personal context to prevent
	// session fallback which could leak org data to personal pages
	const { data: projectData } = useQuery({
		...orpc.projects.get.queryOptions({
			input: { id: projectId, organizationId },
		}),
		enabled: orgContextReady,
	});

	const project = projectData?.project;
	// Who may edit, as the page decides it for the title and a run's Retry
	// (and the collaboration server for writes to the room). `null` until the
	// project has loaded: such a client is not elected to converge a room and
	// does not seed one, but its editor stays editable meanwhile.
	const canEdit: boolean | null = project
		? project.userRole === "owner" || project.userRole === "editor"
		: null;

	// `!orgContextReady` belongs in the loading test, not beside it: the two
	// queries above are disabled until the org resolves, and a disabled query
	// does not report `isLoading`, so without this the render falls straight
	// through to "Document not found" on every org-route load. Mirrors the
	// combined flag in DocumentEditorPage.
	if (isLoading || !orgContextReady) {
		return (
			<div className="flex items-center justify-center h-96">
				<div className="text-muted-foreground">Loading document...</div>
			</div>
		);
	}

	if (!document) {
		return (
			<div className="flex items-center justify-center h-96">
				<div className="text-muted-foreground">Document not found</div>
			</div>
		);
	}

	// If collaboration is enabled, use the collaborative wrapper
	// Otherwise, render the editor directly without collaboration
	if (enableCollaboration) {
		return (
			<CollaborativeDocumentEditor
				projectId={projectId}
				documentId={documentId}
				organizationId={organizationId ?? null}
				document={document}
				project={project ?? null}
				isRegenerating={isRegenerating}
				setIsRegenerating={setIsRegenerating}
				runState={runState}
				roomConvergence={roomConvergence}
				canEdit={canEdit}
				shouldGenerateOnMount={shouldGenerateOnMount}
				isAiSidebarExpanded={isAiSidebarExpanded}
				actionSlot={actionSlot}
				saveSlot={saveSlot}
				syncSlot={syncSlot}
				documentRefKind={documentRefKind}
				activeAssistantConversationId={activeAssistantConversationId}
				setActiveAssistantConversationId={
					setActiveAssistantConversationId
				}
				ssrConversationId={initialAssistantConversationId}
				activeAssistantVisibility={activeAssistantVisibility}
				setActiveAssistantVisibility={setActiveAssistantVisibility}
				activeAssistantVisibilityLockedAt={
					activeAssistantVisibilityLockedAt
				}
				setActiveAssistantVisibilityLockedAt={
					setActiveAssistantVisibilityLockedAt
				}
				initialPersistedMessageIds={initialPersistedMessageIds}
				initialAttachmentsByMessageId={initialAttachmentsByMessageId}
				initialAssistantMessages={initialAssistantMessages}
				documentDataUpdatedAt={documentDataUpdatedAt}
				suppressGenerationOverlay={suppressGenerationOverlay}
				attachToServerRun={attachToServerRun}
				promptSelectorReplacement={promptSelectorReplacement}
				contentThemeProps={contentThemeProps}
				statTiles={statTiles}
				proposalVisuals={proposalVisuals}
			/>
		);
	}

	// Non-collaborative mode - render directly
	return (
		<DocumentEditorInner
			projectId={projectId}
			documentId={documentId}
			organizationId={organizationId ?? null}
			document={document}
			project={project ?? null}
			isRegenerating={isRegenerating}
			setIsRegenerating={setIsRegenerating}
			runState={runState}
			roomConvergence={roomConvergence}
			canEdit={canEdit}
			tabVisible
			enableCollaboration={false}
			ydoc={null}
			provider={null}
			isCollabConnected={false}
			isCollabSynced={false}
			collaborators={[]}
			userColor="#4ECDC4"
			shouldGenerateOnMount={shouldGenerateOnMount}
			isAiSidebarExpanded={isAiSidebarExpanded}
			actionSlot={actionSlot}
			saveSlot={saveSlot}
			syncSlot={syncSlot}
			documentRefKind={documentRefKind}
			activeAssistantConversationId={activeAssistantConversationId}
			setActiveAssistantConversationId={setActiveAssistantConversationId}
			activeAssistantVisibility={activeAssistantVisibility}
			setActiveAssistantVisibility={setActiveAssistantVisibility}
			activeAssistantVisibilityLockedAt={
				activeAssistantVisibilityLockedAt
			}
			setActiveAssistantVisibilityLockedAt={
				setActiveAssistantVisibilityLockedAt
			}
			initialPersistedMessageIds={initialPersistedMessageIds}
			initialAttachmentsByMessageId={initialAttachmentsByMessageId}
			initialAssistantMessages={initialAssistantMessages}
			ssrConversationId={initialAssistantConversationId}
			documentDataUpdatedAt={documentDataUpdatedAt}
			suppressGenerationOverlay={suppressGenerationOverlay}
			attachToServerRun={attachToServerRun}
			promptSelectorReplacement={promptSelectorReplacement}
			contentThemeProps={contentThemeProps}
			statTiles={statTiles}
			proposalVisuals={proposalVisuals}
		/>
	);
}

/**
 * How long a collaborative editor waits for its room to come back, once it
 * has synced, before it shows the saved body read-only (Fizzy #2946).
 */
const ROOM_AWAY_READ_ONLY_AFTER_MS = 45_000;

/**
 * The body this tab's copy of the room holds, as the editor writes it, or
 * `null` when it cannot be read. Read through a copy of the room, so nothing
 * the reading editor does ever reaches the room.
 */
async function readLocalRoomBody(ydoc: Y.Doc): Promise<string | null> {
	const copy = new Y.Doc();
	let reader: DetachedEditor | null = null;
	try {
		Y.applyUpdate(copy, Y.encodeStateAsUpdate(ydoc));
		const extensions = createCollaborativeExtensions({
			ydoc: copy,
			provider: null,
			user: { name: "", color: "#000000" },
			projectId: null,
			documentId: null,
		});
		if (!extensions) {
			return null;
		}
		reader = new DetachedEditor({ extensions });
		// The room binding draws the body into the editor on a later tick.
		await new Promise((resolve) => setTimeout(resolve, 10));
		return getEditorMarkdownForSave(reader);
	} catch {
		return null;
	} finally {
		reader?.destroy();
		copy.destroy();
	}
}

/**
 * What a collaborative editor shows once its room has been out of reach for
 * longer than `ROOM_AWAY_READ_ONLY_AFTER_MS` after the first sync (Fizzy
 * #2946): the saved body, read-only, a reload, and the text typed in this
 * tab since its last save to copy. Nothing saves meanwhile — there is no
 * editor to save from — and the editor is back when the room is.
 */
function RoomAwayView({
	markdown,
	statTiles,
	unsavedText,
}: {
	markdown: string;
	statTiles: boolean;
	unsavedText: string | null;
}) {
	const tRun = useTranslations("projects.documentEditorRun");
	const tRoom = useTranslations("projects.documentEditorRoom");
	const copyUnsavedText = () => {
		const clipboard =
			typeof navigator === "undefined" ? undefined : navigator.clipboard;
		if (!clipboard || unsavedText === null) {
			toast.error(tRoom("offerBack.copyFailed"));
			return;
		}
		clipboard.writeText(unsavedText).then(
			() => toast.success(tRoom("offerBack.copied")),
			() => toast.error(tRoom("offerBack.copyFailed")),
		);
	};
	return (
		<div className="flex flex-col gap-4 p-10">
			<div
				role="alert"
				className="flex flex-wrap items-center gap-3 rounded-md border px-4 py-3 text-sm"
			>
				<AlertTriangle
					className="h-4 w-4 shrink-0 text-highlight"
					aria-hidden
				/>
				<div className="flex min-w-0 flex-1 flex-col gap-1">
					<span className="font-medium">{tRun("away.title")}</span>
					<span className="text-xs text-muted-foreground">
						{tRun("away.hint")}
					</span>
				</div>
				<div className="flex flex-wrap gap-2">
					{unsavedText !== null && (
						<Button
							type="button"
							size="sm"
							variant="outline"
							onClick={copyUnsavedText}
						>
							{tRoom("offerBack.copy")}
						</Button>
					)}
					<Button
						type="button"
						size="sm"
						variant="outline"
						onClick={() => window.location.reload()}
					>
						{tRoom("reload")}
					</Button>
				</div>
			</div>
			<RoomSavedBody markdown={markdown} statTiles={statTiles} />
		</div>
	);
}

// Wrapper component that handles collaborative editing setup
// Has a timeout mechanism - if collaboration doesn't connect and sync within
// 12 seconds of opening, falls back to non-collaborative mode so users aren't
// blocked. After the first sync it never falls back (see below).
function CollaborativeDocumentEditor({
	projectId,
	documentId,
	organizationId,
	document,
	project,
	isRegenerating,
	setIsRegenerating,
	runState,
	roomConvergence,
	canEdit,
	shouldGenerateOnMount = false,
	isAiSidebarExpanded = false,
	actionSlot,
	saveSlot,
	syncSlot,
	documentRefKind,
	activeAssistantConversationId,
	setActiveAssistantConversationId,
	activeAssistantVisibility,
	setActiveAssistantVisibility,
	activeAssistantVisibilityLockedAt,
	setActiveAssistantVisibilityLockedAt,
	initialPersistedMessageIds,
	initialAttachmentsByMessageId,
	initialAssistantMessages,
	ssrConversationId,
	documentDataUpdatedAt,
	suppressGenerationOverlay,
	attachToServerRun,
	promptSelectorReplacement,
	contentThemeProps,
	statTiles,
	proposalVisuals,
}: {
	projectId: string;
	documentId: string;
	organizationId: string | null;
	document: {
		id: string;
		title: string;
		type: string;
		content: string | null;
		status?: string;
		generationError?: string | null;
		generationStartedAt?: Date | string | null;
		// Async decision pre-check result + the content hash it was judged
		// against, forwarded to the editor's inline contradiction banner.
		decisionPrecheck?: unknown;
		contentHash?: string | null;
		// Hash freshly computed from the live content by the read path, compared
		// against the pre-check's `checkedContentHash` for the banner's freshness
		// gate (decoupled from the embed-owned `contentHash`).
		currentContentHash?: string | null;
	};
	project: {
		name: string;
		description?: string | null;
		goals?: string | null;
		techStack: string[];
		features: string[];
		projectTypes?: string[];
		organizationId?: string | null;
		repositoryUrl?: string | null;
		repositoryOwner?: string | null;
		repositoryName?: string | null;
		defaultBranch?: string | null;
	} | null;
	isRegenerating: boolean;
	setIsRegenerating: (value: boolean) => void;
	runState: GenerationRunState;
	shouldGenerateOnMount?: boolean;
	isAiSidebarExpanded?: boolean;
	actionSlot?: HTMLElement | null;
	saveSlot?: HTMLElement | null;
	syncSlot?: HTMLElement | null;
	documentRefKind: "PROJECT_DOCUMENT" | "USER_STORY";
	activeAssistantConversationId: string | null;
	setActiveAssistantConversationId: (value: string | null) => void;
	activeAssistantVisibility: "SHARED" | "PRIVATE";
	setActiveAssistantVisibility: (value: "SHARED" | "PRIVATE") => void;
	activeAssistantVisibilityLockedAt: string | null;
	setActiveAssistantVisibilityLockedAt: (value: string | null) => void;
	initialPersistedMessageIds?: ReadonlyArray<string>;
	initialAttachmentsByMessageId?: ReadonlyMap<
		string,
		MessageAttachmentListItem[]
	>;
	initialAssistantMessages?: ReadonlyArray<Record<string, unknown>>;
	ssrConversationId: string | null;
	documentDataUpdatedAt: number;
	suppressGenerationOverlay: boolean;
	attachToServerRun: boolean;
	promptSelectorReplacement?: ReactNode;
	contentThemeProps?: ProposalThemeRootProps;
	statTiles: boolean;
	proposalVisuals?: ProposalVisualsOptions;
	roomConvergence: boolean;
	canEdit: boolean | null;
}) {
	const tRun = useTranslations("projects.documentEditorRun");
	const [isClient, setIsClient] = useState(false);
	const [connectionTimedOut, setConnectionTimedOut] = useState(false);
	// The document this editor has synced with the room at least once.
	const [syncedDocumentId, setSyncedDocumentId] = useState<string | null>(
		null,
	);
	const hasSynced = syncedDocumentId === documentId;

	// Ensure we're on the client before initializing Yjs
	useEffect(() => {
		setIsClient(true);
	}, []);

	// Initialize collaboration (only on client)
	const {
		ydoc,
		provider,
		isConnected: isCollabConnected,
		isSynced: isCollabSynced,
		collaborators,
		userColor,
	} = useCollaborativeEditor({
		documentId,
		projectId,
		enabled: isClient && !connectionTimedOut, // Disable if timed out
	});

	useEffect(() => {
		if (isCollabConnected && isCollabSynced) {
			setSyncedDocumentId(documentId);
		}
	}, [isCollabConnected, isCollabSynced, documentId]);

	// A room out of reach after the first sync is waited for (see below);
	// past `ROOM_AWAY_READ_ONLY_AFTER_MS` the saved body is shown read-only,
	// with the text typed here since the last save to copy (Fizzy #2946).
	// Whether there is any is kept here: a sync loss unmounts the editor
	// that knows it.
	const typedSinceSaveRef = useRef(false);
	const roomAway =
		hasSynced &&
		(!ydoc ||
			!provider?.awareness ||
			typeof provider.awareness.getStates !== "function" ||
			!isCollabConnected ||
			!isCollabSynced);
	const [roomAwayTooLong, setRoomAwayTooLong] = useState(false);
	useEffect(() => {
		if (!roomAway) {
			setRoomAwayTooLong(false);
			return;
		}
		const timer = setTimeout(
			() => setRoomAwayTooLong(true),
			ROOM_AWAY_READ_ONLY_AFTER_MS,
		);
		return () => clearTimeout(timer);
	}, [roomAway]);
	const [awayUnsavedText, setAwayUnsavedText] = useState<string | null>(null);
	useEffect(() => {
		if (!roomAwayTooLong || !ydoc || !typedSinceSaveRef.current) {
			setAwayUnsavedText(null);
			return;
		}
		let cancelled = false;
		void readLocalRoomBody(ydoc).then((text) => {
			if (!cancelled) {
				setAwayUnsavedText(text?.trim() ? text : null);
			}
		});
		return () => {
			cancelled = true;
		};
	}, [roomAwayTooLong, ydoc]);

	// Leaving the page while typing here is not covered by a save asks
	// first (Fizzy #2946): the room is not the saved document, and a later
	// update to the saved one may replace that text. Only for a client that
	// may edit; the browser shows its own wording.
	useEffect(() => {
		if (!roomConvergence || canEdit !== true) {
			return;
		}
		const onBeforeUnload = (event: BeforeUnloadEvent) => {
			if (!typedSinceSaveRef.current) {
				return;
			}
			event.preventDefault();
			event.returnValue = "";
		};
		window.addEventListener("beforeunload", onBeforeUnload);
		return () => window.removeEventListener("beforeunload", onBeforeUnload);
	}, [roomConvergence, canEdit]);

	// Leaving within the app — the page's Close, a breadcrumb link — unmounts
	// this editor without a `beforeunload`, so typing here that no save has
	// covered is saved on the way out, from the room's stamp (Fizzy #2946).
	// Otherwise it would stay only in the room, and an editor opened later
	// starts with nothing typed: a later update to the saved document would
	// replace that text without offering it back. The editor below supplies
	// the save and decides whether one is due; it clears it when a sync loss
	// unmounts it, so a disconnected room is never saved around. A layout
	// cleanup runs before the room's own passive cleanup tears it down, and
	// before the editor below is destroyed. A development remount (Strict
	// Mode) sets `left` back on its way in.
	const pageLeaveRef = useRef<PageLeave>({ flush: null, left: false });
	useLayoutEffect(() => {
		const leave = pageLeaveRef.current;
		leave.left = false;
		return () => {
			leave.left = true;
			leave.flush?.();
		};
	}, []);

	// Connection timeout - fall back to non-collaborative mode if the
	// PartyKit provider hasn't both connected and synced within the grace
	// window. 12s covers slow initial sync on prod (observed persistent
	// "connecting to collaboration server" spinner) without leaving users
	// waiting indefinitely.
	//
	// Only before the first sync (Fizzy #2946). The fallback editor saves
	// around the room: once this tab has synced, the room holds what other
	// tabs see, and a body saved past it is replaced by the room's older one
	// at the next sync, or writes the room's older one back. A later drop
	// waits for the reconnect instead.
	useEffect(() => {
		if (!isClient || connectionTimedOut || hasSynced) {
			return;
		}

		const timeout = setTimeout(() => {
			if (!isCollabConnected || !isCollabSynced) {
				console.warn(
					"[CollaborativeDocumentEditor] Connection timeout - falling back to non-collaborative mode",
				);
				setConnectionTimedOut(true);
			}
		}, 12000); // 12 second timeout

		// Clear timeout if we successfully connect
		if (isCollabConnected && isCollabSynced) {
			clearTimeout(timeout);
		}

		return () => clearTimeout(timeout);
	}, [
		isClient,
		isCollabConnected,
		isCollabSynced,
		connectionTimedOut,
		hasSynced,
	]);

	// Tell the other editors in the room whether this one started the run in
	// flight or follows it, so only one of them writes its body (see
	// `appliesAttachedRunBody`), and which run that is. The role stays
	// published through the review of a run this editor started, named by
	// that run: a later run started by a colleague, the API or an agent is
	// not one this review wrote, so an editor following it still writes its
	// body into the room. An editor whose own run is in flight names no run:
	// its page may not have read that run's identity yet, and no other run
	// can be in flight beside it.
	//
	// Published here rather than by the editor below (Fizzy #2946): a sync
	// loss unmounts that editor but not the run, so its role must neither be
	// withdrawn nor flip while the room reconnects. A new provider gets the
	// role again; leaving the page withdraws it.
	const { isConfirming, attachedRunRef, reviewedRunStartedAtRef } = runState;
	const latestRun = runIdentity(document.generationStartedAt);
	useEffect(() => {
		publishGenerationRunRole(
			provider?.awareness,
			isRegenerating || isConfirming
				? attachedRunRef.current
					? "attached"
					: "started"
				: null,
			isRegenerating
				? attachedRunRef.current
					? latestRun
					: null
				: reviewedRunStartedAtRef.current,
		);
	}, [
		provider,
		isRegenerating,
		isConfirming,
		latestRun,
		attachedRunRef,
		reviewedRunStartedAtRef,
	]);
	const providerRef = useRef(provider);
	providerRef.current = provider;
	useEffect(() => {
		return () => {
			publishGenerationRunRole(providerRef.current?.awareness, null);
		};
	}, []);

	// Whether this tab is in front, for the election that picks which editor
	// brings a room behind the saved document up to date (Fizzy #2946): a
	// visible tab before a hidden one, whose timers and frames the browser
	// holds back.
	const [tabVisible, setTabVisible] = useState(
		() =>
			typeof window === "undefined" ||
			window.document.visibilityState !== "hidden",
	);
	useEffect(() => {
		if (!roomConvergence) {
			return;
		}
		const onVisibilityChange = () => {
			setTabVisible(window.document.visibilityState !== "hidden");
		};
		onVisibilityChange();
		window.document.addEventListener(
			"visibilitychange",
			onVisibilityChange,
		);
		return () => {
			window.document.removeEventListener(
				"visibilitychange",
				onVisibilityChange,
			);
		};
	}, [roomConvergence]);
	// Published here, beside the run role, so a sync loss does not withdraw
	// it: whether this client may edit — a viewer is never elected — and
	// whether its tab is visible.
	useEffect(() => {
		if (!roomConvergence) {
			return;
		}
		publishRoomPeer(provider?.awareness, {
			canEdit: canEdit === true,
			visible: tabVisible,
		});
	}, [roomConvergence, provider, canEdit, tabVisible]);

	// If connection timed out, render in non-collaborative mode.
	// MUST thread `actionSlot` / `saveSlot` / `syncSlot` through — they're
	// the portal targets for the Save split-button + Version history +
	// collab status pill. The original PR #802 (action-bar redesign)
	// added these to the success path but forgot the fallback, so a
	// collab timeout silently hid the Save / Version-history buttons.
	if (connectionTimedOut) {
		return (
			<DocumentEditorInner
				projectId={projectId}
				documentId={documentId}
				organizationId={organizationId}
				document={document}
				project={project}
				isRegenerating={isRegenerating}
				setIsRegenerating={setIsRegenerating}
				runState={runState}
				roomConvergence={roomConvergence}
				canEdit={canEdit}
				tabVisible={tabVisible}
				enableCollaboration={false}
				ydoc={null}
				provider={null}
				isCollabConnected={false}
				isCollabSynced={false}
				collaborators={[]}
				userColor="#4ECDC4"
				shouldGenerateOnMount={shouldGenerateOnMount}
				isAiSidebarExpanded={isAiSidebarExpanded}
				actionSlot={actionSlot}
				saveSlot={saveSlot}
				syncSlot={syncSlot}
				documentRefKind={documentRefKind}
				activeAssistantConversationId={activeAssistantConversationId}
				setActiveAssistantConversationId={
					setActiveAssistantConversationId
				}
				ssrConversationId={ssrConversationId}
				activeAssistantVisibility={activeAssistantVisibility}
				setActiveAssistantVisibility={setActiveAssistantVisibility}
				activeAssistantVisibilityLockedAt={
					activeAssistantVisibilityLockedAt
				}
				setActiveAssistantVisibilityLockedAt={
					setActiveAssistantVisibilityLockedAt
				}
				initialPersistedMessageIds={initialPersistedMessageIds}
				initialAttachmentsByMessageId={initialAttachmentsByMessageId}
				initialAssistantMessages={initialAssistantMessages}
				documentDataUpdatedAt={documentDataUpdatedAt}
				suppressGenerationOverlay={suppressGenerationOverlay}
				attachToServerRun={attachToServerRun}
				promptSelectorReplacement={promptSelectorReplacement}
				contentThemeProps={contentThemeProps}
				statTiles={statTiles}
				proposalVisuals={proposalVisuals}
			/>
		);
	}

	// Show loading while waiting for client-side hydration, ydoc, provider, connection, AND sync
	// The CollaborationCursor extension requires the provider's awareness to be fully ready,
	// which only happens after the initial sync is complete
	// Also verify provider.awareness exists - this can be undefined during initialization
	const isProviderReady =
		provider?.awareness &&
		typeof provider.awareness.getStates === "function";

	if (
		!isClient ||
		!ydoc ||
		!isProviderReady ||
		!isCollabConnected ||
		!isCollabSynced
	) {
		// A drop after the first sync waits for the reconnect (Fizzy #2946):
		// there is no fallback editor to type into, and the run this editor
		// holds is picked up again when the room is back. A long one shows
		// the saved body read-only meanwhile.
		if (hasSynced) {
			if (roomAwayTooLong) {
				return (
					<RoomAwayView
						markdown={document.content ?? ""}
						statTiles={statTiles}
						unsavedText={awayUnsavedText}
					/>
				);
			}
			return (
				<div className="flex items-center justify-center h-96">
					<output
						aria-live="polite"
						className="flex flex-col items-center gap-3 text-muted-foreground"
					>
						<Loader2 className="h-8 w-8 animate-spin" aria-hidden />
						<span>{tRun("reconnecting.title")}</span>
						<span className="text-xs text-muted-foreground/70">
							{tRun("reconnecting.hint")}
						</span>
					</output>
				</div>
			);
		}
		return (
			<div className="flex items-center justify-center h-96">
				<div className="flex flex-col items-center gap-3 text-muted-foreground">
					<Loader2 className="h-8 w-8 animate-spin" />
					<span>
						{isCollabConnected
							? "Syncing document..."
							: "Connecting to collaboration server..."}
					</span>
					<span className="text-xs text-muted-foreground/70">
						Will continue without collaboration if connection fails
					</span>
				</div>
			</div>
		);
	}

	// Additional safety check - verify ydoc is truly a Y.Doc with required methods
	if (typeof ydoc.getXmlFragment !== "function") {
		console.error(
			"[CollaborativeDocumentEditor] ydoc passed guard but doesn't have getXmlFragment!",
		);
		return (
			<div className="flex items-center justify-center h-96">
				<div className="flex flex-col items-center gap-3 text-muted-foreground">
					<Loader2 className="h-8 w-8 animate-spin" />
					<span>Initializing document structure...</span>
				</div>
			</div>
		);
	}

	return (
		<DocumentEditorInner
			projectId={projectId}
			documentId={documentId}
			organizationId={organizationId}
			document={document}
			project={project}
			isRegenerating={isRegenerating}
			setIsRegenerating={setIsRegenerating}
			runState={runState}
			roomConvergence={roomConvergence}
			canEdit={canEdit}
			tabVisible={tabVisible}
			typedSinceSaveRef={typedSinceSaveRef}
			pageLeaveRef={pageLeaveRef}
			enableCollaboration={true}
			ydoc={ydoc}
			provider={provider}
			isCollabConnected={isCollabConnected}
			isCollabSynced={isCollabSynced}
			collaborators={collaborators ?? []}
			userColor={userColor}
			shouldGenerateOnMount={shouldGenerateOnMount}
			isAiSidebarExpanded={isAiSidebarExpanded}
			actionSlot={actionSlot}
			saveSlot={saveSlot}
			syncSlot={syncSlot}
			documentRefKind={documentRefKind}
			activeAssistantConversationId={activeAssistantConversationId}
			setActiveAssistantConversationId={setActiveAssistantConversationId}
			activeAssistantVisibility={activeAssistantVisibility}
			setActiveAssistantVisibility={setActiveAssistantVisibility}
			activeAssistantVisibilityLockedAt={
				activeAssistantVisibilityLockedAt
			}
			setActiveAssistantVisibilityLockedAt={
				setActiveAssistantVisibilityLockedAt
			}
			initialPersistedMessageIds={initialPersistedMessageIds}
			initialAttachmentsByMessageId={initialAttachmentsByMessageId}
			initialAssistantMessages={initialAssistantMessages}
			ssrConversationId={ssrConversationId}
			documentDataUpdatedAt={documentDataUpdatedAt}
			suppressGenerationOverlay={suppressGenerationOverlay}
			attachToServerRun={attachToServerRun}
			promptSelectorReplacement={promptSelectorReplacement}
			contentThemeProps={contentThemeProps}
			statTiles={statTiles}
			proposalVisuals={proposalVisuals}
		/>
	);
}

// Inner component with CopilotKit hooks
interface CollaboratorInfo {
	name: string;
	color: string;
	image?: string;
}

interface DocumentEditorInnerProps {
	projectId: string;
	documentId: string;
	organizationId: string | null;
	isRegenerating: boolean;
	setIsRegenerating: (value: boolean) => void;
	/** Held by the outer `DocumentEditor`; see `GenerationRunState`. */
	runState: GenerationRunState;
	/** See note on the public DocumentEditor `isAiSidebarExpanded` prop. */
	isAiSidebarExpanded?: boolean;
	document: {
		id: string;
		title: string;
		type: string;
		content: string | null;
		version?: number;
		status?: string;
		generationError?: string | null;
		generationProgress?: number;
		generationStartedAt?: Date | string | null;
		updatedAt?: Date | string | null;
		// Async decision pre-check result + the content hash it was judged
		// against, surfaced by the editor's inline contradiction banner.
		decisionPrecheck?: unknown;
		contentHash?: string | null;
		// Hash freshly computed from the live content by the read path, compared
		// against the pre-check's `checkedContentHash` for the banner's freshness
		// gate (decoupled from the embed-owned `contentHash`).
		currentContentHash?: string | null;
	};
	project: {
		name: string;
		description?: string | null;
		goals?: string | null;
		techStack: string[];
		features: string[];
		projectTypes?: string[];
		organizationId?: string | null;
		repositoryUrl?: string | null;
		repositoryOwner?: string | null;
		repositoryName?: string | null;
		defaultBranch?: string | null;
	} | null;
	// Collaboration props (passed from outer component)
	enableCollaboration: boolean;
	ydoc: Y.Doc | null;
	provider: import("y-partykit/provider").default | null;
	isCollabConnected: boolean;
	isCollabSynced: boolean;
	collaborators: CollaboratorInfo[];
	userColor: string;
	// Auto-generation on mount (from Create Document with AI)
	shouldGenerateOnMount?: boolean;
	/** See note on the public DocumentEditor `actionSlot` / `saveSlot` props. */
	actionSlot?: HTMLElement | null;
	saveSlot?: HTMLElement | null;
	syncSlot?: HTMLElement | null;
	// Group D / E — document-assistant context lifted to the outer
	// `DocumentEditor` so it survives inner re-mounts (yjs ticks, prompt
	// refetches). The inner component reads + mutates them via the setters
	// below. See `DocumentEditor` for the live state owners.
	documentRefKind: "PROJECT_DOCUMENT" | "USER_STORY";
	activeAssistantConversationId: string | null;
	setActiveAssistantConversationId: (value: string | null) => void;
	activeAssistantVisibility: "SHARED" | "PRIVATE";
	setActiveAssistantVisibility: (value: "SHARED" | "PRIVATE") => void;
	activeAssistantVisibilityLockedAt: string | null;
	setActiveAssistantVisibilityLockedAt: (value: string | null) => void;
	/** Threaded from the public `DocumentEditor` prop so the inner
	 * `<CopilotPersistenceHook>` mount can pre-seed its dedupe set. */
	initialPersistedMessageIds?: ReadonlyArray<string>;
	/** Threaded from the public `DocumentEditor` prop so the inner
	 * `<AttachmentRegistryProvider>` mount can pre-populate its map. */
	initialAttachmentsByMessageId?: ReadonlyMap<
		string,
		MessageAttachmentListItem[]
	>;
	/** Raw persisted-conversation blob from the SSR loader, threaded
	 * through to `<HydratedMessagesProvider>` which sits inside the
	 * inner component around `<CopilotSidebar>`. */
	initialAssistantMessages?: ReadonlyArray<Record<string, unknown>>;
	/**
	 * The conversation id the SSR `initialAssistantMessages` blob belongs
	 * to. Distinct from `activeAssistantConversationId` (which is the
	 * LIVE, mutable id that flips when the user clicks "Start a new
	 * conversation"). `<HydratedMessagesProvider>` compares the two to
	 * decide whether the SSR-loaded history is still relevant — when
	 * they diverge (active points at a different / null conversation),
	 * the provider clears the historical set so the user doesn't see
	 * the archived thread's turns inside the brand-new one.
	 */
	ssrConversationId: string | null;
	/**
	 * `dataUpdatedAt` from the outer `documents.get` query that produces
	 * `document` (react-query's fetch-completion timestamp for that query's
	 * current data). Consumed by the FAILED watcher effect below via
	 * `regenerationAckAtRef` to distinguish a genuinely fresh failure from a
	 * stale pre-retry snapshot still in flight when a regenerate mutation
	 * resolved.
	 */
	documentDataUpdatedAt: number;
	/** See the public DocumentEditor `suppressGenerationOverlay` prop. */
	suppressGenerationOverlay: boolean;
	/** See the public DocumentEditor `attachToServerRun` prop. */
	attachToServerRun: boolean;
	/** See the public DocumentEditor `promptSelectorReplacement` prop. */
	promptSelectorReplacement?: ReactNode;
	/** See the public DocumentEditor `contentThemeProps` prop. */
	contentThemeProps?: ProposalThemeRootProps;
	/** See the public DocumentEditor `statTiles` prop. */
	statTiles: boolean;
	/** See the public DocumentEditor `proposalVisuals` prop. */
	proposalVisuals?: ProposalVisualsOptions;
	/** `DOCUMENT_ROOM_CONVERGENCE`, read by the outer `DocumentEditor`. */
	roomConvergence: boolean;
	/**
	 * Whether this client may edit the document; `null` until the project
	 * has loaded (see `DocumentEditor`).
	 */
	canEdit: boolean | null;
	/** Whether this tab is in front (see `CollaborativeDocumentEditor`). */
	tabVisible: boolean;
	/**
	 * Kept up to date with whether this editor holds text typed here since
	 * its last save, for the view a long sync loss shows (see
	 * `CollaborativeDocumentEditor`).
	 */
	typedSinceSaveRef?: RefObject<boolean>;
	/** Held by the collaborative wrapper; see `PageLeave`. */
	pageLeaveRef?: RefObject<PageLeave>;
}

/**
 * Leaving the page within the app, shared by `CollaborativeDocumentEditor`
 * and the editor it renders. `flush` is set by that editor to the save sent
 * when the wrapper unmounts, and cleared when the editor unmounts on its own
 * (a sync loss). `left` is set once the wrapper has unmounted.
 */
type PageLeave = { flush: (() => void) | null; left: boolean };

/**
 * A run's identity, the document's `generationStartedAt`, as an ISO string,
 * or `null` when the server named none (Fizzy #2946).
 */
function runIdentity(
	startedAt: Date | string | null | undefined,
): string | null {
	if (!startedAt) {
		return null;
	}
	const time = new Date(startedAt).getTime();
	return Number.isNaN(time) ? null : new Date(time).toISOString();
}

/** The editor, or `null` once it has been destroyed (it cannot be read). */
function liveEditorOrNull<T extends { isDestroyed: boolean }>(
	editor: T | null | undefined,
): T | null {
	return editor && !editor.isDestroyed ? editor : null;
}

/**
 * Where an offset into `before` lands in `after`, taking the two to differ
 * in one stretch (Fizzy #2946): before it, the offset stays; after it, it
 * moves with the text; inside it, it stays within what replaced it.
 */
function followTextOffset(
	before: string,
	after: string,
	offset: number,
): number {
	const shorter = Math.min(before.length, after.length);
	let prefix = 0;
	while (prefix < shorter && before[prefix] === after[prefix]) {
		prefix += 1;
	}
	let suffix = 0;
	while (
		suffix < shorter - prefix &&
		before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
	) {
		suffix += 1;
	}
	if (offset <= prefix) {
		return offset;
	}
	if (offset >= before.length - suffix) {
		return offset + after.length - before.length;
	}
	return Math.min(offset, after.length - suffix);
}

function formatTranscriptContexts(
	transcripts: Array<{
		meetingSubject: string;
		meetingDate: string | null;
		speakerNames: string[];
		content: string;
	}>,
): string[] {
	return transcripts.map((t) => {
		const date = t.meetingDate
			? new Date(t.meetingDate).toLocaleDateString()
			: "";
		const speakers =
			t.speakerNames.length > 0
				? `Speakers: ${t.speakerNames.join(", ")}\n`
				: "";
		return `[Meeting Transcript - ${t.meetingSubject}${date ? ` (${date})` : ""}]\n${speakers}${t.content}`;
	});
}

function DocumentEditorInner({
	projectId,
	documentId,
	organizationId,
	document,
	project,
	isRegenerating,
	setIsRegenerating,
	runState,
	// Collaboration props from parent
	enableCollaboration,
	ydoc,
	provider,
	isCollabConnected,
	isCollabSynced,
	collaborators,
	userColor,
	// Auto-generation on mount (from Create Document with AI)
	shouldGenerateOnMount = false,
	isAiSidebarExpanded = false,
	actionSlot,
	saveSlot,
	syncSlot,
	// Document-assistant context (Group D/E) — read-only here; setters
	// are wired into the CopilotSidebar header's "New conversation"
	// handler and (in Group H) the post-stream `appendTurnForDocument`
	// success callback.
	documentRefKind,
	activeAssistantConversationId,
	setActiveAssistantConversationId,
	activeAssistantVisibility,
	setActiveAssistantVisibility,
	activeAssistantVisibilityLockedAt,
	setActiveAssistantVisibilityLockedAt,
	initialPersistedMessageIds,
	initialAttachmentsByMessageId,
	initialAssistantMessages,
	ssrConversationId,
	documentDataUpdatedAt,
	suppressGenerationOverlay,
	attachToServerRun,
	promptSelectorReplacement,
	contentThemeProps,
	statTiles,
	proposalVisuals,
	roomConvergence,
	canEdit,
	tabVisible,
	typedSinceSaveRef,
	pageLeaveRef,
}: DocumentEditorInnerProps) {
	const tTooltips = useTranslations("tooltips.documentEditor");
	const tRun = useTranslations("projects.documentEditorRun");
	const tRoom = useTranslations("projects.documentEditorRoom");
	const tWriteRefusal = useTranslations("projects.documentWriteRefusal");
	const tRegenerateToast = useTranslations(
		"projects.documents.regenerateToast",
	);
	const tGenerationFeedback = useTranslations(
		"projects.proposalArtifact.generationFeedback",
	);

	/*
	 * A generation run is already under way — waiting on the project's context
	 * work, or actually writing. Every control that would start another one is
	 * closed off while this holds: the Regenerate button was the one live way
	 * to restart a wait that was working exactly as designed.
	 */
	const isGenerationRunning = isDocumentGenerationRunning(
		document?.status ?? "",
	);
	const isWaitingForContext = document?.status === "QUEUED";

	// Group E — feature flag (FR-27) for the chat-history header. Returns
	// true for personal context and for orgs with the flag ON. When
	// false, the `Header` prop on `<CopilotSidebar>` is left at its
	// CopilotKit default (no plus/history/visibility chip).
	const documentAssistantHistoryEnabled =
		useDocumentAssistantHistoryEnabled();

	// Fork-aware hydration state. Seeded from the SSR-init props, replaced
	// by `handleForked` below when the user forks a historical conversation
	// from the drawer. The three values move together:
	//   - `effectiveAssistantMessages` — what `<HydratedMessagesProvider>`
	//     and `CustomMessages` render as the historical-half of the sidebar.
	//   - `effectiveSsrConversationId` — keyed against `activeAssistant
	//     ConversationId` by the provider: when they match, the messages
	//     render; when they diverge (e.g. "Start new conversation"), the
	//     historical half goes empty. Replacing this with the forked id
	//     keeps the post-fork sidebar populated.
	//   - `effectivePersistedMessageIds` — pre-seeds the persistence walker
	//     so it does NOT re-persist any of the copied messages on the next
	//     fingerprint tick (they already exist in the new conversation
	//     row server-side from the fork transaction).
	//
	// Why local state (not derived): the SSR props are frozen at mount.
	// Fork happens mid-session and needs to replace them without a page
	// reload — otherwise the chat would flicker out before the new conv
	// renders.
	const [effectiveAssistantMessages, setEffectiveAssistantMessages] =
		useState<ReadonlyArray<Record<string, unknown>> | undefined>(
			initialAssistantMessages,
		);
	const [effectiveSsrConversationId, setEffectiveSsrConversationId] =
		useState<string | null>(ssrConversationId);
	const [effectivePersistedMessageIds, setEffectivePersistedMessageIds] =
		useState<ReadonlyArray<string> | undefined>(initialPersistedMessageIds);
	// Group E — CopilotKit's live message-store setter (FR-10). The
	// plus-icon affordance calls `setCopilotMessages([])` to clear the
	// transcript so the next user input lazy-creates a fresh row.
	//
	// `useCopilotChatInternal().setMessages` (NOT
	// `useCopilotMessagesContext().setMessages`) is the supported primitive
	// in CopilotKit 1.52: the context's setMessages writes into a separate
	// `useState([])` that the sidebar does not render from, so clearing it
	// has no visible effect. The internal hook routes through
	// `agent.setMessages(...)` which is the array `<CopilotSidebar>`'s
	// custom <CustomMessages> mounts read for the LIVE half of its
	// output (the historical half comes from <HydratedMessagesProvider>).
	const { setMessages: setCopilotMessages } = useCopilotChatInternal();
	// Cross-tab BroadcastChannel listener: when this user has the same
	// document open in another tab and renames / deletes / appends there,
	// the local drawer's list + viewer pane refetches without waiting for
	// a focus tick. Mount unconditionally — the hook no-ops when the
	// feature flag is off, when BroadcastChannel is unavailable (older
	// browsers / privacy mode), or when the scope doesn't match.
	useDocumentAssistantHistoryRealtimeSync({
		documentRefKind: "PROJECT_DOCUMENT",
		documentRefId: documentId,
		projectId,
		organizationId: organizationId ?? null,
	});
	// Group E — local drawer state. Group F's `<CopilotHistoryDrawer>`
	// reads it; the header flips it open.
	const [historyDrawerOpen, setHistoryDrawerOpen] = useState(false);
	const [isProgressDismissed, setIsProgressDismissed] = useState(false);

	useEffect(() => {
		setIsProgressDismissed(false);
	}, [documentId]);
	// `documentRefKind` is read by `<CopilotSidebarHeader>` (Group E),
	// `<CopilotHistoryDrawer>` (Group F), and will be consumed by
	// `appendTurnForDocument` in Group H.
	// Router for URL manipulation (used by auto-generation and save redirect)
	const router = useRouter();
	// Used to build the Manage Prompts link when the page chrome owns the
	// gear (mirrors PromptSelector's own basePath/documentType-aware URL).
	const { basePath } = useOrganizationContext();
	const params = useParams();

	// Fetch document assets (architecture diagrams etc. produced by Agent Skills).
	// Polls while regenerating so a newly-saved diagram shows up automatically.
	const { data: assetsData } = useQuery({
		...orpc.projects.documents.listAssets.queryOptions({
			input: { projectId, documentId, organizationId },
		}),
		refetchInterval: isRegenerating ? 3000 : false,
	});
	const documentAssets = assetsData?.assets ?? [];

	// Resolve which @mention user IDs in the initial content are still active
	// members of this project/org. The result feeds MentionStatusContext so that
	// MentionNodeView can grey-out chips for removed users.
	const initialMentionIds = useMemo(
		() => extractMentionIdsFromHtml(document.content),
		// document.content is the initial snapshot — intentionally not reactive to
		// live editor changes (which would trigger a fetch on every keystroke).
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[document.id],
	);

	const { data: activeMentionsData } = useQuery({
		...orpc.projects.documents.resolveActiveMentions.queryOptions({
			input: { userIds: initialMentionIds, organizationId, projectId },
		}),
		enabled: initialMentionIds.length > 0,
		staleTime: 60_000,
	});

	const activeIdsSet: MentionActiveIds = useMemo(
		() =>
			activeMentionsData ? new Set(activeMentionsData.activeIds) : null,
		[activeMentionsData],
	);

	const fabricAgentContext = useMemo(
		() => ({
			projectId,
			projectName: project?.name,
			documentId,
			repositoryUrl: project?.repositoryUrl ?? null,
			repositoryOwner: project?.repositoryOwner ?? null,
			repositoryName: project?.repositoryName ?? null,
		}),
		[
			projectId,
			project?.name,
			documentId,
			project?.repositoryUrl,
			project?.repositoryOwner,
			project?.repositoryName,
		],
	);
	useRegisterFabricAgentContext(fabricAgentContext);

	// RAG contexts are no longer pre-fetched and injected into the system prompt.
	// The agent uses search_project_knowledge tool for on-demand retrieval,
	// which returns only relevant contexts per query instead of all 20+ contexts.
	// This reduces the system prompt from ~250K tokens to ~50K tokens.
	const documentContextData = { ragContexts: [] as string[] };
	const isLoadingContexts = false;

	// Check if code search is enabled for this project (controls hasRepoIntegration)
	const { data: ragSettingsData } = useQuery({
		...orpc.projects.ragSettings.get.queryOptions({
			input: { projectId, organizationId: organizationId ?? null },
		}),
		enabled: !!projectId,
		staleTime: 60000,
	});
	const codeSearchEnabled =
		ragSettingsData?.settings?.codeSearchEnabled ?? false;

	// Fetch recent Teams messages for chat editing
	// This provides the last 10 messages from linked Teams chats
	// staleTime: 30s — fresh enough for AI context; explicit refetch on AI-start handles updates
	const {
		data: teamsMessagesData,
		isLoading: isLoadingTeams,
		refetch: refetchTeamsMessages,
	} = useQuery({
		...orpc.integrations.teams.getRecentMessages.queryOptions({
			input: {
				projectId,
				limit: 10,
				organizationId: organizationId ?? null,
			},
		}),
		enabled: !!projectId,
		staleTime: 30_000,
	});

	// Fetch recent Slack messages for chat editing
	// Mirrors the Teams pattern above for Slack parity
	const {
		data: slackMessagesData,
		isLoading: isLoadingSlack,
		refetch: refetchSlackMessages,
	} = useQuery({
		...orpc.integrations.slack.getRecentMessages.queryOptions({
			input: {
				projectId,
				limit: 10,
				organizationId: organizationId ?? null,
			},
		}),
		enabled: !!projectId,
		staleTime: 30_000,
	});

	// Fetch meeting transcript context for chat editing
	// Provides recent meeting transcript summaries/content for AI context
	const { data: transcriptContextData, isLoading: isLoadingTranscripts } =
		useQuery({
			...orpc.projects.meetingTranscriptSync.getContext.queryOptions({
				input: {
					projectId,
					limit: 10,
					organizationId: organizationId ?? null,
				},
			}),
			enabled: !!projectId,
			staleTime: 300000, // Cache for 5 minutes (transcripts sync infrequently)
		});

	// Track if auto-generation has been triggered (prevents duplicates).
	// Held with the run's state, so a remount does not start it twice.
	const hasTriggeredAutoGeneration = runState.autoGenerationStartedRef;

	// The room carries a stamp of the saved body it holds, and saves from it
	// name that stamp as their base (Fizzy #2946).
	const roomStampsOn =
		roomConvergence &&
		enableCollaboration &&
		ydoc !== null &&
		typeof ydoc.getMap === "function";
	/** The saved document as a room stamp, when the server names its body. */
	const savedStamp: RoomStamp | null =
		typeof document?.version === "number" && document?.contentHash
			? { version: document.version, contentHash: document.contentHash }
			: null;
	const [meetingNotesFlow] = useState(() => new MeetingNotesFlow());

	// Safety check: validate collaboration prerequisites
	// We compute this early but handle it after hooks to maintain consistent hook order
	const isCollabPrerequisitesReady =
		!enableCollaboration ||
		(ydoc !== null &&
			typeof ydoc?.getXmlFragment === "function" &&
			provider !== null &&
			provider?.awareness !== null &&
			typeof provider?.awareness?.getStates === "function");

	const queryClient = useQueryClient();
	const { user } = useSession();
	// Simple state following the working CopilotKit pattern
	const [currentDocument, setCurrentDocument] = useState("");
	const [isSaving, setIsSaving] = useState(false);
	// A body taken on from the server — a restored version, a rewound
	// regeneration, a context update — whose identity is being fetched, so
	// the saves after it can name it as their base (Fizzy #2946).
	const [adoptingBase, setAdoptingBase] = useState(false);
	// A Reject sent and not yet settled — answered, refused, or its fallback
	// save answered (Fizzy #2946). The review has closed, but its outcome is
	// still to be applied: the editor takes no input meanwhile, so nothing
	// typed can be replaced by that outcome. Held with the run's state, so a
	// sync-loss remount keeps it.
	const { rejectPending, setRejectPending, typedSinceRejectRef } = runState;
	const rejectPendingRef = useRef(rejectPending);
	rejectPendingRef.current = rejectPending;
	// The regeneration review, held with the run's state (see
	// `GenerationRunState`) so a remount neither drops nor re-arms it.
	const {
		showConfirmDialog,
		setShowConfirmDialog,
		previousContent,
		setPreviousContent,
		newContent,
		setNewContent,
	} = runState;
	const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
	const [showImportedRegenWarning, setShowImportedRegenWarning] =
		useState(false);
	const [showVersionHistory, setShowVersionHistory] = useState(false);
	const [selectedPromptId, setSelectedPromptId] = useState<
		string | undefined
	>(undefined);
	const [selectedPromptVersionId, setSelectedPromptVersionId] = useState<
		string | undefined
	>(undefined);

	// Refs to access values without adding them as effect/action dependencies
	// (prevents CopilotKit setAction → context update → re-render loops)
	const selectedPromptIdRef = useRef(selectedPromptId);
	selectedPromptIdRef.current = selectedPromptId;
	const selectedPromptVersionIdRef = useRef(selectedPromptVersionId);
	selectedPromptVersionIdRef.current = selectedPromptVersionId;
	const currentDocumentRef = useRef(currentDocument);
	currentDocumentRef.current = currentDocument;

	// Lightbox state for read-only image viewing
	const [lightboxImage, setLightboxImage] = useState<{
		src: string;
		alt: string;
	} | null>(null);

	// Repository metadata from project settings (for GitHub CopilotKit actions)
	const repoOwner = (project as Record<string, unknown>)?.repositoryOwner as
		| string
		| undefined;
	const repoName = (project as Record<string, unknown>)?.repositoryName as
		| string
		| undefined;
	// Undefined when the project has not recorded its default branch; the
	// file tools then read the repository's own default branch.
	const repoBranch =
		((project as Record<string, unknown>)?.defaultBranch as
			| string
			| undefined) || undefined;
	const repoProvider = project?.repositoryUrl?.includes("gitlab.com")
		? "gitlab"
		: "github";
	const hasGitHub = !!repoOwner && !!repoName && repoProvider === "github";
	const hasGitLab = repoProvider === "gitlab" && !!repoOwner && !!repoName;
	const gitlabProjectId = hasGitLab
		? encodeURIComponent(`${repoOwner}/${repoName}`)
		: "";
	const lastSavedContentRef = useRef<string>("");
	// Plain-text snapshot of the editor at the last persisted baseline.
	// Used as a fast pre-check in recomputeDirtyState — comparing
	// `editor.state.doc.textContent` to this string is an O(N) walk over the
	// doc's text nodes, with no HTML serialization or Turndown roundtrip.
	// On long documents this is dramatically cheaper than the full markdown
	// comparison and short-circuits the common typing case.
	const lastSavedTextRef = useRef<string>("");
	// The server version of the body the editor last took on: the loaded
	// document, then each save, context update, restore, regeneration or
	// rejected regeneration it adopted. An accepted assistant proposal keeps
	// the editor's visual slots, so when a slot is involved its save is
	// guarded with this version (Fizzy #2589). The query cache is not
	// used: a refetch can bring a newer version the editor never took on.
	// Held with the run's state, so a remount keeps the version the editor
	// took on rather than whatever the cache holds by then.
	const editorBodyVersionRef = runState.editorBodyVersionRef;
	if (editorBodyVersionRef.current === undefined) {
		editorBodyVersionRef.current = document?.version;
	}
	// Its body identity, beside it: the base the single-user editor's saves
	// name (Fizzy #2946). Unknown — and a save names no base — until a
	// snapshot or a save's answer carries it for that version.
	const editorBodyHashRef = runState.editorBodyHashRef;
	if (
		editorBodyHashRef.current === undefined &&
		editorBodyVersionRef.current === document?.version &&
		document?.contentHash
	) {
		editorBodyHashRef.current = document.contentHash;
	}
	const autoSaveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
	// Set when this editor unmounts (a sync loss, leaving the page): the
	// answer of a save still in flight then neither reads the destroyed
	// editor nor schedules an autosave. A development remount (Strict Mode)
	// sets it back on its way in.
	const unmountedRef = useRef(false);
	// Debounce running getEditorMarkdownForSave (Turndown) on every keystroke.
	const dirtyCheckTimeoutRef = useRef<NodeJS.Timeout | null>(null);
	// Forward reference: the recomputeDirtyState helper is declared before
	// triggerAutoSave so it can be used inside onUpdate. We assign the latest
	// triggerAutoSave to this ref each render.
	const triggerAutoSaveRef = useRef<(() => void) | null>(null);
	const isManualSaveRef = useRef(false);
	const shouldRedirectAfterSaveRef = useRef(false);
	// A save refused with CONFLICT is sent again once when the room's stamp
	// moved meanwhile — another editor saved the room (Fizzy #2946).
	const conflictRetriesRef = useRef(0);
	// The page was left within the app while this editor was mounted (see
	// `PageLeave`). The answers of saves still in flight arrive after it is
	// gone: none sends a save again, and a refusal is said, since nobody is
	// in the editor to see the text left unsaved.
	const pageLeft = () => pageLeaveRef?.current.left === true;
	// A single-user editor that was closed (Fizzy #2946): no room holds what
	// it held, and its leaving offers nothing to copy, so text no save took
	// is gone. (A room's editor unmounted by a sync loss is not: the room
	// still holds its text.)
	const editorClosed = () => unmountedRef.current && !ydoc;
	/** The text the page was left with, when a save was sent for it. */
	const leaveContentRef = useRef<string | null>(null);
	const handleSaveRef = useRef<() => void>(() => {});
	// One save at a time (Fizzy #2946). Two saves of this editor in flight at
	// once name the same base, and the server refuses the second with
	// CONFLICT: the single-user editor then stopped saving until a reload,
	// and a room took the refusal for a room behind the saved document. A
	// save asked for while one is in flight goes once that one has been
	// answered, from the base its answer produced.
	const saveInFlightRef = useRef(false);
	/** What the save in flight was asked for as. */
	const inFlightIntentRef = useRef({ manual: false, redirect: false });
	/** The save asked for meanwhile, as what; `null` when none was. */
	const saveAgainRef = useRef<{ manual: boolean; redirect: boolean } | null>(
		null,
	);
	/**
	 * A save sent past `handleSave` — an accepted proposal, a rejected
	 * regeneration's revert — asked for while a save was in flight. It goes
	 * once that save has been answered, ahead of `saveAgainRef`, from the
	 * base the answer produced; `null` when none waits.
	 */
	const pendingDirectSaveRef = useRef<(() => void) | null>(null);
	/** What the save sent past `handleSave` says once it settles. */
	const directSaveOnSettledRef = useRef<(() => void) | null>(null);
	/** The same for the one waiting in `pendingDirectSaveRef`. */
	const pendingDirectOnSettledRef = useRef<(() => void) | null>(null);
	/**
	 * The accepted proposals whose save waits in `pendingDirectSaveRef`,
	 * with what each says of its answer (Fizzy #2946). A save of what the
	 * editor holds that displaces it carries each one whose text it still
	 * holds, and says it; one undone in the editor meanwhile says so, and
	 * its text is not saved.
	 */
	const pendingAcceptsRef = useRef<AcceptAwaitingSave[]>([]);
	/**
	 * The accepted proposals the save in flight carries (Fizzy #2946). The
	 * save of the editor's last text, sent behind it on leaving, makes one
	 * it undid say so, once: its own answer then says nothing.
	 */
	const inFlightAcceptsRef = useRef<AcceptAwaitingSave[]>([]);
	/** The text the save in flight carries: the saved body once it lands. */
	const sendingContentRef = useRef<string | null>(null);
	/**
	 * What the save sent past `handleSave` that is in flight says once it
	 * lands, if anything; set when it is sent, so never by the answer of a
	 * save it waited for, and dropped when it fails.
	 */
	const directSaveOnSavedRef = useRef<
		((saved: RoomStamp | null) => boolean | undefined) | null
	>(null);
	/**
	 * The same for its refusal (Fizzy #2946): set when it is sent, and
	 * carried to the one save sent again after a CONFLICT, whose answer
	 * is then the one said.
	 */
	const directSaveOnFailedRef = useRef<
		((failure: DirectSaveFailure) => void) | null
	>(null);
	const sendDirectSaveRef = useRef<
		(request: {
			build: (
				base: DocumentSaveBase | null | undefined,
			) => ReturnType<typeof buildDocumentSaveInput>;
			confirm: boolean;
			onUnavailable: () => void;
			/**
			 * Whether the save still applies over the base it would name,
			 * resolved when it goes. `false`: nothing is sent, and
			 * `onDeclined` says why.
			 */
			stillApplies?: (
				base: DocumentSaveBase | null | undefined,
			) => boolean;
			onDeclined?: () => void;
			/** Once it is answered, declined, unavailable or dropped. */
			onSettled?: () => void;
			/**
			 * With the stamp of the body it saved, when the answer names it.
			 * `false`: the room did not take that body, so it keeps its stamp.
			 */
			onSaved?: (saved: RoomStamp | null) => boolean | undefined;
			/**
			 * Once it is refused, or answered after the page was left, with
			 * where its text is now; never for the refusal of a save that is
			 * sent once more.
			 */
			onFailed?: (failure: DirectSaveFailure) => void;
			/**
			 * The text it saves, when read from the editor as it is asked
			 * for — an accepted proposal, the save on leaving the page: an
			 * accepted proposal it displaces is in it, unless undone.
			 */
			savesEditor?: string;
			/**
			 * An accepted proposal: the editor's body just before it was
			 * applied, and what it says when it is undone before its save
			 * goes.
			 */
			accept?: { from: string; onUndone: () => void };
		}) => void
	>(() => {});
	// The single-user editor learned from a CONFLICT that the document moved
	// past the body it holds: its saves stop until a reload (Fizzy #2946).
	const [soloBaseStale, setSoloBaseStale] = useState(false);
	// True only while we are programmatically replacing editor content via
	// editor.commands.setContent (initial Yjs sync, content repair, view-mode
	// toggle, regen accept/reject, version restore, streaming diff render).
	// TipTap's onUpdate fires for these too, but they should NOT mark the
	// document as having unsaved user edits — that flag belongs to real input.
	const isProgrammaticUpdateRef = useRef(false);
	// Edits typed in this editor — not received from the room, not applied
	// by the editor itself — counted, and the count the last successful save
	// covered: text typed after the last save is what a room brought back to
	// the saved document would take from this person, and what it offers
	// back to them (Fizzy #2946).
	const localEditCountRef = useRef(0);
	const savedEditCountRef = useRef(0);
	const savingEditCountRef = useRef(0);
	const noteTypedSinceSave = useCallback(() => {
		if (typedSinceSaveRef) {
			typedSinceSaveRef.current =
				localEditCountRef.current > savedEditCountRef.current;
		}
	}, [typedSinceSaveRef]);
	const editorRef = useRef<ReturnType<typeof useEditor>>(null);
	const { isLoading, visibleMessages } = useCopilotChat();
	// `useCopilotChat().visibleMessages` is empty on staging — proven via
	// [DIFF-AUDIT-TRACE] from the diag PR (#1148 + #1150): `len: 0` at
	// the moment a diff is sitting in the editor waiting for accept. The
	// stream that DOES carry the live messages (including the AGUI
	// tool-call entries) is `useCopilotChatInternal().messages` — the
	// same source the persistence walker reads. Wiring the diff-outcome
	// matcher to it lets the chip-stamping flow finally see the data.
	//
	// `internalMessagesForToolCallMatcher` is named verbosely so the
	// useCallback dep / linter rule doesn't pull in the OTHER
	// `useCopilotChatInternal().setMessages` already bound above for the
	// "+ New conversation" flow.
	const { messages: internalMessagesForToolCallMatcher } =
		useCopilotChatInternal();
	// `isLoading` flips true during CopilotKit AG-UI handshakes (info /
	// agent/connect) on mount and re-mount, even when no user-initiated
	// generation is happening. We keep `isLoading` for editor read-only
	// gating (which must be defensive), but the "Generating" pill needs a
	// signal that doesn't flash during background handshakes — it gates on
	// the explicit user-send signal from `useUserRunSignal`, marked by the
	// chat input's `onUserSend`. See the hook's doc-comment for the
	// transition-clear and reload-mid-run semantics.
	const { isUserGenerationActive, markUserRunInitiated, clearUserRunMark } =
		useUserRunSignal(isLoading);

	// Spec §3.8 FR-23 (Group G) — locate the most recent diff-producing
	// tool call in the live chat history so the DiffReviewBar can stamp
	// accept/reject outcomes on the correct entry inside the persisted
	// conversation messages JSON.
	//
	// Supported tool names (must match what the LangGraph agent actually
	// emits — confirmed on staging via API inspection of persisted blobs):
	//   - `write_document_local` — legacy GQL-format inline write
	//   - `confirm_changes`      — current AGUI-format diff confirmation
	//
	// Handles BOTH live message shapes CopilotKit 1.52 surfaces:
	//
	//   (a) GQL-format ActionExecutionMessage — has the `isActionExecutionMessage()`
	//       discriminator method, `name`, and `parentMessageId`. We map
	//       `messageId ← parentMessageId` (the assistant text turn that
	//       authored the call) and `toolCallId ← action.id`.
	//
	//   (b) AGUI-format assistant tool-call message — `{role:"assistant",
	//       toolCalls:[{id, type:"function", function:{name, arguments}}]}`
	//       with NO methods. We support both the top-level `tc.name`
	//       (older shape) and the nested `tc.function.name` (current
	//       OpenAI shape staging actually emits). The "parent" text
	//       message is the immediately-prior assistant text turn
	//       (CopilotKit splits a single turn into text + tool-calls);
	//       we walk backwards to find it, mirroring the persistence
	//       walker's behaviour in `CopilotPersistenceHook`.
	//
	// `messageId` MUST line up with the parent text message's id because
	// the server-side persistence merge (PR #1143) puts toolCalls on the
	// text message, so DiffOutcomeChip can find them.
	const DIFF_TOOL_NAMES: ReadonlyArray<string> = [
		"write_document_local",
		"confirm_changes",
	];
	const lastWriteDocumentLocalToolCall = useMemo(() => {
		// Walk the INTERNAL message store (visibleMessages is empty on
		// staging — see comment at the hook call site for evidence link).
		// Fall back to visibleMessages only as a last resort for any
		// legacy GQL surfaces that route through the public hook.
		const messagesToWalk =
			internalMessagesForToolCallMatcher &&
			internalMessagesForToolCallMatcher.length > 0
				? internalMessagesForToolCallMatcher
				: visibleMessages;
		if (!messagesToWalk || messagesToWalk.length === 0) {
			return null;
		}
		for (let i = messagesToWalk.length - 1; i >= 0; i--) {
			const m = messagesToWalk[i];
			if (!m) {
				continue;
			}
			const asMaybeAction = m as {
				isActionExecutionMessage?: () => boolean;
				id?: string;
				name?: string;
				parentMessageId?: string | null;
				role?: string;
				toolCalls?: unknown;
			};
			// Path (a): GQL-format ActionExecutionMessage.
			if (
				typeof asMaybeAction.isActionExecutionMessage === "function" &&
				asMaybeAction.isActionExecutionMessage()
			) {
				if (
					typeof asMaybeAction.id === "string" &&
					typeof asMaybeAction.name === "string" &&
					DIFF_TOOL_NAMES.includes(asMaybeAction.name)
				) {
					return {
						messageId:
							asMaybeAction.parentMessageId ?? asMaybeAction.id,
						toolCallId: asMaybeAction.id,
					};
				}
				continue;
			}
			// Path (b): AGUI-format tool-call-only assistant message.
			if (
				asMaybeAction.role === "assistant" &&
				Array.isArray(asMaybeAction.toolCalls) &&
				asMaybeAction.toolCalls.length > 0
			) {
				for (const rawTc of asMaybeAction.toolCalls as unknown[]) {
					if (!rawTc || typeof rawTc !== "object") {
						continue;
					}
					const tc = rawTc as {
						id?: unknown;
						name?: unknown;
						function?: { name?: unknown };
					};
					const tcId = typeof tc.id === "string" ? tc.id : null;
					const tcName =
						typeof tc.name === "string"
							? tc.name
							: typeof tc.function?.name === "string"
								? tc.function.name
								: null;
					if (!tcId || !tcName) {
						continue;
					}
					if (!DIFF_TOOL_NAMES.includes(tcName)) {
						continue;
					}
					// Find the parent text message (immediately-prior
					// assistant text turn). Walk backwards from i-1,
					// stopping at the first user message (turn boundary).
					let parentTextId: string | null = null;
					for (let p = i - 1; p >= 0; p--) {
						const prev = messagesToWalk[p] as {
							id?: string;
							role?: string;
							content?: unknown;
						};
						if (!prev?.id) {
							continue;
						}
						if (prev.role === "user") {
							break;
						}
						if (
							prev.role === "assistant" &&
							typeof prev.content === "string" &&
							prev.content.length > 0
						) {
							parentTextId = prev.id;
							break;
						}
					}
					return {
						messageId: parentTextId ?? asMaybeAction.id ?? tcId,
						toolCallId: tcId,
					};
				}
			}
		}
		return null;
	}, [internalMessagesForToolCallMatcher, visibleMessages]);
	// Where the outcome of the proposal under review is stamped: by the
	// review bar's buttons, and by the chat card's, which read it when
	// clicked (Fizzy #2946).
	const diffOutcomeAudit: DiffOutcomeAudit = {
		conversationId: activeAssistantConversationId,
		projectId,
		organizationId,
		messageId: lastWriteDocumentLocalToolCall?.messageId ?? null,
		toolCallId: lastWriteDocumentLocalToolCall?.toolCallId ?? null,
	};
	const diffOutcomeAuditRef = useRef(diffOutcomeAudit);
	diffOutcomeAuditRef.current = diffOutcomeAudit;

	// Chat-session attachment contexts. Kept separate from `localRagContexts`
	// (which holds project-level vector-searched docs + Teams/Slack and is
	// intentionally NOT published via `useCopilotReadable` — see comment at
	// the readable site below) so we can publish *just* the freshly-uploaded
	// files via the rag-context channel the agent actually reads. Without
	// this separate channel, paperclip uploads on this surface vanish into
	// `localRagContexts` and never reach the agent — which is why the user
	// saw "I cannot access the attached screenshot" replies even though the
	// chip showed in the bubble.
	const [chatAttachmentContexts, setChatAttachmentContexts] = useState<
		string[]
	>([]);

	// Callback to add uploaded document content to RAG contexts for follow-up
	// questions. `flushSync` forces the state commit synchronously so the
	// `useCopilotReadable` value is updated before the in-flight Send picks
	// up CopilotKit's context snapshot — without it the first turn after
	// upload races the React batch and ships an empty context.
	//
	// The entry arrives finished from `useCopilotDocumentUpload` — including
	// the image envelope, which differs from text/PDF: the upload pipeline
	// produces a `data:image/...;base64,…` URL for image files and
	// `buildAttachmentContextEntry` surfaces it as a markdown image link so
	// the agent's chat-node can peel the data URL out (`splitRagContextImages`)
	// and re-attach it as an `image_url` content part on the user message —
	// that's the only way vision-capable models actually consume the picture.
	// Without that branch images were sent as base64 text under a "Document"
	// label and the model answered "I can't view the attached image".
	const handleContentExtracted = useCallback((contextEntry: string) => {
		flushSync(() => {
			setChatAttachmentContexts((prev) => [...prev, contextEntry]);
		});
	}, []);

	// FIFO queue of per-message attachment batches, keyed positionally.
	// `CopilotSidebarInput` pushes the latest batch the moment a Send
	// resolves the upload pipeline; `CopilotPersistenceHook` shifts the
	// oldest batch when a user-role message reaches terminal state and
	// attaches the metadata to the `appendTurnForDocument` payload. See
	// `CopilotPersistenceHook.tsx` for the failure-mode analysis.
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

	// Stable hook handed to the input factory below. It flushes the live editor
	// content into the agent's `document` state field right before every chat
	// send — the real closure is assigned to `syncDocumentBeforeSendRef.current`
	// once `editor`/`setAgentStateRef` are declared (further down). `useCoAgent`
	// is bidirectional, so an agent reply that omits `document` syncs an empty
	// value back onto the frontend state (see unified-server.ts:888-891);
	// re-asserting it before each send keeps the agent able to see the open
	// document's sections. Defined here so the factory memo can reference a
	// stable identity without re-registering.
	const syncDocumentBeforeSendRef = useRef<() => void>(() => {});
	const handleBeforeSend = useCallback(() => {
		syncDocumentBeforeSendRef.current();
	}, []);

	// Custom CopilotSidebar Input with document upload support
	const CustomSidebarInput = useMemo(
		() =>
			createCopilotSidebarInput({
				organizationId: organizationId ?? null,
				onContentExtracted: handleContentExtracted,
				surface: "document",
				compressionMaxDimension: 1024,
				compressionQuality: 0.8,
				onAttachmentsForNextMessage: handleAttachmentsForNextMessage,
				onBeforeSend: handleBeforeSend,
				onUserSend: markUserRunInitiated,
				onUserSendFailed: clearUserRunMark,
			}),
		[
			organizationId,
			handleContentExtracted,
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

	// Group E — handles the plus-icon "New conversation" affordance in
	// the sidebar header (FR-10). Order matters:
	//   1. Archive the live thread server-side (if one exists).
	//   2. Null out the local conversationId AND reset visibility back to
	//      the SHARED + unlocked defaults so the next user input
	//      lazy-creates a brand-new row.
	//   3. Clear CopilotKit's in-memory transcript so the user sees a
	//      fresh greeting (same path the empty-thread first-load takes).
	//   4. Toast a polite confirmation so the user knows their click took
	//      effect — important because the visual change is subtle when
	//      the previous thread had only one or two turns.
	//
	// Failure handling: if the archive call fails (network blip,
	// FORBIDDEN, feature-flag), we still reset local state. The server
	// row stays ACTIVE and the next persisted turn appends to it — the
	// worst case is "the old thread reappears on next reload", which is
	// safer than silently leaving the user staring at the previous
	// transcript. The toast tells them what happened.
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
			toast.success("Started a new conversation");
		} catch (err) {
			// Local state still resets so the UI isn't stuck — the message
			// just acknowledges the partial-success path.
			setActiveAssistantConversationId(null);
			setActiveAssistantVisibility("SHARED");
			setActiveAssistantVisibilityLockedAt(null);
			setCopilotMessages([]);
			const message =
				err instanceof Error
					? err.message
					: "Could not archive the previous conversation.";
			toast.error(message);
		}
	}, [activeAssistantConversationId, organizationId, setCopilotMessages]);

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
			title: "AI Assistant",
			documentRefKind,
			documentRefId: documentId,
			projectId,
			organizationId: organizationId ?? null,
			conversationId: activeAssistantConversationId,
			visibility: activeAssistantVisibility,
			visibilityLockedAt: activeAssistantVisibilityLockedAt,
			onNewConversation: handleNewConversation,
			onOpenHistory: handleOpenHistory,
			// Lifts the chip's pre-first-send toggle into the parent
			// state so `requestedVisibility` on the persistence hook
			// matches what the user picked. Without this, toggling to
			// PRIVATE before send would silently lazy-create the
			// conversation as SHARED (the SSR-initial value).
			onVisibilityChange: setActiveAssistantVisibility,
		});
	}, [
		documentAssistantHistoryEnabled,
		documentRefKind,
		documentId,
		projectId,
		organizationId,
		activeAssistantConversationId,
		activeAssistantVisibility,
		activeAssistantVisibilityLockedAt,
		handleNewConversation,
		handleOpenHistory,
	]);

	// Branded reopen launcher for the AI Assistant. Gated on the same
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

	// isConfirming is used for the regeneration confirmation dialog (different from streaming).
	// Held with the run's state (see `GenerationRunState`).
	const { isConfirming, setIsConfirming } = runState;

	// Why a save of the editor's body is refused right now, if it is
	// (Fizzy #2946). The autosave always stood down during a regeneration
	// and its review; the Save button and the save before an assistant run
	// did not, and wrote the body the editor held over the run's result.
	// While a run is live the editor holds what the run started from — or
	// its streamed body — and the run's final save writes the document
	// itself; while the review is open the person has not chosen yet. An
	// editor not bound to a synced room holds something other than the
	// room, so it does not save either.
	// A run counts as live while the editor still polls it: a wait for
	// the project's context, or a run that wrote within the last ten
	// minutes. A run that went silent for longer no longer holds the
	// document; a save then ends it, and the person is told so. The server
	// judges the editor's save by the same rule, so it refuses exactly the
	// saves held back here.
	// A room behind the saved document adds its own reason below, once the
	// editor exists (see `useRoomConvergence`).
	const isRunStillWriting = isGenerationRunStillWriting({
		status: document?.status ?? "",
		generationStartedAt: document?.generationStartedAt,
		updatedAt: document?.updatedAt,
	});
	// hasPendingConfirm: generation is done, Confirm Changes dialog is showing
	const [hasPendingConfirm, setHasPendingConfirm] = useState(false);
	// An assistant proposal under review holds saves back as a regeneration's
	// review does (Fizzy #2946): the editor holds the proposal, which a save
	// would write before anyone accepted it, and a Reject would not undo.
	const runSaveBlockReason: SaveBlockReason | null = isRegenerating
		? "regenerating"
		: showConfirmDialog || isConfirming || rejectPending
			? "review"
			: hasPendingConfirm
				? "proposal"
				: isRunStillWriting
					? "runLive"
					: enableCollaboration && (!provider || !isCollabSynced)
						? "reconnecting"
						: null;
	const saveBlockedId = useId();
	// Callbacks for the DiffReviewBar to trigger accept/reject. Each says
	// what the proposal was answered with.
	const confirmCallbacksRef = useRef<{
		accept: () => boolean;
		reject: () => boolean;
	} | null>(null);
	// Whether the current executing confirm has already been processed (armed a
	// card OR resolved as a no-op). Gates the one-time arm side effects so they
	// don't re-run on every render while the tool call is executing, and signals
	// Effect 4 to hold its write-back during the confirm window.
	const confirmArmedRef = useRef(false);
	// Whether the current confirm resolved as a no-op (normalized-identical
	// payload). While set, the confirm action renders nothing actionable.
	const confirmNoOpRef = useRef(false);
	// Marks a save as confirm-initiated so its outcome (version bump / no-op /
	// error) is surfaced to the user instead of being silent.
	const isConfirmSaveRef = useRef(false);
	// Guard to suppress auto-save during per-change diff review edits
	const isDiffReviewEditRef = useRef(false);
	// Guard to suppress auto-save while the Update-using-context diff is on screen
	const isContextUpdateActiveRef = useRef(false);

	// Ref to preserve the baseline content when regeneration starts
	// This prevents the CopilotKit streaming effect from corrupting the baseline
	// needed for the side-by-side comparison dialog.
	// This and the run refs below are held with the run's state (see
	// `GenerationRunState`), so a sync-loss remount keeps them.
	const regenerationBaselineRef = runState.baselineRef;

	// Tracks the safety-timer handle so we can cancel it once regeneration
	// actually completes. Without this, the timer's closure holds a stale
	// `isRegenerating` value and fires a misleading "timeout" toast even
	// after the document has already been delivered successfully.
	const regenerationTimeoutRef = runState.safetyTimerRef;

	// Ref to store the respond function from regenerate_document action
	// This is called when user accepts/rejects in RegenerationConfirmDialog
	const regenerationRespondRef = runState.respondRef;

	// Ref for image upload handler — allows editorProps (created before handler) to access it
	const imageUploadRef = useRef<((files: FileList) => Promise<void>) | null>(
		null,
	);

	// Keeps uploaded images on a live signed URL; the upload handler hands it
	// the URL it just signed.
	const mediaUrlRefresherRef = useRef<SignedMediaUrlRefresher | null>(null);

	// Track if regeneration was triggered to prevent duplicate triggers
	const regenerationTriggeredRef = runState.triggeredRef;

	// Timestamp (Date.now()) captured the instant the generate mutation
	// resolves. The server (generate-document procedure) writes GENERATING +
	// clears generationError BEFORE it starts the Temporal workflow, so any
	// polled document snapshot fetched AFTER this instant that still shows
	// FAILED reflects a genuine failure during THIS run — not stale data left
	// over from the run we're retrying. Null whenever no mutation-backed
	// regeneration is in flight, which keeps the FAILED watcher below unarmed
	// for paths that don't go through the mutation.
	const regenerationAckAtRef = runState.ackAtRef;

	// Track if this is a direct regeneration (button click) vs agent-based regeneration
	// Direct regeneration should NOT sync agent state back to editor (prevents AI response overwriting)
	const isDirectRegenerationRef = runState.isDirectRef;

	// True while the regeneration in flight is a run this editor did not
	// start and only follows (see the attach effect below). Such a run is
	// adopted when it ends, never reviewed.
	const attachedRunRef = runState.attachedRunRef;

	// LOCAL STATE for RAG contexts and project context
	// These are stored locally and sent via useCopilotReadable (one-way to agent)
	// This prevents them from being overwritten when useCoAgent syncs back from agent response
	const [localRagContexts, setLocalRagContexts] = useState<string[]>([]);
	const [localProjectContext, setLocalProjectContext] =
		useState<ProjectContext | null>(null);

	// Announcement text for the scroll-to-mention live region (screen reader)
	const [scrollAnnouncement, setScrollAnnouncement] = useState("");
	// Store document contexts separately so Teams messages can be updated independently
	const documentContextsRef = useRef<string[]>([]);

	// === STREAMING BASELINE REFS (fixes race condition with async state) ===
	// The baseline must be captured synchronously when loading starts.
	// Using state alone causes race conditions because setCurrentDocument is async
	// but Effect 3 needs the baseline immediately when agentState changes.
	const baselineRef = useRef<string>("");
	const wasLoadingRef = useRef(false);

	// View mode state for raw/rich toggle
	const [viewMode, setViewMode] = useState<"rich" | "raw">("rich");
	const [rawContent, setRawContent] = useState(
		repairMarkdownDocument(document?.content || ""),
	);
	// Whether the raw view was edited since it was opened, and what it
	// holds, read by callbacks that outlive a render (Fizzy #2946).
	const rawEditedRef = useRef(false);
	const viewModeRef = useRef(viewMode);
	viewModeRef.current = viewMode;
	const rawContentRef = useRef(rawContent);
	rawContentRef.current = rawContent;
	// The raw view's textarea, and the selection it keeps across a body it
	// follows (see the raw view's follow below).
	const rawTextareaRef = useRef<HTMLTextAreaElement>(null);
	const rawSelectionRef = useRef<{ start: number; end: number } | null>(null);
	// Edits in the raw view that nothing has saved or carried back to the
	// rich editor yet: they live only in the raw text.
	const rawEditPending = useCallback(
		() => viewModeRef.current === "raw" && rawEditedRef.current,
		[],
	);
	// Edits in the raw view whose base the editor has moved past — an
	// accepted proposal, a run's body, the room's — while they waited
	// (Fizzy #2946). Nothing saves them but an explicit Save: an autosave
	// would write the older body they were made on over the newer one.
	const rawEditsStaleRef = useRef(false);
	// Those edits as they stand now, typing after they went stale included:
	// what their offer copies, when clicked, also after the page was left.
	const staleRawTextRef = useRef("");
	// Counts every change to the editor's body, so a save's answer can tell
	// whether the editor still holds what it held when the save was sent.
	const editorBodyRevisionRef = useRef(0);
	// The raw text last offered back, and whether by the toast that keeps it
	// in the raw view (see `noteRawEditsStale`).
	const rawOfferRef = useRef<{ text: string; kept: boolean } | null>(null);
	// Whether the raw view is held now (see `rawViewHeld`), for the view
	// switch, whose keyboard shortcut outlives a render.
	const rawViewHeldRef = useRef(false);

	// Create collaborative extensions when provider and ydoc are available
	// Additional guards ensure provider.awareness is ready before creating extensions
	const collaborativeExtensions = useMemo(() => {
		if (!enableCollaboration || !provider || !ydoc) {
			return null;
		}
		// Verify provider.awareness is ready
		if (
			!provider.awareness ||
			typeof provider.awareness.getStates !== "function"
		) {
			console.warn(
				"[DocumentEditor] Provider awareness not ready, skipping collaborative extensions",
			);
			return null;
		}
		// Verify ydoc has required methods
		if (typeof ydoc.getXmlFragment !== "function") {
			console.error(
				"[DocumentEditor] ydoc is not valid, skipping collaborative extensions",
			);
			return null;
		}
		return createCollaborativeExtensions({
			ydoc,
			provider,
			user: {
				name: user?.name || "Anonymous",
				color: userColor,
			},
			projectId,
			documentId,
			// Not in a shared session yet (Fizzy #2946): a collaborator's tab on
			// the previous release has no stat-tiles node and would delete the
			// block from the shared document for everyone. The shared editor
			// keeps the fence as a code block until every client knows the node.
		});
	}, [
		enableCollaboration,
		ydoc,
		provider,
		user?.name,
		userColor,
		projectId,
		documentId,
	]);

	// Non-collaborative extensions, rebuilt when the active document changes
	// so the @-mention suggestion popover queries the correct document scope.
	const nonCollaborativeExtensions = useMemo(
		() => buildNonCollaborativeExtensions(projectId, documentId, statTiles),
		[projectId, documentId, statTiles],
	);

	// Determine which extensions to use
	// If collaboration is enabled AND provider is ready, use collaborative extensions
	// Otherwise, use standard extensions
	const editorExtensions = useMemo(() => {
		if (enableCollaboration && collaborativeExtensions) {
			return collaborativeExtensions;
		}
		return nonCollaborativeExtensions;
	}, [
		enableCollaboration,
		collaborativeExtensions,
		nonCollaborativeExtensions,
	]);

	// Initialize TipTap editor
	// Parent component ensures provider is ready before this component mounts (when collaboration is enabled)
	const editor = useEditor(
		{
			extensions: editorExtensions,
			immediatelyRender: false,
			editorProps: {
				attributes: { class: "p-10 tiptap" },
				// Intercept paste to route image files through S3 upload (not base64)
				handlePaste: (_view, event) => {
					const files = event.clipboardData?.files;
					if (!files?.length) {
						return false;
					}
					const imageFiles = Array.from(files).filter(
						(f) =>
							f.type.startsWith("image/") &&
							f.size <= 5 * 1024 * 1024,
					);
					if (!imageFiles.length) {
						return false;
					}
					// Create a FileList-like object and route through S3 pipeline
					const dt = new DataTransfer();
					for (const f of imageFiles) {
						dt.items.add(f);
					}
					imageUploadRef.current?.(dt.files);
					return true; // Prevent TipTap's default base64 paste
				},
				// Intercept drop to route image files through S3 upload
				handleDrop: (_view, event) => {
					const files = event.dataTransfer?.files;
					if (!files?.length) {
						return false;
					}
					const imageFiles = Array.from(files).filter(
						(f) =>
							f.type.startsWith("image/") &&
							f.size <= 5 * 1024 * 1024,
					);
					if (!imageFiles.length) {
						return false;
					}
					event.preventDefault();
					const dt = new DataTransfer();
					for (const f of imageFiles) {
						dt.items.add(f);
					}
					imageUploadRef.current?.(dt.files);
					return true; // Prevent TipTap's default handling
				},
			},
			// Only set initial content in non-collaborative mode
			// In collaborative mode, content is loaded from Yjs
			content: enableCollaboration
				? undefined
				: document?.content
					? (() => {
							try {
								return fromMarkdown(document.content);
							} catch (e) {
								console.error(
									"[DocumentEditor] fromMarkdown failed on initial content:",
									e,
								);
								return "";
							}
						})()
					: "",
			onUpdate: ({ editor: ed, transaction }) => {
				// Only react to user input — skip during AI updates, diff review,
				// programmatic content replacement, or while the confirmation dialog
				// is showing diff marks.
				if (
					!ed.isEditable ||
					isLoading ||
					isRegenerating ||
					isDiffReviewEditRef.current ||
					isProgrammaticUpdateRef.current ||
					hasPendingConfirm ||
					isContextUpdateActiveRef.current
				) {
					return;
				}
				// Typed here, not received from a collaborator through the room
				// (the binding marks those transactions as its own). An undo or
				// redo in the room is applied the same way, but it is this
				// person's: the room's undo manager reverts only this client's
				// own changes (Fizzy #2946). Uncounted, an undo made after the
				// save covering the edit had landed was never saved. An update
				// that changed nothing, as `setEditable` emits, is no edit.
				if (
					transaction?.docChanged &&
					(!isChangeOrigin(transaction) ||
						transaction.getMeta(ySyncPluginKey)
							?.isUndoRedoOperation === true)
				) {
					localEditCountRef.current += 1;
					noteTypedSinceSave();
					typedSinceRejectRef.current = true;
				}
				// Derive hasUnsavedChanges from a content equality check rather
				// than flipping it true on every keystroke. This makes the
				// "Saved" state self-correcting: typing then deleting back to
				// the original content snaps the button back to disabled, and
				// any spurious onUpdate that slips past the guards (e.g. an
				// async Y.js sync transaction) cannot leave the flag stuck on
				// dirty when the document actually matches what's persisted.
				scheduleDirtyCheck();
			},
		},
		[editorExtensions],
	);

	// Keep editor ref in sync so stale closures (e.g. useCopilotAction with [] deps) can access it
	editorRef.current = editor;
	// The same, for writes that outlive this mount (see
	// `GenerationRunState.liveEditorRef`).
	const liveEditorRef = runState.liveEditorRef;
	liveEditorRef.current = editor;
	useEffect(() => {
		return () => {
			if (liveEditorRef.current === editor) {
				liveEditorRef.current = null;
			}
		};
	}, [editor, liveEditorRef]);

	// Register this editor with the Excalidraw auto-insert resolver
	// registry so the chat button can target it when it produces an
	// `<excalidraw-embed>` insert request. See spec §9 (active-editor
	// resolution algorithm). `useRegisterTiptapEditor` is no-op while
	// `editor` is null (still booting).
	useRegisterTiptapEditor({
		projectId,
		kind: "document",
		documentId,
		editor,
	});

	// Consume any pending picker intent the chat may have stashed in
	// sessionStorage before navigating to this document. Defers to the
	// next animation frame so the registration above is committed first.
	// `kind: "document"` is HARDCODED here -- making it configurable
	// would let an intent leak across page navigations.
	usePickerIntentConsumer({
		editor,
		projectId,
		kind: "document",
		documentId,
		documentLabel: document?.title ?? undefined,
	});

	// Wrapper for editor.commands.setContent that flips a ref so the editor's
	// onUpdate callback can distinguish programmatic content replacement from
	// real user input. Without this, every Yjs init / content repair / view
	// toggle / regen / version restore would mark the document as dirty and
	// the Save button would be permanently stuck on "Save" instead of "Saved".
	//
	// The source argument is required (see `ApplyProgrammaticContent`): an
	// assistant application splices visual slots into the model's body before
	// it is rendered — the editor's current ones, or those of `slotSource`
	// when the editor is mid-run and holds a partial frame.
	const applyProgrammaticContent: ApplyProgrammaticContent = useCallback(
		(
			ed: DocumentTiptapEditor | null | undefined,
			content: EditorContentArg,
			source: ProgrammaticContentSource,
			{
				render = fromMarkdown,
				slotSource,
			}: AssistantApplicationOptions = {},
		): string | null => {
			if (!ed) {
				return null;
			}
			let applied = content;
			let appliedMarkdown: string | null = null;
			if (source === "assistant" && typeof content === "string") {
				const withSlots =
					slotSource === undefined
						? preserveEditorVisualSlots(ed, content)
						: preserveVisualSlots(slotSource, content);
				// A generated diagram the assistant left unchanged keeps its
				// marker (Fizzy #2946). The editor is serialised only when it
				// holds one.
				const markerSource =
					slotSource ??
					(ed.state.doc.textContent.includes("fabric-visual:")
						? getEditorMarkdownForSave(ed)
						: null);
				appliedMarkdown = preserveVisualMarkers(
					markerSource,
					withSlots,
				);
				applied = render(appliedMarkdown);
			}
			isProgrammaticUpdateRef.current = true;
			ed.commands.setContent(applied);
			queueMicrotask(() => {
				isProgrammaticUpdateRef.current = false;
			});
			return appliedMarkdown;
		},
		[],
	);

	// A saved body put into a collaborative room goes in together with the
	// room stamp naming it (Fizzy #2946), in one transaction, so no
	// collaborator ever holds the body without its stamp. Without the room
	// flag, or without a stamp, the body alone.
	const applyServerBody = useCallback(
		(
			ed: DocumentTiptapEditor | null | undefined,
			content: EditorContentArg,
			stamp: RoomStamp | null | undefined,
		) => {
			if (!ed) {
				return;
			}
			if (roomStampsOn && ydoc && stamp) {
				ydoc.transact(() => {
					applyProgrammaticContent(ed, content, "server");
					writeRoomStamp(ydoc, stamp, { always: true });
				});
				return;
			}
			applyProgrammaticContent(ed, content, "server");
		},
		[roomStampsOn, ydoc, applyProgrammaticContent],
	);

	// Whether the room already holds this saved body, or a later one: its
	// stamp names it, or a higher version (Fizzy #2946). A run's result
	// applied again over such a room would only wipe what was typed on it.
	const roomHoldsSavedBody = useCallback(
		(stamp: RoomStamp | null | undefined): boolean => {
			if (!roomStampsOn || !ydoc || !stamp) {
				return false;
			}
			const held = readRoomStamp(ydoc);
			return (
				!!held &&
				(sameRoomStamp(held, stamp) || held.version > stamp.version)
			);
		},
		[roomStampsOn, ydoc],
	);

	// A body the review defers to the next frame goes into the editor on
	// screen when that frame lands, never into the one that scheduled it
	// (Fizzy #2946): a hidden tab holds frames back, and by the time one
	// fires a sync-loss remount may have destroyed that editor. Returns the
	// editor written to, or `null` when none is on screen.
	const applyToLiveEditor = useCallback(
		(
			content: EditorContentArg,
			stamp?: RoomStamp | null,
		): DocumentTiptapEditor | null => {
			const ed = liveEditorRef.current;
			if (!ed || ed.isDestroyed) {
				return null;
			}
			applyServerBody(ed, content, stamp);
			return ed;
		},
		[applyServerBody, liveEditorRef],
	);

	// Single point that updates the persisted-content baseline. Capturing the
	// editor's textContent alongside the markdown lets recomputeDirtyState do
	// a cheap text-only pre-check before falling back to Turndown for the
	// rare formatting-only diff. Critical for long documents where Turndown
	// is the dominant cost.
	//
	// IMPORTANT: prefer the editor's *roundtripped* markdown over the raw
	// input. recomputeDirtyState compares against `getEditorMarkdownForSave`
	// output; if we baseline the raw markdown and the editor parses + Turndown
	// roundtrips it into a slightly different form (whitespace, list marker
	// normalisation, etc.), the very first onUpdate after mount sees
	// "currentMarkdown !== baseline" and marks the doc dirty even though the
	// user hasn't touched anything.
	//
	// The editor is read only when it still holds `markdown`. A save answered
	// after more typing here passes the editor's text as it was when that save
	// was sent: the live editor holds typing the save did not carry, which
	// must stay unsaved — dirty, autosaved, and sent on leaving the page.
	const updateSavedBaseline = useCallback(
		(markdown: string, sentText?: string) => {
			if (sentText !== undefined) {
				lastSavedContentRef.current = markdown;
				lastSavedTextRef.current = sentText;
				return;
			}
			// A save answered after this editor was destroyed — the page
			// left, a sync loss — has no editor to read: serializing one
			// throws.
			const ed = liveEditorOrNull(editorRef.current);
			const normalised =
				ed && markdown.trim().length > 0
					? getEditorMarkdownForSave(ed) || markdown
					: markdown;
			lastSavedContentRef.current = normalised;
			lastSavedTextRef.current = ed?.state.doc.textContent ?? "";
		},
		[],
	);

	// A room behind the saved document, brought back to it (Fizzy #2946).
	// The counts restart with each mount, and a sync loss remounts this
	// editor over the same room: the flag lifted into the parent keeps
	// typing from before the loss that no save has covered yet.
	const hasLocalTyping = useCallback(
		() =>
			localEditCountRef.current > savedEditCountRef.current ||
			typedSinceSaveRef?.current === true,
		[typedSinceSaveRef],
	);
	// Whether this editor sits in a collaborative room with nothing typed
	// in it since its last save (Fizzy #2946). Such an editor is never
	// dirty and never saves: whatever the room holds came from another
	// editor, whose own saves carry its typing, or from the server. The
	// typist's editor saves its typing, and on leaving the page sends what
	// no save covered yet. Edits in the raw view count as typing too. The
	// single-user editor keeps the content comparison alone.
	const passiveInRoom = useCallback(
		() => roomStampsOn && !hasLocalTyping(),
		[roomStampsOn, hasLocalTyping],
	);

	// Source of truth for the Save button: compare what the editor currently
	// holds against what we last persisted to the server. This makes the
	// "Saved" state self-correcting — typing then deleting back to the original
	// snaps the button back to "Saved", and any onUpdate that slips past the
	// programmatic guard (e.g. an out-of-band Y.js sync transaction) cannot
	// leave the flag stuck on dirty when the content actually matches.
	//
	// Performance contract for long documents:
	//   1. Fast path — compare editor.state.doc.textContent against the cached
	//      baseline text. This is an O(N) walk over text nodes with no HTML
	//      serialization or Turndown work. The vast majority of dirty
	//      keystrokes change the text content, so this short-circuits without
	//      ever invoking Turndown.
	//   2. Slow path — text matches the baseline, so the only way the doc
	//      can still be dirty is a formatting-only edit (bold toggle, etc.).
	//      Only then do we run getEditorMarkdownForSave (Turndown) for an
	//      authoritative comparison.
	const recomputeDirtyState = useCallback(() => {
		// Nothing to compare, and no autosave to schedule, once this editor
		// is gone: a save answered after the page was left lands here.
		if (unmountedRef.current) {
			return;
		}
		const ed = liveEditorOrNull(editorRef.current);

		const scheduleAutoSave = (isDirty: boolean) => {
			if (autoSaveTimeoutRef.current) {
				clearTimeout(autoSaveTimeoutRef.current);
				autoSaveTimeoutRef.current = null;
			}
			if (isDirty) {
				autoSaveTimeoutRef.current = setTimeout(() => {
					triggerAutoSaveRef.current?.();
				}, DOCUMENT_AUTOSAVE_TIMINGS.delayMs);
			}
		};

		if (passiveInRoom()) {
			scheduleAutoSave(false);
			setHasUnsavedChanges(false);
			return;
		}

		if (viewMode === "raw") {
			const isDirty =
				rawContent.trim() !== lastSavedContentRef.current.trim();
			setHasUnsavedChanges(isDirty);
			scheduleAutoSave(isDirty);
			return;
		}

		if (!ed) {
			return;
		}

		// Fast path: text-only equality. Cheap on long docs.
		const currentText = ed.state.doc.textContent;
		if (currentText !== lastSavedTextRef.current) {
			setHasUnsavedChanges(true);
			scheduleAutoSave(true);
			return;
		}

		// Slow path: text matches; check for formatting-only differences.
		const currentMarkdown = getEditorMarkdownForSave(ed) || "";
		const isDirty =
			currentMarkdown.trim() !== lastSavedContentRef.current.trim();
		setHasUnsavedChanges(isDirty);
		scheduleAutoSave(isDirty);
	}, [viewMode, rawContent, passiveInRoom]);

	// Debounced wrapper — keeps the per-keystroke cost negligible since
	// getEditorMarkdownForSave runs Turndown across the whole document.
	// The check that runs is the latest one, never the one of the render
	// that scheduled it: the editor's update handler keeps an early
	// closure, whose check would compare the rich editor while the raw view
	// holds the edits, and clear them as saved (Fizzy #2946).
	const recomputeDirtyStateRef = useRef(recomputeDirtyState);
	recomputeDirtyStateRef.current = recomputeDirtyState;
	const scheduleDirtyCheck = useCallback(() => {
		if (dirtyCheckTimeoutRef.current) {
			clearTimeout(dirtyCheckTimeoutRef.current);
		}
		dirtyCheckTimeoutRef.current = setTimeout(() => {
			dirtyCheckTimeoutRef.current = null;
			recomputeDirtyStateRef.current();
		}, 150);
	}, []);

	const refetchSavedDocument = useCallback(() => {
		void queryClient.invalidateQueries({
			queryKey: orpc.projects.documents.get.queryKey({
				input: { id: documentId, projectId, organizationId },
			}),
		});
	}, [queryClient, documentId, projectId, organizationId]);
	const applySavedBodyToRoom = useCallback(
		(markdown: string, stamp: RoomStamp) => {
			applyServerBody(
				editorRef.current,
				markdown ? fromMarkdown(markdown) : "",
				stamp,
			);
		},
		[applyServerBody],
	);
	// The editor holds this saved body now: nothing in it is unsaved, and its
	// saves name this body as their base.
	const adoptSavedBody = useCallback(
		(markdown: string, stamp: RoomStamp) => {
			if (autoSaveTimeoutRef.current) {
				clearTimeout(autoSaveTimeoutRef.current);
				autoSaveTimeoutRef.current = null;
			}
			editorBodyVersionRef.current = stamp.version;
			editorBodyHashRef.current = stamp.contentHash;
			// Edits in the raw view stay there, unsaved, until they are saved
			// or discarded: this body is only their new base (Fizzy #2946).
			// What they replace in the room was offered back.
			if (rawEditPending()) {
				updateSavedBaseline(markdown);
				setHasUnsavedChanges(true);
				return;
			}
			savedEditCountRef.current = localEditCountRef.current;
			noteTypedSinceSave();
			baselineRef.current = markdown;
			setCurrentDocument(markdown);
			setRawContent(markdown);
			updateSavedBaseline(markdown);
			setHasUnsavedChanges(false);
		},
		[
			editorBodyVersionRef,
			editorBodyHashRef,
			updateSavedBaseline,
			noteTypedSinceSave,
			rawEditPending,
		],
	);
	// The single-user editor holds this saved body now (Fizzy #2946): as
	// `adoptSavedBody`, with the identity the server named for it, if any.
	const adoptSoloBody = useCallback(
		(markdown: string, version?: number, contentHash?: string) => {
			if (autoSaveTimeoutRef.current) {
				clearTimeout(autoSaveTimeoutRef.current);
				autoSaveTimeoutRef.current = null;
			}
			if (version !== undefined) {
				editorBodyVersionRef.current = version;
			}
			editorBodyHashRef.current = contentHash;
			if (rawEditPending()) {
				updateSavedBaseline(markdown);
				setHasUnsavedChanges(true);
				return;
			}
			savedEditCountRef.current = localEditCountRef.current;
			noteTypedSinceSave();
			baselineRef.current = markdown;
			setCurrentDocument(markdown);
			setRawContent(markdown);
			updateSavedBaseline(markdown);
			setHasUnsavedChanges(false);
		},
		[
			editorBodyVersionRef,
			editorBodyHashRef,
			updateSavedBaseline,
			noteTypedSinceSave,
			rawEditPending,
		],
	);
	// What this person has typed here, as it would be offered back: the raw
	// view's text while it holds edits of its own, the editor's otherwise
	// (Fizzy #2946).
	const readLocalText = useCallback((): string | null => {
		if (rawEditPending()) {
			return rawContentRef.current;
		}
		const ed = liveEditorOrNull(editorRef.current);
		return ed ? getEditorMarkdownForSave(ed) : null;
	}, [rawEditPending]);
	// Text a room brought back to the saved document took from this person,
	// offered back once rather than dropped (Fizzy #2946). Also raw-view
	// edits the editor moved past, under a toast of their own that the
	// offer replaces once they leave the raw view.
	const rawOfferToastId = `raw-edits-offer:${documentId}`;
	const offerBackReplacedText = useCallback(
		(
			text: string,
			{
				message,
				id,
				read,
			}: {
				message?: string;
				id?: string;
				/** The text to copy when clicked, if not `text` as it is now. */
				read?: () => string;
			} = {},
		) => {
			rawOfferRef.current = { text, kept: false };
			// The room offering the raw view's own edits: under the one toast
			// that says what became of them, copying them as they stand when
			// clicked (Fizzy #2946) — leaving replaces it, it is never doubled.
			const rawText = rawEditPending() && text === rawContentRef.current;
			if (rawText) {
				staleRawTextRef.current = text;
			}
			const toastId = id ?? (rawText ? rawOfferToastId : undefined);
			const copied =
				rawText && read === undefined
					? () => staleRawTextRef.current
					: (read ?? (() => text));
			toast.warning(message ?? tRoom("offerBack.message"), {
				...(toastId ? { id: toastId } : {}),
				duration: Number.POSITIVE_INFINITY,
				action: {
					label: tRoom("offerBack.copy"),
					onClick: () => {
						const clipboard =
							typeof navigator === "undefined"
								? undefined
								: navigator.clipboard;
						if (!clipboard) {
							toast.error(tRoom("offerBack.copyFailed"));
							return;
						}
						clipboard.writeText(copied()).then(
							() => toast.success(tRoom("offerBack.copied")),
							() => toast.error(tRoom("offerBack.copyFailed")),
						);
					},
				},
			});
		},
		[tRoom, rawEditPending, rawOfferToastId],
	);
	// The editor took a newer body while the raw view held edits of their
	// own: they stay there, unsaved, and are no longer saved on their own
	// (see `rawEditsStaleRef`). Said once, with the text to copy, unless the
	// room just offered it back as it replaced the body.
	const noteRawEditsStale = () => {
		if (rawEditsStaleRef.current) {
			return;
		}
		rawEditsStaleRef.current = true;
		const text = rawContentRef.current;
		staleRawTextRef.current = text;
		if (rawOfferRef.current?.text === text) {
			return;
		}
		// The raw view stays editable: what is copied is the text as it
		// stands when the offer is clicked.
		offerBackReplacedText(text, {
			message: tRoom("rawEditsStale.message"),
			id: rawOfferToastId,
			read: () => staleRawTextRef.current,
		});
		rawOfferRef.current = { text, kept: true };
	};
	const noteRawEditsStaleRef = useRef(noteRawEditsStale);
	noteRawEditsStaleRef.current = noteRawEditsStale;
	const roomConvergenceState = useRoomConvergence({
		active: roomStampsOn && !!provider && isCollabSynced,
		ydoc: roomStampsOn ? ydoc : null,
		awareness: provider?.awareness,
		editor: editor ?? null,
		canEdit,
		visible: tabVisible,
		savedStamp,
		savedBody: document?.content ?? null,
		savedRun: runIdentity(document?.generationStartedAt),
		savedAt: documentDataUpdatedAt,
		runLive: isRunStillWriting || isRegenerating,
		ownSaveInFlight: isSaving || adoptingBase,
		hasLocalTyping,
		refetchSaved: refetchSavedDocument,
		applySavedBody: applySavedBodyToRoom,
		adoptSavedBody,
		offerBack: offerBackReplacedText,
		readLocalText,
	});
	const roomStatus: RoomStatus = roomStampsOn
		? roomConvergenceState.status
		: "inSync";
	// A save from a room that is behind the saved document would be refused,
	// or write an older body; saves wait until the room is back on it, and
	// until a body adopted from the server is named by its stamp.
	const saveBlockReason: SaveBlockReason | null =
		runSaveBlockReason ??
		(roomConvergence && soloBaseStale
			? "staleBase"
			: roomConvergence && (adoptingBase || roomStatus !== "inSync")
				? "updatingToLatest"
				: null);
	// What the editor shows meanwhile: the saved body, read-only, instead of
	// the room's older one, once the room is being replaced (or cannot be).
	// While the stale rule only looks a second time, only at the end of a
	// run the room has not taken in, and only after a moment: the editor
	// that follows the run usually puts its body in first, and hiding the
	// editor for that moment blanks the page at the end of every run (Fizzy
	// #2946). Before that moment the editor holds still (see
	// `CheckingView`).
	const checkingView = roomStampsOn
		? roomConvergenceState.checkingView
		: "room";
	const showsSavedBody =
		roomStatus === "updating" ||
		roomStatus === "failed" ||
		roomStatus === "behindReadOnly" ||
		(roomStatus === "checking" && checkingView === "savedBody");
	// The editor takes no input while the room is replaced, nor at the end of
	// a run while the room still holds the body before it, and never from a
	// client that may not edit it.
	const roomFreezesEditor =
		roomStampsOn &&
		(roomStatus === "updating" ||
			roomStatus === "failed" ||
			roomStatus === "behindReadOnly" ||
			(roomStatus === "checking" && checkingView !== "room") ||
			canEdit === false);
	// Typing that waited for the room, or for the answer to an assistant
	// proposal, is saved once saves may go again: the autosave that fell
	// due meanwhile stood down without rescheduling (Fizzy #2946). After a
	// proposal only when no save of its own went — an accept sends one, and
	// a failed save is retried by the person, not on its own.
	const previousSaveBlockRef = useRef(saveBlockReason);
	useEffect(() => {
		const previous = previousSaveBlockRef.current;
		previousSaveBlockRef.current = saveBlockReason;
		if (
			((roomConvergence && previous === "updatingToLatest") ||
				(previous === "proposal" &&
					!saveInFlightRef.current &&
					!pendingDirectSaveRef.current)) &&
			saveBlockReason === null &&
			hasUnsavedChanges
		) {
			scheduleDirtyCheck();
		}
	}, [
		saveBlockReason,
		roomConvergence,
		hasUnsavedChanges,
		scheduleDirtyCheck,
	]);

	// A body taken on from the server whose answer named its version but not
	// its identity — a restored version, a rewound regeneration, a context
	// update — gets its identity from a fresh read of the document, when that
	// read still holds it (Fizzy #2946). Until then saves wait, and the room
	// hears that a save is in flight. When the read holds something else, a
	// later write landed: the stale rule brings the room to it.
	const adoptTokenRef = useRef(0);
	const adoptServerBase = useCallback(
		async ({
			body,
			version,
		}: {
			body: string | null;
			version?: number;
		}) => {
			if (!roomConvergence) {
				return;
			}
			const token = ++adoptTokenRef.current;
			const stampBefore =
				roomStampsOn && ydoc ? readRoomStamp(ydoc) : null;
			setAdoptingBase(true);
			if (roomStampsOn) {
				publishRoomSaveInFlight(
					provider?.awareness,
					stampBefore ?? {
						version: version ?? 0,
						contentHash: "pending",
					},
				);
			}
			try {
				const fresh = await queryClient.fetchQuery({
					...orpc.projects.documents.get.queryOptions({
						input: { id: documentId, projectId, organizationId },
					}),
					staleTime: 0,
				});
				const saved = fresh?.document;
				if (
					token !== adoptTokenRef.current ||
					!saved ||
					typeof saved.contentHash !== "string" ||
					!saved.contentHash ||
					(body !== null && saved.content !== body) ||
					(version !== undefined && saved.version !== version)
				) {
					return;
				}
				editorBodyVersionRef.current = saved.version;
				editorBodyHashRef.current = saved.contentHash;
				if (roomStampsOn && ydoc) {
					const held = readRoomStamp(ydoc);
					if (
						(held === null && stampBefore === null) ||
						sameRoomStamp(held, stampBefore)
					) {
						writeRoomStamp(ydoc, {
							version: saved.version,
							contentHash: saved.contentHash,
						});
					}
				}
			} catch {
				// Left to the stale rule.
			} finally {
				if (token === adoptTokenRef.current) {
					setAdoptingBase(false);
					if (roomStampsOn) {
						publishRoomSaveInFlight(provider?.awareness, null);
					}
				}
			}
		},
		[
			roomConvergence,
			roomStampsOn,
			ydoc,
			provider,
			queryClient,
			documentId,
			projectId,
			organizationId,
			editorBodyVersionRef,
			editorBodyHashRef,
		],
	);

	// useCoAgent for streaming updates from LangGraph
	// NOTE: ragContexts and projectContext are NOT stored here because useCoAgent
	// syncs bidirectionally - when the agent responds, it replaces the state.
	// Since the agent doesn't return these fields, they would get lost.
	// Instead, they're stored in local state and sent via useCopilotReadable.
	//
	// `initialState` MUST be memoized: a fresh object on every render causes
	// CopilotKit / AG-UI to re-emit `agent/connect` handshakes, which on top of
	// presence-tick re-renders sends dozens of redundant /api/copilotkit POSTs
	// per document load and burns the per-user 500/min rate-limit budget.
	const repositoryUrl = (project as Record<string, unknown>)?.repositoryUrl;
	const initialAgentState = useMemo<AgentState>(
		() => ({
			document: "",
			streamingContent: "",
			documentType: document?.type
				? normalizeDocumentType(document.type)
				: "general",
			error: undefined,
			retryCount: 0,
			hasTeamsIntegration: false,
			hasSlackIntegration: false,
			hasGitHubIntegration: !!repositoryUrl,
			hasRepoIntegration: codeSearchEnabled && !!repositoryUrl,
			projectId,
			userId: user?.id ?? "",
			organizationId: organizationId ?? undefined,
			// Declare reasoningByTurn / toolCallsByTurn in initialState so
			// CopilotKit's useCoAgent doesn't filter them out of the React
			// state updates. Without these keys, STATE_SNAPSHOT events that
			// carry per-turn reasoning/tool-call traces (PR #976/#1023/#1024)
			// arrive on the SSE wire but are dropped before reaching
			// CopilotAssistantMessage's useCoAgent subscription.
			reasoningByTurn: {},
			toolCallsByTurn: {},
		}),
		[
			document?.type,
			repositoryUrl,
			codeSearchEnabled,
			projectId,
			user?.id,
			organizationId,
		],
	);

	const {
		state: agentState,
		setState: setCoAgentState,
		nodeName,
	} = useCoAgent<AgentState>({
		name: "project_document_generator",
		initialState: initialAgentState,
	});

	// Every document handed to the agent goes through `toAgentDocument`, so the
	// model never sees (and echoes back) Turndown's escapes. What the agent
	// returns is therefore compared against `toAgentDocument(baseline)`.
	const withAgentDocument = (state: AgentState): AgentState =>
		typeof state.document === "string"
			? { ...state, document: toAgentDocument(state.document) }
			: state;
	const setAgentState = (
		update: AgentState | ((prev: AgentState | undefined) => AgentState),
	) =>
		setCoAgentState(
			typeof update === "function"
				? (prev) => withAgentDocument(update(prev))
				: withAgentDocument(update),
		);

	// `useCoAgent` returns a new `setState` function every render, so listing it in
	// a useEffect dep array causes an infinite render loop. Stash the latest
	// reference in a ref and read through it from effects that only need to fire
	// when their *data* dependencies change.
	const setAgentStateRef = useRef(setAgentState);
	setAgentStateRef.current = setAgentState;

	// Mirror the agent's proposed document into a ref so the confirm action —
	// whose render closure is stale under empty deps — can read the freshest
	// proposed content deterministically when the confirm arms (RC2 fix).
	const agentDocumentRef = useRef<string>("");
	agentDocumentRef.current = agentState?.document ?? "";

	// Keep the before-send sync closure (handed to the input factory above as
	// `handleBeforeSend`) pointing at the latest `editor` + `setAgentStateRef`.
	// Flushes the current editor markdown into `state.document` synchronously
	// right before each send so the outgoing turn always carries the open
	// document — guards against the bidirectional `useCoAgent` sync having
	// clobbered it to empty. Partial-update form only (never spread a stale
	// `agentState` snapshot).
	syncDocumentBeforeSendRef.current = () => {
		if (!editor) {
			return;
		}
		// This only mirrors editor content into the agent's
		// context state (not a save) — `?? ""` is fine; a failed read just
		// means the agent temporarily sees an empty document.
		const markdown = getEditorMarkdownForSave(editor) ?? "";
		flushSync(() => {
			setAgentStateRef.current({
				document: markdown,
			} as Partial<AgentState> as AgentState);
		});
	};

	// Track whether we've initialized the agent state
	const agentStateInitializedRef = useRef(false);
	const yjsInitializedRef = useRef(false);
	const ragContextsInitializedRef = useRef(false);
	const contentRepairAppliedRef = useRef(false);

	// Populate agent state with RAG contexts, Teams messages, and project context when data loads
	// This enables the chat sidebar to reference uploaded documents, Notion pages, and Teams discussions
	// IMPORTANT: Wait for BOTH queries to complete to avoid race condition where Teams messages
	// arrive after initial state is set (ragContextsInitializedRef would block the update)
	useEffect(() => {
		// Wait for all queries to finish loading before initializing
		// This prevents the race condition where contexts arrive before Teams/Slack/transcript data
		const bothQueriesComplete =
			!isLoadingContexts &&
			!isLoadingTeams &&
			!isLoadingSlack &&
			!isLoadingTranscripts;

		if (
			bothQueriesComplete &&
			documentContextData &&
			project &&
			!ragContextsInitializedRef.current
		) {
			// Vector-searched RAG contexts (already filtered and ranked by Qdrant)
			const documentContexts = documentContextData.ragContexts || [];

			// Format Teams messages as context strings
			// Format: [Teams - ChatName] Author (Date): Message
			const teamsContexts: string[] = [];
			if (
				teamsMessagesData?.messages &&
				teamsMessagesData.messages.length > 0
			) {
				for (const msg of teamsMessagesData.messages) {
					const date = msg.createdAt
						? new Date(msg.createdAt).toLocaleDateString()
						: "";
					const formattedMsg = `[Teams - ${msg.chatName}] ${msg.from}${date ? ` (${date})` : ""}: ${msg.content}`;
					teamsContexts.push(formattedMsg);
				}
			}

			// Format Slack messages as context strings
			// Format: [Slack - #channelName] Author (Date): Message
			const slackContexts: string[] = [];
			if (
				slackMessagesData?.messages &&
				slackMessagesData.messages.length > 0
			) {
				for (const msg of slackMessagesData.messages) {
					const date = msg.createdAt
						? new Date(msg.createdAt).toLocaleDateString()
						: "";
					const formattedMsg = `[Slack - #${msg.channelName}] ${msg.from}${date ? ` (${date})` : ""}: ${msg.content}`;
					slackContexts.push(formattedMsg);
				}
			}

			const transcriptContexts = formatTranscriptContexts(
				transcriptContextData?.transcripts ?? [],
			);

			// Combine all contexts: vector-searched documents first, then transcripts, then Teams/Slack messages
			const ragContexts = [
				...documentContexts,
				...transcriptContexts,
				...teamsContexts,
				...slackContexts,
			];

			// Clear features when DOCUMENT RAG exists (features vs RAG fix)
			// This prevents wizard-generated features from overriding actual uploaded content
			// Note: We only check documentContexts, not teamsContexts, because Teams messages
			// are discussion context, not document specifications that would replace features
			const hasDocumentRag = documentContexts.length > 0;

			ragContextsInitializedRef.current = true;
			// Store document contexts in ref for later Teams updates
			documentContextsRef.current = documentContexts;

			// Sync integration flags into agent state so the agent can bind the right search tools.
			// hasTeamsIntegration / hasSlackIntegration default to false in useCoAgent's initial state
			// and are never updated otherwise, so Teams/Slack search tools are never bound.
			// Recompute repo-related flags unconditionally — `prev?.hasRepoIntegration`
			// can be `false` (not undefined) from useCoAgent's initialState when this
			// component renders before the `ragSettings` query resolves, and `??`
			// would strand that stale `false` even after the toggle/URL are known.
			const repoUrlPresent = !!(project as Record<string, unknown>)
				?.repositoryUrl;
			setAgentState((prev) => ({
				document: prev?.document ?? "",
				streamingContent: prev?.streamingContent ?? "",
				documentType: prev?.documentType ?? document?.type ?? "general",
				error: prev?.error,
				retryCount: prev?.retryCount ?? 0,
				focusAnchor: prev?.focusAnchor,
				projectId: prev?.projectId ?? projectId,
				userId: prev?.userId ?? user?.id ?? "",
				organizationId:
					prev?.organizationId ?? organizationId ?? undefined,
				hasGitHubIntegration: repoUrlPresent,
				hasRepoIntegration: codeSearchEnabled && repoUrlPresent,
				hasTeamsIntegration: !!teamsMessagesData?.hasTeamsIntegration,
				hasSlackIntegration: !!slackMessagesData?.hasSlackIntegration,
			}));

			// Store in LOCAL state (not agent state) so it doesn't get overwritten
			// when useCoAgent syncs back from agent response
			setLocalRagContexts(ragContexts);
			setLocalProjectContext({
				name: project.name,
				description: project.description ?? undefined,
				goals: project.goals ?? undefined,
				techStack: project.techStack ?? [],
				features: hasDocumentRag ? [] : (project.features ?? []),
				projectTypes: project.projectTypes ?? [],
				repositoryUrl: (project as Record<string, unknown>)
					.repositoryUrl as string | undefined,
				repositoryOwner: (project as Record<string, unknown>)
					.repositoryOwner as string | undefined,
				repositoryName: (project as Record<string, unknown>)
					.repositoryName as string | undefined,
				defaultBranch: (project as Record<string, unknown>)
					.defaultBranch as string | undefined,
			});
		}
	}, [
		documentContextData,
		teamsMessagesData?.messages,
		slackMessagesData?.messages,
		transcriptContextData?.transcripts,
		project,
		isLoadingContexts,
		isLoadingTeams,
		isLoadingSlack,
		isLoadingTranscripts,
	]);

	// Sync integration flags into agent state whenever their source queries change.
	// The main initialization effect above is guarded by a one-shot ref, so toggling
	// "Enable code search for AI agents" (or connecting Teams/Slack) while the editor
	// is open wouldn't otherwise propagate to the agent state — leaving code-search
	// tools unbound until a hard reload.
	// Partial update form — matches the pattern already used elsewhere (e.g. the
	// document/focusAnchor updates). We read `setAgentState` through a ref because
	// `useCoAgent` returns a new function reference every render; listing it in deps
	// would cause an infinite update loop.
	const repoUrlForSync = (project as Record<string, unknown>)
		?.repositoryUrl as string | undefined;
	useEffect(() => {
		const repoUrlPresent = !!repoUrlForSync;
		setAgentStateRef.current({
			hasTeamsIntegration: !!teamsMessagesData?.hasTeamsIntegration,
			hasSlackIntegration: !!slackMessagesData?.hasSlackIntegration,
			hasGitHubIntegration: repoUrlPresent,
			hasRepoIntegration: codeSearchEnabled && repoUrlPresent,
		} as AgentState);
	}, [
		teamsMessagesData?.hasTeamsIntegration,
		slackMessagesData?.hasSlackIntegration,
		repoUrlForSync,
		codeSearchEnabled,
	]);

	// Update localRagContexts when Teams/Slack/transcript data changes AFTER initialization
	// This allows fresh messages to be included in subsequent AI requests
	useEffect(() => {
		// Only run after initialization and when messages change
		if (
			!ragContextsInitializedRef.current ||
			isLoadingTeams ||
			isLoadingSlack
		) {
			return;
		}

		const transcriptContexts = formatTranscriptContexts(
			transcriptContextData?.transcripts ?? [],
		);

		// Format Teams messages
		const teamsContexts: string[] = [];
		if (
			teamsMessagesData?.messages &&
			teamsMessagesData.messages.length > 0
		) {
			for (const msg of teamsMessagesData.messages) {
				const date = msg.createdAt
					? new Date(msg.createdAt).toLocaleDateString()
					: "";
				const formattedMsg = `[Teams - ${msg.chatName}] ${msg.from}${date ? ` (${date})` : ""}: ${msg.content}`;
				teamsContexts.push(formattedMsg);
			}
		}

		// Format Slack messages
		const slackContexts: string[] = [];
		if (
			slackMessagesData?.messages &&
			slackMessagesData.messages.length > 0
		) {
			for (const msg of slackMessagesData.messages) {
				const date = msg.createdAt
					? new Date(msg.createdAt).toLocaleDateString()
					: "";
				const formattedMsg = `[Slack - #${msg.channelName}] ${msg.from}${date ? ` (${date})` : ""}: ${msg.content}`;
				slackContexts.push(formattedMsg);
			}
		}

		// Combine document contexts (from ref) with fresh transcripts/Teams/Slack messages
		const updatedRagContexts = [
			...documentContextsRef.current,
			...transcriptContexts,
			...teamsContexts,
			...slackContexts,
		];

		setLocalRagContexts(updatedRagContexts);
	}, [
		teamsMessagesData?.messages,
		slackMessagesData?.messages,
		transcriptContextData?.transcripts,
		isLoadingTeams,
		isLoadingSlack,
	]);

	// Initialize Yjs document with content when first synced (only in collaborative mode)
	useEffect(() => {
		if (
			enableCollaboration &&
			isCollabSynced &&
			ydoc &&
			!yjsInitializedRef.current &&
			document?.content &&
			editor
		) {
			if (roomStampsOn) {
				// Only a room nobody has written takes the saved body, with its
				// stamp, and only from a client that may edit it (Fizzy #2946).
				// The check reads the fragment the editor is bound to. A room
				// that already holds a body keeps it: one behind the saved
				// document is brought back to it by the convergence, which
				// offers back what it replaces.
				if (canEdit === null) {
					return;
				}
				if (canEdit && isRoomBodyEmpty(ydoc)) {
					applyServerBody(
						editor,
						fromMarkdown(document.content),
						savedStamp,
					);
				}
				yjsInitializedRef.current = true;
				return;
			}
			// Check if Yjs doc is empty (first load). The literal is deliberate:
			// the body lives in `ROOM_BODY_FRAGMENT`, so this fragment always
			// reads empty and, with the room flag off, every editor seeds the
			// room from the saved body as it always has.
			const xmlFragment = ydoc.getXmlFragment("prosemirror");
			if (xmlFragment.length === 0) {
				// Set content through the editor which will sync to Yjs
				applyProgrammaticContent(
					editor,
					fromMarkdown(document.content),
					"server",
				);
			}
			yjsInitializedRef.current = true;
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [
		enableCollaboration,
		isCollabSynced,
		document?.content,
		editor,
		ydoc,
		roomStampsOn,
		canEdit,
	]);

	// Scroll to a mentioned anchor when the URL hash matches `#m-<anchor>`.
	// Mentions are stored as `data-mention-id="m_<rand>"` (underscore form);
	// the URL fragment uses `#m-<rand>` (hyphen form) for cleaner URLs.
	useEffect(() => {
		if (typeof window === "undefined") {
			return;
		}
		if (!editor) {
			return;
		}
		const hash = window.location.hash;
		if (!hash.startsWith("#m-")) {
			return;
		}
		// Anchors are generated from `Math.random().toString(36)` + a base-36
		// timestamp, so legitimate ids only contain `[0-9a-z_]`. Reject
		// anything else so a crafted hash can't break querySelector.
		const fragment = hash.slice(3);
		if (!/^[0-9a-z_]+$/.test(fragment)) {
			return;
		}
		const dataValue = `m_${fragment}`;
		let cancelled = false;
		let retries = 0;
		const MAX_RETRIES = 10; // ~2 s of hydration window
		let flashTimer: ReturnType<typeof setTimeout> | undefined;
		let announcementTimer: ReturnType<typeof setTimeout> | undefined;
		const tryScroll = () => {
			if (cancelled) {
				return;
			}
			const el = window.document.querySelector<HTMLElement>(
				`span[data-mention-id="${dataValue}"]`,
			);
			if (!el) {
				if (retries >= MAX_RETRIES) {
					return;
				}
				retries += 1;
				setTimeout(tryScroll, 200);
				return;
			}
			el.scrollIntoView({ block: "center" });
			el.classList.add("mention-flash");
			flashTimer = setTimeout(
				() => el.classList.remove("mention-flash"),
				1500,
			);
			// Announce the navigation to screen readers via the polite live region.
			setScrollAnnouncement("Jumped to mention in document.");
			announcementTimer = setTimeout(
				() => setScrollAnnouncement(""),
				3000,
			);
		};
		tryScroll();
		return () => {
			cancelled = true;
			if (flashTimer !== undefined) {
				clearTimeout(flashTimer);
			}
			if (announcementTimer !== undefined) {
				clearTimeout(announcementTimer);
			}
		};
	}, [editor]);

	// Show toast notification when agent error occurs
	useEffect(() => {
		if (agentState?.error) {
			toast.error(agentState.error);
		}
	}, [agentState?.error]);

	// Initialize agent state with document content on mount
	// Use ref to ensure this only runs once even if dependencies change
	// IMPORTANT: Use getEditorMarkdownForSave to ensure proper markdown conversion
	// This handles cases where document.content might have raw HTML (e.g., TipTap tables)
	useEffect(() => {
		if (document?.content && editor && !agentStateInitializedRef.current) {
			// Get properly converted markdown from the editor
			// This uses Turndown with custom rules for TipTap tables
			const editorMarkdown = getEditorMarkdownForSave(editor);
			// Use editor markdown if available, otherwise fall back to document
			// content. Fizzy #1987: `editorMarkdown` is null on serialization
			// failure (was "" before) — that already routes into this same
			// document.content fallback below.
			const markdownContent =
				editorMarkdown && editorMarkdown.trim().length > 0
					? editorMarkdown
					: document.content;

			agentStateInitializedRef.current = true;
			// Use properly converted markdown for agent state
			// This ensures the AI sees markdown, not raw HTML
			setCurrentDocument(markdownContent);
			// IMPORTANT: Preserve ragContexts and projectContext (may be set before or after)
			setAgentState((prev) => ({
				...prev,
				document: markdownContent,
				streamingContent: markdownContent,
			}));
			updateSavedBaseline(markdownContent);
			// CRITICAL: Also set baselineRef so diff highlighting works correctly
			// Without this, the first streaming would see an empty baseline and show all content as additions
			baselineRef.current = markdownContent;

			// If TipTap editor was initialized empty (because document was generating),
			// populate the editor canvas immediately once generated content arrives.
			if (
				editorMarkdown !== null &&
				editorMarkdown.trim().length === 0 &&
				!enableCollaboration
			) {
				try {
					applyProgrammaticContent(
						editor,
						fromMarkdown(markdownContent),
						"server",
					);
					editorBodyVersionRef.current =
						document.version ?? editorBodyVersionRef.current;
					editorBodyHashRef.current =
						document.contentHash ?? undefined;
				} catch {
					/* leave canvas as-is on programmatic update error */
				}
			}
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [editor, document?.content]);

	// Repair malformed loaded content once after the editor has hydrated.
	// This catches previously saved/collaborative documents that already contain
	// broken code blocks and would otherwise bypass the markdown import cleanup.
	useEffect(() => {
		if (
			!editor ||
			isLoading ||
			isRegenerating ||
			contentRepairAppliedRef.current
		) {
			return;
		}

		if (enableCollaboration && !isCollabSynced) {
			return;
		}

		const currentMarkdown = getEditorMarkdownForSave(editor);
		const fallbackMarkdown = repairMarkdownDocument(
			document?.content || "",
		);
		// `currentMarkdown` is null on serialization failure (was
		// "" before) — that already routes into the fallbackMarkdown branch.
		const sourceMarkdown =
			currentMarkdown && currentMarkdown.trim().length > 0
				? currentMarkdown
				: fallbackMarkdown;
		const repairedMarkdown = repairMarkdownDocument(sourceMarkdown);

		contentRepairAppliedRef.current = true;

		if (
			repairedMarkdown.trim().length > 0 &&
			repairedMarkdown !== sourceMarkdown
		) {
			applyProgrammaticContent(
				editor,
				fromMarkdown(repairedMarkdown),
				"server",
			);
			setCurrentDocument(repairedMarkdown);
			setRawContent(repairedMarkdown);
			// applyProgrammaticContent dispatches synchronously, so the editor
			// already holds the repaired content by the time we capture the
			// text snapshot here.
			updateSavedBaseline(repairedMarkdown);
			baselineRef.current = repairedMarkdown;
		}
	}, [
		document?.content,
		editor,
		enableCollaboration,
		isCollabSynced,
		isLoading,
		isRegenerating,
	]);

	// Typing from before a sync loss that no save covered is still unsaved
	// when the room comes back (Fizzy #2946). The loss remounted this editor,
	// which took the room's body — that typing included — as its baseline
	// above and so showed it saved, with no autosave due. The baseline goes
	// back to the saved body and the dirty check runs as after a keystroke:
	// Save comes back on and the autosave is scheduled. That autosave still
	// stands down while saves are blocked (a run, a room behind the saved
	// document) and goes when they lift; leaving clears it and saves the
	// typing on the way out instead. Once per mount, for a client that may
	// edit; a save clears the lifted flag. Only for typing from before this
	// mount: typing here — an accepted proposal included — already reads as
	// unsaved, and the saved body read meanwhile may be a save's optimistic
	// answer, which would mark that typing saved before the save lands. For
	// the same reason a save still in flight from before the loss is waited
	// for: until it answers, the saved body is its optimistic one; then a
	// failure has put the saved body back, and a success has cleared the flag.
	const restoredTypingRef = useRef(false);
	const typedBeforeMountRef = useRef(typedSinceSaveRef?.current === true);
	const savesInFlight = useIsMutating({
		mutationKey: orpc.projects.documents.update.mutationKey(),
		predicate: (mutation) =>
			(mutation.state.variables as { id?: unknown } | undefined)?.id ===
			documentId,
	});
	useEffect(() => {
		if (
			restoredTypingRef.current ||
			!typedBeforeMountRef.current ||
			!roomConvergence ||
			!enableCollaboration ||
			canEdit !== true ||
			!editor ||
			savesInFlight > 0
		) {
			return;
		}
		restoredTypingRef.current = true;
		if (typedSinceSaveRef?.current !== true) {
			return;
		}
		lastSavedContentRef.current = document?.content ?? "";
		recomputeDirtyState();
	}, [
		roomConvergence,
		enableCollaboration,
		canEdit,
		editor,
		savesInFlight,
		document?.content,
		typedSinceSaveRef,
		recomputeDirtyState,
	]);

	// NOTE: Streaming effects are defined below in the "STREAMING PATTERN" section.
	// This section follows the exact ag-ui-demo pattern for reliable diff highlighting.

	// Auto-save pending changes before AI updates begin — unless saves are
	// refused right now (see `saveBlockReason`).
	useEffect(() => {
		if (
			isLoading &&
			hasUnsavedChanges &&
			saveBlockReason === null &&
			// Nothing typed here: nothing of this editor's to save first
			// (Fizzy #2946).
			!passiveInRoom() &&
			// Nor when the save in flight already carries all of it, as an
			// accepted proposal's save does.
			!(
				saveInFlightRef.current &&
				localEditCountRef.current <= savingEditCountRef.current
			)
		) {
			// Cancel the debounce timer and save immediately
			if (autoSaveTimeoutRef.current) {
				clearTimeout(autoSaveTimeoutRef.current);
				autoSaveTimeoutRef.current = null;
			}
			handleSave();
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [isLoading]);

	// Refetch Teams/Slack messages when AI request starts (rising edge only)
	// This ensures the next request has the latest context
	const prevIsLoadingRef = useRef(false);
	useEffect(() => {
		if (isLoading && !prevIsLoadingRef.current) {
			// Refetch messages in the background
			// The updated messages will be available for the NEXT AI request
			refetchTeamsMessages();
			refetchSlackMessages();
		}
		prevIsLoadingRef.current = isLoading;
	}, [isLoading, refetchTeamsMessages, refetchSlackMessages]);

	// Cleanup auto-save and dirty-check timeouts on unmount
	useEffect(() => {
		unmountedRef.current = false;
		return () => {
			unmountedRef.current = true;
			if (autoSaveTimeoutRef.current) {
				clearTimeout(autoSaveTimeoutRef.current);
				autoSaveTimeoutRef.current = null;
			}
			if (dirtyCheckTimeoutRef.current) {
				clearTimeout(dirtyCheckTimeoutRef.current);
				dirtyCheckTimeoutRef.current = null;
			}
		};
	}, []);

	// Detect when document content changes during regeneration
	// For regeneration: Load new content directly into editor (no diff highlighting)
	// and show a simple Accept/Reject confirmation
	//
	// Only for the run's own result (Fizzy #2946). Never while the server
	// still reports the run queued or generating: its final save writes the
	// body and COMPLETE together, so a body that changes before then is a
	// colleague's save. And never without the baseline this editor recorded
	// when it started the run: without one it holds no run of its own to
	// review, whatever `isRegenerating` says, and the body it would take for
	// the result is the one it already had.
	useEffect(() => {
		if (!isRegenerating || isConfirming) {
			return;
		}
		// A run this editor only follows is adopted by the effect after the
		// attach effect below, without this review.
		if (attachedRunRef.current) {
			return;
		}
		if (
			document?.status === "QUEUED" ||
			document?.status === "GENERATING"
		) {
			return;
		}
		const baseline = regenerationBaselineRef.current;
		if (baseline === null) {
			return;
		}

		const polledContent = document?.content;

		// Content must exist and differ from baseline.
		// The baseline is empty for a first generation — any non-empty content triggers.
		const hasNewContent =
			polledContent != null &&
			polledContent.length > 0 &&
			polledContent !== baseline;

		if (!hasNewContent) {
			return;
		}

		// Cancel the safety timer — regeneration succeeded, so the
		// "taking longer than expected" notice must not fire afterwards.
		if (regenerationTimeoutRef.current) {
			clearTimeout(regenerationTimeoutRef.current);
			regenerationTimeoutRef.current = null;
		}

		// Batch all state updates to prevent flicker
		startTransition(() => {
			// Stop polling and set confirming flag
			setIsRegenerating(false);
			setIsConfirming(true);
			// Store previous and new content using the preserved baseline
			setPreviousContent(baseline);
			setNewContent(polledContent);

			// For regeneration: Load new content directly into editor (no diff)
			// The user can then Accept (keep) or Reject (revert)
			// The effect below puts it in the editor on screen.
			// The editor now holds the regenerated body; a rejection moves this
			// on to the version the rewind (or its fallback save) answers with.
			editorBodyVersionRef.current =
				document?.version ?? editorBodyVersionRef.current;
			editorBodyHashRef.current = document?.contentHash ?? undefined;
			// The same snapshot names the body under review for the room
			// (Fizzy #2946).
			runState.reviewStampRef.current = savedStamp;
			runState.reviewedVersionRef.current = document?.version ?? null;
			// And the run itself, which a newer run's identical body cannot
			// stand in for (Fizzy #2946).
			runState.reviewedRunStartedAtRef.current = runIdentity(
				document?.generationStartedAt,
			);
			setCurrentDocument(polledContent);
			// NOTE: Don't call setAgentState here - it can trigger CopilotKit to respond
			// The agent state will be updated when user accepts/rejects

			// Show confirmation dialog
			setShowConfirmDialog(true);
			// Clear the baseline ref after use
			regenerationBaselineRef.current = null;
		});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [document?.content, document?.status, isRegenerating, isConfirming]);

	// The body under review goes into the editor on screen once per review
	// (Fizzy #2946), right after this render — never on the next frame,
	// which a background tab holds back while every editor in the room waits
	// behind the saved body for it. When no editor is on screen — the room
	// lost sync and the editor is waiting for it — the next editor mounted
	// while the review is open takes it instead of showing the room's
	// previous body behind the dialog. Once written, the room keeps it,
	// together with anything a colleague types after it, so a later remount
	// does not write it again, and the editor that wrote it takes it as its
	// saved body. A polled body the generation workflow wrote — it already
	// carried the visual slots over server-side — so it is applied as is.
	const reviewAppliedRef = runState.reviewAppliedRef;
	useEffect(() => {
		if (!showConfirmDialog) {
			reviewAppliedRef.current = null;
			return;
		}
		if (!editor || reviewAppliedRef.current === newContent) {
			return;
		}
		const body = newContent;
		const stamp = runState.reviewStampRef.current;
		// Out of the render's commit (TipTap's node views flush
		// synchronously), but not a frame later.
		queueMicrotask(() => {
			if (reviewAppliedRef.current === body) {
				return;
			}
			// The room may hold this body already, written by a colleague's
			// editor, or a later saved one, and colleagues' typing on it
			// (Fizzy #2946).
			if (roomHoldsSavedBody(stamp)) {
				reviewAppliedRef.current = body;
				return;
			}
			if (applyToLiveEditor(fromMarkdown(body), stamp)) {
				reviewAppliedRef.current = body;
				if (roomStampsOn && stamp) {
					adoptSavedBody(body, stamp);
				}
			}
		});
	}, [
		editor,
		showConfirmDialog,
		newContent,
		applyToLiveEditor,
		reviewAppliedRef,
		roomHoldsSavedBody,
		runState.reviewStampRef,
		roomStampsOn,
		adoptSavedBody,
	]);

	// Whether a write after the run's — another run, a restore, a
	// colleague's save — has superseded the body under review (Fizzy #2946).
	// The review then no longer describes the document: its Reject would
	// revert the newer write and its Accept would put the older body back on
	// screen. The saved document says so when its body is no longer the
	// reviewed one; the room says so sooner when it holds a later saved body.
	// The same body at a higher version is the run's own version step, not a
	// newer write.
	//
	// A newer run supersedes it as soon as the document names that run,
	// before it writes, where this editor then follows that run or the room
	// brings it the run's body: an editor holding a review follows no other
	// run. Anywhere else the review stays until the run's body arrives, which
	// closes it and puts that body on screen.
	const latestRunIdentity = runIdentity(document?.generationStartedAt);
	const newerRunStarted = useCallback((): boolean => {
		const reviewedRun = runState.reviewedRunStartedAtRef.current;
		return (
			(attachToServerRun || roomStampsOn) &&
			reviewedRun !== null &&
			latestRunIdentity !== null &&
			latestRunIdentity !== reviewedRun
		);
	}, [
		attachToServerRun,
		roomStampsOn,
		latestRunIdentity,
		runState.reviewedRunStartedAtRef,
	]);
	const reviewSuperseded = useCallback((): boolean => {
		const savedBody = document?.content;
		if (typeof savedBody === "string" && savedBody !== newContent) {
			return true;
		}
		if (newerRunStarted()) {
			return true;
		}
		const reviewStamp = runState.reviewStampRef.current;
		if (roomStampsOn && ydoc && reviewStamp) {
			const held = readRoomStamp(ydoc);
			if (
				held &&
				held.version > reviewStamp.version &&
				held.contentHash !== reviewStamp.contentHash
			) {
				return true;
			}
		}
		return false;
	}, [
		document?.content,
		newContent,
		newerRunStarted,
		roomStampsOn,
		ydoc,
		runState.reviewStampRef,
	]);

	// Only a newer run superseded the review, its body not written yet: the
	// person is told that, not that the document changed.
	const supersededByRunOnly = useCallback(
		(): boolean => document?.content === newContent && newerRunStarted(),
		[document?.content, newContent, newerRunStarted],
	);

	// Closes a superseded review without writing anything to the server:
	// the newer write stays. In a stamped room the stale-base rules bring
	// the editor to it. Anywhere else nothing would: the review put its body
	// on screen, so the latest saved body goes in now and becomes the
	// editor's saved body — no older reviewed body is left there to edit and
	// save over the newer one (Fizzy #2946).
	const closeSupersededReview = useCallback(
		(
			messageKey:
				| "reviewSuperseded"
				| "reviewSupersededByRun"
				| "rejectReviewStale"
				| "rejectRunLive",
			latest?: {
				content?: string | null;
				version?: number;
				contentHash?: string | null;
			} | null,
		) => {
			const latestBody = latest?.content;
			if (!roomStampsOn && typeof latestBody === "string") {
				const version =
					typeof latest?.version === "number"
						? latest.version
						: undefined;
				const contentHash = latest?.contentHash ?? undefined;
				setCurrentDocument(latestBody);
				queueMicrotask(() => {
					if (
						applyToLiveEditor(
							latestBody ? fromMarkdown(latestBody) : "",
						)
					) {
						adoptSoloBody(latestBody, version, contentHash);
					}
				});
			}
			if (regenerationRespondRef.current) {
				// Nothing was reverted: the run's body stays in the history.
				regenerationRespondRef.current({ accepted: true });
				regenerationRespondRef.current = null;
			}
			setShowConfirmDialog(false);
			regenerationTriggeredRef.current = false;
			setTimeout(() => {
				isDirectRegenerationRef.current = false;
			}, 500);
			setTimeout(() => {
				setIsConfirming(false);
			}, 1000);
			toast.info(tRun(messageKey));
		},
		[
			roomStampsOn,
			applyToLiveEditor,
			adoptSoloBody,
			regenerationRespondRef,
			regenerationTriggeredRef,
			isDirectRegenerationRef,
			setShowConfirmDialog,
			setIsConfirming,
			tRun,
		],
	);

	// An open review is closed the moment the saved document moves past it,
	// so a stale dialog does not stay actionable. The run's own version step
	// re-points the review at the version it landed on. Not once the person
	// has accepted or rejected it: the document then moves because of that
	// choice — a rewind's answer can land before the dialog has closed —
	// and the choice says what happened.
	const reviewDecidedRef = useRef(false);
	useEffect(() => {
		if (!showConfirmDialog) {
			reviewDecidedRef.current = false;
			return;
		}
		if (reviewDecidedRef.current) {
			return;
		}
		if (reviewSuperseded()) {
			closeSupersededReview(
				supersededByRunOnly()
					? "reviewSupersededByRun"
					: "reviewSuperseded",
				document,
			);
			return;
		}
		if (
			typeof document?.version === "number" &&
			document.content === newContent &&
			runState.reviewedVersionRef.current !== null &&
			document.version > runState.reviewedVersionRef.current
		) {
			runState.reviewedVersionRef.current = document.version;
			if (savedStamp) {
				runState.reviewStampRef.current = savedStamp;
			}
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [
		showConfirmDialog,
		document?.content,
		document?.version,
		reviewSuperseded,
		supersededByRunOnly,
		closeSupersededReview,
	]);

	// FAILED watcher (issue #720): the effect above only ever looks for NEW
	// content — a workflow that fails mid-run never writes content, so it had
	// nothing to react to, and the "Regenerating Document…" spinner sat there
	// until the 5-minute safety timer finally gave up. This effect watches
	// the polled `document.status` for a genuine FAILED and stops the
	// spinner the moment one shows up.
	//
	// The tricky part is telling a FRESH failure apart from a STALE one. The
	// generate-document procedure writes QUEUED + clears
	// `generationError` BEFORE it starts the Temporal workflow (see
	// `markDocumentGenerationQueued`), so:
	//   - `regenerationAckAtRef.current` is the instant the mutation that
	//     kicked off THIS run resolved.
	//   - Any polled snapshot whose `dataUpdatedAt` is AFTER that instant was
	//     fetched no earlier than the server's GENERATING write, so a FAILED
	//     status in it can only be a real failure from THIS run — never a
	//     leftover FAILED row from the run being retried.
	//   - A snapshot fetched BEFORE that instant (a poll that was already in
	//     flight when the mutation resolved) is ignored: it can still carry
	//     the PREVIOUS run's FAILED status even though this run is already
	//     underway.
	useEffect(() => {
		if (!isRegenerating) {
			return;
		}
		const ackAt = regenerationAckAtRef.current;
		// Null means either the mutation hasn't resolved yet, or this
		// regeneration didn't go through the mutation at all (see the
		// CopilotKit / agent auto-regen paths) — stay unarmed rather than
		// react to a status we can't date.
		if (ackAt == null) {
			return;
		}
		if (document?.status !== "FAILED") {
			return;
		}
		if (documentDataUpdatedAt <= ackAt) {
			// Stale pre-retry snapshot — ignore it.
			return;
		}

		// Genuine mid-workflow failure: stop the regenerating state so the
		// existing DocumentGenerationFailedNotice overlay takes over.
		if (regenerationTimeoutRef.current) {
			clearTimeout(regenerationTimeoutRef.current);
			regenerationTimeoutRef.current = null;
		}
		setIsRegenerating(false);
		toast.error(
			document.generationError
				? `Document generation failed: ${document.generationError}`
				: "Document generation failed. Please try again.",
		);
		if (regenerationRespondRef.current) {
			regenerationRespondRef.current({ accepted: false });
			regenerationRespondRef.current = null;
		}
		regenerationTriggeredRef.current = false;
		regenerationBaselineRef.current = null;
		regenerationAckAtRef.current = null;
		attachedRunRef.current = false;
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [
		document?.status,
		document?.generationError,
		documentDataUpdatedAt,
		isRegenerating,
	]);

	// Attach to a run the editor did not start (Fizzy #2801). Without this,
	// a Proposal regenerated from the documents list, the chat or before a
	// reload ends with the editor still holding the body it loaded: the
	// regeneration effect above only listens while this editor is
	// regenerating. Attaching marks the editor regenerating for that run,
	// and the effect below adopts the run's body when it ends. There is no
	// Accept/Reject: the run belongs to whoever started it, and a Reject
	// here would rewind it for everyone.
	//
	// - A run this editor started is already regenerating, so attaching is a
	//   no-op and the run keeps its review.
	// - An empty document is left to the first-load path, which takes the
	//   first body without a review.
	// - The baseline is the saved body: the server writes the regenerated
	//   body only at the run's final save.
	// - The ack is the time of the snapshot that showed the run in
	//   progress, so the FAILED watcher treats a later FAILED as this run's
	//   own rather than ignoring it for want of a mutation to date it by.
	useEffect(() => {
		if (!attachToServerRun || isRegenerating || isConfirming) {
			return;
		}
		// Only a run that still reports: one silent for longer than the
		// editor polls is not followed again once the editor has given up
		// on it, or the document could never be saved (Fizzy #2946).
		if (!isRunStillWriting) {
			return;
		}
		const savedBody = document?.content;
		if (!savedBody) {
			return;
		}
		attachedRunRef.current = true;
		regenerationBaselineRef.current = savedBody;
		isDirectRegenerationRef.current = true;
		regenerationTriggeredRef.current = true;
		regenerationAckAtRef.current = documentDataUpdatedAt;
		setIsRegenerating(true);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [
		attachToServerRun,
		isRunStillWriting,
		document?.content,
		documentDataUpdatedAt,
		isRegenerating,
		isConfirming,
	]);

	// The end of an attached run (Fizzy #2801).
	//
	// - While the server still reports the run queued or generating, nothing
	//   is taken: the final save writes the body and COMPLETE together, so a
	//   body that changes before then is a colleague's save, not the result.
	// - FAILED belongs to the FAILED watcher above, which needs the ack this
	//   effect would otherwise clear.
	// - Any other status with a new body: the editor adopts it as it adopts
	//   a restored version — its content, its version for the slot guard,
	//   and its saved baseline. Under collaboration one open editor writes
	//   it into the shared document (see `appliesAttachedRunBody`) and the
	//   others receive it through the room; two writing at once would leave
	//   the body in it twice.
	// - Without a new body the run is over all the same, and the editor
	//   stops regenerating.
	// - A run the server still lists as generating that has not written for
	//   longer than the editor polls is no longer followed (Fizzy #2946):
	//   the editor stops regenerating, so its saves are no longer refused —
	//   a save then ends that run, and a person who asked is told so. The
	//   attach effect follows it again if it writes again.
	// - Nothing is taken, and the run not ended, until an editor is on
	//   screen (Fizzy #2946): a sync-loss remount mounts the editor a
	//   render after this effect first runs, and a body applied to no editor
	//   would be lost while the run counted as over.
	//
	// The body is applied synchronously, so its room update leaves before
	// the cleared awareness role that lets another editor take over.
	useEffect(() => {
		if (!isRegenerating || !attachedRunRef.current) {
			return;
		}
		const status = document?.status;
		if (status === "QUEUED" || status === "GENERATING") {
			if (!isRunStillWriting) {
				attachedRunRef.current = false;
				isDirectRegenerationRef.current = false;
				regenerationTriggeredRef.current = false;
				regenerationBaselineRef.current = null;
				regenerationAckAtRef.current = null;
				setIsRegenerating(false);
			}
			return;
		}
		if (status === "FAILED") {
			return;
		}
		if (!editor || editor.isDestroyed) {
			return;
		}
		const baseline = regenerationBaselineRef.current;
		const polledContent = document?.content;
		const hasNewContent =
			polledContent != null &&
			polledContent.length > 0 &&
			polledContent !== (baseline || "");
		if (hasNewContent) {
			const awareness = enableCollaboration ? provider?.awareness : null;
			// With its stamp, unless the room holds it, or a later body,
			// already (Fizzy #2946). A review another editor holds of an
			// earlier run does not stand in for this run's body.
			if (
				appliesAttachedRunBody(
					awareness,
					runIdentity(document?.generationStartedAt),
				) &&
				!roomHoldsSavedBody(savedStamp)
			) {
				applyServerBody(
					editor,
					fromMarkdown(polledContent),
					savedStamp,
				);
				baselineRef.current = polledContent;
				updateSavedBaseline(polledContent);
				setHasUnsavedChanges(false);
			}
			editorBodyVersionRef.current =
				document?.version ?? editorBodyVersionRef.current;
			editorBodyHashRef.current = document?.contentHash ?? undefined;
			setCurrentDocument(polledContent);
		}
		attachedRunRef.current = false;
		isDirectRegenerationRef.current = false;
		regenerationTriggeredRef.current = false;
		regenerationBaselineRef.current = null;
		regenerationAckAtRef.current = null;
		setIsRegenerating(false);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [
		document?.status,
		document?.content,
		isRegenerating,
		isRunStillWriting,
		editor,
	]);

	// The run role this editor holds in a collaborative room is published by
	// `CollaborativeDocumentEditor`, which a sync loss does not unmount.

	// === STREAMING PATTERN - REF-BASED TO FIX RACE CONDITIONS ===
	// The key insight: React state updates are async, but we need the baseline
	// IMMEDIATELY when streaming starts. Using refs ensures synchronous access.

	// Effect 1: Capture baseline when loading STARTS (transition from false to true)
	// Uses ref to detect the transition and capture baseline synchronously
	useEffect(() => {
		// Do not advance the loading-edge ref until the editor exists.
		// `useEditor` runs with `immediatelyRender: false`, so `editor` is
		// null on the first commit, while `isLoading` tracks the assistant's
		// connect handshake rather than a user request and can already be
		// true. Serializing a null editor returns null, which the branch
		// below would report as a failed AI review; consuming the transition
		// would also lose the baseline for the run that follows. `editor` is
		// a dependency, so this re-runs once the instance exists.
		if (!editor) {
			return;
		}
		// Only capture baseline on transition: wasLoading=false → isLoading=true
		if (isLoading && !wasLoadingRef.current && !isRegenerating) {
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
				setCurrentDocument(baseline); // Keep state in sync for other uses
			} else {
				toast.error(
					"Couldn't read the document content to start this AI review — please retry.",
				);
			}
		}
		wasLoadingRef.current = isLoading;
		editor.setEditable(
			!isLoading &&
				!isRegenerating &&
				!roomFreezesEditor &&
				!rejectPending,
		);
	}, [isLoading, isRegenerating, editor, roomFreezesEditor, rejectPending]);

	// Effect 2: Final diff when nodeName becomes "end"
	// Uses baselineRef instead of currentDocument state to avoid stale closure
	useEffect(() => {
		if (nodeName === "end" && !isRegenerating) {
			const baseline = baselineRef.current;
			const newDocument = agentState?.document || "";

			// Only show diff if we have BOTH baseline AND new content
			if (
				baseline.trim().length > 0 &&
				newDocument.trim().length > 0 &&
				toAgentDocument(baseline) !== newDocument
			) {
				// TipTap's setContent calls flushSync internally; deferring to a
				// microtask moves it out of the useEffect's render phase, where
				// React would otherwise throw "flushSync was called from inside
				// a lifecycle method".
				queueMicrotask(() => {
					isDiffReviewEditRef.current = true;
					// Slots from the baseline, as in Effect 3: the editor
					// still holds the last streamed frame.
					applyProgrammaticContent(editor, newDocument, "assistant", {
						slotSource: baseline,
						render: (preserved) =>
							fromMarkdown(
								diffKeepingVisualSlotsWhole(
									baseline,
									preserved,
									true,
								),
							),
					});
					isDiffReviewEditRef.current = false;
				});
			}

			// Focus on the changed section using focusAnchor from agent state
			const anchor = agentState?.focusAnchor;
			if (anchor && anchor.trim().length > 0) {
				setTimeout(() => {
					focusOnAnchor(editor, anchor);
				}, 100);
			}
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [nodeName, isRegenerating, agentState?.document]);

	// Effect 3: Streaming diff updates
	// CRITICAL: Uses baselineRef.current instead of currentDocument state
	// This fixes the race condition where state hasn't updated yet
	//
	// Every frame takes its visual slots from the baseline, not the editor.
	// The editor holds the previous partial frame, where a slot whose section
	// has not streamed yet sits orphaned at the partial's end; lifted from
	// there, it would be re-anchored under an earlier section, and copied
	// again from the baseline tail the partial diff appends. The editor is
	// read-only while the run streams (Effect 1), so the baseline holds every
	// slot the person placed; a collaborator's mid-run change is replaced by
	// the next frame, slots included, like the rest of the editor.
	useEffect(() => {
		if (isLoading && !isRegenerating) {
			const baseline = baselineRef.current;
			const newDocument = agentState?.document || "";

			// Skip if baseline is empty (shouldn't happen, but safety check)
			if (baseline.trim().length === 0) {
				// No baseline - just show the new content without diff
				if (newDocument.trim().length > 0) {
					applyProgrammaticContent(editor, newDocument, "assistant", {
						slotSource: baseline,
					});
				}
				return;
			}

			// Skip if new document is empty or same as baseline
			if (
				newDocument.trim().length === 0 ||
				newDocument === toAgentDocument(baseline)
			) {
				return;
			}

			applyProgrammaticContent(editor, newDocument, "assistant", {
				slotSource: baseline,
				render: (preserved) =>
					fromMarkdown(
						diffKeepingVisualSlotsWhole(baseline, preserved),
					),
			});
			// Follow the last diff element during streaming
			focusOnLastDiff(editor);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [agentState?.document, isRegenerating, isLoading]);

	// Effect 4: Sync editor to state when not loading
	// Also updates baselineRef so it's ready for the next streaming session
	const editorDocRef = editor?.state?.doc;
	useEffect(() => {
		// Do NOT write the editor's (still-baseline) markdown back into agent
		// state while a confirm is arming or pending. At end-of-run all events
		// land in one commit with `isLoading` already false, so this effect
		// would otherwise clobber the freshly-delivered proposed document with
		// the stale baseline — the write-back half of the RC2 race. The confirm
		// handler owns delivery of the proposed content in that window.
		if (
			!isLoading &&
			!isRegenerating &&
			editor &&
			!hasPendingConfirm &&
			!confirmArmedRef.current
		) {
			const editorMarkdown = getEditorMarkdownForSave(editor);
			// Null means serialization failed on this edit — skip
			// the sync rather than overwriting currentDocument/baselineRef with
			// "". Those values feed straight into save (handleSave/rawContent)
			// and AI diffing, so silently corrupting them to empty would just
			// relocate the original data-loss bug one hop over.
			if (editorMarkdown !== null) {
				setCurrentDocument(editorMarkdown);
				baselineRef.current = editorMarkdown; // Keep ref in sync
				// IMPORTANT: Use functional update to preserve ragContexts and projectContext
				setAgentState((prev) => ({
					...prev,
					document: editorMarkdown,
				}));
			}
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [editorDocRef, isLoading, isRegenerating, hasPendingConfirm]);

	// Sync raw content when currentContent changes (from editor updates)
	useEffect(() => {
		if (viewMode === "rich" && editor) {
			const markdown = getEditorMarkdownForSave(editor);
			// Null means serialization failed — skip the sync
			// rather than corrupting the raw-mode mirror (which handleSave
			// writes directly to the DB) to "".
			if (markdown !== null) {
				setRawContent(markdown);
			}
		}
	}, [editor?.state?.doc, viewMode, editor]);

	// The raw view shows the editor's body. Someone reading or placing the
	// caret in it keeps the caret where it was in the text, which a new value
	// would move to the end.
	const showInRawView = (markdown: string) => {
		const area = rawTextareaRef.current;
		if (
			area &&
			area.ownerDocument.activeElement === area &&
			area.value === rawContentRef.current &&
			rawContentRef.current !== markdown
		) {
			rawSelectionRef.current = {
				start: followTextOffset(
					area.value,
					markdown,
					area.selectionStart,
				),
				end: followTextOffset(area.value, markdown, area.selectionEnd),
			};
		}
		setRawContent(markdown);
	};
	const showInRawViewRef = useRef(showInRawView);
	showInRawViewRef.current = showInRawView;

	// The raw view follows the editor's body while it holds no edits of its
	// own (Fizzy #2946). Nothing types into the editor while the raw view is
	// open: what reaches it comes from outside — a colleague's typing, a
	// run's body put into the room by this editor or another — and the raw
	// text, read from the editor only on the way in, kept the body from
	// before, which an edit there then wrote back over the run's. Edits of
	// its own stay as they are. Read at once after a quiet spell — with the
	// change, so whatever made it, a run's end included, renders together
	// with the body it brought; while changes keep coming, once per
	// `RAW_VIEW_FOLLOW_MS`.
	useEffect(() => {
		if (!editor) {
			return;
		}
		let timer: ReturnType<typeof setTimeout> | null = null;
		let readAt = Number.NEGATIVE_INFINITY;
		const follows = () =>
			viewModeRef.current === "raw" && !rawEditedRef.current;
		const read = () => {
			timer = null;
			if (editor.isDestroyed || !follows()) {
				return;
			}
			readAt = Date.now();
			const markdown = getEditorMarkdownForSave(editor);
			if (markdown === null) {
				return;
			}
			showInRawViewRef.current(markdown);
		};
		const onTransaction = ({
			transaction,
		}: {
			transaction: { docChanged: boolean };
		}) => {
			if (!transaction.docChanged) {
				return;
			}
			editorBodyRevisionRef.current += 1;
			if (viewModeRef.current !== "raw") {
				return;
			}
			// Nothing types into the editor while the raw view is open, so
			// edits of its own now sit on an older body.
			if (rawEditedRef.current) {
				noteRawEditsStaleRef.current();
				return;
			}
			if (timer) {
				return;
			}
			const wait = readAt + RAW_VIEW_FOLLOW_MS - Date.now();
			if (wait > 0) {
				timer = setTimeout(read, wait);
			} else {
				read();
			}
		};
		editor.on("transaction", onTransaction);
		return () => {
			editor.off("transaction", onTransaction);
			if (timer) {
				clearTimeout(timer);
			}
		};
	}, [editor]);
	useLayoutEffect(() => {
		const selection = rawSelectionRef.current;
		const area = rawTextareaRef.current;
		rawSelectionRef.current = null;
		if (selection && area) {
			area.setSelectionRange(selection.start, selection.end);
		}
	}, [rawContent]);

	// Handle switching between raw and rich view
	const handleViewModeToggle = () => {
		// Not while a Reject is unanswered, nor while the raw view is held
		// (see `rawViewHeld`): switching back writes the raw edits into the
		// editor that a run, a proposal under review or the room is writing,
		// where an Accept would save them (Fizzy #2946).
		if (rejectPendingRef.current || rawViewHeldRef.current) {
			return;
		}
		if (viewMode === "raw") {
			// Nothing edited in the raw view: the rich editor still holds the
			// body, with whatever colleagues typed into the room meanwhile,
			// which writing the raw text back would take from them
			// (Fizzy #2946).
			if (!rawEditedRef.current) {
				setViewMode("rich");
				return;
			}
			rawEditedRef.current = false;
			// Edits made on a body the editor has since moved past stay out
			// of it: written back, the older body they were made on would
			// replace the newer one. They leave with the raw view, offered
			// back to copy — over the toast that kept them, if there was one
			// (Fizzy #2946).
			if (rawEditsStaleRef.current) {
				rawEditsStaleRef.current = false;
				const offer = rawOfferRef.current;
				if (offer?.text !== rawContent || offer?.kept) {
					offerBackReplacedText(
						rawContent,
						offer?.kept ? { id: rawOfferToastId } : {},
					);
				}
				const ed = liveEditorOrNull(editorRef.current);
				const markdown = ed ? getEditorMarkdownForSave(ed) : null;
				if (markdown !== null) {
					setRawContent(markdown);
				}
				setViewMode("rich");
				scheduleDirtyCheck();
				return;
			}
			// Switching from raw to rich - update editor with raw content
			const normalized = repairMarkdownDocument(rawContent);
			// What was edited in the raw view was counted as this person's
			// typing as it was typed (see `handleRawContentChange`); a round
			// trip with no edit is none (Fizzy #2946).
			setRawContent(normalized);
			setCurrentDocument(normalized);
			if (editor) {
				// The person's own edit: a slot they deleted in raw mode stays
				// deleted.
				applyProgrammaticContent(
					editor,
					fromMarkdown(normalized),
					"server",
				);
			}
			setViewMode("rich");
		} else {
			// Switching from rich to raw: what the editor holds now, which a
			// colleague's typing in the room may have changed without a
			// render that would have synced it (Fizzy #2946).
			const ed = liveEditorOrNull(editorRef.current);
			const markdown = ed ? getEditorMarkdownForSave(ed) : null;
			if (markdown !== null) {
				setRawContent(markdown);
			}
			rawEditedRef.current = false;
			setViewMode("raw");
		}
	};

	// @fabric mention support for raw markdown editor
	const { handleInputChange: handleRawEditorFabricMention } =
		useFabricMention({
			projectId,
			projectName: project?.name,
			onMentionTrigger: () => {
				toast.info("Opening Fabric Agent...");
			},
		});

	// Code context launcher for "Ask About This" functionality
	const { openWithSelectedCode, getSelectedText, isLikelyCode } =
		useCodeContextLauncher({
			projectId,
			projectName: project?.name,
			repositoryUrl: project?.repositoryUrl ?? null,
			repositoryOwner: project?.repositoryOwner ?? null,
			repositoryName: project?.repositoryName ?? null,
			defaultBranch: project?.defaultBranch ?? null,
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

	// Broken images render a readable message instead of the browser's native
	// broken-image icon (Fizzy #2027) — e.g. an image whose storage object is
	// gone. That lives in the ImageLoadFallback extension, as a decoration, so
	// the message can never reach the saved document.

	// Uploaded images are stored with the URL signed at upload time, which
	// expires after an hour. Re-sign them on load AND whenever an image is
	// re-rendered from the document (resize, caption, remount), which brings
	// that expired URL back (Fizzy #2800).
	useEffect(() => {
		if (!editor) {
			return;
		}
		const ownKeys = `document-media/${projectId}/${documentId}/`;
		const refresher = createSignedMediaUrlRefresher({
			editor,
			keyFromImageSrc: (src) =>
				keyWithinPrefix(extractDocumentS3KeyFromImgSrc(src), ownKeys),
			keyFromStoredKey: (key) => keyWithinPrefix(key, ownKeys),
			resolve: async (s3Keys) => {
				const { urls } =
					await orpcClient.projects.documents.resolveMediaUrls({
						projectId,
						documentId,
						organizationId,
						s3Keys,
					});
				return urls;
			},
			onError: (e) =>
				console.error("[DocumentEditor] Failed to resolve S3 URLs:", e),
		});
		mediaUrlRefresherRef.current = refresher;
		return () => {
			refresher.destroy();
			mediaUrlRefresherRef.current = null;
		};
	}, [editor, projectId, documentId, organizationId]);

	// Handle image upload from toolbar or drag-drop
	const handleImageUpload = async (files: FileList) => {
		if (!editor) {
			return;
		}

		for (let i = 0; i < files.length; i++) {
			const file = files[i];
			if (!file) {
				continue;
			}

			const uploadId = `upload_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

			// Insert upload placeholder
			editor.commands.insertImageUpload({
				uploadId,
				filename: file.name,
				progress: 0,
				error: null,
			});

			try {
				const s3Key = await uploadImage({
					file,
					projectId,
					documentId,
					organizationId,
					onProgress: (percent) => {
						editor.commands.updateImageUpload(uploadId, {
							progress: percent,
						});
					},
				});

				// Resolve the S3 key to a signed URL for display
				const urls =
					await orpcClient.projects.documents.resolveMediaUrls({
						projectId,
						documentId,
						organizationId,
						s3Keys: [s3Key],
					});
				const signedUrl = urls.urls[s3Key];

				// Remove placeholder and insert actual image with all attrs at once.
				// Using insertContent (not setImage + updateAttributes) because
				// setImage moves the cursor past the image, so updateAttributes
				// wouldn't target the newly inserted image.
				editor.commands.removeImageUpload(uploadId);
				if (signedUrl) {
					mediaUrlRefresherRef.current?.remember(s3Key, signedUrl);
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
				toast.error(`Failed to upload ${file.name}: ${message}`);
			}
		}
	};

	// Keep the ref in sync so editorProps handlers can access the latest function
	imageUploadRef.current = handleImageUpload;

	// Register the S3 upload handler for slash commands
	useEffect(() => {
		setSlashCommandImageUploadHandler(handleImageUpload);
		return () => setSlashCommandImageUploadHandler(null);
	}, [editor, projectId, documentId]);

	// Handle raw content changes
	const handleRawContentChange = (value: string) => {
		// Check for @fabric mention
		const result = handleRawEditorFabricMention(value);
		if (result.consumed) {
			// Mention was consumed, don't update content
			return;
		}
		setRawContent(result.value);
		setCurrentDocument(result.value);
		if (rawEditsStaleRef.current) {
			staleRawTextRef.current = result.value;
		}
		// An edit in the raw view is this person's typing, like one in the
		// rich editor (Fizzy #2946): a saved body the room brings in is
		// never adopted over it, and in a room it is what this editor saves.
		rawEditedRef.current = true;
		localEditCountRef.current += 1;
		noteTypedSinceSave();
		typedSinceRejectRef.current = true;
		// Same content-equality model as the rich editor: dirty iff the new
		// raw value differs from what we last persisted. Compare directly
		// without debouncing because we already have the new value here.
		const isDirty =
			result.value.trim() !== lastSavedContentRef.current.trim();
		setHasUnsavedChanges(isDirty);
		if (autoSaveTimeoutRef.current) {
			clearTimeout(autoSaveTimeoutRef.current);
			autoSaveTimeoutRef.current = null;
		}
		// The latest autosave, not this render's: this render's still reads
		// the document as saved, and the first edit was never autosaved
		// (Fizzy #2946).
		if (isDirty) {
			autoSaveTimeoutRef.current = setTimeout(() => {
				triggerAutoSaveRef.current?.();
			}, DOCUMENT_AUTOSAVE_TIMINGS.delayMs);
		}
	};

	// Keyboard shortcut for toggling view mode (Ctrl+Shift+V or Cmd+Shift+V)
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === "V") {
				e.preventDefault();
				handleViewModeToggle();
			}
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [viewMode, rawContent]);

	// Save mutation with optimistic update to avoid flicker between confirm and server write
	// Must carry `organizationId` because the `documents.get` query itself
	// now does. `setQueryData` / `getQueryData` match the key EXACTLY (unlike
	// invalidate/cancel, which match by prefix), so a key missing this field
	// would write the optimistic save into a phantom cache entry and make the
	// error rollback a silent no-op.
	const documentGetQueryKey = orpc.projects.documents.get.queryKey({
		input: { id: documentId, projectId, organizationId },
	});
	// One id for the refusal of this document's save (Fizzy #2946): an
	// error toast stays until it is closed, so a later refusal replaces
	// it rather than stacking, and the next save that lands takes it
	// away. It is the generic refusal's, and a guarded accept's version
	// conflict's: that one tells to reload, but once a save lands the
	// accepted text it kept is saved, so it no longer holds. The refusals
	// that carry a Reload or Copy action — an editor older than the
	// server, the single-user editor's conflict, a save after the page
	// was left — keep toasts of their own.
	const saveFailedToastId = `document-save-failed:${documentId}`;
	const saveMutation = useMutation(
		orpc.projects.documents.update.mutationOptions({
			onMutate: async (variables) => {
				// A save sent past `handleSave` — an accepted proposal, a
				// rejected regeneration — holds back the saves asked for
				// meanwhile too (see `saveInFlightRef`).
				if (!saveInFlightRef.current) {
					saveInFlightRef.current = true;
					inFlightIntentRef.current = {
						manual: isManualSaveRef.current,
						redirect: shouldRedirectAfterSaveRef.current,
					};
				}
				// A save from the room tells the other editors it is in flight,
				// with its base, until its answer has advanced the room's stamp:
				// none of them takes the moment before that answer for a room
				// behind the saved document (Fizzy #2946).
				if (
					roomStampsOn &&
					variables.expectedContentHash !== undefined
				) {
					publishRoomSaveInFlight(provider?.awareness, {
						version: variables.expectedVersion ?? 0,
						contentHash: variables.expectedContentHash,
					});
				}
				savingEditCountRef.current = localEditCountRef.current;
				// The body the document holds once this save lands (Fizzy
				// #2946): leaving with the editor back to another body sends
				// that one after it.
				sendingContentRef.current =
					typeof variables.content === "string"
						? variables.content
						: null;
				// What this save carries, as the editor holds it now: its answer
				// makes that the saved baseline, not typing that came after.
				const sent = {
					editCount: localEditCountRef.current,
					text:
						liveEditorOrNull(editorRef.current)?.state.doc
							.textContent ?? "",
					editorRevision: editorBodyRevisionRef.current,
				};
				// Cancel outgoing refetches so they don't overwrite our optimistic update
				await queryClient.cancelQueries({
					queryKey: documentGetQueryKey,
				});
				// Snapshot previous value
				const previous = queryClient.getQueryData(documentGetQueryKey);
				// Optimistically update cache
				queryClient.setQueryData(documentGetQueryKey, (old: any) => {
					if (!old?.document) {
						return old;
					}
					return {
						...old,
						document: {
							...old.document,
							content: variables.content,
						},
					};
				});
				return { previous, sent };
			},
			onError: (error, variables, context) => {
				// Rollback cache
				if (context?.previous) {
					queryClient.setQueryData(
						documentGetQueryKey,
						context.previous,
					);
				}
				// A save sent past `handleSave` says it was refused once the
				// branch below is done, and where its text is now — unless it
				// is sent once more, whose answer then says it (Fizzy #2946).
				const onFailed = directSaveOnFailedRef.current;
				directSaveOnFailedRef.current = null;
				let sentAgain = false;
				let failure: DirectSaveFailure = "keptInEditor";
				if (pageLeft()) {
					// The page was left: no editor holds the text any more, so
					// nothing is retried, and the text is offered to copy.
					// A save the page was left with that waited for this one
					// does not go after a failure: its text is the one offered.
					failure = "offeredToCopy";
					conflictRetriesRef.current = 0;
					notifyLeaveSaveFailed(
						leaveContentRef.current ?? variables.content ?? "",
					);
				} else if (isSaveBaseRequiredRefusal(error)) {
					// The server wants every save to name its base and this one
					// did not: this editor is older than the server (Fizzy
					// #2946). Nothing was written; the text stays in the editor.
					setHasUnsavedChanges(true);
					toast.error(tRoom("baseRequired"), {
						duration: Number.POSITIVE_INFINITY,
						action: {
							label: tRoom("reload"),
							onClick: () => window.location.reload(),
						},
					});
				} else if (
					getOrpcCode(error) === "CONFLICT" &&
					getOrpcErrorData(error).code ===
						DOCUMENT_GENERATION_IN_PROGRESS
				) {
					// A generation run holds the document (Fizzy #2946): it
					// queued after the editor last read the document, or the
					// save was one the server refuses under a run. Nothing was
					// written, and the base did not move, so this is no
					// version conflict: the room is not brought back and the
					// single-user editor does not stop saving. The text stays
					// unsaved in the editor; the refetch brings the run, whose
					// state holds saves back until it finishes.
					conflictRetriesRef.current = 0;
					setHasUnsavedChanges(true);
					toast.info(tRun("saveBlocked.runLive"));
					void queryClient.invalidateQueries({
						queryKey: documentGetQueryKey,
					});
				} else if (
					variables.expectedContentHash !== undefined &&
					getOrpcCode(error) === "CONFLICT"
				) {
					// The save named its base and the document no longer holds
					// that body: a newer save or a server write landed first,
					// and nothing was written (Fizzy #2946). Never retried
					// without the base.
					setHasUnsavedChanges(true);
					const sentBase: RoomStamp = {
						version: variables.expectedVersion ?? 0,
						contentHash: variables.expectedContentHash,
					};
					const roomStamp =
						roomStampsOn && ydoc ? readRoomStamp(ydoc) : null;
					if (
						roomStamp &&
						!sameRoomStamp(roomStamp, sentBase) &&
						variables.skipVersionBump !== true &&
						conflictRetriesRef.current < 1
					) {
						// The room's stamp moved meanwhile: another editor saved
						// this room. Once more, from the room as it is now —
						// which also covers a save asked for meanwhile.
						conflictRetriesRef.current += 1;
						const held = saveAgainRef.current;
						saveAgainRef.current = null;
						const intent = {
							manual: isManualSaveRef.current || !!held?.manual,
							confirm: isConfirmSaveRef.current,
							redirect:
								shouldRedirectAfterSaveRef.current ||
								!!held?.redirect,
						};
						// What a save sent past `handleSave` says of its
						// answer goes with it to the save sent again: an
						// accepted proposal is reported as that answer, not
						// as this refusal (Fizzy #2946). Held out of this
						// save's `onSettled`, which runs first.
						sentAgain = true;
						const report = {
							onSaved: directSaveOnSavedRef.current,
							onFailed,
							onSettled: directSaveOnSettledRef.current,
							accepts: inFlightAcceptsRef.current,
						};
						directSaveOnSavedRef.current = null;
						directSaveOnSettledRef.current = null;
						setTimeout(() => {
							isManualSaveRef.current = intent.manual;
							isConfirmSaveRef.current = intent.confirm;
							shouldRedirectAfterSaveRef.current =
								intent.redirect;
							// Never handed to the answer of another save in
							// flight by then.
							const idle = !saveInFlightRef.current;
							if (idle) {
								directSaveOnSavedRef.current = report.onSaved;
								directSaveOnFailedRef.current = report.onFailed;
								directSaveOnSettledRef.current =
									report.onSettled;
							}
							handleSaveRef.current();
							if (idle && saveInFlightRef.current) {
								inFlightAcceptsRef.current = report.accepts;
							}
							if (!idle || !saveInFlightRef.current) {
								// It did not go as a save of its own: what it
								// would have saved stays unsaved in the editor.
								if (idle) {
									directSaveOnSavedRef.current = null;
									directSaveOnFailedRef.current = null;
									directSaveOnSettledRef.current = null;
								}
								report.onSettled?.();
							}
						}, 0);
					} else if (roomStampsOn) {
						// The room is behind the saved document: it is brought
						// back to it, and what was typed since the last save is
						// offered back.
						failure = "offeredToCopy";
						conflictRetriesRef.current = 0;
						roomConvergenceState.noteConflict();
						if (
							isManualSaveRef.current ||
							isConfirmSaveRef.current
						) {
							toast.info(tRoom("saveConflictRoom"));
						}
					} else {
						// The single-user editor keeps the text, stops saving, and
						// offers it with a reload; the saved document is fetched
						// for the badge and history.
						conflictRetriesRef.current = 0;
						setSoloBaseStale(true);
						const kept =
							viewMode === "raw"
								? rawContent
								: getEditorMarkdownForSave(editorRef.current);
						toast.error(tRoom("saveConflictSolo"), {
							duration: Number.POSITIVE_INFINITY,
							...(kept
								? {
										action: {
											label: tRoom("offerBack.copy"),
											onClick: () => {
												void navigator.clipboard
													?.writeText(kept)
													.catch(() => undefined);
											},
										},
									}
								: {}),
							cancel: {
								label: tRoom("reload"),
								onClick: () => window.location.reload(),
							},
						});
						void queryClient.invalidateQueries({
							queryKey: documentGetQueryKey,
						});
					}
				} else if (
					variables.expectedVersion !== undefined &&
					getOrpcCode(error) === "CONFLICT"
				) {
					// A guarded accept lost the race: the document was saved
					// elsewhere since the editor last synced, and nothing was
					// written. The proposal stays in the editor and reads as
					// unsaved. No autosave is scheduled — an unguarded one would
					// overwrite the newer version the guard just protected. The
					// refetch brings that version to the badge and the history;
					// the editor's content is left alone.
					toast.error(ACCEPT_VERSION_CONFLICT_MESSAGE, {
						id: saveFailedToastId,
					});
					setHasUnsavedChanges(true);
					void queryClient.invalidateQueries({
						queryKey: documentGetQueryKey,
					});
					void queryClient.invalidateQueries({
						queryKey:
							orpc.projects.documents.versions.list.queryKey({
								input: {
									projectId,
									documentId,
									organizationId,
								},
							}),
					});
				} else {
					// Any other refusal, in the reader's words, never the
					// server's (Fizzy #2946). Nothing was written, so typing
					// here stays unsaved; an editor in a room with none, such
					// as a rejected regeneration's fallback save, still holds
					// the saved body.
					if (!passiveInRoom()) {
						setHasUnsavedChanges(true);
					}
					toast.error(
						describeDocumentWriteRefusal(error, tWriteRefusal)
							.message,
						{ id: saveFailedToastId },
					);
				}
				if (failure === "keptInEditor" && editorClosed()) {
					failure = "editorClosed";
				}
				if (!sentAgain) {
					onFailed?.(failure);
				}
				setIsSaving(false);
			},
			onSuccess: (data, variables, context) => {
				// A refusal said earlier is taken away once a save lands
				// (Fizzy #2946): saving works again, and the Save button says
				// whether anything is still unsaved.
				toast.dismiss(saveFailedToastId);
				// An explicit Save asks the server to complete a draft (see
				// `buildDocumentSaveInput`). Say so when this save did: the
				// editor shows no status of its own, so the toast is the only
				// sign. The server's own answer is used, not a comparison
				// with the cached status, which may be older than the row.
				const completedDraft = data?.draftCompleted === true;
				if (isManualSaveRef.current) {
					toast.success(
						completedDraft
							? "Document saved and marked as complete"
							: "Document saved successfully",
					);
				} else if (isConfirmSaveRef.current) {
					// Confirm-initiated saves must never be silent (I3/AC3/AC5):
					// a version-bearing success, an informational no-op, or the
					// error toast in onError — exactly one, always.
					if (data?.contentUnchanged) {
						toast.info(
							"No changes were applied — the document already matches the saved version.",
						);
					} else {
						const version = data?.document?.version;
						toast.success(
							version != null
								? `Changes applied — saved as v${version}`
								: "Changes applied.",
						);
					}
				}
				// A save sent past `handleSave` that reports its own landing:
				// a rejected regeneration's revert (Fizzy #2946).
				const onSaved = directSaveOnSavedRef.current;
				directSaveOnSavedRef.current = null;
				const roomKeepsStamp =
					onSaved?.(
						typeof data?.document?.version === "number" &&
							typeof data.document.contentHash === "string" &&
							data.document.contentHash
							? {
									version: data.document.version,
									contentHash: data.document.contentHash,
								}
							: null,
					) === false;
				// The body just saved is the one the editor holds (plus any
				// typing since, which is local).
				if (data?.document?.version != null) {
					editorBodyVersionRef.current = data.document.version;
				}
				// Its identity, which the next save names as its base; and the
				// room's stamp moves to it — unless the room moved past this
				// save's base meanwhile (Fizzy #2946).
				const savedHash = data?.document?.contentHash;
				if (
					roomConvergence &&
					data?.document?.version != null &&
					typeof savedHash === "string" &&
					savedHash
				) {
					editorBodyHashRef.current = savedHash;
					if (
						roomStampsOn &&
						ydoc &&
						!roomKeepsStamp &&
						variables.expectedContentHash !== undefined &&
						sameRoomStamp(readRoomStamp(ydoc), {
							version: variables.expectedVersion ?? 0,
							contentHash: variables.expectedContentHash,
						})
					) {
						writeRoomStamp(ydoc, {
							version: data.document.version,
							contentHash: savedHash,
						});
					}
				}
				conflictRetriesRef.current = 0;
				const sentEditCount =
					context?.sent.editCount ?? savingEditCountRef.current;
				savedEditCountRef.current = Math.max(
					savedEditCountRef.current,
					sentEditCount,
				);
				noteTypedSinceSave();
				// Update the persisted-content baseline, then re-derive the
				// dirty flag from it. Typed here while this save was in
				// flight, the baseline is what the save carried, not the live
				// editor: the newer typing stays dirty, its autosave is
				// scheduled, and leaving the page still sends it.
				const typedSinceSent =
					context !== undefined &&
					localEditCountRef.current > sentEditCount;
				// A save of the raw view's edits, with nothing typed there
				// since: the editor — and the room — take the body saved, and
				// the raw view follows the editor again (Fizzy #2946). Left
				// in the raw view alone, the edits kept the raw view from
				// following: a proposal accepted later was saved, and the
				// raw text, compared with it, was autosaved back over it.
				const savedStamp =
					typeof data?.document?.version === "number" &&
					typeof savedHash === "string" &&
					savedHash
						? {
								version: data.document.version,
								contentHash: savedHash,
							}
						: null;
				// Only over the body the editor held when the save was sent: a
				// run, a review or the room that changed it meanwhile wrote a
				// newer one, which a late answer must not take back — the raw
				// edits then stay as they are, offered and not autosaved.
				const liveEditor = liveEditorOrNull(editorRef.current);
				const rawSaveLanded =
					!!liveEditor &&
					!typedSinceSent &&
					rawEditPending() &&
					typeof variables.content === "string" &&
					variables.content === rawContentRef.current;
				const roomNamesSave =
					!roomStampsOn ||
					(!!ydoc &&
						!!savedStamp &&
						sameRoomStamp(readRoomStamp(ydoc), savedStamp));
				if (
					liveEditor &&
					rawSaveLanded &&
					roomNamesSave &&
					context?.sent.editorRevision ===
						editorBodyRevisionRef.current
				) {
					rawEditedRef.current = false;
					rawEditsStaleRef.current = false;
					applyServerBody(
						liveEditor,
						fromMarkdown(repairMarkdownDocument(variables.content)),
						roomStampsOn ? savedStamp : null,
					);
				} else if (
					liveEditor &&
					rawSaveLanded &&
					roomStampsOn &&
					roomNamesSave
				) {
					// The editor moved because the saved body itself reached it
					// first — a colleague's editor brought the room to it — so
					// the editor, the room and the document all hold the raw
					// text: nothing is stale, and the raw view follows again.
					const held = getEditorMarkdownForSave(liveEditor);
					if (
						held !== null &&
						normalizeForComparison(held) ===
							normalizeForComparison(
								repairMarkdownDocument(variables.content ?? ""),
							)
					) {
						rawEditedRef.current = false;
						if (rawEditsStaleRef.current) {
							rawEditsStaleRef.current = false;
							toast.dismiss(rawOfferToastId);
						}
						showInRawView(held);
					}
				}
				updateSavedBaseline(
					variables.content || "",
					typedSinceSent ? context.sent.text : undefined,
				);
				recomputeDirtyState();
				// Ensure cache reflects saved content and version without triggering refetch flicker
				queryClient.setQueryData(documentGetQueryKey, (old: any) => {
					if (!old?.document) {
						return old;
					}
					// A later write the document already shows — a run's,
					// another editor's — is not taken back by a late answer
					// (Fizzy #2946).
					if (
						typeof old.document.version === "number" &&
						typeof data?.document?.version === "number" &&
						old.document.version > data.document.version
					) {
						return old;
					}
					return {
						...old,
						document: {
							...old.document,
							content: variables.content,
							...(data?.document?.version != null
								? { version: data.document.version }
								: {}),
							// The identity of the body now saved, beside its
							// version: the room's stamp is compared with both.
							...(roomConvergence &&
							typeof data?.document?.contentHash === "string"
								? { contentHash: data.document.contentHash }
								: {}),
							// The document is complete — by this save or by
							// someone else before it. The Save button reads
							// the status to know there is nothing left to
							// finish. Only COMPLETE is taken from the response:
							// any other status comes with timestamps this
							// cache entry would not have.
							...(data?.document?.status === "COMPLETE"
								? { status: "COMPLETE" }
								: {}),
						},
					};
				});
				// Invalidate version history so new version appears in the list
				queryClient.invalidateQueries({
					queryKey: orpc.projects.documents.versions.list.queryKey({
						input: {
							projectId,
							documentId,
							organizationId,
						},
					}),
				});
				// An explicit Save may have completed a draft. The Documents
				// tab would otherwise keep showing "Draft" from its cache
				// until that goes stale on its own.
				if (variables.completeDraft) {
					queryClient.invalidateQueries({
						queryKey: orpc.projects.documents.list.queryKey({
							input: { projectId, organizationId },
						}),
					});
				}
				// Only redirect when the user explicitly chose "Save & Close".
				// "Save" (primary), auto-save, and confirm/reject saves all keep
				// the user on the document.
				if (shouldRedirectAfterSaveRef.current) {
					const orgSlug = params?.organizationSlug as
						| string
						| undefined;
					const projectUrl = orgSlug
						? `/app/${orgSlug}/projects/${projectId}`
						: `/app/projects/${projectId}`;
					router.push(projectUrl);
				}
			},
			onSettled: (_data, error) => {
				setIsSaving(false);
				// After the answer advanced the room's stamp, if it did.
				if (roomStampsOn) {
					publishRoomSaveInFlight(provider?.awareness, null);
				}
				// Reset the intent refs whether the save succeeded or failed so a
				// later auto-save (or unrelated save) doesn't inherit stale
				// "manual" / "confirm" / "redirect" intent from a previous click.
				isManualSaveRef.current = false;
				isConfirmSaveRef.current = false;
				shouldRedirectAfterSaveRef.current = false;
				// A failed save says nothing of its own landing (a successful
				// one has already said it), and a landed one nothing of a
				// refusal.
				directSaveOnSavedRef.current = null;
				directSaveOnFailedRef.current = null;
				inFlightAcceptsRef.current = [];
				// The save asked for meanwhile goes now, from the base this
				// answer produced. After a failure it does not: the failure
				// was said, and the text stays unsaved in the editor.
				// An accepted proposal or a revert asked for meanwhile goes
				// first; the save asked for meanwhile then waits for its
				// answer. After a failure neither goes: the text they would
				// have saved stays unsaved in the editor.
				const settled = directSaveOnSettledRef.current;
				directSaveOnSettledRef.current = null;
				settled?.();
				const direct = pendingDirectSaveRef.current;
				pendingDirectSaveRef.current = null;
				const directSettled = pendingDirectOnSettledRef.current;
				pendingDirectOnSettledRef.current = null;
				pendingAcceptsRef.current = [];
				if (direct && !error) {
					setTimeout(direct, 0);
					return;
				}
				directSettled?.();
				saveInFlightRef.current = false;
				const again = saveAgainRef.current;
				saveAgainRef.current = null;
				if (again && !error && !pageLeft()) {
					setTimeout(() => {
						isManualSaveRef.current = again.manual;
						shouldRedirectAfterSaveRef.current = again.redirect;
						handleSaveRef.current();
					}, 0);
				}
			},
		}),
	);

	// Update using context — reviews meeting transcripts + Teams/Slack chatter
	// since the doc was created and proposes in-editor diff edits.
	const contextUpdate = useUpdateDocumentWithContext({
		projectId,
		documentId,
		// Its confirm names the base the editor's saves name (Fizzy #2946);
		// the ref is read when the confirm runs.
		resolveBase: () => resolveSaveBaseRef.current(),
		organizationId: organizationId ?? null,
		editor,
		getEditorMarkdownForSave,
		fromMarkdown,
		// Its review diff is rendered into this editor too, so a slot the
		// proposal re-anchors must not be split by the word diff.
		diffPartialText: diffKeepingVisualSlotsWhole,
		onSaved: (savedVersion) => {
			// The hook puts the confirmed body in the editor.
			editorBodyVersionRef.current = savedVersion;
			editorBodyHashRef.current = undefined;
			void adoptServerBase({ body: null, version: savedVersion });
			queryClient.invalidateQueries({ queryKey: documentGetQueryKey });
			queryClient.invalidateQueries({
				queryKey: orpc.projects.documents.versions.list.queryKey({
					input: { projectId, documentId, organizationId },
				}),
			});
		},
	});
	// Keep the ref in sync so the onUpdate + triggerAutoSave guards can read it.
	isContextUpdateActiveRef.current = contextUpdate.isActive;

	// Diff review-mode toggle (inline / side-by-side / full preview). Pure view
	// state — switching never mutates the editor doc or the pending diff. One
	// shared preference across both review flows (and the Feature editor).
	const isDiffReviewActive = hasPendingConfirm || contextUpdate.showingDiff;
	const {
		diffViewMode,
		setDiffViewMode,
		diffViews,
		effectiveDiffViewMode,
		showDiffPreviewPanes,
	} = useDiffPreview(editor, isDiffReviewActive);

	// The raw view takes no input while the rich editor takes none, nor while
	// a run holds the document, a proposal — a run's, the assistant's, an
	// update using context — is under review, or a Reject is unanswered
	// (Fizzy #2946): the raw view follows the editor, which then holds the
	// proposal, and an edit made there would save it unanswered, or be
	// written back over the run's body.
	const rawViewHeld =
		isLoading ||
		isRegenerating ||
		isRunStillWriting ||
		showConfirmDialog ||
		isConfirming ||
		hasPendingConfirm ||
		contextUpdate.isActive ||
		rejectPending ||
		roomFreezesEditor;
	// The view switch waits too, but never for a client that may not edit:
	// it has no edits to write back, and reads the markdown as it likes.
	const viewSwitchHeld = rawViewHeld && canEdit !== false;
	rawViewHeldRef.current = viewSwitchHeld;
	const viewSwitchHeldId = useId();

	// The editor is read-only while any assistant run is under way (Effect
	// 1), also the short one that answers an Accept, which shows no
	// "Generating" pill. Said beside Save, unless something else already
	// says why: that pill, a regeneration or its review, a proposal under
	// review, a generation run, the room's own state (Fizzy #2946). Shown
	// once it has held for a moment, hidden as soon as it ends.
	// Only for the run an answer to a proposal starts: CopilotKit's connect
	// handshake on a page load holds the chat busy too, for seconds at
	// times, and is no run anyone waits for. An answer counts until the
	// next run ends, or for `ASSISTANT_FINISHING_ARM_MS` if none starts.
	const [assistantAnswered, setAssistantAnswered] = useState(false);
	const answeredLoadingRef = useRef(isLoading);
	useEffect(() => {
		const wasLoading = answeredLoadingRef.current;
		answeredLoadingRef.current = isLoading;
		if (wasLoading && !isLoading) {
			setAssistantAnswered(false);
		}
	}, [isLoading]);
	useEffect(() => {
		if (!assistantAnswered || isLoading) {
			return;
		}
		const timer = setTimeout(
			() => setAssistantAnswered(false),
			ASSISTANT_FINISHING_ARM_MS,
		);
		return () => clearTimeout(timer);
	}, [assistantAnswered, isLoading]);
	const assistantFinishing =
		assistantAnswered &&
		isLoading &&
		!isUserGenerationActive &&
		!isRegenerating &&
		!isGenerationRunning &&
		!showConfirmDialog &&
		!isDiffReviewActive &&
		!rejectPending &&
		!roomFreezesEditor;
	const [assistantFinishingShown, setAssistantFinishingShown] =
		useState(false);
	useEffect(() => {
		if (!assistantFinishing) {
			setAssistantFinishingShown(false);
			return;
		}
		const timer = setTimeout(
			() => setAssistantFinishingShown(true),
			ASSISTANT_FINISHING_SHOW_DELAY_MS,
		);
		return () => clearTimeout(timer);
	}, [assistantFinishing]);

	// Auto-save function - skip save if content hasn't actually changed
	const triggerAutoSave = () => {
		if (!hasUnsavedChanges || !document) {
			return;
		}
		// Nothing typed here since the last save: what the room holds is
		// another editor's to save, or the server's (Fizzy #2946).
		if (passiveInRoom()) {
			setHasUnsavedChanges(false);
			return;
		}
		// Never auto-save while the context-update diff is on screen — the
		// editor contains diff markers, not the user's chosen content.
		if (isContextUpdateActiveRef.current) {
			return;
		}
		// Never auto-save while a regeneration is in flight or its
		// accept/reject dialog is open. The editor is showing programmatically
		// streamed content (or the result of one), and an autosave here would
		// bump projectDocument.version without creating a matching
		// DocumentVersion row — leaving Reject unable to do a clean
		// rollback (see Fizzy #1155). The same for a run the server still
		// reports live and an editor off its room (see `saveBlockReason`).
		if (saveBlockReason !== null) {
			return;
		}
		// Only require editor for rich mode — raw mode uses rawContent
		// directly. A destroyed editor cannot be serialized.
		if (viewMode !== "raw" && (!editor || editor.isDestroyed)) {
			return;
		}
		// Compare current editor content against the baseline to avoid
		// creating versions from HTML→Markdown roundtrip differences
		if (viewMode !== "raw") {
			// Null means the serializer failed on this tick. Bail
			// silently — coercing to "" would make `currentMarkdown` never equal
			// `lastSavedContentRef`, so this would re-fire `handleSave()` (and
			// its stale-content fallback) every 10s for as long as the
			// serializer stays broken. `handleSave` already reports failures
			// when the user saves manually, so no toast here.
			const editorMarkdown = getEditorMarkdownForSave(editor);
			if (editorMarkdown === null) {
				return;
			}
			if (editorMarkdown.trim() === lastSavedContentRef.current.trim()) {
				setHasUnsavedChanges(false);
				return;
			}
			handleSave();
			return;
		}
		const currentMarkdown = rawContent;
		if (currentMarkdown.trim() === lastSavedContentRef.current.trim()) {
			setHasUnsavedChanges(false);
			return;
		}
		handleSave();
	};
	// Expose the latest triggerAutoSave to recomputeDirtyState via a ref so
	// the dirty-check helper (declared earlier) can schedule it without a
	// circular forward reference.
	triggerAutoSaveRef.current = triggerAutoSave;

	// The base a save names (Fizzy #2946): the room's stamp for a save from
	// a collaborative room — whose content descends from that saved body —
	// and the body the single-user editor loaded or last adopted. Off the
	// room flag, none. `"unavailable"`: a room without a stamp yet, whose
	// saves wait until it has one, rather than go out unguarded.
	const resolveSaveBase = ():
		| DocumentSaveBase
		| null
		| undefined
		| "unavailable" => {
		if (!roomConvergence) {
			return undefined;
		}
		if (roomStampsOn && ydoc) {
			return readRoomStamp(ydoc) ?? "unavailable";
		}
		const version = editorBodyVersionRef.current;
		const contentHash = editorBodyHashRef.current;
		return version !== undefined && contentHash
			? { version, contentHash }
			: null;
	};
	const resolveSaveBaseRef = useRef(resolveSaveBase);
	resolveSaveBaseRef.current = resolveSaveBase;

	// Whether the base a rejected regeneration's fallback save would name is
	// still the reviewed body (Fizzy #2946). In a room the reviewed body's
	// identity must be known and match; the single-user editor compares
	// when it knows both. Without a base (the room flag off) nothing can
	// be compared.
	const fallbackBaseIsReviewed = (
		base: DocumentSaveBase | null | undefined,
		reviewStamp: RoomStamp | null,
	): boolean => {
		if (!base) {
			return true;
		}
		const reviewedHash = reviewStamp?.contentHash;
		if (roomStampsOn) {
			return !!reviewedHash && base.contentHash === reviewedHash;
		}
		return !reviewedHash || base.contentHash === reviewedHash;
	};

	// Whether the editor's text no longer holds an accepted proposal (Fizzy
	// #2946): it is back to the body the proposal's review started from, or
	// to the body saved when it was accepted — and is not the accepted text
	// itself. The saved body is the one from then: a colleague's save
	// landing since may already hold the accepted text.
	const acceptUndoneIn = (text: string, accept: AcceptAwaitingSave) => {
		const held = text.trim();
		return (
			held !== accept.accepted.trim() &&
			(held === accept.acceptedFrom.trim() ||
				held === accept.savedBody.trim())
		);
	};

	// A save sent past `handleSave` keeps to one save at a time as well: while
	// one is in flight it waits for that answer (see `pendingDirectSaveRef`),
	// and its base is resolved when it is sent, so it names the body the
	// answer produced rather than the one that save replaced.
	sendDirectSaveRef.current = (request) => {
		const { build, confirm, onUnavailable, stillApplies, onDeclined } =
			request;
		// Accepted proposals waiting behind the save in flight are displaced
		// by a save of what the editor holds — the save on leaving the page,
		// a later accept (Fizzy #2946). One whose text that save holds rides
		// on it, and its answer is the proposal's to say as well; otherwise
		// nobody would. One the editor undid meanwhile says so now, and is
		// never saved.
		const waiting =
			saveInFlightRef.current &&
			pendingDirectSaveRef.current &&
			request.savesEditor !== undefined
				? pendingAcceptsRef.current
				: [];
		const carried = waiting.filter(
			(accept) => !acceptUndoneIn(request.savesEditor ?? "", accept),
		);
		for (const accept of waiting) {
			if (!carried.includes(accept)) {
				accept.onUndone();
			}
		}
		// The save of the editor's last text — on leaving, or on closing
		// an editor outside a room — also settles an accepted proposal the
		// save in flight carries when that text undid it: the proposal says
		// it was undone, and that save's answer then says nothing of it
		// (each accept records once). This save, sent behind it, writes the
		// text the editor holds.
		if (
			saveInFlightRef.current &&
			request.savesEditor !== undefined &&
			!request.accept
		) {
			const editorText = request.savesEditor;
			const undoneInFlight = inFlightAcceptsRef.current.filter((accept) =>
				acceptUndoneIn(editorText, accept),
			);
			for (const accept of undoneInFlight) {
				accept.onUndone();
			}
			inFlightAcceptsRef.current = inFlightAcceptsRef.current.filter(
				(accept) => !undoneInFlight.includes(accept),
			);
		}
		// The accepted proposals this save carries: those it displaced and
		// still holds, and itself when it is one.
		const riders: AcceptAwaitingSave[] = request.accept
			? [
					...carried,
					{
						accepted: request.savesEditor ?? "",
						acceptedFrom: request.accept.from,
						savedBody: lastSavedContentRef.current,
						onSaved: request.onSaved,
						onFailed: request.onFailed,
						onSettled: request.onSettled,
						onUndone: request.accept.onUndone,
					},
				]
			: carried;
		const onSaved = carried.length
			? (saved: RoomStamp | null) => {
					for (const accept of carried) {
						accept.onSaved?.(saved);
					}
					return request.onSaved?.(saved);
				}
			: request.onSaved;
		const onFailed = carried.length
			? (failure: DirectSaveFailure) => {
					for (const accept of carried) {
						accept.onFailed?.(failure);
					}
					request.onFailed?.(failure);
				}
			: request.onFailed;
		const onSettled = carried.length
			? () => {
					for (const accept of carried) {
						accept.onSettled?.();
					}
					request.onSettled?.();
				}
			: request.onSettled;
		const send = () => {
			const base = resolveSaveBaseRef.current();
			if (base === "unavailable") {
				// Nothing goes, so the save asked for meanwhile does not
				// either: the text stays unsaved for a later save.
				saveInFlightRef.current = false;
				saveAgainRef.current = null;
				setHasUnsavedChanges(true);
				onUnavailable();
				onSettled?.();
				return;
			}
			if (stillApplies && !stillApplies(base)) {
				// The document moved on while this save waited: nothing
				// goes, and the save asked for meanwhile goes as it would
				// after an answer.
				saveInFlightRef.current = false;
				const again = saveAgainRef.current;
				saveAgainRef.current = null;
				if (again && !pageLeft()) {
					setTimeout(() => {
						isManualSaveRef.current = again.manual;
						shouldRedirectAfterSaveRef.current = again.redirect;
						handleSaveRef.current();
					}, 0);
				}
				onDeclined?.();
				onSettled?.();
				return;
			}
			saveInFlightRef.current = true;
			isManualSaveRef.current = false;
			shouldRedirectAfterSaveRef.current = false;
			inFlightIntentRef.current = { manual: false, redirect: false };
			// Marked only when it is sent, so the answer of the save it
			// waited for is never reported as its own.
			isConfirmSaveRef.current = confirm;
			directSaveOnSavedRef.current = onSaved ?? null;
			directSaveOnFailedRef.current = onFailed ?? null;
			directSaveOnSettledRef.current = onSettled ?? null;
			inFlightAcceptsRef.current = riders;
			setIsSaving(true);
			saveMutation.mutate(build(base));
		};
		if (saveInFlightRef.current) {
			pendingDirectSaveRef.current = send;
			pendingDirectOnSettledRef.current = onSettled ?? null;
			pendingAcceptsRef.current = riders;
			setHasUnsavedChanges(true);
			return;
		}
		send();
	};

	// A save that went, or was meant to go, after the page was left within
	// the app did not land: nobody is in the editor to see the text left
	// unsaved, so it is said, with the text to copy.
	// One toast per document: it replaces the warning that kept raw-view
	// edits, and a second failure after leaving replaces the first.
	const notifyLeaveSaveFailed = (text: string) => {
		const id = rawOfferToastId;
		toast.error(tRoom("leaveSaveFailed"), {
			id,
			duration: Number.POSITIVE_INFINITY,
			...(text.trim()
				? {
						action: {
							label: tRoom("offerBack.copy"),
							onClick: () => {
								void navigator.clipboard
									?.writeText(text)
									.catch(() => undefined);
							},
						},
					}
				: {}),
		});
	};

	// The save sent when the page is left within the app (see
	// `CollaborativeDocumentEditor`): typing from this room that no save
	// covers, read from the editor now and sent from the room's stamp when it
	// goes — after the save in flight, if there is one. Nothing is sent by a
	// client that may not edit, while saves are blocked (a run owns the
	// document, or the room is behind the saved one), or when the editor
	// holds what was last saved.
	const flushOnLeave = () => {
		// Raw-view edits on a body the editor moved past are not saved over
		// it on the way out: nobody asked to. They are said to be unsaved,
		// with the text as it stands now to copy, in place of the warning
		// that kept them in the raw view (Fizzy #2946).
		// Unless the person's own Save of exactly that text is in flight: its
		// answer says what became of it (Fizzy #2946).
		if (
			viewMode === "raw" &&
			rawEditedRef.current &&
			rawEditsStaleRef.current &&
			!(
				saveInFlightRef.current &&
				sendingContentRef.current === rawContentRef.current
			)
		) {
			notifyLeaveSaveFailed(rawContentRef.current);
			return;
		}
		if (
			!roomStampsOn ||
			!ydoc ||
			canEdit !== true ||
			!document ||
			saveBlockReason !== null ||
			!hasLocalTyping()
		) {
			return;
		}
		// The save in flight already carries everything typed so far.
		if (
			saveInFlightRef.current &&
			localEditCountRef.current <= savingEditCountRef.current
		) {
			return;
		}
		const content =
			viewMode === "raw"
				? rawContent
				: getEditorMarkdownForSave(editorRef.current);
		// Holding what the document will hold, nothing is left to save
		// (Fizzy #2946): the body the save in flight carries, else the saved
		// one. Unless an accepted proposal still waits behind that save: its
		// save would write text the editor no longer holds, so this one goes
		// in its place. A regeneration's revert that waits is compared with
		// the saved body, as before: replaced by this save, it would lose
		// what makes it a revert.
		const revertWaits =
			pendingDirectSaveRef.current !== null &&
			pendingAcceptsRef.current.length === 0;
		const heldOnceSaved =
			saveInFlightRef.current &&
			!revertWaits &&
			sendingContentRef.current !== null
				? sendingContentRef.current
				: lastSavedContentRef.current;
		if (
			content === null ||
			(pendingAcceptsRef.current.length === 0 &&
				content.trim() === heldOnceSaved.trim())
		) {
			return;
		}
		if (autoSaveTimeoutRef.current) {
			clearTimeout(autoSaveTimeoutRef.current);
			autoSaveTimeoutRef.current = null;
		}
		leaveContentRef.current = content;
		sendDirectSaveRef.current({
			confirm: false,
			// What the editor holds now: an accepted proposal still waiting
			// behind the save in flight is in it, and is said by its answer,
			// unless the editor undid it.
			savesEditor: content,
			build: (base) =>
				buildDocumentSaveInput({
					projectId,
					documentId,
					content,
					isManualSave: false,
					base,
				}),
			onUnavailable: () => notifyLeaveSaveFailed(content),
		});
	};
	const flushOnLeaveRef = useRef(flushOnLeave);
	flushOnLeaveRef.current = flushOnLeave;

	// Edit with instructions reads Main from the server, so a client-document
	// Proposal's diagram saves the editor first (Fizzy #2946). `false` when
	// saving is refused right now (a run owns the document, the room is
	// behind the saved body, the viewer may not edit) or the save does not
	// land: the diagram then reads as changed, and nothing is asked.
	const flushBeforeVisualEdit = (): Promise<boolean> => {
		if (
			canEdit !== true ||
			!document ||
			saveBlockReason !== null ||
			viewMode === "raw"
		) {
			return Promise.resolve(false);
		}
		const content = getEditorMarkdownForSave(editorRef.current);
		if (content === null) {
			return Promise.resolve(false);
		}
		if (
			!saveInFlightRef.current &&
			pendingAcceptsRef.current.length === 0 &&
			content.trim() === lastSavedContentRef.current.trim()
		) {
			return Promise.resolve(true);
		}
		if (autoSaveTimeoutRef.current) {
			clearTimeout(autoSaveTimeoutRef.current);
			autoSaveTimeoutRef.current = null;
		}
		return new Promise((resolve) => {
			let landed = false;
			sendDirectSaveRef.current({
				confirm: false,
				savesEditor: content,
				build: (base) =>
					buildDocumentSaveInput({
						projectId,
						documentId,
						content,
						isManualSave: false,
						base,
					}),
				onUnavailable: () => {},
				onSaved: () => {
					landed = true;
					return undefined;
				},
				onSettled: () =>
					resolve(
						landed ||
							lastSavedContentRef.current.trim() ===
								content.trim(),
					),
			});
		});
	};
	const flushBeforeVisualEditRef = useRef(flushBeforeVisualEdit);
	flushBeforeVisualEditRef.current = flushBeforeVisualEdit;
	const flushForVisualEdit = useCallback(
		() => flushBeforeVisualEditRef.current(),
		[],
	);
	useLayoutEffect(() => {
		const leave = pageLeaveRef?.current;
		if (!leave) {
			return;
		}
		const flush = () => flushOnLeaveRef.current();
		leave.flush = flush;
		return () => {
			if (leave.flush === flush) {
				leave.flush = null;
			}
		};
	}, [pageLeaveRef]);

	// Closing an editor outside a room sends nothing of its own (Fizzy
	// #2946): an accepted proposal's save in flight, or waiting behind the
	// one in flight, still goes after it is closed. When the editor's last
	// text undid such a proposal, that save would write text the editor no
	// longer holds. Every waiting one undone, none in flight, and the save
	// in flight already carrying that last text: the waiting save does not
	// go, and each says it was undone. Otherwise a save of that last text
	// goes behind the one in flight, in place of the waiting save, and
	// settles each proposal by what the text holds.
	// Read in a layout cleanup, while the editor still exists.
	const settleUndoneAcceptsOnClose = () => {
		const waiting = pendingAcceptsRef.current;
		const inFlight = inFlightAcceptsRef.current;
		// Outside a room only, as `editorClosed`: a room's editor leaves its
		// saves to the room, also with the room flag off and on a sync loss.
		if (
			ydoc ||
			!saveInFlightRef.current ||
			(waiting.length === 0 && inFlight.length === 0)
		) {
			return;
		}
		const text =
			viewMode === "raw"
				? rawContent
				: getEditorMarkdownForSave(editorRef.current);
		if (text === null) {
			return;
		}
		const undone = (accept: AcceptAwaitingSave) =>
			acceptUndoneIn(text, accept);
		if (!waiting.some(undone) && !inFlight.some(undone)) {
			return;
		}
		// Dropped only when the text the save in flight carries is the
		// editor's last text: otherwise that save would leave the document
		// on a body the person undid too.
		if (
			waiting.length > 0 &&
			waiting.every(undone) &&
			!inFlight.some(undone) &&
			text.trim() ===
				(
					sendingContentRef.current ?? lastSavedContentRef.current
				).trim()
		) {
			pendingDirectSaveRef.current = null;
			pendingDirectOnSettledRef.current = null;
			pendingAcceptsRef.current = [];
			for (const accept of waiting) {
				accept.onUndone();
			}
			return;
		}
		sendDirectSaveRef.current({
			confirm: false,
			savesEditor: text,
			build: (base) =>
				buildDocumentSaveInput({
					projectId,
					documentId,
					content: text,
					isManualSave: false,
					base,
				}),
			onUnavailable: () => {},
		});
	};
	const settleUndoneAcceptsOnCloseRef = useRef(settleUndoneAcceptsOnClose);
	settleUndoneAcceptsOnCloseRef.current = settleUndoneAcceptsOnClose;
	useLayoutEffect(() => () => settleUndoneAcceptsOnCloseRef.current(), []);

	const handleSave = () => {
		if (!document) {
			// As below: no save runs, so clear the intent here.
			isManualSaveRef.current = false;
			shouldRedirectAfterSaveRef.current = false;
			return;
		}
		// Raw-view edits the editor has moved past are saved only when the
		// person asks (see `rawEditsStaleRef`): the autosave and the save
		// before an assistant run stand down, and the edits stay unsaved.
		if (
			viewMode === "raw" &&
			rawEditsStaleRef.current &&
			!isManualSaveRef.current
		) {
			shouldRedirectAfterSaveRef.current = false;
			return;
		}
		// Refused while a regeneration owns the document (see
		// `saveBlockReason`). A person who asked is told why; the unsaved
		// state stays, so the text is saved once the block lifts.
		if (saveBlockReason !== null) {
			if (isManualSaveRef.current) {
				toast.info(tRun(`saveBlocked.${saveBlockReason}`));
			}
			isManualSaveRef.current = false;
			shouldRedirectAfterSaveRef.current = false;
			return;
		}
		// A save is in flight: this one goes once it has been answered (see
		// `saveInFlightRef`). The intent refs stay the in-flight save's — a
		// Save & Close asked for now must not leave the page on the answer
		// of a save that does not hold the latest text.
		if (saveInFlightRef.current) {
			const sent = inFlightIntentRef.current;
			const held = saveAgainRef.current;
			saveAgainRef.current = {
				manual:
					!!held?.manual || (isManualSaveRef.current && !sent.manual),
				redirect:
					!!held?.redirect ||
					(shouldRedirectAfterSaveRef.current && !sent.redirect),
			};
			isManualSaveRef.current = sent.manual;
			shouldRedirectAfterSaveRef.current = sent.redirect;
			return;
		}
		// A run the server still lists as generating but that has not
		// written for ten minutes does not block the save (see
		// `saveBlockReason`); saving ends it, so a person who asked is told.
		if (
			isManualSaveRef.current &&
			isGenerationRunning &&
			!isRunStillWriting
		) {
			toast.warning(tRun("staleRunSave"));
		}
		// Clear auto-save timeout when manually saving
		if (autoSaveTimeoutRef.current) {
			clearTimeout(autoSaveTimeoutRef.current);
			autoSaveTimeoutRef.current = null;
		}
		// Use raw content if in raw mode, otherwise get from editor.
		// `editorMarkdown` is null on serialization failure (was
		// "" before). Falling through to the agentState.document /
		// currentDocument fallback chain on a `null` read would silently
		// persist a stale, older revision over the user's current text — so
		// bail before building `content` at all.
		const editorMarkdown =
			viewMode === "raw" ? null : getEditorMarkdownForSave(editor);
		if (viewMode !== "raw" && editorMarkdown === null) {
			setIsSaving(false);
			// No save runs, so `onSettled` never clears the manual-save
			// intent. Left set, the next autosave would go out as an explicit
			// Save — completing a draft nobody asked to complete, and
			// following a Save & Close that never saved.
			isManualSaveRef.current = false;
			shouldRedirectAfterSaveRef.current = false;
			toast.error(
				"Couldn't save your changes — the editor content could not be read. Your text is still here; please copy it somewhere safe and reload the page.",
			);
			return;
		}
		const content =
			viewMode === "raw"
				? rawContent
				: (editorMarkdown && editorMarkdown.trim().length > 0
						? editorMarkdown
						: agentState?.document) ||
					currentDocument ||
					"";
		const base = resolveSaveBase();
		if (base === "unavailable") {
			if (isManualSaveRef.current) {
				toast.info(tRun("saveBlocked.updatingToLatest"));
			}
			isManualSaveRef.current = false;
			shouldRedirectAfterSaveRef.current = false;
			return;
		}
		saveInFlightRef.current = true;
		inFlightIntentRef.current = {
			manual: isManualSaveRef.current,
			redirect: shouldRedirectAfterSaveRef.current,
		};
		// A save of its own: no accepted proposal is said by its answer.
		inFlightAcceptsRef.current = [];
		setIsSaving(true);
		// Update local state immediately so future streaming diffs compare against saved text
		setCurrentDocument(content);
		// IMPORTANT: Preserve ragContexts and projectContext when updating document
		setAgentState((prev) => ({
			...prev,
			document: content,
			streamingContent: content,
		}));
		saveMutation.mutate(
			buildDocumentSaveInput({
				projectId,
				documentId,
				content,
				isManualSave: isManualSaveRef.current,
				base,
			}),
		);
	};
	handleSaveRef.current = handleSave;

	// Expose document state to CopilotKit (memoized to avoid re-registrations on every render)
	const documentReadableValue = useMemo(
		() => ({
			documentId,
			documentType: document?.type,
			title: document?.title,
			// NOTE: document content is intentionally omitted here — it is already
			// included in the agent's system prompt via state.document (useCoAgent).
			// Sending it again as JSON doubles the token count and can overflow the
			// model's effective reasoning space, causing it to answer questions
			// conversationally instead of calling write_document_local.
			projectName: project?.name,
			projectDescription: project?.description,
			techStack: project?.techStack,
			features: project?.features,
		}),
		[
			documentId,
			document?.type,
			document?.title,
			project?.name,
			project?.description,
			project?.techStack,
			project?.features,
		],
	);
	useCopilotReadable({
		description: "The current document being edited",
		value: documentReadableValue,
	});

	// Project-level RAG contexts (`localRagContexts`) are intentionally NOT
	// sent via `useCopilotReadable` — the agent uses the
	// `search_project_knowledge` tool for on-demand retrieval against the
	// Qdrant index instead.
	//
	// CHAT-SESSION attachments (`chatAttachmentContexts`) are different:
	// they are uploaded via the paperclip in this turn, are not in Qdrant,
	// and the agent has no way to retrieve them without our help. We
	// publish them via the same "rag context" description the
	// `project_document_generator` chat-node already reads
	// (`findReadableValue("rag context")` →
	// `unified-server.ts:447-450`). The value shape mirrors what
	// StoryWorkspace and DocumentGeneratorEditor publish, so the agent
	// extracts `value.ragContexts` uniformly across all three surfaces.
	useCopilotReadable({
		description:
			"RAG context — content extracted from files the user has attached in this chat session. Each entry is prefixed with the filename and contains either the raw text (documents) or a markdown image link with a base64 data URL (images, for vision-capable models).",
		value: {
			ragContexts: chatAttachmentContexts,
			ragContextsCount: chatAttachmentContexts.length,
		},
	});

	// Mirror chat-attachment contexts onto `useCoAgent` state as a
	// belt-and-suspenders fallback. The agent reads `useCopilotReadable`
	// first and falls back to `state.ragContexts` if the readable arrives
	// stale on a turn that races with the file-upload state commit. Same
	// pattern as DocumentGeneratorEditor and StoryWorkspace.
	useEffect(() => {
		setAgentStateRef.current({
			ragContexts: chatAttachmentContexts,
		} as Partial<AgentState> as AgentState);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [chatAttachmentContexts]);

	const hasRepoUrl = !!(project as Record<string, unknown>)?.repositoryUrl;
	const projectContextReadableValue = useMemo(
		() => ({
			projectContext: localProjectContext,
			hasTeamsIntegration: !!teamsMessagesData?.hasTeamsIntegration,
			hasSlackIntegration: !!slackMessagesData?.hasSlackIntegration,
			hasGitHubIntegration: hasRepoUrl,
			hasRepoIntegration: codeSearchEnabled && hasRepoUrl,
			projectId,
		}),
		[
			localProjectContext,
			teamsMessagesData?.hasTeamsIntegration,
			slackMessagesData?.hasSlackIntegration,
			hasRepoUrl,
			codeSearchEnabled,
			projectId,
		],
	);
	useCopilotReadable({
		description:
			"Project context including name, description, tech stack, and features",
		value: projectContextReadableValue,
	});

	// Embed contexts mutation - ensures contexts are in Qdrant before regeneration
	// Same pattern as wizard's DocumentGenerationStep.tsx
	const embedContextsMutation = useMutation(
		orpc.projects.contexts.embed.mutationOptions({}),
	);

	// Regenerate document action - triggers Temporal workflow for major rewrites
	const regenerateMutation = useMutation(
		orpc.projects.documents.generate.mutationOptions({
			onSuccess: (result) => {
				const documentQueryKey = orpc.projects.documents.get.queryKey({
					input: { id: documentId, projectId, organizationId },
				});

				// A run already holds this document, or the server could not
				// confirm whether the live run the row names still exists
				// (Fizzy #2946). This request started nothing of this editor's
				// own, so it says so and arms no review: reviewing would take
				// that run's result, or a colleague's save, for a run this
				// editor never started. The refetch brings the run's status;
				// an editor that attaches to server runs then follows that run
				// and adopts its body.
				//
				// `statusUnknown` is not among them: this request's own start
				// may have registered, and the row is already queued for it,
				// so it takes the started path below — the review, the poll
				// and the FAILED watcher settle what happened.
				const outcome = (result as { outcome?: string } | undefined)
					?.outcome;
				if (
					outcome === "alreadyInProgress" ||
					outcome === "liveRunUnknown"
				) {
					const cached = queryClient.getQueryData(documentQueryKey) as
						| { document?: { status?: string | null } }
						| undefined;
					const message = tRegenerateToast(
						resolveRegenerateToastKey({
							outcome,
							documentStatus: cached?.document?.status ?? null,
						}),
					);
					if (outcome === "liveRunUnknown") {
						toast.warning(message);
					} else {
						toast.info(message);
					}
					if (regenerationTimeoutRef.current) {
						clearTimeout(regenerationTimeoutRef.current);
						regenerationTimeoutRef.current = null;
					}
					// The assistant's instructions were not applied.
					if (regenerationRespondRef.current) {
						regenerationRespondRef.current({ accepted: false });
						regenerationRespondRef.current = null;
					}
					regenerationTriggeredRef.current = false;
					regenerationBaselineRef.current = null;
					regenerationAckAtRef.current = null;
					isDirectRegenerationRef.current = false;
					setIsRegenerating(false);
					void queryClient.invalidateQueries({
						queryKey: documentQueryKey,
					});
					return;
				}

				// Record the instant the server confirmed this run started.
				// generate-document writes GENERATING + clears generationError
				// BEFORE it starts the workflow, so any polled snapshot fetched
				// after this instant that still shows FAILED is a genuine
				// failure from THIS run, not a stale one left over from the run
				// being retried — see the FAILED-watcher effect above.
				regenerationAckAtRef.current = Date.now();

				// Force a refetch now so it supersedes any poll that was
				// already in flight when the mutation resolved — an in-flight
				// poll can carry a pre-GENERATING (possibly still-FAILED)
				// snapshot yet complete after ackAt, which would otherwise
				// slip past the watcher's dataUpdatedAt guard.
				void queryClient.invalidateQueries({
					queryKey: documentQueryKey,
				});

				// Clear any timer from a previous regeneration attempt before
				// scheduling a new one — prevents overlapping safety timers.
				if (regenerationTimeoutRef.current) {
					clearTimeout(regenerationTimeoutRef.current);
				}

				// Safety net for the rare case where polling never observes a
				// content change (e.g. workflow stalled, or regeneration produced
				// byte-identical output). On fire we refetch once from the server
				// — if new content has in fact arrived, the detection effect above
				// will process it and cancel this path; only if content still
				// hasn't changed do we surface a soft notice to the user.
				const armSafetyTimer = () => {
					regenerationTimeoutRef.current = setTimeout(() => {
						regenerationTimeoutRef.current = null;
						void queryClient
							.invalidateQueries({ queryKey: documentQueryKey })
							.finally(() => {
								// Read the freshest cached content directly — this
								// avoids stale closures and races with the detection
								// effect. If content has actually arrived, the
								// detection effect will (or already did) open the
								// confirm dialog; we must stay silent to avoid a
								// duplicate "timed out" toast on top of it.
								const latest = queryClient.getQueryData(
									documentQueryKey,
								) as
									| {
											document?: {
												content?: string | null;
												status?: string | null;
												generationStartedAt?:
													| Date
													| string
													| null;
												updatedAt?:
													| Date
													| string
													| null;
											};
									  }
									| undefined;
								const latestContent =
									latest?.document?.content ?? null;
								const baseline =
									regenerationBaselineRef.current;
								const contentArrived =
									latestContent != null &&
									latestContent.length > 0 &&
									latestContent !== (baseline ?? "");
								if (contentArrived) {
									return;
								}
								// In artifact mode the page shows the run's
								// progress itself, and a Proposal run can write
								// for longer than five minutes (Fizzy #2946).
								// Giving up on a run the server still reports
								// queued or generating cleared it here and lost
								// its review, so the editor keeps waiting and
								// looks again later. The review, the FAILED
								// watcher, a run that leaves the running
								// states, or one silent for longer than the
								// editor polls ends the wait.
								const latestStatus =
									latest?.document?.status ?? "";
								if (
									suppressGenerationOverlay &&
									isDocumentGenerationRunning(latestStatus) &&
									getDocumentPollInterval(
										latestStatus,
										resolveGenerationClock(
											latestStatus,
											latest?.document
												?.generationStartedAt,
											latest?.document?.updatedAt,
										),
									) !== false
								) {
									armSafetyTimer();
									return;
								}
								// Genuinely no new content after one last server
								// check — surface a soft, actionable notice.
								setIsRegenerating(false);
								toast.info(
									"Document generation is taking longer than expected. Refresh the page to check for the latest version.",
								);
								if (regenerationRespondRef.current) {
									regenerationRespondRef.current({
										accepted: false,
									});
									regenerationRespondRef.current = null;
								}
								regenerationTriggeredRef.current = false;
							});
					}, 300000); // 5 minutes
				};
				armSafetyTimer();
			},
			onError: (error) => {
				console.error(
					"[DocumentEditor] Regeneration mutation failed:",
					error,
				);
				// A coded refusal — nothing bound to the prompt a Proposal is
				// written from, or an action the Proposal artifact supersedes —
				// is said in the reader's language with the way to resolve it
				// (Fizzy #2946); anything else keeps the server's message.
				const refusal = describeGenerationRefusal(error, {
					t: tGenerationFeedback,
					basePath,
				});
				if (refusal) {
					toast.error(refusal.message, {
						action: {
							label: refusal.catalog.label,
							onClick: () => router.push(refusal.catalog.href),
						},
					});
				} else {
					toast.error(
						`Failed to regenerate document: ${error.message}`,
					);
				}
				setIsRegenerating(false);
				// Cancel the safety timer — we already know the outcome.
				if (regenerationTimeoutRef.current) {
					clearTimeout(regenerationTimeoutRef.current);
					regenerationTimeoutRef.current = null;
				}
				// Unblock the CopilotKit action so UI recovers
				if (regenerationRespondRef.current) {
					regenerationRespondRef.current({ accepted: false });
					regenerationRespondRef.current = null;
				}
				// Reset triggered ref so user can retry
				regenerationTriggeredRef.current = false;
				// Clear the baseline ref
				regenerationBaselineRef.current = null;
				// Clear the ack timestamp — this run never got a GENERATING
				// write to ack, so the FAILED watcher must stay unarmed.
				regenerationAckAtRef.current = null;
				// The server may have gone GENERATING → FAILED as part of
				// this failed start (generate-document marks GENERATING
				// before starting the workflow, then FAILED if the start
				// itself throws). A poll in flight when the mutation
				// rejected can have cached that intermediate GENERATING
				// snapshot, and since we just stopped polling above (by
				// setting isRegenerating false), that stale cache would
				// otherwise never refresh. Refetch once so the persisted
				// FAILED status reaches the cache — with the spinner
				// already stopped, DocumentGenerationFailedNotice can now
				// render instead of leaving the user with only this toast.
				void queryClient.invalidateQueries({
					queryKey: orpc.projects.documents.get.queryKey({
						input: { id: documentId, projectId, organizationId },
					}),
				});
			},
		}),
	);

	// Reject-regeneration mutation: atomically deletes the freshly-created
	// DocumentVersion row and rewinds projectDocument.{content, version} so
	// version history stays consistent with the live document. Used in the
	// Reject handler below; falls back to the old skipVersionBump path on
	// CONFLICT (e.g. first-ever generation has no prior version to revert to).
	// The room's stamp, and the earlier body the single-user editor put on
	// screen, as a Reject went (Fizzy #2946): its answer writes only over
	// what it was sent from.
	const rejectSendStampRef = useRef<RoomStamp | null>(null);
	const rejectShownBodyRef = useRef<string | null>(null);
	// Anything typed since the Reject went — in this editor or one mounted
	// after a sync loss — offered back before the Reject's outcome replaces
	// it (Fizzy #2946). Read from the editor on screen now.
	const offerTypedSinceReject = useCallback(() => {
		if (!typedSinceRejectRef.current) {
			return;
		}
		typedSinceRejectRef.current = false;
		const ed = liveEditorOrNull(liveEditorRef.current);
		const typed = rawEditPending()
			? rawContentRef.current
			: ed
				? getEditorMarkdownForSave(ed)
				: null;
		if (typed?.trim()) {
			offerBackReplacedText(typed);
		}
	}, [
		typedSinceRejectRef,
		liveEditorRef,
		rawEditPending,
		offerBackReplacedText,
	]);
	const rejectRegenerationMutation = useMutation(
		orpc.projects.documents.rejectRegeneration.mutationOptions({
			onSuccess: (data) => {
				const reverted = data?.document;
				const version =
					typeof reverted?.version === "number"
						? reverted.version
						: undefined;
				const body =
					typeof reverted?.content === "string"
						? reverted.content
						: null;
				const contentHash =
					typeof reverted?.contentHash === "string" &&
					reverted.contentHash
						? reverted.contentHash
						: undefined;
				const sendStamp = rejectSendStampRef.current;
				const shownBody = rejectShownBodyRef.current;
				rejectSendStampRef.current = null;
				rejectShownBodyRef.current = null;
				const refreshCaches = () => {
					queryClient.invalidateQueries({
						queryKey: documentGetQueryKey,
					});
					queryClient.invalidateQueries({
						queryKey:
							orpc.projects.documents.versions.list.queryKey({
								input: {
									projectId,
									documentId,
									organizationId,
								},
							}),
					});
				};
				if (!roomStampsOn) {
					// The server is back on the prior body. The single-user
					// editor put the body it remembered from before the run on
					// screen already; the server's rewind can differ from it,
					// and then its own body goes in and becomes the saved one
					// (Fizzy #2946).
					editorBodyVersionRef.current =
						version ?? editorBodyVersionRef.current;
					editorBodyHashRef.current = contentHash;
					if (
						body !== null &&
						shownBody !== null &&
						body.trim() !== shownBody.trim()
					) {
						setCurrentDocument(body);
						queueMicrotask(() => {
							offerTypedSinceReject();
							if (
								applyToLiveEditor(
									body ? fromMarkdown(body) : "",
								)
							) {
								adoptSoloBody(body, version, contentHash);
							}
						});
					}
					void adoptServerBase({ body, version });
					refreshCaches();
					setRejectPending(false);
					return;
				}
				// A room hears of the rewind only now, from the server: the
				// body it rewound to — not the one this editor remembered from
				// before the run, which can differ — goes in with its stamp,
				// in one transaction, and this editor takes it as its saved
				// body (Fizzy #2946). Only over the room the Reject was sent
				// from, though: a save that moved it meanwhile, or a newer
				// saved body this editor already heard of, is newer than the
				// rewind, so the room keeps it and the stale rule decides.
				const held = ydoc ? readRoomStamp(ydoc) : null;
				const roomUnmoved =
					sendStamp === null
						? held === null
						: sameRoomStamp(held, sendStamp);
				const cached = (
					queryClient.getQueryData(documentGetQueryKey) as
						| {
								document?: {
									version?: number;
									contentHash?: string | null;
								};
						  }
						| undefined
				)?.document;
				const reviewedHash =
					runState.reviewStampRef.current?.contentHash;
				const newerSaved =
					!!cached?.contentHash &&
					typeof cached.version === "number" &&
					version !== undefined &&
					cached.version > version &&
					cached.contentHash !== contentHash &&
					cached.contentHash !== reviewedHash &&
					cached.contentHash !== sendStamp?.contentHash;
				if (body === null || !roomUnmoved || newerSaved) {
					publishRoomSaveInFlight(provider?.awareness, null);
					refreshCaches();
					setRejectPending(false);
					return;
				}
				editorBodyVersionRef.current =
					version ?? editorBodyVersionRef.current;
				editorBodyHashRef.current = undefined;
				const stamp: RoomStamp | null =
					version !== undefined && contentHash
						? { version, contentHash }
						: null;
				setCurrentDocument(body);
				offerTypedSinceReject();
				const written = applyToLiveEditor(
					body ? fromMarkdown(body) : "",
					stamp,
				);
				if (written && stamp) {
					adoptSavedBody(body, stamp);
				} else if (written) {
					updateSavedBaseline(body);
					setHasUnsavedChanges(false);
				}
				if (written) {
					// A read that no longer holds this body is never stamped
					// over it.
					void adoptServerBase({ body, version });
				} else {
					// No editor on screen took the body (the room lost sync):
					// the room keeps the reviewed body under its own stamp,
					// and the stale rule brings it to the rewind.
					publishRoomSaveInFlight(provider?.awareness, null);
				}
				refreshCaches();
				setRejectPending(false);
			},
			// The editor that sent the Reject was remounted meanwhile (a sync
			// loss): its own refusal handling no longer runs, so the lock is
			// released here and the stale rule brings the room up to date
			// (Fizzy #2946).
			onError: () => {
				if (unmountedRef.current) {
					setRejectPending(false);
				}
			},
		}),
	);

	// A Reject the server refused as stale wrote nothing (Fizzy #2946). A
	// room was never changed by it: it hears that no save is in flight, and
	// the stale rule brings it to the newer saved document — one editor,
	// under a claim, offering back what it replaces. The single-user editor
	// put the earlier body on screen already: it goes back to the saved
	// document, which is newer than the review, and takes it as its base.
	const restoreLatestSavedBody = useCallback(async () => {
		const refreshVersions = () => {
			queryClient.invalidateQueries({
				queryKey: orpc.projects.documents.versions.list.queryKey({
					input: { projectId, documentId, organizationId },
				}),
			});
		};
		if (roomStampsOn) {
			publishRoomSaveInFlight(provider?.awareness, null);
			refetchSavedDocument();
			refreshVersions();
			return;
		}
		try {
			const fresh = await queryClient.fetchQuery({
				...orpc.projects.documents.get.queryOptions({
					input: { id: documentId, projectId, organizationId },
				}),
				staleTime: 0,
			});
			const saved = fresh?.document;
			if (saved && typeof saved.content === "string") {
				const body = saved.content;
				const version =
					typeof saved.version === "number"
						? saved.version
						: undefined;
				const contentHash = saved.contentHash ?? undefined;
				setCurrentDocument(body);
				queueMicrotask(() => {
					// Anything typed after the Reject went is offered back
					// before the saved body replaces it (Fizzy #2946).
					offerTypedSinceReject();
					if (applyToLiveEditor(body ? fromMarkdown(body) : "")) {
						adoptSoloBody(body, version, contentHash);
					}
				});
			}
		} catch {
			// The next read brings it.
		}
		refreshVersions();
	}, [
		roomStampsOn,
		provider?.awareness,
		queryClient,
		documentId,
		projectId,
		organizationId,
		applyToLiveEditor,
		refetchSavedDocument,
		adoptSoloBody,
		offerTypedSinceReject,
	]);

	// The safety timer is not cancelled when this editor unmounts: a sync
	// loss unmounts it in the middle of the run the timer watches. The outer
	// `DocumentEditor` cancels it (see `useGenerationRunState`).

	// Direct regeneration handler - called by the Regenerate button (bypasses agent)
	const handleDirectRegenerate = async () => {
		if (isRegenerating || isLoading) {
			return;
		}

		// Always confirm before regenerating: regen replaces the live content
		// with a fresh AI generation. The current content is preserved in
		// version history, but the user should know that's what's about to
		// happen so they can cancel if they meant to edit instead.
		if (!showImportedRegenWarning) {
			setShowImportedRegenWarning(true);
			return;
		}
		setShowImportedRegenWarning(false);

		// Capture baseline BEFORE regeneration starts
		const baselineContent = document?.content || currentDocument;
		regenerationBaselineRef.current = baselineContent;

		// Mark as direct regeneration (not agent-based)
		// This prevents Effect 4 from syncing agent state back to editor
		isDirectRegenerationRef.current = true;
		regenerationTriggeredRef.current = true;
		// Clear any ackAt left over from a previous run before this run's
		// mutation resolves and (re)arms it — otherwise the FAILED watcher
		// could momentarily see a stale ackAt from before this retry began.
		regenerationAckAtRef.current = null;
		setIsProgressDismissed(false);
		setIsRegenerating(true);

		try {
			// Step 1: Embed contexts first (same pattern as wizard's DocumentGenerationStep)
			// This ensures project contexts are in Qdrant before RAG retrieval
			await embedContextsMutation.mutateAsync({ projectId });
		} catch {
			// Continue anyway - some contexts might already be embedded
		}

		// Step 2: Use empty prompt to trigger document-type-specific default prompt in Temporal workflow
		// e.g., "Create a comprehensive PRD that outlines the product vision..." for PRD
		// The system prompt (from Prompt Library) + project context provide all necessary context
		regenerateMutation.mutate({
			id: documentId,
			prompt: "", // Empty = use default document-type prompt (matches Step 5 behavior)
			promptId: selectedPromptId,
			promptVersionId: selectedPromptVersionId,
		});
	};

	// Auto-generate on mount when coming from "Create Document with AI"
	// The document content contains the AI prompt from the create dialog
	useEffect(() => {
		let timeoutId: ReturnType<typeof setTimeout> | null = null;
		let isCancelled = false;

		// Also check regenerationTriggeredRef to prevent double-triggering if previous attempt already started
		if (
			shouldGenerateOnMount &&
			!hasTriggeredAutoGeneration.current &&
			!regenerationTriggeredRef.current &&
			document &&
			!isLoading &&
			!isRegenerating
		) {
			// The document content is the AI prompt from CreateDocumentDialog
			const aiPrompt = document.content || "";

			// Start generation after a short delay to let the UI settle
			timeoutId = setTimeout(async () => {
				// Check if component was unmounted or effect re-ran during the delay
				if (isCancelled) {
					return;
				}

				// CRITICAL: Only mark as triggered AFTER we confirm the timeout callback is executing
				// If we set this before the timeout, and the effect re-runs before timeout fires,
				// the flag will be true but the mutation was never called.
				hasTriggeredAutoGeneration.current = true;

				// Mark as regenerating FIRST (before any async operations)
				regenerationTriggeredRef.current = true;
				isDirectRegenerationRef.current = true;
				// Clear any ackAt left over from a previous run — see the
				// comment on the same line in handleDirectRegenerate.
				regenerationAckAtRef.current = null;
				setIsRegenerating(true);

				// Capture baseline (the AI prompt, which will be replaced)
				regenerationBaselineRef.current = aiPrompt;

				// Clear URL parameter to prevent re-renders from retriggering
				const newUrl = window.location.pathname;
				router.replace(newUrl);

				try {
					// Step 1: Embed contexts first
					await embedContextsMutation.mutateAsync({ projectId });
				} catch (_error) {
					// Continue anyway - some contexts might already be embedded
				}

				// Step 2: Trigger generation with the AI prompt
				// Read prompt IDs from refs to avoid stale closures without adding them as deps
				regenerateMutation.mutate({
					id: documentId,
					prompt: aiPrompt, // Use the AI prompt from the create dialog
					promptId: selectedPromptIdRef.current,
					promptVersionId: selectedPromptVersionIdRef.current,
				});
			}, 500);
		}

		// Cleanup: clear timeout and mark as cancelled on unmount
		return () => {
			isCancelled = true;
			if (timeoutId) {
				clearTimeout(timeoutId);
			}
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [
		shouldGenerateOnMount,
		document,
		isLoading,
		isRegenerating,
		documentId,
		projectId,
		router,
	]);

	// Render default-MCP tool results (e.g. Excalidraw `create_view`)
	// inline in the AI Document Assistant sidebar. The hook hooks the
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
			(
				project as {
					clarifyingQuestionFrequency?: ClarifyingQuestionFrequency | null;
				} | null
			)?.clarifyingQuestionFrequency ?? "BALANCED",
		organizationId: organizationId ?? null,
	});

	// Meeting selection action - shows MeetingSelector inline in chat
	// Mirrors the pattern from BacklogChat.tsx
	const fetchConfirmedMeetingNotes = async (
		selectedMeetings: Array<{ joinUrl: string; startTime?: string }>,
	) => {
		const result = await orpcClient.projects.documents.fetchMeetingNotes({
			projectId,
			organizationId: organizationId ?? null,
			selectedMeetings,
		});
		const formattedNotes = result.notes
			.filter((n) => n.content)
			.map((n) => `## Meeting: ${n.subject}\n\n${n.content}`)
			.join("\n\n---\n\n");
		// Keep the instruction short and specific — the system prompt already
		// has comprehensive editing rules via buildCurrentDocumentSection.
		// Verbose competing rules confuse the model and cause full rewrites.
		return [
			`${MEETING_NOTES_TRANSCRIPT_MARKER} (reference material — extract relevant points only):`,
			"",
			formattedNotes,
			"",
			"REMINDER: Append a few bullet points to 1-3 existing sections. Do NOT change the document title, type, structure, or rewrite existing text.",
		].join("\n");
	};

	useCopilotAction({
		name: "select_meetings",
		description:
			"Show a meeting selector. On confirmation the application fetches transcripts and returns them for document editing; do not call fetchMeetingNotes afterwards.",
		parameters: [],
		renderAndWaitForResponse: (render) => (
			<MeetingNotesFlowCard
				status={render.status}
				result={
					"result" in render && typeof render.result === "string"
						? render.result
						: undefined
				}
				controller={meetingNotesFlow}
				messageId={
					genuineUserMessage(internalMessagesForToolCallMatcher)?.id
				}
				projectId={projectId}
				organizationId={organizationId ?? null}
				fetchNotes={fetchConfirmedMeetingNotes}
				respond={render.respond}
			/>
		),
	});

	// Fetch meeting notes action - calls API to get meeting transcripts
	useCopilotAction({
		name: "fetchMeetingNotes",
		description:
			"Compatibility read of transcripts fetched by the current meeting selection. Does not start another fetch. Use the transcript text returned by select_meetings to edit the document.",
		parameters: [
			{
				name: "selectedMeetings",
				type: "object[]",
				attributes: [
					{ name: "joinUrl", type: "string", required: true },
					{ name: "startTime", type: "string", required: false },
				],
				description:
					"The selectedMeetings array returned by select_meetings. Pass it directly.",
				required: true,
			},
		],
		handler: async () =>
			meetingNotesFlow.result(
				genuineUserMessage(internalMessagesForToolCallMatcher)?.id,
			),
		render: ({ status, result }) => {
			if (
				status === "complete" &&
				typeof result === "string" &&
				result.startsWith("Error:")
			) {
				return (
					<div className="p-3 rounded-lg bg-destructive/10 border border-destructive/30 text-sm text-destructive">
						Failed to fetch meeting notes.
					</div>
				);
			}
			if (
				status === "complete" &&
				(result === MEETING_NOTES_SKIPPED_NONE_RESULT ||
					result === MEETING_NOTES_SKIPPED_TOO_MANY_RESULT)
			) {
				return (
					<div className="p-3 rounded-lg bg-muted/50 text-sm text-muted-foreground">
						{result === MEETING_NOTES_SKIPPED_NONE_RESULT
							? "No meetings were selected. Meeting notes were not fetched."
							: "Meeting notes were not fetched. Select at most 10 meetings."}
					</div>
				);
			}
			if (
				status === "complete" &&
				isMeetingNotesTranscriptResult(result)
			) {
				return (
					<div className="p-3 rounded-lg bg-green-50 dark:bg-green-950/30 text-sm">
						Meeting notes fetched successfully.
					</div>
				);
			}
			if (status === "complete") {
				return (
					<div className="p-3 rounded-lg bg-muted/50 text-sm text-muted-foreground">
						No meeting notes were fetched.
					</div>
				);
			}
			return (
				<div className="p-3 rounded-lg bg-muted/50 flex items-center gap-2 text-sm text-muted-foreground">
					<Loader2 className="h-4 w-4 animate-spin" />
					Fetching meeting notes...
				</div>
			);
		},
	});

	// === GitHub Repository Tools ===
	// These actions let the AI assistant read code, PRs, and issues from the
	// project's connected GitHub repository. Follows the fetchMeetingNotes pattern.
	// Auto-fills owner/repo from project settings so the user only needs to specify paths.

	useCopilotAction(
		{
			name: "github_get_file_contents",
			description: hasGitHub
				? `Read a file or list a directory from the project's GitHub repository (${repoOwner}/${repoName}). Use this to look at source code, configs, READMEs, etc. when editing documents. The owner and repo are auto-filled. Just provide the file path.`
				: "GitHub not connected.",
			parameters: [
				{
					name: "path",
					type: "string",
					description:
						"File or directory path in the repo (e.g. 'src/auth/middleware.ts' or 'src/')",
					required: true,
				},
				{
					name: "ref",
					type: "string",
					description:
						"Branch or commit SHA. Defaults to the project's default branch.",
					required: false,
				},
			],
			handler: async (args) => {
				if (!hasGitHub) {
					return "GitHub not connected to this project.";
				}
				try {
					const result =
						await orpcClient.projects.documents.executeGitHubTool({
							projectId,
							organizationId: organizationId ?? null,
							methodName: "get_file_contents",
							args: {
								owner: repoOwner,
								repo: repoName,
								path: args.path,
								ref: (args.ref as string) || repoBranch,
							},
						});
					const data = result.result as Record<string, unknown>;
					if (Array.isArray(data)) {
						const listing = (data as Array<Record<string, unknown>>)
							.map(
								(f) =>
									`${f.type === "dir" ? "dir" : "file"}  ${f.path}`,
							)
							.join("\n");
						return `DIRECTORY LISTING: ${args.path}\n\n${listing}`;
					}
					const content = (data.content as string) || "";
					const filePath = (data.path as string) || args.path;
					return `FILE: ${filePath}\n\n\`\`\`\n${content}\n\`\`\``;
				} catch (error) {
					return `Error reading file: ${error instanceof Error ? error.message : "Unknown error"}`;
				}
			},
			render: ({ status }) => {
				if (status === "complete") {
					return (
						<div className="p-3 rounded-lg bg-green-50 dark:bg-green-950/30 text-sm">
							File contents fetched from GitHub.
						</div>
					);
				}
				return (
					<div className="p-3 rounded-lg bg-muted/50 flex items-center gap-2 text-sm text-muted-foreground">
						<Loader2 className="h-4 w-4 animate-spin" />
						Reading from GitHub repository...
					</div>
				);
			},
		},
		[hasGitHub, repoOwner, repoName, repoBranch],
	);

	useCopilotAction(
		{
			name: "github_get_repository",
			description: hasGitHub
				? `Get repository metadata for ${repoOwner}/${repoName}. Returns description, language, topics, default branch, and last updated date.`
				: "GitHub not connected.",
			parameters: [],
			handler: async () => {
				if (!hasGitHub) {
					return "GitHub not connected to this project.";
				}
				try {
					const result =
						await orpcClient.projects.documents.executeGitHubTool({
							projectId,
							organizationId: organizationId ?? null,
							methodName: "get_repository",
							args: { owner: repoOwner, repo: repoName },
						});
					const repo = result.result as Record<string, unknown>;
					return [
						`REPOSITORY: ${repo.full_name || `${repoOwner}/${repoName}`}`,
						`Description: ${repo.description || "N/A"}`,
						`Language: ${repo.language || "N/A"}`,
						`Default branch: ${repo.default_branch || repoBranch || "unknown"}`,
						`Topics: ${(repo.topics as string[])?.join(", ") || "none"}`,
						`Last updated: ${repo.updated_at || "N/A"}`,
					].join("\n");
				} catch (error) {
					return `Error fetching repository info: ${error instanceof Error ? error.message : "Unknown error"}`;
				}
			},
			render: ({ status }) => {
				if (status === "complete") {
					return (
						<div className="p-3 rounded-lg bg-green-50 dark:bg-green-950/30 text-sm">
							Repository info fetched.
						</div>
					);
				}
				return (
					<div className="p-3 rounded-lg bg-muted/50 flex items-center gap-2 text-sm text-muted-foreground">
						<Loader2 className="h-4 w-4 animate-spin" />
						Fetching repository info...
					</div>
				);
			},
		},
		[hasGitHub, repoOwner, repoName],
	);

	useCopilotAction(
		{
			name: "github_list_pull_requests",
			description: hasGitHub
				? `List recent pull requests from ${repoOwner}/${repoName}. Useful for understanding recent changes and what's in progress.`
				: "GitHub not connected.",
			parameters: [
				{
					name: "state",
					type: "string",
					description:
						"Filter by state: 'open', 'closed', or 'all'. Defaults to 'open'.",
					required: false,
				},
			],
			handler: async (args) => {
				if (!hasGitHub) {
					return "GitHub not connected to this project.";
				}
				try {
					const result =
						await orpcClient.projects.documents.executeGitHubTool({
							projectId,
							organizationId: organizationId ?? null,
							methodName: "list_pull_requests",
							args: {
								owner: repoOwner,
								repo: repoName,
								state: (args.state as string) || "open",
								per_page: 15,
							},
						});
					const prs = result.result as Array<Record<string, unknown>>;
					if (!Array.isArray(prs) || prs.length === 0) {
						return "No pull requests found.";
					}
					const formatted = prs
						.map(
							(pr) =>
								`- #${pr.number} ${pr.title} (${pr.state}${pr.draft ? ", draft" : ""}) by ${pr.author || "unknown"} — ${pr.head} → ${pr.base}`,
						)
						.join("\n");
					return `PULL REQUESTS (${(args.state as string) || "open"}):\n\n${formatted}`;
				} catch (error) {
					return `Error fetching pull requests: ${error instanceof Error ? error.message : "Unknown error"}`;
				}
			},
			render: ({ status }) => {
				if (status === "complete") {
					return (
						<div className="p-3 rounded-lg bg-green-50 dark:bg-green-950/30 text-sm">
							Pull requests fetched from GitHub.
						</div>
					);
				}
				return (
					<div className="p-3 rounded-lg bg-muted/50 flex items-center gap-2 text-sm text-muted-foreground">
						<Loader2 className="h-4 w-4 animate-spin" />
						Fetching pull requests...
					</div>
				);
			},
		},
		[hasGitHub, repoOwner, repoName],
	);

	useCopilotAction(
		{
			name: "github_list_issues",
			description: hasGitHub
				? `List recent issues from ${repoOwner}/${repoName}. Useful for understanding bugs, feature requests, and open work items.`
				: "GitHub not connected.",
			parameters: [
				{
					name: "state",
					type: "string",
					description:
						"Filter by state: 'open', 'closed', or 'all'. Defaults to 'open'.",
					required: false,
				},
			],
			handler: async (args) => {
				if (!hasGitHub) {
					return "GitHub not connected to this project.";
				}
				try {
					const result =
						await orpcClient.projects.documents.executeGitHubTool({
							projectId,
							organizationId: organizationId ?? null,
							methodName: "list_issues",
							args: {
								owner: repoOwner,
								repo: repoName,
								state: (args.state as string) || "open",
								per_page: 15,
							},
						});
					const issues = result.result as Array<
						Record<string, unknown>
					>;
					if (!Array.isArray(issues) || issues.length === 0) {
						return "No issues found.";
					}
					const formatted = issues
						.map(
							(i) =>
								`- #${i.number} ${i.title} (${i.state}) [${(i.labels as string[])?.join(", ") || "no labels"}]`,
						)
						.join("\n");
					return `ISSUES (${(args.state as string) || "open"}):\n\n${formatted}`;
				} catch (error) {
					return `Error fetching issues: ${error instanceof Error ? error.message : "Unknown error"}`;
				}
			},
			render: ({ status }) => {
				if (status === "complete") {
					return (
						<div className="p-3 rounded-lg bg-green-50 dark:bg-green-950/30 text-sm">
							Issues fetched from GitHub.
						</div>
					);
				}
				return (
					<div className="p-3 rounded-lg bg-muted/50 flex items-center gap-2 text-sm text-muted-foreground">
						<Loader2 className="h-4 w-4 animate-spin" />
						Fetching issues...
					</div>
				);
			},
		},
		[hasGitHub, repoOwner, repoName],
	);

	// ── GitLab CopilotKit actions ───────────────────────────────────
	// Mirror the GitHub actions above but target GitLab API via executeGitLabTool

	useCopilotAction(
		{
			name: "gitlab_get_file_contents",
			description: hasGitLab
				? `Read a file or list a directory from the project's GitLab repository (${repoOwner}/${repoName}). Use this to look at source code, configs, READMEs, etc. when editing documents. Just provide the file path.`
				: "GitLab not connected.",
			parameters: [
				{
					name: "path",
					type: "string",
					description:
						"File or directory path in the repo (e.g. 'src/auth/middleware.ts' or 'src/')",
					required: true,
				},
				{
					name: "ref",
					type: "string",
					description:
						"Branch or commit SHA. Defaults to the project's default branch.",
					required: false,
				},
			],
			handler: async (args) => {
				if (!hasGitLab) {
					return "GitLab not connected to this project.";
				}
				try {
					const result =
						await orpcClient.projects.documents.executeGitLabTool({
							projectId,
							organizationId: organizationId ?? null,
							methodName: "get_file_contents",
							args: {
								project_id: gitlabProjectId,
								path: args.path,
								ref:
									(args.ref as string) ||
									repoBranch ||
									"HEAD",
							},
						});
					const data = result.result as Record<string, unknown>;
					if (Array.isArray(data)) {
						const listing = (data as Array<Record<string, unknown>>)
							.map(
								(f) =>
									`${f.type === "tree" ? "dir" : "file"}  ${f.path}`,
							)
							.join("\n");
						return `DIRECTORY LISTING: ${args.path}\n\n${listing}`;
					}
					const content = (data.content as string) || "";
					const filePath = (data.path as string) || args.path;
					return `FILE: ${filePath}\n\n\`\`\`\n${content}\n\`\`\``;
				} catch (error) {
					return `Error reading file: ${error instanceof Error ? error.message : "Unknown error"}`;
				}
			},
			render: ({ status }) => {
				if (status === "complete") {
					return (
						<div className="p-3 rounded-lg bg-green-50 dark:bg-green-950/30 text-sm">
							File contents fetched from GitLab.
						</div>
					);
				}
				return (
					<div className="p-3 rounded-lg bg-muted/50 flex items-center gap-2 text-sm text-muted-foreground">
						<Loader2 className="h-4 w-4 animate-spin" />
						Reading from GitLab repository...
					</div>
				);
			},
		},
		[hasGitLab, repoOwner, repoName, repoBranch, gitlabProjectId],
	);

	useCopilotAction(
		{
			name: "gitlab_get_project",
			description: hasGitLab
				? `Get project metadata for ${repoOwner}/${repoName} on GitLab. Returns description, default branch, topics, and last activity date.`
				: "GitLab not connected.",
			parameters: [],
			handler: async () => {
				if (!hasGitLab) {
					return "GitLab not connected to this project.";
				}
				try {
					const result =
						await orpcClient.projects.documents.executeGitLabTool({
							projectId,
							organizationId: organizationId ?? null,
							methodName: "get_project",
							args: { project_id: gitlabProjectId },
						});
					const proj = result.result as Record<string, unknown>;
					return [
						`PROJECT: ${proj.name_with_namespace || `${repoOwner}/${repoName}`}`,
						`Description: ${proj.description || "N/A"}`,
						`Default branch: ${proj.default_branch || repoBranch || "unknown"}`,
						`Topics: ${(proj.topics as string[])?.join(", ") || "none"}`,
						`Last activity: ${proj.last_activity_at || "N/A"}`,
					].join("\n");
				} catch (error) {
					return `Error fetching project info: ${error instanceof Error ? error.message : "Unknown error"}`;
				}
			},
			render: ({ status }) => {
				if (status === "complete") {
					return (
						<div className="p-3 rounded-lg bg-green-50 dark:bg-green-950/30 text-sm">
							Project info fetched from GitLab.
						</div>
					);
				}
				return (
					<div className="p-3 rounded-lg bg-muted/50 flex items-center gap-2 text-sm text-muted-foreground">
						<Loader2 className="h-4 w-4 animate-spin" />
						Fetching project info...
					</div>
				);
			},
		},
		[hasGitLab, repoOwner, repoName, gitlabProjectId],
	);

	useCopilotAction(
		{
			name: "gitlab_list_merge_requests",
			description: hasGitLab
				? `List recent merge requests from ${repoOwner}/${repoName} on GitLab. Useful for understanding recent changes and what's in progress.`
				: "GitLab not connected.",
			parameters: [
				{
					name: "state",
					type: "string",
					description:
						"Filter by state: 'opened', 'closed', 'merged', or 'all'. Defaults to 'opened'.",
					required: false,
				},
			],
			handler: async (args) => {
				if (!hasGitLab) {
					return "GitLab not connected to this project.";
				}
				try {
					const result =
						await orpcClient.projects.documents.executeGitLabTool({
							projectId,
							organizationId: organizationId ?? null,
							methodName: "list_merge_requests",
							args: {
								project_id: gitlabProjectId,
								state: (args.state as string) || "opened",
								per_page: 15,
							},
						});
					const mrs = result.result as Array<Record<string, unknown>>;
					if (!Array.isArray(mrs) || mrs.length === 0) {
						return "No merge requests found.";
					}
					const formatted = mrs
						.map(
							(mr) =>
								`- !${mr.iid} ${mr.title} (${mr.state}${mr.draft ? ", draft" : ""}) by ${mr.author || "unknown"} -- ${mr.source_branch} -> ${mr.target_branch}`,
						)
						.join("\n");
					return `MERGE REQUESTS (${(args.state as string) || "opened"}):\n\n${formatted}`;
				} catch (error) {
					return `Error fetching merge requests: ${error instanceof Error ? error.message : "Unknown error"}`;
				}
			},
			render: ({ status }) => {
				if (status === "complete") {
					return (
						<div className="p-3 rounded-lg bg-green-50 dark:bg-green-950/30 text-sm">
							Merge requests fetched from GitLab.
						</div>
					);
				}
				return (
					<div className="p-3 rounded-lg bg-muted/50 flex items-center gap-2 text-sm text-muted-foreground">
						<Loader2 className="h-4 w-4 animate-spin" />
						Fetching merge requests...
					</div>
				);
			},
		},
		[hasGitLab, repoOwner, repoName, gitlabProjectId],
	);

	useCopilotAction(
		{
			name: "gitlab_list_issues",
			description: hasGitLab
				? `List recent issues from ${repoOwner}/${repoName} on GitLab. Useful for understanding bugs, feature requests, and open work items.`
				: "GitLab not connected.",
			parameters: [
				{
					name: "state",
					type: "string",
					description:
						"Filter by state: 'opened', 'closed', or 'all'. Defaults to 'opened'.",
					required: false,
				},
			],
			handler: async (args) => {
				if (!hasGitLab) {
					return "GitLab not connected to this project.";
				}
				try {
					const result =
						await orpcClient.projects.documents.executeGitLabTool({
							projectId,
							organizationId: organizationId ?? null,
							methodName: "list_issues",
							args: {
								project_id: gitlabProjectId,
								state: (args.state as string) || "opened",
								per_page: 15,
							},
						});
					const issues = result.result as Array<
						Record<string, unknown>
					>;
					if (!Array.isArray(issues) || issues.length === 0) {
						return "No issues found.";
					}
					const formatted = issues
						.map(
							(i) =>
								`- #${i.iid} ${i.title} (${i.state}) [${(i.labels as string[])?.join(", ") || "no labels"}]`,
						)
						.join("\n");
					return `ISSUES (${(args.state as string) || "opened"}):\n\n${formatted}`;
				} catch (error) {
					return `Error fetching issues: ${error instanceof Error ? error.message : "Unknown error"}`;
				}
			},
			render: ({ status }) => {
				if (status === "complete") {
					return (
						<div className="p-3 rounded-lg bg-green-50 dark:bg-green-950/30 text-sm">
							Issues fetched from GitLab.
						</div>
					);
				}
				return (
					<div className="p-3 rounded-lg bg-muted/50 flex items-center gap-2 text-sm text-muted-foreground">
						<Loader2 className="h-4 w-4 animate-spin" />
						Fetching issues...
					</div>
				);
			},
		},
		[hasGitLab, repoOwner, repoName, gitlabProjectId],
	);

	// Regenerate document action - uses renderAndWaitForResponse to block the agent
	// until user accepts/rejects in RegenerationConfirmDialog
	useCopilotAction(
		{
			name: "regenerate_document",
			description:
				"Fully regenerate document content from scratch using AI with project context and RAG. Use this for major rewrites, not iterative edits.",
			parameters: [
				{
					name: "prompt",
					type: "string",
					description:
						"Instructions for what to generate (e.g., 'Regenerate the entire PRD with more technical details')",
					required: true,
				},
			],
			renderAndWaitForResponse: ({ args, respond, status }) => {
				// Always update respond ref to latest (it may change between renders)
				if (respond) {
					regenerationRespondRef.current = respond;
				}

				// Trigger regeneration only once when status is "executing"
				// Check both the ref AND state to prevent duplicate triggers
				if (
					status === "executing" &&
					!regenerationTriggeredRef.current &&
					!isRegenerating
				) {
					// Mark as triggered immediately to prevent race conditions
					regenerationTriggeredRef.current = true;
					// Clear any ackAt left over from a previous run — see the
					// comment on the same line in handleDirectRegenerate.
					regenerationAckAtRef.current = null;

					const prompt = args.prompt as string;

					// Capture baseline BEFORE regeneration starts
					const baselineContent =
						document?.content || currentDocumentRef.current;
					regenerationBaselineRef.current = baselineContent;

					// Start regeneration - use setTimeout to avoid state update during render
					setTimeout(async () => {
						setIsRegenerating(true);

						// Step 1: Embed contexts first (same pattern as wizard's DocumentGenerationStep)
						try {
							await embedContextsMutation.mutateAsync({
								projectId,
							});
						} catch (_error) {
							// Continue anyway - some contexts might already be embedded
						}

						// Step 2: Trigger regeneration workflow
						// Read prompt IDs from refs to avoid adding them as deps
						regenerateMutation.mutate({
							id: documentId,
							prompt,
							promptId: selectedPromptIdRef.current,
							promptVersionId: selectedPromptVersionIdRef.current,
						});
					}, 0);
				}

				// If status is "complete", don't show anything (action is done)
				if (status === "complete") {
					return (
						<div className="p-3 bg-muted/50 rounded-lg text-sm text-muted-foreground">
							Document regeneration completed.
						</div>
					);
				}

				// Show waiting UI - agent is blocked until respond() is called
				return (
					<div className="p-4 bg-muted rounded-lg">
						<div className="flex items-center gap-2">
							<div className="animate-spin rounded-full h-4 w-4 border-2 border-primary border-t-transparent" />
							<span className="text-muted-foreground">
								{isRegenerating
									? "Regenerating document... This may take a few minutes."
									: "Starting document regeneration..."}
							</span>
						</div>
						<p className="text-sm text-muted-foreground mt-2">
							A confirmation dialog will appear when the document
							is ready.
						</p>
					</div>
				);
			},
		},
		[isRegenerating, document?.content, documentId],
	);

	// Fizzy #1412 CopilotKit Option A — Tier 3 wire-up (extends PR #1240
	// StoryWorkspace integration to DocumentEditor). Persists a
	// `role: "system"` operation-result message into the underlying
	// AgentConversation when the user accepts or rejects the
	// `confirm_changes` dialog below.
	//
	// **Latest-ref pattern is REQUIRED here** (more so than in
	// StoryWorkspace) because this `useCopilotAction` registers with
	// an EMPTY dependency array `[]` (see the closing `[]` at the end
	// of the action options object below). Based on observed behavior
	// in CopilotKit 1.52.0 (not a documented API guarantee), an empty
	// deps array causes the library to cache the
	// `renderAndWaitForResponse` callback ONCE at first render — when
	// `activeAssistantConversationId` is still `null` (PersistenceHook
	// hasn't lazy-created yet) — and never refresh it. Without the
	// ref, every click would fire the helper's null-info-log path
	// forever; the operation-result would never persist. The ref
	// always points at the freshest closure with the resolved
	// conversationId. This is the same regression Copilot caught on
	// PR #1240; here it would manifest 100% of the time because the
	// deps array is empty.
	//
	// Two refs cover the two staleness vectors Codex round-2 flagged:
	//   - `recordOutcomeRef`: freshest helper callback so the
	//     conversationId flip is observed at click time.
	//   - `documentRef`: freshest document so a parent renaming the
	//     document mid-flow produces an accurate persisted summary.
	//
	// Both refs are updated via `useLayoutEffect` (not `useEffect`)
	// because passive effects run AFTER paint, leaving a narrow
	// window where a click event could fire with a stale ref payload
	// (Codex round-2 Important #1). `useLayoutEffect` runs
	// synchronously during the commit phase BEFORE paint, eliminating
	// that race. The fire-and-forget persistence here doesn't strictly
	// need that guarantee, but it costs nothing and keeps the wire-up
	// consistent with how other latest-ref patterns in this codebase
	// would behave if they ever became durable.
	const verdictFactory = useConfirmChangesVerdict({
		surface: "document",
		projectId,
	});
	const verdictFactoryRef = useRef(verdictFactory);
	verdictFactoryRef.current = verdictFactory;
	const recordConfirmChangesOutcome = useConfirmChangesOperationResult({
		conversationId: activeAssistantConversationId,
		projectId,
		organizationId: organizationId ?? null,
		operationLabel: "Confirm AI document changes",
	});
	const recordOutcomeRef = useRef(recordConfirmChangesOutcome);
	const documentRef = useRef(document);
	useLayoutEffect(() => {
		recordOutcomeRef.current = recordConfirmChangesOutcome;
	}, [recordConfirmChangesOutcome]);
	useLayoutEffect(() => {
		documentRef.current = document;
	}, [document]);

	// Confirmation action for agent changes
	// CRITICAL FIX: Use editor content with diff tags stripped, NOT agentState.document
	// The AI may return only partial content, but the editor has the full merged view
	// with diff highlighting. getEditorMarkdownForSave() strips diff tags and gives us
	// the final content (original - deletions + additions).
	useCopilotAction(
		{
			name: "confirm_changes",
			renderAndWaitForResponse: ({ args, respond, status }) => {
				const recordVerdict = verdictFactoryRef.current();
				// Every answer resumes the agent for one more short run, which the
				// editor waits out read-only: the status beside Save says so (see
				// `assistantAnswered`, Fizzy #2946).
				// Says what it answered: the card and the review bar stamp it as
				// the proposal's outcome.
				const answer = (result: { accepted: boolean }): boolean => {
					setAssistantAnswered(true);
					respond?.(result);
					return result.accepted;
				};
				const handleReject = () => {
					void recordVerdict(false);
					setHasPendingConfirm(false);
					confirmCallbacksRef.current = null;
					// Reject: Restore the baseline content — the document as it
					// stood before the assistant ran, slots included.
					const fallback =
						baselineRef.current || currentDocumentRef.current;
					applyProgrammaticContent(
						editorRef.current,
						fromMarkdown(fallback),
						"server",
					);
					setAgentState((prev) => ({
						...prev,
						document: fallback,
					}));
					// Fire-and-forget operation-result persistence (Tier 3).
					// Read via `recordOutcomeRef.current` (latest-ref pattern)
					// so the helper sees the freshest `conversationId` even
					// when the captured closure dates back to a pre-lazy-
					// create render.
					void recordOutcomeRef.current({ accepted: false });
					return answer({ accepted: false });
				};

				const handleAccept = () => {
					// Confirm: Get the merged content from editor (strips diff tags)
					const currentEditor = editorRef.current;
					const finalContent =
						getEditorMarkdownForSave(currentEditor);

					// Null means serialization failed outright
					// (distinct from a genuinely empty document, which is ""
					// and a legitimate save). Persisting null would write an
					// empty document. Surface an actionable error and resolve
					// the tool call cleanly (as a non-apply) so it never
					// dangles in "executing" — the editor is left untouched
					// for the user to copy from before reloading.
					if (finalContent === null) {
						toast.error(
							"Couldn't read the document content from the editor — nothing was saved. Copy any unsaved work and reload the page.",
						);
						setHasPendingConfirm(false);
						confirmCallbacksRef.current = null;
						void recordOutcomeRef.current({ accepted: false });
						return answer({ accepted: false });
					}

					// Never persist an extraction that came back empty against a
					// non-empty baseline (I4/RC3): even a legitimate "" read here
					// would silently wipe the document. Surface an actionable
					// error and resolve the tool call cleanly (as a non-apply) so
					// it never dangles in "executing" — the editor is left
					// untouched for the user to copy from before reloading.
					if (
						isEmptyExtractionAgainstBaseline(
							finalContent,
							baselineRef.current,
						)
					) {
						toast.error(
							"Couldn't read the document content from the editor — nothing was saved. Copy any unsaved work and reload the page.",
						);
						setHasPendingConfirm(false);
						confirmCallbacksRef.current = null;
						void recordOutcomeRef.current({ accepted: false });
						return answer({ accepted: false });
					}

					void recordVerdict(true);

					setHasPendingConfirm(false);
					confirmCallbacksRef.current = null;

					// An accepted assistant proposal: the editor's slots as they
					// stand now — one placed while the proposal was pending
					// included — are what get applied and saved.
					const acceptedContent =
						applyProgrammaticContent(
							currentEditor,
							finalContent,
							"assistant",
						) ?? finalContent;
					// The body the proposal's review started from (Fizzy
					// #2946): `baselineRef`, which follows the editor until a
					// proposal arms, and is kept while it is reviewed.
					const acceptedFrom = baselineRef.current;
					setCurrentDocument(acceptedContent);
					baselineRef.current = acceptedContent;
					setAgentState((prev) => ({
						...prev,
						document: acceptedContent,
					}));

					// The spliced slots are right only for the version the editor
					// last synced with: when a slot is involved, guard the save
					// with it, so a slot another writer added or deleted in
					// between is neither lost nor resurrected — the save is
					// refused instead. A slot-free accept keeps the unguarded
					// save it always had.
					const expectedVersion =
						hasVisualSlots(finalContent) ||
						hasVisualSlots(acceptedContent)
							? editorBodyVersionRef.current
							: undefined;
					// Accepted here, so it counts as this editor's own edit
					// (Fizzy #2946): a save of it that fails, or that cannot
					// go yet, leaves it unsaved — dirty, and sent on leaving
					// the page — rather than held only by the room. The
					// save below covers it once it lands. It is put in without
					// the dirty check a keystroke schedules, so it reads as
					// unsaved from here.
					localEditCountRef.current += 1;
					noteTypedSinceSave();
					setHasUnsavedChanges(true);
					// Fire-and-forget operation-result persistence (Tier 3),
					// recorded once the save is answered, never before
					// (Fizzy #2946): the chat is answered at once, and its
					// record says what became of the accepted text — saved,
					// refused, or kept unsaved in the editor. Exactly one
					// record per accept, under one key made now: the helper
					// holds back only a call with the same key, so a reject of
					// another proposal recorded meanwhile never swallows it,
					// and the server's per-key dedup covers a retried request.
					// Read via `recordOutcomeRef.current` (latest-ref pattern)
					// so the helper sees the freshest `conversationId` when
					// the answer arrives; see the hook-call doc comment above
					// for the empty-deps caching rationale.
					const acceptOperationKey = crypto.randomUUID();
					let outcomeRecorded = false;
					const recordOutcome = (options: RecordOnResolveOptions) => {
						if (outcomeRecorded) {
							return;
						}
						outcomeRecorded = true;
						void recordOutcomeRef.current({
							...options,
							operationKey: acceptOperationKey,
						});
					};
					const recordUnsaved = () =>
						recordOutcome({
							accepted: true,
							outcome: "partial",
							summary: ACCEPT_OUTCOME_SUMMARIES.unsaved,
						});
					const recordFailed = (failure: DirectSaveFailure) =>
						recordOutcome({
							accepted: true,
							outcome: "failure",
							summary:
								failure === "offeredToCopy"
									? ACCEPT_OUTCOME_SUMMARIES.failedOfferedToCopy
									: failure === "editorClosed"
										? ACCEPT_OUTCOME_SUMMARIES.failedEditorClosed
										: ACCEPT_OUTCOME_SUMMARIES.failed,
						});
					// Taken back in the editor while its save still waited: it
					// was never sent, and the editor's own text went instead.
					// Recorded as declined, not as a failure (Fizzy #2946).
					const recordUndone = () =>
						recordOutcome({
							accepted: false,
							summary: ACCEPT_OUTCOME_SUMMARIES.undone,
						});
					// No answer of its own says what became of it — it was
					// dropped after the save it waited for failed, or not
					// sent: it is unsaved in the editor, unless the editor is
					// gone (Fizzy #2946). After the page was left, the save
					// on leaving carried it and offered it to copy when that
					// did not land; without one it went nowhere. A closed
					// single-user editor offers nothing.
					const recordNotSent = () => {
						if (pageLeft()) {
							recordFailed(
								leaveContentRef.current !== null
									? "offeredToCopy"
									: "editorClosed",
							);
						} else if (editorClosed()) {
							recordFailed("editorClosed");
						} else {
							recordUnsaved();
						}
					};
					// With the room flag every accept names its whole base
					// (Fizzy #2946), which covers the slots as well.
					const base = resolveSaveBaseRef.current();
					if (base === "unavailable") {
						// The room has no stamp yet: the accepted body stays in
						// the editor, unsaved, and the autosave takes it once
						// the room has one. Never silent.
						toast.info(tRun("saveBlocked.updatingToLatest"));
						recordUnsaved();
						return answer({ accepted: true });
					}

					// A confirm-initiated save, so its outcome is surfaced
					// (version bump / no-op / error) instead of silent. It
					// waits for a save in flight, and names the base that
					// save's answer produced.
					startTransition(() => {
						sendDirectSaveRef.current({
							confirm: true,
							// The editor's body with the proposal in it.
							savesEditor: acceptedContent,
							accept: {
								from: acceptedFrom,
								onUndone: recordUndone,
							},
							build: (sendBase) =>
								buildDocumentSaveInput({
									projectId,
									documentId,
									content: acceptedContent,
									isManualSave: false,
									base: sendBase,
									expectedVersion:
										expectedVersion === undefined
											? undefined
											: editorBodyVersionRef.current,
								}),
							onUnavailable: () => {
								toast.info(
									tRun("saveBlocked.updatingToLatest"),
								);
								recordNotSent();
							},
							onSaved: () => {
								recordOutcome({
									accepted: true,
									summary: ACCEPT_OUTCOME_SUMMARIES.saved,
								});
								// The room takes the saved body's stamp as
								// for any save.
								return undefined;
							},
							// Refused: the text is still in the editor, or —
							// the page left, the room brought back to the
							// saved document — it was offered to copy, or the
							// single-user editor holding it was closed.
							onFailed: recordFailed,
							// Settled without an answer of its own — dropped
							// after the save it waited for failed, or not sent
							// again after a CONFLICT. After an answer, this
							// adds nothing.
							onSettled: recordNotSent,
						});
					});
					return answer({ accepted: true });
				};

				// Deterministic confirm delivery (RC2). The action render closure
				// is stale under empty deps, so read the freshest proposed document
				// from `agentDocumentRef` and process each executing confirm once.
				if (status === "executing") {
					if (!confirmArmedRef.current) {
						confirmArmedRef.current = true;
						const proposedDoc = agentDocumentRef.current ?? "";
						const baseline = baselineRef.current;
						const noOp = isNoOpProposedContent(
							proposedDoc,
							toAgentDocument(baseline),
						);
						confirmNoOpRef.current = noOp;
						if (noOp) {
							// No-op gate (I1): never present an actionable card for an
							// unchanged document (a bare model-initiated confirm, or an
							// edit that collapsed to baseline). Resolve the tool call
							// like a reject and inform the user — once.
							confirmCallbacksRef.current = null;
							queueMicrotask(() => {
								toast.info(
									"No updates found — the document is unchanged.",
								);
								void recordOutcomeRef.current({
									accepted: false,
								});
								answer({ accepted: false });
							});
						} else {
							confirmCallbacksRef.current = {
								accept: handleAccept,
								reject: handleReject,
							};
							queueMicrotask(() => {
								// Apply the reviewed diff from the arming path (I2/RC2)
								// so delivery no longer hinges on Effect 2's microtask
								// beating Effect 4's write-back. Idempotent with Effect
								// 2 — skip when the editor already shows the merge.
								const currentEditor = editorRef.current;
								if (currentEditor) {
									const editorMarkdown =
										getEditorMarkdownForSave(currentEditor);
									// Null means serialization
									// failed — treat like "not already merged"
									// so the diff overlay below still applies
									// rather than comparing against a failed read.
									// Compared with the slots spliced in, as the
									// application below would write them — else a
									// document with visual slots never reads as
									// merged when the model left the tags out.
									const editorAlreadyMerged =
										editorMarkdown !== null &&
										editorMarkdown !== "" &&
										normalizeForComparison(
											toAgentDocument(editorMarkdown),
										) ===
											normalizeForComparison(
												preserveEditorVisualSlots(
													currentEditor,
													proposedDoc,
												),
											);
									if (!editorAlreadyMerged) {
										isDiffReviewEditRef.current = true;
										applyProgrammaticContent(
											currentEditor,
											proposedDoc,
											"assistant",
											{
												render: (preserved) =>
													fromMarkdown(
														diffKeepingVisualSlotsWhole(
															baseline,
															preserved,
															true,
														),
													),
											},
										);
										isDiffReviewEditRef.current = false;
									}
								}
								setHasPendingConfirm(true);
							});
						}
					}
				} else {
					// Tool call resolved — allow the next confirm cycle to re-arm.
					confirmArmedRef.current = false;
					confirmNoOpRef.current = false;
				}

				// A no-op confirm renders nothing actionable — it is resolved above.
				if (confirmNoOpRef.current) {
					return <>{null}</>;
				}

				return (
					<ConfirmChanges
						recordVerdict={recordVerdict}
						args={args}
						respond={respond}
						status={status}
						onMount={() => {
							// Mounted again while its call is executing — the
							// chat's row was keyed anew — the card's leaving
							// took the review bar's callbacks with it: they come
							// back with it (Fizzy #2946).
							confirmCallbacksRef.current = {
								accept: handleAccept,
								reject: handleReject,
							};
							setHasPendingConfirm(true);
						}}
						onDone={() => {
							setHasPendingConfirm(false);
							confirmCallbacksRef.current = null;
						}}
						onReject={handleReject}
						onConfirm={handleAccept}
						outcomeAuditRef={diffOutcomeAuditRef}
					/>
				);
			},
		},
		[],
	);

	// AI Diagram Suggestion action - analyzes content and suggests Mermaid diagrams
	useCopilotAction(
		{
			name: "suggest_diagram",
			description:
				"Suggest a Mermaid diagram that could help illustrate part of the document. " +
				"Analyze the document content for architecture descriptions, workflows, data flows, " +
				"entity relationships, or process steps that would benefit from a visual diagram. " +
				"Generate the Mermaid code and insert it at the cursor position. " +
				"Use calm, advisory language -- never claim the diagram is optimal or required.",
			parameters: [
				{
					name: "diagramType",
					type: "string",
					description:
						"The type of Mermaid diagram to generate (flowchart, sequence, classDiagram, erDiagram, mindmap, C4Context, C4Container, stateDiagram, gantt)",
					required: true,
				},
				{
					name: "mermaidCode",
					type: "string",
					description:
						"The complete Mermaid diagram code to insert. Must be valid Mermaid syntax.",
					required: true,
				},
				{
					name: "rationale",
					type: "string",
					description:
						"A brief, advisory explanation of why this diagram might be helpful for the document. Use neutral language.",
					required: true,
				},
			],
			handler: async (args) => {
				const mermaidCode = args.mermaidCode as string;

				if (!editor) {
					return "Editor is not available. The diagram was not inserted.";
				}

				// Insert Mermaid code block at cursor via the editor
				// The MermaidBlock extension will render it as a diagram
				editor
					.chain()
					.focus()
					.insertContent({
						type: "mermaidBlock",
						attrs: { content: mermaidCode },
					})
					.run();

				return `Diagram inserted. ${args.rationale}`;
			},
			render: ({ args, status }) => {
				if (status === "complete") {
					return (
						<div className="p-3 rounded-lg bg-muted/50 text-sm text-muted-foreground">
							<span className="font-medium text-foreground">
								Diagram added
							</span>{" "}
							&mdash;{" "}
							{(args.rationale as string) ||
								"A diagram has been placed in the document."}
						</div>
					);
				}
				return (
					<div className="p-3 rounded-lg bg-muted/50 flex items-center gap-2 text-sm text-muted-foreground">
						<Loader2 className="h-4 w-4 animate-spin" />
						Preparing diagram...
					</div>
				);
			},
		},
		[editor],
	);

	// Safety check: if collaboration prerequisites aren't ready, show loading
	// This handles edge cases with React concurrent rendering where guards may pass
	// but props become stale during render
	if (!isCollabPrerequisitesReady) {
		console.warn(
			"[DocumentEditorInner] Collaboration prerequisites not ready",
		);
		return (
			<div className="flex items-center justify-center h-96">
				<div className="flex flex-col items-center gap-3 text-muted-foreground">
					<Loader2 className="h-8 w-8 animate-spin" />
					<span>Initializing collaboration...</span>
				</div>
			</div>
		);
	}

	// Suggestion chips shown in the chat sidebar
	const suggestions = [
		{
			title: "Update from meeting notes",
			message:
				"Update this document with insights from my recent meetings. Show me the meeting selector so I can choose which meetings to include.",
		},
		{
			title: "Expand technical details",
			message: "Add more technical details to the architecture section",
		},
		{
			title: "Add implementation details",
			message:
				"Add implementation details, constraints, and assumptions to the relevant sections without regenerating the whole document.",
		},
		{
			title: "Fill missing sections",
			message:
				"Identify thin or missing sections and expand them in place with concrete details, examples, and edge cases.",
		},
		{
			title: "Suggest a diagram",
			message:
				"Analyze this document and suggest a Mermaid diagram that could help illustrate the architecture, workflow, or relationships described in the content.",
		},
	];

	return (
		<MentionStatusContext.Provider value={activeIdsSet}>
			<AttachmentRegistryProvider
				pendingAttachmentsRef={pendingAttachmentsRef}
				initialAttachmentsByMessageId={initialAttachmentsByMessageId}
			>
				<DocumentAssistantOutcomesProvider
					documentRefKind={documentRefKind}
					documentRefId={documentId}
					projectId={projectId}
					organizationId={organizationId ?? null}
				>
					<HydratedMessagesProvider
						initialMessages={effectiveAssistantMessages ?? []}
						ssrConversationId={effectiveSsrConversationId}
						activeConversationId={activeAssistantConversationId}
						documentRefKind={documentRefKind}
						documentRefId={documentId}
						projectId={projectId}
						organizationId={organizationId ?? null}
					>
						<CopilotReplyRatingSidebar
							enabled={documentAssistantHistoryEnabled}
							featureKey={
								featureKeyForAgentId(
									"project_document_generator",
								) ?? "document-generation"
							}
							projectId={projectId}
							AssistantMessage={AssistantMessageWithMark}
							UserMessage={CopilotUserMessage}
							Messages={CustomMessages}
							defaultOpen={false}
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
								title: "AI Assistant",
								initial:
									"Hi! I can help you edit this document in place. Try asking me to:\n\n• Expand a specific section\n• Add technical details, examples, or edge cases\n• Fill in missing sections or clarify requirements\n• Draw an Excalidraw diagram (architecture, flow, etc.)\n\nUse the 'Regenerate' button above the editor only for full document regeneration.",
							}}
							suggestions={suggestions}
						>
							{/* Group H — persists each terminal-state CopilotKit
				    message via `appendTurnForDocument` (FR-2,
				    AC-5/AC-6/AC-7). Side-effect-only component (renders
				    `null`). Mounted inside <CopilotSidebar> so the
				    `useCopilotChatInternal` hook resolves against the
				    same provider the sidebar consumes. Gated on the
				    feature flag to mirror the sidebar header + history
				    drawer mounts. */}
							{documentAssistantHistoryEnabled ? (
								<CopilotPersistenceHook
									documentRefKind={documentRefKind}
									documentRefId={documentId}
									projectId={projectId}
									organizationId={organizationId ?? null}
									conversationId={
										activeAssistantConversationId
									}
									onConversationIdResolved={
										setActiveAssistantConversationId
									}
									onSpilled={setActiveAssistantConversationId}
									requestedVisibility={
										activeAssistantVisibility
									}
									agentId="project_document_generator"
									pendingAttachmentsRef={
										pendingAttachmentsRef
									}
									initialPersistedMessageIds={
										effectivePersistedMessageIds
									}
								/>
							) : null}
							<div className="flex flex-col h-full">
								{/* Header */}
								<div className="relative flex items-center justify-between px-6 py-2 border-b bg-background gap-4">
									{/* AI Generating Indicator - Centered when active */}
									{isUserGenerationActive &&
									!hasPendingConfirm ? (
										<>
											{/* Shimmer progress line at bottom of header */}
											<div className="absolute bottom-0 left-0 right-0 h-0.5 overflow-hidden">
												<div className="generating-shimmer-line" />
											</div>
											<div className="flex-1 flex justify-center">
												<div className="flex items-center gap-2.5 px-5 py-2 rounded-full bg-foreground shadow-md">
													<FabricLogo
														className="size-3.5 opacity-80"
														size={14}
														variant="inverse"
													/>
													<span className="text-sm font-medium text-background">
														Generating
													</span>
													<span className="flex items-center gap-1">
														<span className="size-1.5 rounded-full bg-background/40 animate-bounce [animation-delay:0ms]" />
														<span className="size-1.5 rounded-full bg-background/40 animate-bounce [animation-delay:150ms]" />
														<span className="size-1.5 rounded-full bg-background/40 animate-bounce [animation-delay:300ms]" />
													</span>
												</div>
											</div>
										</>
									) : (
										<>
											{/* The page-level header (lines 1 & 2) already carries the
								  document title and document-type chip, so this row carries
								  prompt-related controls (selector + Manage Prompts gear +
								  Regenerate + Update using context) flush-LEFT, sitting
								  underneath the document type on Line 3. */}
											<div className="flex items-center gap-2 min-w-0 flex-1 justify-start">
												<div className="flex min-w-0 lg:flex-initial">
													{promptSelectorReplacement ?? (
														<PromptSelector
															agentName="project_document_generator"
															documentType={
																document.type
															}
															projectId={
																projectId
															}
															value={
																selectedPromptId
															}
															onValueChange={
																setSelectedPromptId
															}
															onPromptVersionChange={
																setSelectedPromptVersionId
															}
															disabled={
																isSaving ||
																isRegenerating
															}
															placeholder="Use default prompt"
															// Always show the "Update Binding" action so
															// users can re-bind their prompt selection as
															// the default for this document type. The
															// action bar is lean enough now that there's
															// always room for it.
															showBindAction={
																true
															}
															// PromptSelector renders its own Manage
															// Prompts gear inline. Action slot on Line 3
															// no longer mirrors this control — it lives
															// here next to the selector where prompt-
															// management actions belong.
															hideManagePromptsAction={
																false
															}
															// Compact sizing matches the 32-px buttons in
															// the prompt row (Line 4) — non-doc-editor
															// usages (form contexts in ExistingProjectFlow
															// etc.) keep the default Radix h-9/text-base.
															compact={true}
														/>
													)}
												</div>

												{/* Spacer pushes Regenerate + Update using
									  context to the right edge of the row so the
									  prompt-related cluster (selector + Manage
									  Prompts gear + Update Binding) stays
									  flush-left underneath the document type. */}
												<div className="flex-1" />

												{/* Wide tier: inline action buttons.
									  Normally shown at lg+ (1024). When the AI sidebar
									  is expanded the *available* width shrinks by 28rem
									  (448px) on top of the 72px nav rail, so even at
									  the xl breakpoint (1280) only ~760px is left —
									  not enough for the full inline tier. We bump to
									  2xl (1536) for the wide tier in that case so the
									  overflow menu kicks in earlier. */}
												<div
													className={`items-center gap-2 ${
														isAiSidebarExpanded
															? "hidden 2xl:flex"
															: "hidden lg:flex"
													}`}
												>
													<TooltipProvider>
														<Tooltip>
															<TooltipTrigger
																asChild
															>
																<Button
																	type="button"
																	variant="outline"
																	size="sm"
																	onClick={
																		handleDirectRegenerate
																	}
																	disabled={
																		isSaving ||
																		isRegenerating ||
																		isGenerationRunning
																	}
																	className="h-8 gap-1.5 text-xs"
																>
																	<RefreshCw
																		className={`size-3 ${isRegenerating ? "animate-spin" : ""}`}
																	/>
																	<span className="hidden xl:inline">
																		Regenerate
																	</span>
																</Button>
															</TooltipTrigger>
															<TooltipContent>
																{isWaitingForContext ? (
																	<p>
																		{tTooltips(
																			"generationQueued",
																		)}
																	</p>
																) : (
																	<>
																		<p>
																			Regenerate
																			the
																			entire
																			document
																			using
																			AI
																		</p>
																		<p className="text-xs text-muted-foreground">
																			Uses
																			Temporal
																			workflow
																			for
																			reliable
																			processing
																		</p>
																	</>
																)}
															</TooltipContent>
														</Tooltip>
													</TooltipProvider>
													<TooltipProvider>
														<Tooltip>
															<TooltipTrigger
																asChild
															>
																<Button
																	type="button"
																	variant="outline"
																	size="sm"
																	onClick={() =>
																		void contextUpdate.start()
																	}
																	disabled={
																		isSaving ||
																		isRegenerating ||
																		isGenerationRunning ||
																		contextUpdate.isActive ||
																		viewMode ===
																			"raw"
																	}
																	className="h-8 gap-1.5 text-xs"
																>
																	{contextUpdate.isLoading ? (
																		<Loader2 className="size-3 animate-spin" />
																	) : (
																		<RefreshCcwDotIcon className="size-3" />
																	)}
																	<span className="hidden xl:inline">
																		Update
																		using
																		context
																	</span>
																</Button>
															</TooltipTrigger>
															<TooltipContent>
																<p>
																	Update this
																	document
																	with the
																	latest
																	context
																</p>
																<p className="text-xs text-muted-foreground">
																	{viewMode ===
																	"raw"
																		? "Switch to Rich mode to review proposed changes"
																		: "Reviews recent meeting transcripts and team messages"}
																</p>
															</TooltipContent>
														</Tooltip>
													</TooltipProvider>
													{enableCollaboration &&
														!actionSlot && (
															<CollaborationStatus
																isConnected={
																	isCollabConnected
																}
																isSynced={
																	isCollabSynced
																}
																collaborators={
																	collaborators ??
																	[]
																}
															/>
														)}
												</div>

												{/* Narrow tier: overflow menu — visible at the
									  same widths the wide tier hides. */}
												<div
													className={`flex ${
														isAiSidebarExpanded
															? "2xl:hidden"
															: "lg:hidden"
													}`}
												>
													{enableCollaboration &&
														!actionSlot && (
															<CollaborationStatus
																isConnected={
																	isCollabConnected
																}
																isSynced={
																	isCollabSynced
																}
																collaborators={
																	collaborators ??
																	[]
																}
															/>
														)}
													<DropdownMenu>
														<TooltipProvider>
															<Tooltip>
																<TooltipTrigger
																	asChild
																>
																	<DropdownMenuTrigger
																		asChild
																	>
																		<Button
																			type="button"
																			variant="outline"
																			size="sm"
																			aria-label="More document actions"
																			disabled={
																				isSaving
																			}
																		>
																			<MoreHorizontalIcon className="h-4 w-4" />
																		</Button>
																	</DropdownMenuTrigger>
																</TooltipTrigger>
																<TooltipContent>
																	<p>
																		More
																		document
																		actions
																	</p>
																</TooltipContent>
															</Tooltip>
														</TooltipProvider>
														<DropdownMenuContent
															align="end"
															className="w-56"
														>
															{/* Same gate as the wide-tier button
																above — this is that action at a
																narrower breakpoint, not a second
																opinion on it. */}
															<DropdownMenuItem
																onSelect={() =>
																	handleDirectRegenerate()
																}
																disabled={
																	isSaving ||
																	isRegenerating ||
																	isGenerationRunning
																}
															>
																<RefreshCw
																	className={`mr-2 h-4 w-4 ${isRegenerating ? "animate-spin" : ""}`}
																/>
																Regenerate
															</DropdownMenuItem>
															<DropdownMenuItem
																onSelect={() =>
																	void contextUpdate.start()
																}
																disabled={
																	isSaving ||
																	isRegenerating ||
																	isGenerationRunning ||
																	contextUpdate.isActive ||
																	viewMode ===
																		"raw"
																}
															>
																{contextUpdate.isLoading ? (
																	<Loader2 className="mr-2 h-4 w-4 animate-spin" />
																) : (
																	<RefreshCcwDotIcon className="mr-2 h-4 w-4" />
																)}
																Update using
																context
															</DropdownMenuItem>
														</DropdownMenuContent>
													</DropdownMenu>
												</div>
											</div>
										</>
									)}
								</div>

								{/* Toolbar - Only show in rich mode. Visual-slot
								    insert controls (toolbar and slash command)
								    need the Glossy gate and an eligible type. */}
								{viewMode === "rich" && (
									<VisualSlotControlsGate
										editor={editor}
										documentType={document.type}
									>
										{(visualSlots) => (
											<EditorToolbar
												editor={editor}
												onImageUpload={
													handleImageUpload
												}
												visualSlots={visualSlots}
											/>
										)}
									</VisualSlotControlsGate>
								)}

								{/* Non-blocking banner when generation progress overlay is dismissed */}
								{isProgressDismissed &&
									isGenerationRunning &&
									(!document.content ||
										document.content.trim().length ===
											0) && (
										<div className="mx-6 mt-4 flex items-center justify-between rounded-lg border border-primary/20 bg-primary/5 px-4 py-2.5 text-xs text-primary">
											<div className="flex items-center gap-2">
												{/* A queued run is not in progress, and
													saying so with a spinner would claim
													work that has not begun. */}
												{document.status ===
												"QUEUED" ? (
													<>
														<ClockIcon className="h-3.5 w-3.5 motion-safe:animate-pulse" />
														<span>
															Waiting on the
															project's context
															work before
															generating...
														</span>
													</>
												) : (
													<>
														<Loader2 className="h-3.5 w-3.5 animate-spin" />
														<span>
															Document generation
															in progress...
														</span>
													</>
												)}
											</div>
											<div className="flex items-center gap-2">
												<Button
													size="sm"
													variant="ghost"
													className="h-6 px-2 text-xs text-primary hover:text-primary"
													onClick={() =>
														setIsProgressDismissed(
															false,
														)
													}
												>
													Show Progress
												</Button>
												{(() => {
													// Status first: a QUEUED
													// document is waiting, not
													// stalled, so it is never
													// offered a retry.
													const isStale =
														isDocumentGenerationStale(
															document?.status,
															document?.generationStartedAt,
															document?.updatedAt,
														);
													if (!isStale) {
														return null;
													}
													return (
														<Button
															size="sm"
															variant="outline"
															className="h-6 px-2 text-xs border-primary/30"
															disabled={
																isRegenerating
															}
															onClick={
																handleDirectRegenerate
															}
														>
															Retry
														</Button>
													);
												})()}
											</div>
										</div>
									)}

								{/* Generation & Regeneration Progress Overlay.
									QUEUED counts: a document waiting on the project's
									context work has no content yet either, and gating
									on GENERATING alone left it staring at an empty
									editor with nothing saying why. */}
								{!suppressGenerationOverlay &&
									!isProgressDismissed &&
									!showImportedRegenWarning &&
									((isRegenerating && !showConfirmDialog) ||
										(isGenerationRunning &&
											(!document.content ||
												document.content.trim()
													.length === 0))) && (
										<div className="fixed inset-0 bg-background/80 backdrop-blur-sm z-40 flex items-center justify-center p-4">
											<DocumentGenerationProgress
												status={
													document?.status ||
													"GENERATING"
												}
												progress={
													document?.generationProgress ??
													0
												}
												title={document?.title}
												error={
													document?.generationError
												}
												generationStartedAt={
													document?.generationStartedAt
												}
												updatedAt={document?.updatedAt}
												onRetry={handleDirectRegenerate}
												onDismiss={() =>
													setIsProgressDismissed(true)
												}
												isRetrying={isRegenerating}
												isRegenerating={isRegenerating}
											/>
										</div>
									)}

								{/* Failed-generation notice — surfaces a persisted FAILED
					    status so a failed generation isn't shown as an empty
					    "saved" document with no error (Business Case QA, AC-7). */}
								{document?.status === "FAILED" &&
									!isRegenerating &&
									!showConfirmDialog &&
									!showImportedRegenWarning && (
										<DocumentGenerationFailedNotice
											error={document.generationError}
											onRetry={handleDirectRegenerate}
											isRetrying={isRegenerating}
										/>
									)}

								{/* Warning dialog before regeneration */}
								{showImportedRegenWarning &&
									(() => {
										const docSource = (document as any)
											?.source as string | undefined;
										const isImported =
											docSource === "IMPORTED" ||
											docSource === "EXTERNAL";
										return (
											<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
												<div className="bg-card border border-border rounded-lg p-6 shadow-2xl max-w-md mx-4">
													<div className="flex items-center gap-2 mb-3">
														<AlertTriangle className="h-5 w-5 text-highlight" />
														<h3 className="text-lg font-semibold">
															{isImported
																? "Regenerate Imported Document?"
																: "Regenerate this document?"}
														</h3>
													</div>
													{isImported && (
														<p className="text-sm text-muted-foreground mb-3">
															{docSource ===
															"EXTERNAL"
																? "This document was imported from an external source."
																: "This document was imported from an uploaded file."}
														</p>
													)}
													<p className="text-sm mb-3">
														Regenerating will
														replace the current
														content with a new
														AI-generated version
														using all your project
														context. You'll be able
														to accept or reject the
														result after generation.
													</p>
													<div className="p-3 bg-muted rounded-lg mb-4">
														<p className="text-sm text-muted-foreground">
															{isImported
																? "Your imported version will be preserved in version history."
																: "Your current content will be saved to version history before being replaced."}
														</p>
													</div>
													<div className="flex justify-end gap-2">
														<Button
															variant="outline"
															size="sm"
															onClick={() =>
																setShowImportedRegenWarning(
																	false,
																)
															}
														>
															Cancel
														</Button>
														<Button
															size="sm"
															onClick={
																handleDirectRegenerate
															}
														>
															<RefreshCw className="mr-2 h-4 w-4" />
															Regenerate
														</Button>
													</div>
												</div>
											</div>
										);
									})()}

								{/* Confirmation Dialog for Regenerated Content */}
								{showConfirmDialog && (
									<RegenerationConfirmDialog
										previousContent={previousContent}
										newContent={newContent}
										onAccept={() => {
											// A newer write superseded the body
											// under review: keep it, put nothing
											// older on screen (Fizzy #2946).
											if (reviewSuperseded()) {
												closeSupersededReview(
													supersededByRunOnly()
														? "reviewSupersededByRun"
														: "reviewSuperseded",
													document,
												);
												return;
											}
											reviewDecidedRef.current = true;
											// Accept new content
											startTransition(() => {
												const html =
													fromMarkdown(newContent);

												// Deferred out of this handler, not to
												// the next frame, which a background tab
												// holds back (Fizzy #2946). The stored
												// regenerated body — the workflow already
												// carried the visual slots over. It lands
												// in the editor on screen by then. With
												// its stamp, and not again over a room
												// that holds it, or a later body,
												// already; the editor that writes it
												// takes it as its saved body.
												const reviewStamp =
													runState.reviewStampRef
														.current;
												const acceptedBody = newContent;
												queueMicrotask(() => {
													if (
														roomHoldsSavedBody(
															reviewStamp,
														)
													) {
														return;
													}
													if (
														applyToLiveEditor(
															html,
															reviewStamp,
														) &&
														roomStampsOn &&
														reviewStamp
													) {
														adoptSavedBody(
															acceptedBody,
															reviewStamp,
														);
													}
												});

												// Update local state only - DO NOT call setAgentState for direct regeneration
												// Calling setAgentState triggers CopilotKit which causes the AI response to appear
												setCurrentDocument(newContent);

												// Only update agent state for agent-based regeneration (has respond ref)
												if (
													regenerationRespondRef.current
												) {
													// IMPORTANT: Preserve ragContexts and projectContext
													setAgentState((prev) => ({
														...prev,
														document: newContent,
														streamingContent:
															newContent,
													}));
													regenerationRespondRef.current(
														{
															accepted: true,
														},
													);
													regenerationRespondRef.current =
														null;
												}

												setShowConfirmDialog(false);
												regenerationTriggeredRef.current = false;
												// Keep isDirectRegenerationRef true a bit longer to prevent any async effects
												setTimeout(() => {
													isDirectRegenerationRef.current = false;
												}, 500);

												// Reset confirming flag after a delay
												setTimeout(() => {
													setIsConfirming(false);
												}, 1000);

												toast.success(
													tRun(
														"regenerationAccepted",
													),
												);
											});
										}}
										onReject={() => {
											// A newer write superseded the body
											// under review: rewinding would
											// revert that write, so nothing is
											// sent and nothing changes on screen
											// (Fizzy #2946).
											const reviewedVersion =
												runState.reviewedVersionRef
													.current;
											if (
												reviewedVersion === null ||
												reviewSuperseded()
											) {
												closeSupersededReview(
													supersededByRunOnly()
														? "rejectRunLive"
														: "rejectReviewStale",
													document,
												);
												return;
											}
											reviewDecidedRef.current = true;
											// Revert to previous content
											startTransition(() => {
												const markdown =
													fromMarkdown(
														previousContent,
													);

												// The single-user editor shows the
												// earlier body at once. A room is left
												// alone until the server answers: the
												// rewind's own body then goes in with
												// its stamp (see
												// `rejectRegenerationMutation`), so no
												// collaborator ever holds this
												// editor's memory of the earlier body,
												// unstamped, under the reviewed body's
												// stamp (Fizzy #2946).
												if (!roomStampsOn) {
													// Deferred out of this handler,
													// not to the next frame, which a
													// background tab holds back: the
													// server's answer must find it
													// there (Fizzy #2946).
													queueMicrotask(() => {
														applyToLiveEditor(
															markdown,
														);
													});
													// Update local state only - DO NOT call setAgentState for direct regeneration
													setCurrentDocument(
														previousContent,
													);
												}
												// The rewind is a server write: the
												// room hears that one is in flight
												// until its stamp follows (Fizzy #2946).
												const reviewStamp =
													runState.reviewStampRef
														.current;
												const reviewedRunStartedAt =
													runState
														.reviewedRunStartedAtRef
														.current;
												// What the room holds as the
												// Reject goes: its answer writes
												// the room only if nothing moved
												// it meanwhile (Fizzy #2946).
												rejectSendStampRef.current =
													roomStampsOn && ydoc
														? readRoomStamp(ydoc)
														: null;
												rejectShownBodyRef.current =
													roomStampsOn
														? null
														: previousContent;
												// Nothing is typed until the
												// Reject settles (Fizzy #2946).
												typedSinceRejectRef.current = false;
												setRejectPending(true);
												let fallbackDeclined = false;
												const releaseReject = () =>
													setRejectPending(false);
												if (roomStampsOn && ydoc) {
													publishRoomSaveInFlight(
														provider?.awareness,
														reviewStamp ??
															readRoomStamp(ydoc),
													);
												}

												// True rollback: delete the regen's DocumentVersion row and
												// rewind projectDocument.{version, content} to the prior
												// snapshot, so version history stays consistent. Falls back
												// to the old skipVersionBump save when there is no prior
												// version to revert to (e.g. first-ever generation) or
												// the live state has drifted from the latest snapshot.
												// Passing `organizationId` explicitly anchors the side
												// effects (RAG re-embed, realtime) to the current route's
												// tenant rather than the session's active org, which can
												// be stale.
												// It names the reviewed run, so
												// the server refuses it when a
												// newer write landed since
												// (Fizzy #2946).
												rejectRegenerationMutation.mutate(
													{
														projectId,
														id: documentId,
														organizationId:
															organizationId ??
															null,
														expectedVersion:
															reviewedVersion,
														...(reviewStamp?.contentHash
															? {
																	expectedContentHash:
																		reviewStamp.contentHash,
																}
															: {}),
														...(reviewedRunStartedAt
															? {
																	expectedGenerationStartedAt:
																		reviewedRunStartedAt,
																}
															: {}),
													},
													{
														// Said once the server has
														// rewound the document, never
														// before it answers (Fizzy #2946).
														onSuccess: () => {
															releaseReject();
															toast.info(
																tRun(
																	"regenerationRejected",
																),
															);
														},
														onError: (error) => {
															if (roomStampsOn) {
																publishRoomSaveInFlight(
																	provider?.awareness,
																	null,
																);
															}
															// The document moved past the
															// reviewed run before the rewind
															// (Fizzy #2946): nothing was
															// reverted, and the fallback save
															// below would write the older body
															// over the newer one. The editor
															// goes back to the saved body.
															if (
																(
																	error as {
																		data?: {
																			code?: string;
																		};
																	}
																)?.data
																	?.code ===
																REJECT_REVIEW_STALE
															) {
																toast.error(
																	tRun(
																		"rejectReviewStale",
																	),
																);
																void restoreLatestSavedBody().finally(
																	releaseReject,
																);
																return;
															}
															const isNoPrior =
																(
																	error as {
																		code?: string;
																	}
																)?.code ===
																"CONFLICT";
															if (!isNoPrior) {
																releaseReject();
																toast.error(
																	describeDocumentWriteRefusal(
																		error,
																		tWriteRefusal,
																	).message,
																);
																return;
															}
															// A newer generation run took the
															// document while the review was open
															// (Fizzy #2946): the server refused the
															// rewind, and the fallback save below
															// would be refused too.
															const runLive =
																(
																	error as {
																		data?: {
																			code?: string;
																		};
																	}
																)?.data
																	?.code ===
																DOCUMENT_GENERATION_IN_PROGRESS;
															// Nothing to go back to (Fizzy #2946):
															// saving an empty body would wipe the
															// regenerated one for everyone and leave
															// nothing to restore. Nothing is written,
															// and the regenerated body — still the
															// saved one — goes back into the
															// single-user editor, which showed the
															// earlier one; a room was never left.
															// The same when a run holds the document.
															if (
																runLive ||
																previousContent.trim() ===
																	""
															) {
																releaseReject();
																toast.error(
																	tRun(
																		runLive
																			? "rejectRunLive"
																			: "rejectEmptyBody",
																	),
																);
																const kept =
																	newContent;
																setCurrentDocument(
																	kept,
																);
																if (
																	roomStampsOn
																) {
																	setHasUnsavedChanges(
																		false,
																	);
																	return;
																}
																// After the
																// write that put the
																// earlier body on
																// screen.
																queueMicrotask(
																	() => {
																		if (
																			applyToLiveEditor(
																				fromMarkdown(
																					kept,
																				),
																				reviewStamp,
																			)
																		) {
																			updateSavedBaseline(
																				kept,
																			);
																		}
																		setHasUnsavedChanges(
																			false,
																		);
																	},
																);
																return;
															}
															// First-ever generation — no prior version
															// to revert to. Best we can do is overwrite
															// the live content back to the captured
															// previousContent without touching versions.
															// Guarded like every save from
															// the room: the regenerated body
															// it replaces is its base
															// (Fizzy #2946). It waits for a
															// save in flight, and names the
															// base that answer produced. The
															// rejection is said once this save
															// lands; a refused one says why.
															sendDirectSaveRef.current(
																{
																	confirm: false,
																	build: (
																		base,
																	) =>
																		buildDocumentSaveInput(
																			{
																				projectId,
																				documentId,
																				content:
																					previousContent,
																				isManualSave: false,
																				skipVersionBump: true,
																				organizationId:
																					organizationId ??
																					null,
																				base,
																			},
																		),
																	onUnavailable:
																		() =>
																			toast.error(
																				tRun(
																					"saveBlocked.updatingToLatest",
																				),
																			),
																	// Only over the
																	// reviewed body
																	// (Fizzy #2946): a
																	// save that landed
																	// since — a
																	// colleague's, or
																	// one this one
																	// waited for — is
																	// never replaced
																	// by the earlier
																	// body.
																	stillApplies:
																		(
																			base,
																		) =>
																			fallbackBaseIsReviewed(
																				base,
																				reviewStamp,
																			),
																	onDeclined:
																		() => {
																			toast.error(
																				tRun(
																					"rejectReviewStale",
																				),
																			);
																			fallbackDeclined = true;
																			void restoreLatestSavedBody().finally(
																				releaseReject,
																			);
																		},
																	onSettled:
																		() => {
																			if (
																				!fallbackDeclined
																			) {
																				releaseReject();
																			}
																		},
																	onSaved: (
																		saved,
																	) => {
																		toast.info(
																			tRun(
																				"regenerationRejected",
																			),
																		);
																		if (
																			!roomStampsOn
																		) {
																			return undefined;
																		}
																		// The room takes the
																		// earlier body only
																		// now, with the stamp
																		// of this save. When
																		// no editor on screen
																		// takes it, the room
																		// keeps its stamp and
																		// the stale rule
																		// brings it to the
																		// saved body
																		// (Fizzy #2946).
																		if (
																			!saved ||
																			!applyToLiveEditor(
																				previousContent
																					? fromMarkdown(
																							previousContent,
																						)
																					: "",
																				saved,
																			)
																		) {
																			return false;
																		}
																		setCurrentDocument(
																			previousContent,
																		);
																		adoptSavedBody(
																			previousContent,
																			saved,
																		);
																		return undefined;
																	},
																},
															);
														},
													},
												);

												// Only update agent state for agent-based regeneration (has respond ref)
												if (
													regenerationRespondRef.current
												) {
													// IMPORTANT: Preserve ragContexts and projectContext
													setAgentState((prev) => ({
														...prev,
														document:
															previousContent,
														streamingContent:
															previousContent,
													}));
													regenerationRespondRef.current(
														{
															accepted: false,
														},
													);
													regenerationRespondRef.current =
														null;
												}

												setShowConfirmDialog(false);
												regenerationTriggeredRef.current = false;
												// Keep isDirectRegenerationRef true a bit longer to prevent any async effects
												setTimeout(() => {
													isDirectRegenerationRef.current = false;
												}, 500);

												// Reset confirming flag after a delay
												setTimeout(() => {
													setIsConfirming(false);
												}, 1000);
											});
										}}
									/>
								)}

								{/* Editor */}
								<div className="relative flex min-h-0 flex-1 overflow-hidden">
									{viewMode === "rich" &&
										!showDiffPreviewPanes && (
											<DocumentTocRail
												editor={editor}
												onAnnounce={
													setScrollAnnouncement
												}
											/>
										)}
									{viewMode === "rich" ? (
										// biome-ignore lint/a11y/useKeyWithClickEvents: click delegates to image lightbox, keyboard handled via Escape in lightbox
										// biome-ignore lint/a11y/noStaticElementInteractions: editor container delegates image clicks, not interactive itself
										<div
											className={`flex-1 overflow-auto bg-background ${isLoading || hasPendingConfirm || contextUpdate.showingDiff ? "streaming-diff-active" : ""} ${!editor?.isEditable ? "tiptap-readonly" : ""}`}
											onClick={(e) => {
												// Open lightbox when clicking images in read-only mode
												if (!editor?.isEditable) {
													const target =
														e.target as HTMLElement;
													const imgEl =
														target.tagName === "IMG"
															? (target as HTMLImageElement)
															: target
																	.closest(
																		"figure",
																	)
																	?.querySelector(
																		"img",
																	);
													if (
														imgEl &&
														imgEl instanceof
															HTMLImageElement
													) {
														setLightboxImage({
															src: imgEl.src,
															alt:
																imgEl.alt || "",
														});
													}
												}
											}}
										>
											{editor && (
												<ImageSelectionToolbar
													editor={editor}
												/>
											)}
											{/* Sticky diff-review header — the mode toggle and
							    accept/reject bar stay pinned to the top of the
							    scroll area while a long document is reviewed. */}
											<div className="sticky top-0 z-20 bg-background">
												{isDiffReviewActive && (
													<div className="flex items-center justify-end border-b border-border bg-muted/30 px-4 py-2">
														<DiffViewModeToggle
															value={diffViewMode}
															onChange={
																setDiffViewMode
															}
														/>
													</div>
												)}
												{hasPendingConfirm && (
													<DiffReviewBar
														editor={editor}
														mode={
															effectiveDiffViewMode
														}
														onAcceptAll={() =>
															confirmCallbacksRef.current?.accept()
														}
														onRejectAll={() =>
															confirmCallbacksRef.current?.reject()
														}
														onBeforeChange={() => {
															isDiffReviewEditRef.current = true;
														}}
														onAfterChange={() => {
															isDiffReviewEditRef.current = false;
														}}
														outcomeAudit={
															diffOutcomeAudit
														}
													/>
												)}
												{contextUpdate.isLoading && (
													<div className="sticky top-0 z-10 flex items-center gap-3 px-4 py-2 bg-muted/50 border-b border-border text-sm backdrop-blur-sm">
														<Loader2 className="h-4 w-4 animate-spin text-primary shrink-0" />
														<span className="font-medium text-foreground">
															{
																contextUpdate.loadingStage
															}
														</span>
														<span className="text-xs text-muted-foreground tabular-nums">
															·{" "}
															{
																contextUpdate.elapsedSeconds
															}
															s elapsed
														</span>
														<span className="ml-auto text-xs text-muted-foreground">
															This usually takes
															30–120 s
														</span>
													</div>
												)}
												{contextUpdate.showingDiff && (
													<DiffReviewBar
														editor={editor}
														mode={
															effectiveDiffViewMode
														}
														onAcceptAll={() => {
															void contextUpdate.confirm();
														}}
														onRejectAll={() => {
															contextUpdate.reject();
														}}
														onBeforeChange={() => {
															isDiffReviewEditRef.current = true;
														}}
														onAfterChange={() => {
															isDiffReviewEditRef.current = false;
														}}
													/>
												)}
											</div>
											{document && (
												<DocumentDecisionPrecheckBanner
													projectId={projectId}
													documentId={documentId}
													organizationId={
														organizationId ?? null
													}
													decisionPrecheck={
														document.decisionPrecheck
													}
													currentContentHash={
														document.currentContentHash ??
														null
													}
													onAcknowledged={() => {
														queryClient.invalidateQueries(
															{
																queryKey:
																	documentGetQueryKey,
															},
														);
													}}
												/>
											)}
											{contextUpdate.showingDiff &&
												contextUpdate.preview
													?.summary && (
													<div className="mx-4 mt-2 rounded-md border border-border bg-card px-3 py-2">
														<p className="text-xs font-medium text-muted-foreground uppercase tracking-[0.2em]">
															AI Summary
														</p>
														<p className="mt-1 text-sm text-foreground/80">
															{
																contextUpdate
																	.preview
																	.summary
															}
														</p>
													</div>
												)}
											<div
												{...contentThemeProps}
												className={
													cn(
														contentThemeProps?.className,
														showDiffPreviewPanes &&
															"hidden",
													) || undefined
												}
											>
												{/* While the room is behind the saved document, the
												    saved body, read-only; the room's editor stays
												    mounted behind it (Fizzy #2946). Made ready,
												    hidden, during a second look that froze the
												    editor at the end of a run, which it may end in;
												    a second look that keeps the room's body on
												    screen builds no hidden editor. */}
												<MermaidVisualProvider
													enabled={
														statTiles &&
														documentRefKind ===
															"PROJECT_DOCUMENT"
													}
													projectId={projectId}
													documentId={documentId}
													isMember={
														proposalVisuals?.isMember ===
														true
													}
													paint={
														proposalVisuals?.paint
													}
													flushSave={
														flushForVisualEdit
													}
												>
													<EditorContent
														editor={editor}
														className={cn(
															"prose prose-sm max-w-none dark:prose-invert",
															showsSavedBody &&
																"hidden",
														)}
													/>
													{(showsSavedBody ||
														(roomStatus ===
															"checking" &&
															checkingView !==
																"room")) && (
														<RoomSavedBody
															markdown={
																document?.content ??
																""
															}
															statTiles={
																statTiles
															}
															shown={
																showsSavedBody
															}
														/>
													)}
												</MermaidVisualProvider>
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
														derived={diffViews}
													/>
												)}
											<DocumentAssetsPanel
												assets={documentAssets}
											/>
										</div>
									) : (
										<div className="flex-1 overflow-auto bg-background p-10">
											{rawContent.includes(
												"data:image/",
											) && (
												<div className="mb-3 flex items-center gap-2 rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
													<ImageIcon className="size-3.5 shrink-0" />
													<span>
														This document contains
														embedded images. Use the
														rich editor to view
														them.
													</span>
												</div>
											)}
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
													disabled={isLoading}
													className="gap-1.5"
												>
													<SparklesIcon className="size-3.5" />
													Ask About Selection
												</Button>
											</div>
											{/* The raw view holds still with the
											    room's editor, and shows the saved
											    body with it unless it holds edits
											    of its own; otherwise it follows the
											    editor's body (Fizzy #2946). */}
											<Textarea
												ref={rawTextareaRef}
												value={
													showsSavedBody &&
													!rawEditPending()
														? (document?.content ??
															"")
														: rawContent
												}
												onChange={(e) =>
													handleRawContentChange(
														e.target.value,
													)
												}
												placeholder="Enter your document content in markdown format... Type @fabric followed by your question to ask the AI agent."
												className="font-mono text-sm resize-none min-h-[calc(100vh-300px)] w-full"
												disabled={rawViewHeld}
											/>
											<div className="mt-4 space-y-2">
												<p className="text-xs text-muted-foreground">
													Raw markdown view. Edit the
													document directly in
													markdown format.
												</p>
											</div>
											<DocumentAssetsPanel
												assets={documentAssets}
											/>
										</div>
									)}
								</div>
							</div>

							{/* Version History Panel */}
							<DocumentVersionHistory
								open={showVersionHistory}
								onOpenChange={setShowVersionHistory}
								projectId={projectId}
								documentId={documentId}
								currentVersion={document?.version || 1}
								currentContent={
									document?.content || currentDocument || ""
								}
								// Restore waits for a run (Fizzy #2946): the
								// server refuses a restore while one holds a
								// run-guarded document — the ten-minute rule
								// for a silent run is the editor's, not the
								// server's — and this tab's own regeneration
								// or its review owns the body until it ends.
								restoreBlockedReason={
									isGenerationRunning &&
									isRunGuardedDocumentType(
										document?.type ?? "",
									)
										? "runLive"
										: isRegenerating ||
												showConfirmDialog ||
												isConfirming
											? "regenerating"
											: null
								}
								onVersionRestored={(
									restoredContent: string,
									restoredVersion?: number,
								) => {
									// Programmatically update editor - no page reload
									applyProgrammaticContent(
										editor,
										fromMarkdown(restoredContent),
										"server",
									);
									editorBodyVersionRef.current =
										restoredVersion ??
										editorBodyVersionRef.current;
									editorBodyHashRef.current = undefined;
									void adoptServerBase({
										body: restoredContent,
										version: restoredVersion,
									});
									setCurrentDocument(restoredContent);
									baselineRef.current = restoredContent;
									updateSavedBaseline(restoredContent);
									setAgentState((prev) => ({
										...prev,
										document: restoredContent,
										streamingContent: restoredContent,
									}));
									setHasUnsavedChanges(false);
									// Invalidate queries to refresh version list and document metadata
									queryClient.invalidateQueries({
										queryKey:
											orpc.projects.documents.get.queryKey(
												{
													input: {
														id: documentId,
														projectId,
														organizationId,
													},
												},
											),
									});
									queryClient.invalidateQueries({
										queryKey:
											orpc.projects.documents.versions.list.queryKey(
												{
													input: {
														projectId,
														documentId,
														organizationId,
													},
												},
											),
									});
									setShowVersionHistory(false);
								}}
							/>
						</CopilotReplyRatingSidebar>

						{/* Group F — persistent chat-history drawer. The drawer is
			    the secondary surface for browsing prior conversations;
			    only mounted when the org has the feature flag ON,
			    mirroring `CustomSidebarHeader`. */}
						{documentAssistantHistoryEnabled && user ? (
							<CopilotHistoryDrawer
								open={historyDrawerOpen}
								onOpenChange={setHistoryDrawerOpen}
								documentRefKind={documentRefKind}
								documentRefId={documentId}
								projectId={projectId}
								organizationId={organizationId ?? null}
								currentUserId={user.id}
								activeConversationId={
									activeAssistantConversationId
								}
								onForked={({
									forkedConversationId,
									copiedMessages,
								}) => {
									// Swap the live chat to the new (forked)
									// conversation without crashing CopilotKit.
									//
									// Order:
									//   1. Clear CopilotKit's runtime so the live
									//      half of the sidebar shows nothing — only
									//      the historical (forked) messages render.
									//   2. Update the hydrated trio (messages + ssr
									//      id + persisted ids) so HydratedMessagesProvider
									//      re-renders with the forked messages and
									//      CopilotPersistenceHook does NOT re-persist
									//      any of them (ids pre-seeded into the
									//      walker's "already persisted" set).
									//   3. Flip the active conversation id last so
									//      the provider's `sameThread` check passes
									//      and the historical half lights up.
									//
									// What we DON'T do: push the copied messages
									// into CopilotKit's runtime via a second
									// setMessages call. That triggers an internal
									// "Remember to wrap your app in <CopilotKit>"
									// error mid-render which the error boundary
									// then catches and unmounts the whole editor.
									// Reproduced on staging dpl_2RyCKvUFvsaMv2CojKQ7BEu8qo3q.
									//
									// Agent context for the next user send is
									// recovered server-side: the LangGraph agent
									// reads the persisted messages[] for the
									// active conversationId, so the user's next
									// turn carries the full forked history without
									// the client having to seed the runtime.
									// Verified on staging: "How many D7 markers did
									// we add?" answered "There are 2 — D7 marker 1
									// and D7 marker 2" — backend pulled context.
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

						{/* Image Lightbox for read-only viewing */}
						{lightboxImage && (
							<ImageLightbox
								src={lightboxImage.src}
								alt={lightboxImage.alt}
								onClose={() => setLightboxImage(null)}
							/>
						)}

						{/* Page-chrome sync slot — Yjs sync status pill. Lives on the
			  breadcrumb row alongside the project-presence indicators. */}
						{syncSlot &&
							enableCollaboration &&
							createPortal(
								roomStatus === "inSync" ? (
									<CollaborationStatus
										isConnected={isCollabConnected}
										isSynced={isCollabSynced}
										collaborators={collaborators ?? []}
									/>
								) : (
									<RoomUpdatingStatus
										failed={roomStatus === "failed"}
										onReloadLatest={
											roomConvergenceState.reloadLatest
										}
									/>
								),
								syncSlot,
							)}

						{/* Page-chrome action slot — Raw + Version history (action
			  buttons only). Portaled into Line 3 of the page-level masthead
			  alongside Save. The Manage Prompts gear lives inline next to
			  PromptSelector, not here. */}
						{actionSlot &&
							createPortal(
								<>
									<TooltipProvider>
										<Tooltip>
											<TooltipTrigger asChild>
												{/* Focusable while disabled, so the reason shows. */}
												<span
													tabIndex={
														viewSwitchHeld ? 0 : -1
													}
													className="inline-flex"
												>
													<Button
														type="button"
														variant={
															viewMode === "raw"
																? "secondary"
																: "ghost"
														}
														size="sm"
														onClick={
															handleViewModeToggle
														}
														disabled={
															rejectPending ||
															viewSwitchHeld
														}
														aria-label={
															viewMode === "rich"
																? "View raw markdown"
																: "Switch to rich editor"
														}
														aria-describedby={
															viewSwitchHeld
																? viewSwitchHeldId
																: undefined
														}
													>
														{viewMode === "rich" ? (
															<Code2Icon className="size-4" />
														) : (
															<EyeIcon className="size-4" />
														)}
													</Button>
												</span>
											</TooltipTrigger>
											<TooltipContent>
												<p>
													{viewSwitchHeld
														? VIEW_SWITCH_HELD_TEXT
														: viewMode === "rich"
															? "Switch to raw markdown view"
															: "Switch to rich editor"}
												</p>
											</TooltipContent>
										</Tooltip>
										{viewSwitchHeld && (
											<span
												id={viewSwitchHeldId}
												className="sr-only"
											>
												{VIEW_SWITCH_HELD_TEXT}
											</span>
										)}
									</TooltipProvider>
									<TooltipProvider>
										<Tooltip>
											<TooltipTrigger asChild>
												<Button
													type="button"
													variant="ghost"
													size="sm"
													onClick={() =>
														setShowVersionHistory(
															true,
														)
													}
													disabled={
														isSaving ||
														isRegenerating
													}
													aria-label={`Version history, current v${
														(document as any)
															?.version || 1
													}`}
												>
													<HistoryIcon className="size-4 mr-1" />
													<span className="text-xs text-muted-foreground">
														v
														{(document as any)
															?.version || 1}
													</span>
												</Button>
											</TooltipTrigger>
											<TooltipContent>
												<p>Version history</p>
											</TooltipContent>
										</Tooltip>
									</TooltipProvider>
								</>,
								actionSlot,
							)}

						{/* Page-chrome save slot — Save split-button. Same UX as the
			  feature editor: primary "Save"/"Saved"/"Saving…" + dropdown
			  for "Save & close". */}
						{saveSlot &&
							createPortal(
								(() => {
									// A draft with content is still owed its
									// completion once its text is saved, and
									// Save is what completes it. An autosave
									// clears the unsaved state ten seconds
									// after the last keystroke, so without
									// this the button would be disabled by the
									// time anyone reached for it.
									//
									// Not while the editor holds text nobody
									// has accepted — an assistant run
									// streaming in, a proposal or a context
									// update awaiting review, a regeneration.
									// Save would store that text and complete
									// the document on it; the autosave stands
									// down in the same states. And not for an
									// integration contract, whose status the
									// server never lets a save change.
									const completesDraft =
										document?.status === "DRAFT" &&
										document.type !==
											"INTEGRATION_CONTRACT" &&
										(document.content ?? "").trim() !==
											"" &&
										!isLoading &&
										!isRegenerating &&
										!showConfirmDialog &&
										!isDiffReviewActive;
									const isSaved =
										!isSaving &&
										!hasUnsavedChanges &&
										!completesDraft;
									// A refused save says why (Fizzy #2946):
									// in the tooltip, and as the button's
									// description for assistive technology.
									const saveBlockedText =
										saveBlockReason !== null
											? tRun(
													`saveBlocked.${saveBlockReason}`,
												)
											: null;
									const isPrimaryDisabled =
										isSaving ||
										isSaved ||
										saveBlockedText !== null;
									const primaryLabel = isSaving
										? "Saving…"
										: isSaved
											? "Saved"
											: "Save";
									const primaryAriaLabel = isSaving
										? "Saving"
										: isSaved
											? "Document saved, no changes to save"
											: "Save document";
									const primaryTooltip = isSaving
										? "Saving…"
										: saveBlockedText !== null
											? saveBlockedText
											: isSaved
												? "No changes to save"
												: completesDraft
													? tTooltips(
															"saveCompletesDraft",
														)
													: "Save document";
									const PrimaryIcon = isSaving
										? Loader2
										: isSaved
											? CheckIcon
											: SaveIcon;
									return (
										<>
											<output
												aria-live="polite"
												className={
													assistantFinishingShown
														? "mr-3 flex items-center gap-1 text-xs text-muted-foreground"
														: "sr-only"
												}
											>
												{assistantFinishingShown && (
													<>
														<Loader2
															className="h-3 w-3 animate-spin"
															aria-hidden
														/>
														<span>
															{tRun(
																"assistantFinishing",
															)}
														</span>
													</>
												)}
											</output>
											<div
												className="inline-flex shrink-0"
												aria-live="polite"
											>
												<Tooltip>
													<TooltipTrigger asChild>
														<span
															tabIndex={
																isPrimaryDisabled
																	? 0
																	: -1
															}
															className="inline-flex"
														>
															<Button
																type="button"
																size="sm"
																disabled={
																	isPrimaryDisabled
																}
																aria-label={
																	primaryAriaLabel
																}
																aria-describedby={
																	saveBlockedText !==
																	null
																		? saveBlockedId
																		: undefined
																}
																className="shrink-0 rounded-r-none"
																onClick={() => {
																	isManualSaveRef.current = true;
																	shouldRedirectAfterSaveRef.current = false;
																	handleSave();
																}}
															>
																<PrimaryIcon
																	className={`size-4 mr-2 ${
																		isSaving
																			? "animate-spin"
																			: ""
																	}`}
																	aria-hidden
																/>
																{primaryLabel}
															</Button>
														</span>
													</TooltipTrigger>
													<TooltipContent>
														{primaryTooltip}
													</TooltipContent>
												</Tooltip>
												{saveBlockedText !== null && (
													<span
														id={saveBlockedId}
														className="sr-only"
													>
														{saveBlockedText}
													</span>
												)}
												<DropdownMenu modal={false}>
													<DropdownMenuTrigger
														asChild
													>
														<Button
															type="button"
															size="sm"
															disabled={
																isPrimaryDisabled
															}
															aria-label="More save options"
															className="shrink-0 rounded-l-none border-l border-primary-foreground/30 px-2"
														>
															<ChevronDown
																className="size-4"
																aria-hidden
															/>
														</Button>
													</DropdownMenuTrigger>
													<DropdownMenuContent align="end">
														<DropdownMenuItem
															onSelect={() => {
																isManualSaveRef.current = true;
																shouldRedirectAfterSaveRef.current = true;
																handleSave();
															}}
															className="cursor-pointer rounded-md bg-primary text-primary-foreground focus:bg-primary/90 focus:text-primary-foreground data-[highlighted]:bg-primary/90 data-[highlighted]:text-primary-foreground"
														>
															<XIcon
																className="mr-2 size-4"
																aria-hidden
															/>
															Save & Close
														</DropdownMenuItem>
													</DropdownMenuContent>
												</DropdownMenu>
											</div>
										</>
									);
								})(),
								saveSlot,
							)}
						{/* Polite live region — announces scroll-to-mention navigation to screen readers */}
						<div
							role="status"
							aria-live="polite"
							className="sr-only"
						>
							{scrollAnnouncement}
						</div>
					</HydratedMessagesProvider>
				</DocumentAssistantOutcomesProvider>
			</AttachmentRegistryProvider>
		</MentionStatusContext.Provider>
	);
}

// Regeneration confirmation dialog component
interface RegenerationConfirmDialogProps {
	previousContent: string;
	newContent: string;
	onAccept: () => void;
	onReject: () => void;
}

function RegenerationConfirmDialog({
	previousContent,
	newContent,
	onAccept,
	onReject,
}: RegenerationConfirmDialogProps) {
	const [accepted, setAccepted] = useState<boolean | null>(null);
	const [isVisible, setIsVisible] = useState(false);
	const [showStatus, setShowStatus] = useState(false);

	// Smooth mount animation
	useEffect(() => {
		const timer = setTimeout(() => {
			setIsVisible(true);
		}, 10);
		return () => clearTimeout(timer);
	}, []);

	// Delay status message appearance
	useEffect(() => {
		if (accepted !== null) {
			const timer = setTimeout(() => {
				setShowStatus(true);
			}, 150);
			return () => clearTimeout(timer);
		}
	}, [accepted]);

	// The choice lands after a short delay, and only while this dialog is
	// open (Fizzy #2946): a review closed meanwhile — a newer write
	// superseded it — unmounts the dialog, and a choice made on it then
	// must not run against a document that has moved on.
	const decisionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(() => {
		return () => {
			if (decisionTimerRef.current) {
				clearTimeout(decisionTimerRef.current);
				decisionTimerRef.current = null;
			}
		};
	}, []);

	const handleAccept = () => {
		setAccepted(true);
		if (decisionTimerRef.current) {
			clearTimeout(decisionTimerRef.current);
		}
		decisionTimerRef.current = setTimeout(() => {
			decisionTimerRef.current = null;
			onAccept();
		}, 800);
	};

	const handleReject = () => {
		setAccepted(false);
		if (decisionTimerRef.current) {
			clearTimeout(decisionTimerRef.current);
		}
		decisionTimerRef.current = setTimeout(() => {
			decisionTimerRef.current = null;
			onReject();
		}, 800);
	};

	return (
		<div
			data-testid="regeneration-confirm-modal"
			className="fixed inset-0 bg-background/80 backdrop-blur-sm z-50 flex items-center justify-center p-2"
			style={{
				opacity: isVisible ? 1 : 0,
				transition: "opacity 0.2s ease-out",
			}}
		>
			<div
				className="bg-card border border-border rounded-lg shadow-2xl w-[98vw] h-[98vh] overflow-hidden flex flex-col"
				style={{
					transform: isVisible ? "scale(1)" : "scale(0.95)",
					transition: "transform 0.2s ease-out",
				}}
			>
				<div className="shrink-0 p-6 border-b border-border">
					<h3 className="text-lg font-semibold">
						Document Regeneration Complete
					</h3>
					<p className="text-sm text-muted-foreground mt-1">
						Review the changes and decide whether to accept or
						reject the new version.
					</p>
				</div>

				<div className="flex-1 p-6 min-h-0 overflow-auto">
					<div className="grid grid-cols-2 gap-4 h-full min-h-[600px]">
						<div className="flex flex-col h-full min-h-0">
							<h4 className="text-sm font-medium mb-2 text-muted-foreground shrink-0">
								Previous Version (
								{countDocumentWords(previousContent)} words)
							</h4>
							<div className="flex-1 min-h-0 bg-muted/50 rounded-lg p-4 text-sm whitespace-pre-wrap font-mono overflow-y-auto overflow-x-auto">
								{previousContent}
							</div>
						</div>
						<div className="flex flex-col h-full min-h-0">
							<h4 className="text-sm font-medium mb-2 text-primary shrink-0">
								New Version ({countDocumentWords(newContent)}{" "}
								words)
							</h4>
							<div className="flex-1 min-h-0 bg-primary/5 border border-primary/20 rounded-lg p-4 text-sm whitespace-pre-wrap font-mono overflow-y-auto overflow-x-auto">
								{newContent}
							</div>
						</div>
					</div>
				</div>

				{accepted === null ? (
					<div className="shrink-0 p-6 border-t border-border flex justify-end gap-3">
						<Button
							variant="outline"
							onClick={handleReject}
							className="min-w-24"
						>
							Reject
						</Button>
						<Button onClick={handleAccept} className="min-w-24">
							Accept
						</Button>
					</div>
				) : (
					<div className="shrink-0 p-6 border-t border-border flex justify-center">
						{showStatus && (
							<div
								data-testid="status-display"
								className="bg-muted text-muted-foreground py-2 px-4 rounded transition-all duration-200 ease-out"
								style={{
									opacity: showStatus ? 1 : 0,
									transform: showStatus
										? "scale(1)"
										: "scale(0.95)",
								}}
							>
								{accepted ? "✓ Accepted" : "✗ Rejected"}
							</div>
						)}
					</div>
				)}
			</div>
		</div>
	);
}

// Confirmation dialog component - matches reference implementation
interface ConfirmChangesProps {
	recordVerdict: DraftVerdictRecorder;
	args: any;
	respond: any;
	status: any;
	/** Each says what the proposal was answered with. */
	onConfirm: () => boolean;
	onReject: () => boolean;
	originalLength?: number;
	newLength?: number;
	onMount?: () => void;
	onDone?: () => void;
	/** Where the person's choice is stamped, read when they make it. */
	outcomeAuditRef?: { readonly current: DiffOutcomeAudit };
}

function ConfirmChanges({
	recordVerdict,
	respond,
	status,
	onConfirm,
	onReject,
	originalLength = 0,
	newLength = 0,
	onMount,
	onDone,
	outcomeAuditRef,
}: ConfirmChangesProps) {
	useConfirmChangesVerdictCard(recordVerdict);
	// Track user's choice locally, but also derive from status
	// This handles the case where component is recreated after action re-registration
	const [userChoice, setUserChoice] = useState<
		"accepted" | "rejected" | null
	>(null);
	const [hidden, setHidden] = useState(false);
	// What the proposal was answered with is stamped on its tool call, as
	// the review bar stamps it, so the chat's outcome chip shows it rather
	// than "Pending" (Fizzy #2946): an Accept that could not read the editor
	// answered that nothing was accepted. Where to stamp is read before the
	// choice is acted on, while it still names this proposal.
	const stampDiffOutcome = useDiffOutcomeStamp();
	const choose = (choice: "accepted" | "rejected") => {
		const audit = outcomeAuditRef?.current;
		setUserChoice(choice);
		const accepted = choice === "accepted" ? onConfirm() : onReject();
		void stampDiffOutcome(audit, accepted ? "accepted" : "rejected");
	};

	// Auto-dismiss after user makes a choice
	useEffect(() => {
		if (userChoice !== null) {
			const timer = setTimeout(() => setHidden(true), 2000);
			return () => clearTimeout(timer);
		}
	}, [userChoice]);

	// Signal to parent that generation is done and confirm dialog is active —
	// only while this card's tool call is executing (Fizzy #2946). The chat
	// mounts a card again when a message enters the history ahead of it, and
	// an answered card that said so again held the editor in review: every
	// later edit went uncounted, and was never saved. Its cleanup runs when
	// the call is answered, so a card that leaves the chat later cannot close
	// a newer proposal's review.
	const executing = status === "executing";
	useEffect(() => {
		if (!executing) {
			return;
		}
		onMount?.();
		return () => onDone?.();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [executing]);

	// Calculate content loss percentage
	const hasContentLoss = originalLength > 0 && newLength < originalLength;
	const contentLossPercent = hasContentLoss
		? Math.round(((originalLength - newLength) / originalLength) * 100)
		: 0;
	const isSignificantLoss = contentLossPercent > 20; // More than 20% content removed

	// If status is not "executing", the tool call has been responded to
	// Don't show anything for completed/old confirmations to avoid UI clutter
	const isCompleted = status !== "executing";

	// If completed but no local choice, this component was recreated after the action completed
	// Hide it completely to avoid cluttering the sidebar with old confirmations
	if (isCompleted && userChoice === null) {
		return null;
	}

	if (hidden) {
		return null;
	}

	// User just made a choice - show the result
	if (userChoice !== null) {
		return (
			<div
				data-testid="confirm-changes-modal"
				className="bg-card text-card-foreground p-6 rounded-lg shadow-lg border border-border mt-5 mb-5"
			>
				<h2 className="text-lg font-bold mb-4 text-foreground">
					Confirm Changes
				</h2>
				<div className="flex justify-end">
					<div
						data-testid="status-display"
						className="mt-4 bg-muted text-muted-foreground py-2 px-4 rounded inline-block"
					>
						{userChoice === "accepted"
							? "✓ Changes accepted"
							: "✗ Changes discarded"}
					</div>
				</div>
			</div>
		);
	}

	// Show buttons for active confirmation
	return (
		<div
			data-testid="confirm-changes-modal"
			className="bg-card text-card-foreground p-6 rounded-lg shadow-lg border border-border mt-5 mb-5"
		>
			<h2 className="text-lg font-bold mb-4 text-foreground">
				Confirm Changes
			</h2>
			{isSignificantLoss && (
				<div className="mb-4 p-3 bg-destructive/10 border border-destructive/30 rounded-lg">
					<p className="text-sm text-destructive font-medium">
						⚠️ Warning: {contentLossPercent}% content reduction
						detected
					</p>
					<p className="text-xs text-destructive/80 mt-1">
						The AI removed significant content. Review the changes
						(red = removed, green = added) before accepting.
					</p>
				</div>
			)}
			<p className="mb-6 text-foreground">
				Do you want to accept the changes?
			</p>
			<div className="flex justify-end space-x-4">
				<button
					type="button"
					data-testid="reject-button"
					className="bg-muted text-muted-foreground py-2 px-4 rounded cursor-pointer hover:bg-muted/80"
					onClick={() => choose("rejected")}
				>
					Reject
				</button>
				<button
					type="button"
					data-testid="confirm-button"
					className="bg-primary text-primary-foreground py-2 px-4 rounded cursor-pointer hover:bg-primary/90"
					onClick={() => choose("accepted")}
				>
					Confirm
				</button>
			</div>
		</div>
	);
}
